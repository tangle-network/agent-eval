/**
 * Analyst-kind factory — the typed way to define trace analysts.
 *
 * A "kind" is a specialized analyst whose actor prompt, tool subset,
 * and Ax recursion config target one failure-mode lens (failure-mode
 * classification, knowledge gap discovery, knowledge poisoning, recursive
 * self-improvement, ...). Kinds emit findings in the typed `RawAnalystFinding`
 * shape via a JSON-array Ax output; the factory validates each row with
 * Zod and lifts it into `AnalystFinding[]` with no shape guessing.
 *
 * Composition rules:
 *   - Each kind owns its actor description. No generic "answer this
 *     question" prompt — the prompt names the failure lens.
 *   - Each kind picks a narrow tool subset from `ANALYST_TOOL_GROUPS`.
 *     A kind that never needs full-trace dumps can drop `viewTrace` /
 *     `viewSpans` and stay cheap.
 *   - Each kind declares its recursion + parallelism budget. Discovery-
 *     heavy kinds (failure-mode) get higher `maxDepth`; lens kinds
 *     (poisoning) usually stay at 0 since they have a tighter brief.
 *
 * Optimizer hook: kinds may declare `goldens` — labeled examples used
 * by `AxMiPRO` / `AxBootstrapFewShot` / `AxGEPA` to fit the actor
 * description programmatically. Stored on the kind, not the registry,
 * because the right metric is kind-specific.
 */

import type { AxAIService, AxFunction } from '@ax-llm/ax'
import { AxJSRuntime, agent } from '@ax-llm/ax'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { TraceFileMissingError } from '../trace-analyst/store-otlp'
import {
  parseRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  type RawAnalystFinding,
} from './finding-signature'
import { KIND_EXPECTED_SUBJECTS, parseFindingSubject } from './finding-subject'
import { structureFindings } from './structure-findings'
import type {
  Analyst,
  AnalystContext,
  AnalystCost,
  AnalystFinding,
  AnalystUsageReceipt,
} from './types'
import { makeFinding } from './types'

/**
 * Per-kind specification. The factory turns this into a regular
 * `Analyst<TraceAnalysisStore>` ready for `AnalystRegistry.register()`.
 */
export interface TraceAnalystKindSpec {
  /** Stable id. Appears in finding_id, telemetry, and registry exclusions. */
  id: string
  /** One-sentence description shown in `registry.list()`. */
  description: string
  /** Coarse classification stamped on every emitted finding (`failure-mode`, `knowledge-gap`, ...). */
  area: string
  /** Bump on any breaking change to the actor prompt or output schema. */
  version: string
  /** Actor system prompt. Must instruct the LLM to emit `findings` per the schema. */
  actorDescription: string
  /** Responder system prompt; falls back to a minimal "format the findings" instruction. */
  responderDescription?: string
  /** Tool functions the actor may call. Pick narrow subsets via `ANALYST_TOOL_GROUPS`. */
  buildTools: (store: TraceAnalysisStore) => AxFunction[]
  /** Recursion budget. `maxDepth: 0` disables subagents. */
  recursion?: { maxDepth: number; maxParallelSubagents?: number }
  /** Actor turn cap. Default 12. */
  maxTurns?: number
  /** Runtime char cap. Default 6000. */
  maxRuntimeChars?: number
  /** Cost classification surfaced in `registry.list()` and budget enforcement. */
  cost: AnalystCost
  /** Per-finding-row hook — kinds may reject / rewrite before lifting. */
  postProcess?: (row: RawAnalystFinding, ctx: AnalystContext) => RawAnalystFinding | null
  /** Optional optimizer hook — populated when a kind wants to fit its prompt against labeled examples. */
  goldens?: TraceAnalystGolden[]
}

/**
 * One labeled example consumed by Ax optimizers (MIPRO / GEPA / Bootstrap).
 * Each input is the same `{question}` an analyst would receive; `expected`
 * is the ground-truth finding set a fitted prompt should produce on this
 * input. Metric: kind-specific (default: F1 on `finding_id` overlap).
 */
export interface TraceAnalystGolden {
  question: string
  expected: ReadonlyArray<Omit<RawAnalystFinding, 'confidence'>>
}

