/**
 * Semantic concept judge — "does the built artifact actually implement
 * the features the user asked for?"
 *
 * Distinct from the domain/code/coherence judges in `judges.ts`:
 *   - those judges score free-form conversational agent outputs along
 *     quality dimensions (accuracy, depth, etc.)
 *   - this judge scores a *built artifact* (served HTML + source files)
 *     against an explicit list of expected concepts, returning per-concept
 *     {present, score 0-10, evidence, severity}.
 *
 * The judge is strict about distinguishing (a) a working implementation
 * from (b) a keyword-present stub. "// TODO: mint button" is NOT present.
 * Only real, functional, wired-up code counts.
 *
 * Use via {@link createSemanticConceptJudge} or directly via
 * {@link runSemanticConceptJudge}. Soft-fails (available=false) on LLM
 * or JSON-parse errors so the caller can treat that as "layer skipped"
 * rather than "layer failed" in a multi-layer pipeline.
 */

import { callLlmJson, type LlmClientOptions } from './llm-client'
import type { Severity } from './multi-layer-verifier'

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Implementation complexity class for weighted scoring (added 0.11).
 *
 * - `render` (default): the concept is a UI surface that displays static
 *   data — render a list, show a counter, lay out a button. Single-file
 *   work, no external integration.
 * - `integrate`: the concept requires wiring a real external system —
 *   wallet connect (wagmi + RainbowKit + chain config), payment provider
 *   (Stripe Elements + intent + webhook), an API client with auth.
 *   Multi-file, library-knowledge, runtime correctness matters.
 * - `compute`: the concept requires algorithmic work — solver, simulator,
 *   constraint propagation, ML inference. Correctness > UI polish.
 *
 * Default weights (when applied via `weightConcepts: 'complexity'`):
 *   render=1.0, integrate=2.0, compute=2.5
 *
 * Cross-vertical scoring without complexity weighting silently inflates
 * the rate of UI-heavy verticals (healthcare, fintech dashboards) vs
 * integration-heavy verticals (DeFi, wallets) — all concepts treated
 * equally even though the agent does 2-3x the work for `integrate`.
 */
export type ConceptComplexity = 'render' | 'integrate' | 'compute'

export interface ConceptSpec {
  name: string
  /** Short hints that help the judge; not used for matching. */
  keywords?: string[]
  /** Optional explicit weight; default 1.0. Overrides complexity-derived weight. */
  weight?: number
  /** Implementation complexity class. Default `render`. */
  complexity?: ConceptComplexity
}

export interface ConceptFinding {
  concept: string
  present: boolean
  /** 0..10. 10 = production-ready; 7 = functional thin; 4 = partial; 0 = absent. */
  score: number
  evidence: string
  severity: Severity
}

export interface SemanticConceptJudgeInput {
  /** Full natural-language prompt the agent was handed. */
  userRequest: string
  /** Rendered HTML the preview returns (UI artifacts). Optional. */
  servedHtml?: string
  /** Top-level source files from the agent's workdir. */
  sourceFiles: Array<{ path: string; content: string }>
  /** The expected concept list. */
  expectedConcepts: ConceptSpec[]
  /** Free-form metadata (id, difficulty) to inject into the prompt. */
  artifactLabel?: string
  artifactDescription?: string
}

export interface SemanticConceptJudgeResult {
  kind: 'semantic-concept'
  version: string
  /** Normalized 0..1 score — mean of per-concept scores / 10. */
  score: number
  presentCount: number
  totalCount: number
  findings: ConceptFinding[]
  summary: string
  durationMs: number
  costUsd: number | null
  /** False on LLM/JSON error — treat as "skipped / unable to judge" in pipelines. */
  available: boolean
  error?: string
}

/**
 * Score-aggregation strategy. Default `mean` (legacy behavior — 0.10
 * and earlier always averaged 0-10 scores). `complexity` applies the
 * default weight table (render=1, integrate=2, compute=2.5) unless a
 * concept has an explicit `weight`. `explicit` honors only `weight`
 * (defaulting to 1 for unspecified).
 */
export type ConceptWeightStrategy = 'mean' | 'complexity' | 'explicit'

export const DEFAULT_COMPLEXITY_WEIGHTS: Record<ConceptComplexity, number> = {
  render: 1.0,
  integrate: 2.0,
  compute: 2.5,
}

