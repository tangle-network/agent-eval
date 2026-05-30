/**
 * @experimental
 *
 * `gepaDriver` — a reflective `ImprovementDriver` for prompt-tier surfaces.
 * Each generation it reflects on the prior best candidate's per-scenario
 * scores + weakest dimensions, asks an LLM to propose targeted rewrites of
 * the current surface, and returns them as the next population.
 *
 * Honest scope vs the GEPA paper (Agrawal et al., arXiv:2507.19457):
 * this driver implements the *reflection* primitive — it does NOT implement
 * GEPA's Pareto frontier of candidates, multi-objective non-dominated
 * tracking, or the combine-complementary-lessons step. We use "best by
 * composite" as the parent each generation; the paper retains a Pareto set
 * and combines lessons across non-dominated candidates. Tracked as #101 in
 * the substrate roadmap. See `docs/specs/driver-honest-spec.md`.
 *
 * Optional `constraints` move structured-doc guards into the driver
 * (preserve H2 section headings, cap sentence-level edits) — useful when
 * the surface IS a structured procedure like a SKILL.md / runbook /
 * judge rubric. When `constraints` is omitted, behavior is unchanged.
 *
 * The driver is surface-agnostic — any string surface in any consumer opts
 * in by selecting it. Reuses the generic reflection primitive
 * (`buildReflectionPrompt` / `parseReflectionResponse`) and the router
 * client; no dependency on the legacy `runMultiShotOptimization` /
 * `prompt-evolution` orchestration.
 *
 * Earns its keep where there is real per-instance signal (which the
 * dimensional + per-scenario evidence + the `LabeledScenarioStore` flywheel
 * now provide). For thin-signal surfaces it degrades to plain reflection.
 * On generation 0 (no history) it reflects on the current surface against
 * the mutation primitives alone.
 */

import { callLlm, type LlmClientOptions } from '../../llm-client'
import {
  buildReflectionPrompt,
  parseReflectionResponse,
  type TrialTrace,
} from '../../reflective-mutation'
import type { ImprovementDriver, ProposeContext, ProposedCandidate } from '../types'

const REFLECTION_SYSTEM =
  'You are an expert prompt engineer. Output ONLY a JSON object of shape ' +
  '{"proposals":[{"label":string,"rationale":string,"payload":string}]} where ' +
  'each `payload` is the FULL improved surface text. No prose outside the JSON.'

export interface GepaDriverConstraints {
  /** H2 section headings that MUST appear unchanged in every candidate.
   *  When set, the driver auto-detects current H2s if this is empty AND
   *  rejects any candidate that drops or renames a preserved heading.
   *  Use when the surface is a structured doc (SKILL.md, runbook,
   *  sectioned system prompt, judge rubric). */
  preserveSections?: string[]
  /** Maximum sentence-level edits per candidate vs the parent surface.
   *  Rejection threshold = maxSentenceEdits × 2 (counts adds + removes).
   *  Inspired by SkillOpt's edit-budget as a "textual learning rate."
   *  Cap prevents an LLM rewrite from overwriting useful prior rules. */
  maxSentenceEdits?: number
}

export interface GepaDriverOptions {
  /** Router transport (apiKey/baseUrl). */
  llm: LlmClientOptions
  /** Model that performs the reflection. */
  model: string
  /** What is being optimized — appears in the reflection prompt for orientation. */
  target: string
  /** Surface-specific mutation levers offered to the model. */
  mutationPrimitives?: string[]
  /** Top/bottom scenarios surfaced as evidence each generation. Default 3. */
  evidenceK?: number
  /** Reflection sampling temperature. Default 0.7. */
  temperature?: number
  /** Reflection max tokens. Default 6000. */
  maxTokens?: number
  /** Structured-doc constraints. Candidates violating any are rejected
   *  post-parse and dropped from the returned population. */
  constraints?: GepaDriverConstraints
}