export interface CreateTraceAnalystKindOpts {
  /** AxAIService bound at registration time. */
  ai: AxAIService
  /** Optional model override; falls back to the AI service's default. */
  model?: string
  /** Override the spec's `version` (e.g. when an optimizer has fitted a new prompt). */
  versionSuffix?: string
  /**
   * Optional two-phase recovery: when the agentic harvest is empty but the
   * actor produced a substantive free-form `report`, extract findings from that
   * prose via a tolerant chat-completions pass (`structureFindings`) — no
   * strict-emission contract, so it works on weak models. Omit to leave the
   * actor's harvest as-is (the report is still surfaced fail-loud either way).
   */
  recovery?: { baseUrl: string; apiKey?: string; model?: string; fetchImpl?: typeof fetch }
}

/**
 * Build an `Analyst<TraceAnalysisStore>` from a kind spec.
 *
 * Lifts the Ax pipeline once at registration time so the registry
 * gets a stateless analyst. The Ax agent is freshly constructed per
 * `analyze()` call (the agent carries chat-log + usage state we don't
 * want shared across analyst runs).
 */
export function createTraceAnalystKind(
  spec: TraceAnalystKindSpec,
  opts: CreateTraceAnalystKindOpts,
): Analyst<TraceAnalysisStore> {
  const version = opts.versionSuffix ? `${spec.version}+${opts.versionSuffix}` : spec.version
  return {
    id: spec.id,
    description: spec.description,
    inputKind: 'trace-store',
    cost: spec.cost,
    version,
    async analyze(store, ctx) {
      const tools = spec.buildTools(store)
      const maxDepth = spec.recursion?.maxDepth ?? 0
      const maxParallel = spec.recursion?.maxParallelSubagents ?? 2
      const priorContext = renderPriorFindings(ctx.priorFindings)
      const upstreamContext = renderUpstreamFindings(ctx.upstreamFindings)
      const functions = tools as unknown as NonNullable<Parameters<typeof agent>[1]>['functions']

      const actorDescription =
        spec.actorDescription.trim() +
        priorContext +
        upstreamContext +
        '\n\n' +
        RAW_FINDING_SCHEMA_PROMPT +
        '\n\nFirst write `report`: a concise free-form prose diagnosis of what ' +
        'the traces show — what succeeded, what was suboptimal or failed — with ' +
        'concrete trace ids and numbers. THEN return the structured `findings` ' +
        'array (it MAY be empty when there is nothing to report). Use `final(...)` ' +
        'with the `{ report, findings }` payload when you are done.'

      const ax = agent<{ question: string }, { report: string; findings: unknown[] }>(
        'question:string -> report:string, findings:json[]',
        {
          agentIdentity: {
            name: spec.id,
            description: spec.description,
          },
          contextFields: ['question'],
          runtime: new AxJSRuntime({
            permissions: [],
            blockDynamicImport: true,
            allowedModules: [],
            freezeIntrinsics: true,
            blockShadowRealm: true,
            preventGlobalThisExtensions: false,
          }),
          mode: maxDepth > 0 ? 'advanced' : 'simple',
          recursionOptions: maxDepth > 0 ? { maxDepth } : undefined,
          maxTurns: spec.maxTurns ?? 12,
          maxRuntimeChars: spec.maxRuntimeChars ?? 6000,
          maxBatchedLlmQueryConcurrency: maxParallel,
          promptLevel: 'detailed',
          // Trace analysis depends on exact prior tool results and runtime variables.
          contextPolicy: { preset: 'full', budget: 'balanced' },
          functions,
          actorOptions: {
            description: actorDescription,
            ...(opts.model ? { model: opts.model } : {}),
            showThoughts: false,
            thinkingTokenBudget: 'none',
          },
          responderOptions: {
            description:
              spec.responderDescription ??
              "Pass through the actor's `report` prose verbatim, and format the `findings` array exactly as the actor produced it. Do not add, drop, or summarize entries.",
            ...(opts.model ? { model: opts.model } : {}),
            showThoughts: false,
          },
          bubbleErrors: [TraceFileMissingError],
        },
      )

      ctx.log?.(`analyst.kind ${spec.id} forward`, {
        max_depth: maxDepth,
        tool_count: tools.length,
        tags: ctx.tags,
      })

      let result: { report: string; findings: unknown[] }
      try {
        result = await ax.forward(opts.ai, { question: deriveQuestion(ctx, spec) })
      } finally {
        ctx.recordUsage?.(usageReceiptFromAx(ax.getUsage()))
      }

      const expectedSubjects = KIND_EXPECTED_SUBJECTS[spec.id]
      const out: AnalystFinding[] = []
      const rawRows = Array.isArray(result.findings) ? result.findings : []
      let rejectedWrongKind = 0
      for (const row of rawRows) {
        const parsed = parseRawFinding(row, ctx.log)
        if (!parsed) continue
        // Subject-grammar check: if the kind has a declared expects-set
        // (every shipped kind does), the finding's subject MUST parse to
        // one of the declared variants. A wrong-kind subject is a
        // contract violation — the actor's prompt drifted from the
        // grammar — and we count it for prompt-audit visibility.
        if (expectedSubjects && parsed.subject !== undefined) {
          const parsedSubject = parseFindingSubject(parsed.subject)
          if (parsedSubject === null) {
            ctx.log?.('finding rejected: subject failed to parse', {
              kind: spec.id,
              subject: parsed.subject,
            })
            rejectedWrongKind += 1
            continue
          }
          if (!expectedSubjects.includes(parsedSubject.kind)) {
            ctx.log?.('finding rejected: subject variant not allowed for this kind', {
              kind: spec.id,
              subject_kind: parsedSubject.kind,
              subject: parsed.subject,
              allowed: expectedSubjects,
            })
            rejectedWrongKind += 1
            continue
          }
        }
        const postProcessed = spec.postProcess?.(parsed, ctx) ?? parsed
        if (!postProcessed) continue
        out.push(toAnalystFinding(spec, postProcessed))
      }

      ctx.log?.(`analyst.kind ${spec.id} done`, {
        emitted: rawRows.length,
        accepted: out.length,
        rejected_wrong_subject: rejectedWrongKind,
      })

      // Two-phase recovery / fail-loud. The actor reasons free-form (the
      // `report`); a weak model often produces a sound diagnosis but fails the
      // strict findings emission (or the rows get rejected). If the harvest is
      // empty but the report is substantive, recover findings from the prose
      // via the tolerant structuring pass (opt-in), and — either way — surface
      // the report as a visible info finding so an empty harvest is never a
      // silent zero. A genuinely empty diagnosis (short/no report) stays empty.
      const report = typeof result.report === 'string' ? result.report : ''
      if (out.length === 0 && report.trim().length >= 200) {
        if (opts.recovery) {
          const recovered = await structureFindings({
            report,
            analystId: spec.id,
            area: spec.area,
            model: opts.recovery.model ?? opts.model ?? '',
            baseUrl: opts.recovery.baseUrl,
            apiKey: opts.recovery.apiKey,
            fetchImpl: opts.recovery.fetchImpl,
          })
          out.push(...recovered.findings)
          ctx.log?.(`analyst.kind ${spec.id} recovery`, {
            outcome: recovered.outcome,
            recovered: recovered.findings.length,
          })
        }
        if (out.length === 0) {
          out.push(
            makeFinding({
              analyst_id: spec.id,
              area: spec.area,
              claim: 'Analyst produced a diagnosis but no structured findings — see report.',
              rationale: report.slice(0, 1500),
              severity: 'info',
              confidence: 0.3,
              evidence_refs: [
                { kind: 'artifact', uri: 'report://summary', excerpt: report.slice(0, 2000) },
              ],
              metadata: { outcome: 'extraction_failed' },
            }),
          )
        }
      }
      return out
    },
  }
}