export interface SemanticConceptJudgeOptions {
  /** Model id to call. Default 'claude-sonnet-4-6' via agent-eval defaults. */
  model?: string
  /** Per-call timeout. Default 180s. */
  timeoutMs?: number
  /** Pipeline budget for the prompt (source blob truncation). Default 45000. */
  maxSourceChars?: number
  /** Per-file cap before inclusion. Default 20000. */
  maxPerFileChars?: number
  /** HTML cap. Default 30000. */
  maxHtmlChars?: number
  /** LlmClient config (baseUrl, apiKey, authHeader, …). */
  llm?: LlmClientOptions
  /**
   * Score aggregation strategy. Default `mean` for backward compatibility
   * with 0.10 and earlier callers. Cross-vertical comparisons should use
   * `complexity` to neutralize the integrate-vs-render asymmetry.
   */
  weightConcepts?: ConceptWeightStrategy
  /** Override the default complexity → weight table. */
  complexityWeights?: Partial<Record<ConceptComplexity, number>>
}

// ─── Prompt assembly ────────────────────────────────────────────────────

export const SEMANTIC_CONCEPT_JUDGE_VERSION = 'semantic-concept-judge-v1-2026-04-24'

const DEFAULT_MAX_SOURCE = 45_000
const DEFAULT_MAX_HTML = 30_000
const DEFAULT_MAX_PER_FILE = 20_000
const DEFAULT_TIMEOUT = 180_000
const DEFAULT_MODEL = 'claude-sonnet-4-6'

const SEMANTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'concepts'],
  properties: {
    summary: { type: 'string', minLength: 20, maxLength: 600 },
    concepts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['concept', 'present', 'score', 'evidence', 'severity'],
        properties: {
          concept: { type: 'string', minLength: 1, maxLength: 120 },
          present: { type: 'boolean' },
          score: { type: 'number', minimum: 0, maximum: 10 },
          evidence: { type: 'string', minLength: 5, maxLength: 400 },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] },
        },
      },
    },
  },
}

function truncate(body: string, cap: number, label: string): string {
  if (body.length <= cap) return body
  return body.slice(0, cap) + `\n… [truncated ${body.length - cap} chars of ${label}]`
}

function buildPrompt(input: SemanticConceptJudgeInput, opts: Required<SemanticConceptJudgeOptions>): string {
  const sourceBlob = input.sourceFiles
    .filter((f) => f.content.length <= opts.maxPerFileChars)
    .map((f) => `--- FILE: ${f.path} ---\n${f.content}`)
    .join('\n\n')

  const html = input.servedHtml ?? ''

  return `You are a strict code-review judge evaluating whether an agent's 0-to-1 build actually implements the features the user asked for.

You MUST distinguish:
  (a) WORKING code that implements the concept (rendered UI, wired handler, real API call),
  (b) KEYWORD-PRESENT stub (comments mentioning the concept, variable names, TODOs),
  (c) ABSENT (concept nowhere).

A comment like "// TODO: add mint button" is NOT present — score 2-3. Only count a concept as present if there is real functional code: a rendered component, a call handler wired to state or a network call, a computed value actually used.

USER REQUEST (what the agent was asked to build):
${input.userRequest}

${input.artifactLabel ? `ARTIFACT METADATA:\n  name: ${input.artifactLabel}\n  description: ${input.artifactDescription ?? ''}\n\n` : ''}EXPECTED CONCEPTS (each must be graded independently):
${input.expectedConcepts
  .map((c, i) => `  ${i + 1}. "${c.name}"${c.keywords?.length ? ` — hints: [${c.keywords.slice(0, 6).join(' | ')}]` : ''}`)
  .join('\n')}

${html ? `SERVED HTML (what the preview returns when hit):\n${truncate(html, opts.maxHtmlChars, 'HTML')}\n\n` : ''}SOURCE FILES (the agent's workdir):
${truncate(sourceBlob, opts.maxSourceChars, 'source')}

For EACH concept, return:
  - concept: the concept name as given (match exactly)
  - present: boolean — does a working implementation exist?
  - score: 0-10 — 10 = production-ready; 7 = functional but thin; 4 = partial/stubbed; 2 = keyword-only comment; 0 = absent
  - evidence: cite "<file>:<line>" or "served-html:<selector>" pointing at the strongest supporting code. If the concept is absent or stubbed, explain what's missing.
  - severity:
      "info" when present: true AND score >= 7
      "minor" when present: true AND 4 <= score < 7
      "major" when present: false OR score < 4
      "critical" when the concept is not only absent but a core user flow depends on it

Also produce a "summary" (one sentence, 20-600 chars): overall verdict on whether this is a shippable implementation of the user request vs a keyword-dense placeholder.

BE SKEPTICAL. Keyword matching already passed — your job is to catch what keyword matching misses. If the agent shipped a working build, say so. If it shipped a stub, say so. Don't grade on effort.

Return STRICT JSON. No prose outside the JSON.`
}

// ─── Runner ─────────────────────────────────────────────────────────────