export function gepaDriver(opts: GepaDriverOptions): ImprovementDriver {
  const evidenceK = opts.evidenceK ?? 3
  return {
    kind: 'gepa',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const parent =
        typeof ctx.currentSurface === 'string'
          ? ctx.currentSurface
          : JSON.stringify(ctx.currentSurface)
      const { top, bottom, target } = buildEvidence(ctx, evidenceK, opts.target)

      const userPrompt = buildReflectionPrompt({
        target,
        parentPayload: parent,
        topTrials: top,
        bottomTrials: bottom,
        childCount: ctx.populationSize,
        mutationPrimitives: opts.mutationPrimitives,
      })

      const result = await callLlm(
        {
          model: opts.model,
          messages: [
            { role: 'system', content: REFLECTION_SYSTEM },
            { role: 'user', content: userPrompt },
          ],
          jsonMode: true,
          temperature: opts.temperature ?? 0.7,
          maxTokens: opts.maxTokens ?? 6000,
        },
        opts.llm,
      )

      const proposals = parseReflectionResponse(result.content, ctx.populationSize)
      const out: ProposedCandidate[] = []
      const seen = new Set<string>()
      const constraints = opts.constraints
      const preserveSections =
        constraints?.preserveSections !== undefined
          ? constraints.preserveSections.length === 0
            ? extractH2Sections(parent)
            : constraints.preserveSections
          : null
      const maxEdits = constraints?.maxSentenceEdits
      for (const proposal of proposals) {
        const text = typeof proposal.payload === 'string' ? proposal.payload.trim() : ''
        if (!text || text === parent || seen.has(text)) continue
        if (preserveSections && !validatePreservedSections(text, preserveSections)) continue
        if (maxEdits !== undefined && countSentenceEdits(parent, text) > maxEdits * 2) continue
        seen.add(text)
        // Thread label + rationale through so the candidate stays attributable:
        // the loop records WHY this rewrite was proposed, not just the payload.
        out.push({ surface: text, label: proposal.label, rationale: proposal.rationale })
      }
      return out
    },
  }
}

/** Extract H2 headings (`## Foo`) from a markdown surface. Exported for
 *  consumers building custom mutators that share the same invariant. */
export function extractH2Sections(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) out.push(match[1]!)
  }
  return out
}

/** Sentence-level edit distance — count distinct add/remove ops between
 *  two surfaces via a normalised line-by-line set diff. Treats trivial
 *  whitespace as identical. Exported for tests + consumer-side validators. */
export function countSentenceEdits(baseline: string, candidate: string): number {
  const norm = (s: string) =>
    s
      .split(/(?<=[.!?])\s+|\n/g)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  const a = new Set(norm(baseline))
  const b = new Set(norm(candidate))
  let edits = 0
  for (const s of a) if (!b.has(s)) edits++
  for (const s of b) if (!a.has(s)) edits++
  return edits
}

function validatePreservedSections(candidate: string, required: readonly string[]): boolean {
  if (required.length === 0) return true
  const have = new Set(extractH2Sections(candidate))
  for (const section of required) {
    if (!have.has(section)) return false
  }
  return true
}

/** Turn the prior generation's best candidate into reflective evidence:
 *  top/bottom scenarios by composite + a weakest-dimensions note on the target.
 *  Empty on generation 0 — the model reflects on the surface alone. */
function buildEvidence(
  ctx: ProposeContext,
  evidenceK: number,
  baseTarget: string,
): { top: TrialTrace[]; bottom: TrialTrace[]; target: string } {
  const last = ctx.history.at(-1)
  if (!last || last.candidates.length === 0) {
    return { top: [], bottom: [], target: baseTarget }
  }
  const best = [...last.candidates].sort((a, b) => b.composite - a.composite)[0]
  if (!best) return { top: [], bottom: [], target: baseTarget }

  const byScore = [...best.scenarios].sort((a, b) => b.composite - a.composite)
  const toTrace = (s: { scenarioId: string; composite: number }): TrialTrace => ({
    id: s.scenarioId,
    score: s.composite,
  })
  const top = byScore.slice(0, evidenceK).map(toTrace)
  const bottom = byScore.slice(-evidenceK).reverse().map(toTrace)

  const weakest = Object.entries(best.dimensions)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([dim, value]) => `${dim} (${value.toFixed(2)})`)
  const target =
    weakest.length > 0 ? `${baseTarget} — weakest dimensions: ${weakest.join(', ')}` : baseTarget

  return { top, bottom, target }
}