function deriveQuestion(ctx: AnalystContext, spec: TraceAnalystKindSpec): string {
  // The actor's user message must orient it at the task, not echo the kind id.
  // A bare id like "failure-mode" gives the actor nothing to act on, so it
  // spends turns inspecting the input instead of reading traces. Operators can
  // still steer with `tags.focus = "leaf-X"`, appended to the task directive.
  const focus = ctx.tags?.focus?.trim()
  const task = `Analyze this trace dataset with the available tools and report ${spec.area} findings. ${spec.description}`
  return focus ? `${task} Focus: ${focus}.` : task
}

function toAnalystFinding(spec: TraceAnalystKindSpec, raw: RawAnalystFinding): AnalystFinding {
  return makeFinding({
    analyst_id: spec.id,
    area: spec.area,
    subject: raw.subject,
    claim: raw.claim,
    rationale: raw.rationale,
    severity: raw.severity,
    confidence: raw.confidence,
    evidence_refs: [
      {
        kind: evidenceKindFromUri(raw.evidence_uri),
        uri: raw.evidence_uri,
        excerpt: raw.evidence_excerpt,
      },
    ],
    recommended_action: raw.recommended_action,
    metadata: { kind_version: spec.version },
  })
}

function evidenceKindFromUri(uri: string): 'span' | 'artifact' | 'metric' | 'event' | 'finding' {
  if (uri.startsWith('span://')) return 'span'
  if (uri.startsWith('artifact://')) return 'artifact'
  if (uri.startsWith('metric://')) return 'metric'
  if (uri.startsWith('event://')) return 'event'
  if (uri.startsWith('finding://')) return 'finding'
  return 'artifact'
}