/**
 * Run the semantic concept judge. Soft-fails to available=false on
 * LLM/JSON errors — callers in a MultiLayerVerifier pipeline can treat
 * that as "skip" rather than "fail."
 */
export async function runSemanticConceptJudge(
  input: SemanticConceptJudgeInput,
  options: SemanticConceptJudgeOptions = {},
): Promise<SemanticConceptJudgeResult> {
  const start = Date.now()
  const totalCount = input.expectedConcepts.length

  if (totalCount === 0) {
    return {
      kind: 'semantic-concept',
      version: SEMANTIC_CONCEPT_JUDGE_VERSION,
      score: 0,
      presentCount: 0,
      totalCount: 0,
      findings: [],
      summary: 'no expected concepts declared',
      durationMs: 0,
      costUsd: null,
      available: false,
      error: 'no expected concepts declared',
    }
  }

  const opts: Required<SemanticConceptJudgeOptions> = {
    model: options.model ?? DEFAULT_MODEL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    maxSourceChars: options.maxSourceChars ?? DEFAULT_MAX_SOURCE,
    maxPerFileChars: options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE,
    maxHtmlChars: options.maxHtmlChars ?? DEFAULT_MAX_HTML,
    llm: options.llm ?? {},
    weightConcepts: options.weightConcepts ?? 'mean',
    complexityWeights: { ...DEFAULT_COMPLEXITY_WEIGHTS, ...(options.complexityWeights ?? {}) },
  }

  // Build a name → weight map for aggregation. Mean strategy keeps every
  // weight at 1 (preserves 0.10 behavior). Complexity strategy reads the
  // table and lets explicit `weight` override. Explicit strategy uses
  // ONLY the spec's `weight` (defaulting to 1).
  const weightForConcept = (spec: ConceptSpec): number => {
    if (opts.weightConcepts === 'mean') return 1
    if (spec.weight != null) return spec.weight
    if (opts.weightConcepts === 'complexity') {
      return opts.complexityWeights[spec.complexity ?? 'render'] ?? 1
    }
    return 1
  }
  const weightByName = new Map<string, number>(
    input.expectedConcepts.map((c) => [c.name, weightForConcept(c)]),
  )

  try {
    const { value, result } = await callLlmJson<{
      summary: string
      concepts: ConceptFinding[]
    }>(
      {
        model: opts.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a strict code-review judge. Return strict JSON only. No prose outside the JSON. A keyword in a comment is NOT a working implementation.',
          },
          { role: 'user', content: buildPrompt(input, opts) },
        ],
        jsonSchema: { name: 'semantic_concept_judge', schema: SEMANTIC_SCHEMA },
        temperature: 0,
        timeoutMs: opts.timeoutMs,
      },
      opts.llm,
    )

    if (!value?.concepts || !Array.isArray(value.concepts)) {
      throw new Error('judge returned malformed response — expected array under "concepts"')
    }

    const findings: ConceptFinding[] = value.concepts.map((c) => ({
      concept: String(c.concept),
      present: Boolean(c.present),
      score: Math.max(0, Math.min(10, Number(c.score ?? 0))),
      evidence: String(c.evidence ?? ''),
      severity: (['critical', 'major', 'minor', 'info'] as const).includes(c.severity)
        ? c.severity
        : 'info',
    }))

    const presentCount = findings.filter((f) => f.present && f.score >= 7).length
    let weightSum = 0
    let weightedScoreSum = 0
    for (const f of findings) {
      const w = weightByName.get(f.concept) ?? 1
      weightSum += w
      weightedScoreSum += w * f.score
    }
    const scoreAvg = weightSum > 0
      ? weightedScoreSum / weightSum
      : findings.reduce((a, f) => a + f.score, 0) / Math.max(1, findings.length)

    return {
      kind: 'semantic-concept',
      version: SEMANTIC_CONCEPT_JUDGE_VERSION,
      score: Number((scoreAvg / 10).toFixed(3)),
      presentCount,
      totalCount,
      findings,
      summary: String(value.summary ?? ''),
      durationMs: Date.now() - start,
      costUsd: result.costUsd ?? null,
      available: true,
    }
  } catch (err) {
    return {
      kind: 'semantic-concept',
      version: SEMANTIC_CONCEPT_JUDGE_VERSION,
      score: 0,
      presentCount: 0,
      totalCount,
      findings: [],
      summary: '',
      durationMs: Date.now() - start,
      costUsd: null,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Factory: pin LLM options once, return a closure that accepts inputs.
 * Convenient for pipelines that want to share a single LlmClient config.
 */
export function createSemanticConceptJudge(
  options: SemanticConceptJudgeOptions = {},
): (input: SemanticConceptJudgeInput) => Promise<SemanticConceptJudgeResult> {
  return (input) => runSemanticConceptJudge(input, options)
}