/**
 * Render a compact prior-findings block the actor reads alongside its
 * brief. Each row is one line so the actor can scan dozens cheaply.
 * The kind's prompt instructs the actor to (a) check whether a new
 * cluster matches a prior `finding_id` (carry the id forward via
 * `id_basis` to keep diffs stable) and (b) raise severity / confidence
 * when a prior finding has reappeared without remediation.
 *
 * Returns the empty string when there are no prior findings — most
 * runs are "first-of-its-kind" and the prompt stays unchanged.
 *
 * Exported for tests + for consumers that build their own actor
 * prompts (e.g. specialized analysts living outside the default kinds).
 */
export function renderPriorFindings(prior: AnalystContext['priorFindings']): string {
  if (!prior || prior.length === 0) return ''
  const MAX_ROWS = 40 // keep the block under ~2KB; older history is summarized externally
  const rows = prior.slice(0, MAX_ROWS).map((f) => {
    const subject = f.subject ? ` [${f.subject}]` : ''
    return `  - id=${f.finding_id} ${f.severity}${subject} ${truncateForContext(f.claim, 160)}`
  })
  const overflow =
    prior.length > MAX_ROWS
      ? `\n  ... +${prior.length - MAX_ROWS} more prior findings (older history truncated)`
      : ''
  return [
    '',
    '',
    'PRIOR FINDINGS (from a previous run on related data):',
    'When the work you do now matches a row below, REUSE the `finding_id` (pass it as `id_basis`) so the cross-run diff stays stable.',
    'A finding that reappears with no remediation evidence SHOULD raise its `confidence` and may justify a higher `severity`.',
    ...rows,
    overflow,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Render findings produced earlier in this same registry run. */
export function renderUpstreamFindings(upstream: AnalystContext['upstreamFindings']): string {
  if (!upstream || upstream.length === 0) return ''
  const MAX_ROWS = 40
  const rows = upstream.slice(0, MAX_ROWS).map((finding) => {
    const subject = finding.subject ? ` [${finding.subject}]` : ''
    const action = finding.recommended_action
      ? ` action=${truncateForContext(finding.recommended_action, 120)}`
      : ''
    const evidence = finding.evidence_refs[0]
      ? ` evidence=${truncateForContext(finding.evidence_refs[0].uri, 120)}`
      : ''
    return `  - id=${finding.finding_id} source=${finding.analyst_id} ${finding.severity}${subject} claim=${truncateForContext(finding.claim, 160)}${action}${evidence}`
  })
  const overflow =
    upstream.length > MAX_ROWS
      ? `\n  ... +${upstream.length - MAX_ROWS} more upstream findings (truncated)`
      : ''
  return [
    '',
    '',
    'UPSTREAM FINDINGS (produced earlier in this same registry run):',
    'Use these as intermediate evidence. Build on them instead of repeating the same diagnosis, and cite a dependency with `finding://<id>`.',
    ...rows,
    overflow,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Convert Ax's public usage records into the registry's provider-neutral receipt. */
function usageReceiptFromAx(value: unknown): AnalystUsageReceipt {
  const usage = asRecord(value)
  const entries = [...asRecordArray(usage.actor), ...asRecordArray(usage.responder)]
  let input = 0
  let output = 0
  let cached = 0
  let sawCached = false
  let tokensCaptured = entries.length > 0

  for (const entry of entries) {
    const tokens = asRecord(entry.tokens)
    const promptTokens = finiteNonNegative(tokens.promptTokens)
    const completionTokens = finiteNonNegative(tokens.completionTokens)
    if (promptTokens === null || completionTokens === null) {
      tokensCaptured = false
      continue
    }
    input += promptTokens
    output += completionTokens
    const cacheReadTokens = finiteNonNegative(tokens.cacheReadTokens)
    if (cacheReadTokens !== null) {
      cached += cacheReadTokens
      sawCached = true
    }
  }

  return {
    calls: entries.length,
    tokens: tokensCaptured ? { input, output, ...(sawCached ? { cached } : {}) } : null,
    // AxProgramUsage exposes model + token usage, but no billed or estimated
    // dollars. Keep that absence explicit instead of manufacturing $0.
    cost: { kind: 'uncaptured', usd: null },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  )
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function truncateForContext(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}
