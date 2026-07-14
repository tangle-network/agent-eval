/**
 * Analyst-kind factory — the typed way to define trace analysts.
 *
 * A "kind" is a specialized analyst whose actor prompt, tool subset,
 * and bounded Ax subqueries target one failure-mode lens (failure-mode
 * classification, knowledge gap discovery, knowledge poisoning,
 * self-improvement, ...). Kinds emit findings in the typed
 * `CanonicalRawAnalystFinding` shape via a JSON-array Ax output; the factory
 * validates each row with Zod and lifts it into `AnalystFinding[]`.
 *
 * Composition rules:
 *   - Each kind owns its actor description. No generic "answer this
 *     question" prompt — the prompt names the failure lens.
 *   - Each kind picks a narrow tool subset from `ANALYST_TOOL_GROUPS`.
 *     A kind that never needs full-trace dumps can drop `viewTrace` /
 *     `viewSpans` and stay cheap.
 *   - Each kind declares its subquery + parallelism budget. Discovery-heavy
 *     kinds can fan out more bounded semantic questions than narrow lenses.
 *
 * Optimizer hook: kinds may declare `goldens` — labeled examples used
 * by `AxBootstrapFewShot` / `AxGEPA` to fit the actor
 * description programmatically. Stored on the kind, not the registry,
 * because the right metric is kind-specific.
 */

import type { AxAIService, AxFunction } from '@ax-llm/ax'
import { CostLedger } from '../cost-ledger'
import { runTraceAnalysisLoop } from '../trace-analyst/loop'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { meterAxChatService } from './ax-cost-service'
import { resolveAnalystModel } from './ax-service'
import {
  applyLegacyRawFindingCallback,
  type CanonicalRawAnalystFinding,
  evidenceRefsFromRawFinding,
  parseCanonicalRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  type RawAnalystFinding,
} from './finding-signature'
import { KIND_EXPECTED_SUBJECTS, parseFindingSubject } from './finding-subject'
import { structureFindings } from './structure-findings'
import type { Analyst, AnalystContext, AnalystCost, AnalystFinding } from './types'
import { makeFinding } from './types'
import { settleUsageReceiptFromCostLedger, validateUsageSettlementTimeout } from './usage-receipt'

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
  /** Tool functions the actor may call. Pick narrow subsets via `ANALYST_TOOL_GROUPS`. */
  buildTools: (store: TraceAnalysisStore) => AxFunction[]
  /** Bounded semantic subqueries. `maxCalls: 0` disables model fan-out. */
  subqueries?: { maxCalls: number; maxParallel?: number }
  /** Actor turn cap. Default 12. */
  maxTurns?: number
  /** Runtime char cap. Default 6000. */
  maxRuntimeChars?: number
  /** Maximum output tokens for every actor and subquery model call. Default 4096. */
  maxOutputTokens?: number
  /** Cost classification surfaced in `registry.list()` and budget enforcement. */
  cost: AnalystCost
  /** Per-finding-row hook — kinds may reject / rewrite before lifting. */
  postProcess?: (row: RawAnalystFinding, ctx: AnalystContext) => RawAnalystFinding | null
  /** Minimum citations per finding. Default 1; rows below it are rejected. */
  minimumEvidenceCitations?: number
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
  expected: ReadonlyArray<Omit<CanonicalRawAnalystFinding, 'confidence'>>
}

export interface CreateTraceAnalystKindOpts {
  /** AxAIService bound at registration time. */
  ai: AxAIService
  /** Required unless `ai` was created by {@link createAnalystAi}. */
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
  /** Maximum post-cancellation wait for a provider receipt. Default 5 seconds. */
  settlementTimeoutMs?: number
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
  rejectRemovedKindOptions(spec)
  const version = opts.versionSuffix ? `${spec.version}+${opts.versionSuffix}` : spec.version
  const model = resolveAnalystModel(opts.ai, opts.model)
  const minimumEvidenceCitations = spec.minimumEvidenceCitations ?? 1
  if (!Number.isInteger(minimumEvidenceCitations) || minimumEvidenceCitations < 1) {
    throw new TypeError('minimumEvidenceCitations must be a positive integer')
  }
  const settlementTimeoutMs = validateUsageSettlementTimeout(opts.settlementTimeoutMs)
  return {
    id: spec.id,
    description: spec.description,
    inputKind: 'trace-store',
    cost: spec.cost,
    version,
    async analyze(store, ctx) {
      const maxOutputTokens = spec.maxOutputTokens ?? 4096
      const costLedger = ctx.costLedger ?? new CostLedger(ctx.budgetUsd)
      const costTags = {
        ...(ctx.tags ?? {}),
        analystId: spec.id,
        ...(ctx.correlationId ? { analystRunId: ctx.correlationId } : {}),
      }
      const meteredAi = meterAxChatService(opts.ai, {
        ledger: costLedger,
        actor: spec.id,
        maxOutputTokens,
        defaultModel: model,
        phase: ctx.costPhase,
        signal: ctx.signal,
        tags: costTags,
      })
      try {
        const tools = spec.buildTools(store)
        const maxSubqueries = spec.subqueries?.maxCalls ?? 0
        const maxParallel = spec.subqueries?.maxParallel ?? 2
        const priorContext = renderPriorFindings(ctx.priorFindings)
        const upstreamContext = renderUpstreamFindings(ctx.upstreamFindings)
        const actorDescription =
          spec.actorDescription.trim() +
          priorContext +
          upstreamContext +
          '\n\n' +
          RAW_FINDING_SCHEMA_PROMPT +
          (minimumEvidenceCitations > 1
            ? `\n\nThis kind requires at least ${minimumEvidenceCitations} evidence citations per finding; rows with fewer are rejected.`
            : '') +
          '\n\nFirst write `report`: a concise free-form prose diagnosis of what ' +
          'the traces show — what succeeded, what was suboptimal or failed — with ' +
          'concrete trace ids and numbers. THEN return the structured `findings` ' +
          'array (it MAY be empty when there is nothing to report).'

        ctx.log?.(`analyst.kind ${spec.id} forward`, {
          max_subqueries: maxSubqueries,
          tool_count: tools.length,
          tags: ctx.tags,
        })

        const completed = await runTraceAnalysisLoop({
          id: spec.id,
          description: spec.description,
          prompt: actorDescription,
          question: deriveQuestion(ctx, spec),
          ai: meteredAi,
          model,
          tools,
          findingType: 'object',
          maxSubqueries,
          maxParallelSubqueries: maxParallel,
          maxTurns: spec.maxTurns ?? 12,
          maxRuntimeChars: spec.maxRuntimeChars ?? 6000,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        const { report, findings: submittedFindings } = completed

        const expectedSubjects = KIND_EXPECTED_SUBJECTS[spec.id]
        const out: AnalystFinding[] = []
        const rawRows = submittedFindings
        let rejectedWrongKind = 0
        let rejectedInsufficientEvidence = 0
        const processRow = (
          parsed: CanonicalRawAnalystFinding,
        ): CanonicalRawAnalystFinding | null => {
          const postProcessed = spec.postProcess
            ? applyLegacyRawFindingCallback(
                parsed,
                (row) => spec.postProcess?.(row, ctx) ?? null,
                ctx.log,
              )
            : parsed
          if (!postProcessed) return null
          if (expectedSubjects && postProcessed.subject !== undefined) {
            const parsedSubject = parseFindingSubject(postProcessed.subject)
            if (parsedSubject === null) {
              ctx.log?.('finding rejected: subject failed to parse', {
                kind: spec.id,
                subject: postProcessed.subject,
              })
              rejectedWrongKind += 1
              return null
            }
            if (!expectedSubjects.includes(parsedSubject.kind)) {
              ctx.log?.('finding rejected: subject variant not allowed for this kind', {
                kind: spec.id,
                subject_kind: parsedSubject.kind,
                subject: postProcessed.subject,
                allowed: expectedSubjects,
              })
              rejectedWrongKind += 1
              return null
            }
          }
          const distinctEvidenceCitations = new Set(
            postProcessed.evidence.map((citation) => citation.uri.trim()),
          ).size
          if (distinctEvidenceCitations < minimumEvidenceCitations) {
            ctx.log?.('finding rejected: insufficient evidence citations', {
              kind: spec.id,
              required: minimumEvidenceCitations,
              received: postProcessed.evidence.length,
              distinct: distinctEvidenceCitations,
            })
            rejectedInsufficientEvidence += 1
            return null
          }
          return postProcessed
        }
        for (const row of rawRows) {
          const parsed = parseCanonicalRawFinding(row, ctx.log)
          if (!parsed) continue
          const postProcessed = processRow(parsed)
          if (!postProcessed) continue
          out.push(toAnalystFinding(spec, version, postProcessed))
        }

        ctx.log?.(`analyst.kind ${spec.id} done`, {
          emitted: rawRows.length,
          accepted: out.length,
          rejected_wrong_subject: rejectedWrongKind,
          rejected_insufficient_evidence: rejectedInsufficientEvidence,
        })

        // Two-phase recovery / fail-loud. The actor reasons free-form (the
        // `report`); a weak model often produces a sound diagnosis but fails the
        // strict findings emission (or the rows get rejected). If the harvest is
        // empty but the report is substantive, recover findings from the prose
        // via the tolerant structuring pass (opt-in), and — either way — surface
        // the report as a visible info finding so an empty harvest is never a
        // silent zero. A genuinely empty diagnosis (short/no report) stays empty.
        if (out.length === 0 && report.trim().length >= 200) {
          if (opts.recovery) {
            const wrongKindBefore = rejectedWrongKind
            const insufficientEvidenceBefore = rejectedInsufficientEvidence
            const recovered = await structureFindings({
              report,
              analystId: spec.id,
              area: spec.area,
              model: opts.recovery.model ?? model,
              baseUrl: opts.recovery.baseUrl,
              apiKey: opts.recovery.apiKey,
              fetchImpl: opts.recovery.fetchImpl,
              costLedger,
              costPhase: ctx.costPhase,
              costTags,
              signal: ctx.signal,
              maxTokens: Math.min(maxOutputTokens, 2_000),
              processCanonicalRow: processRow,
              findingMetadata: { kind_version: version },
            })
            out.push(...recovered.findings)
            ctx.log?.(`analyst.kind ${spec.id} recovery`, {
              outcome: recovered.outcome,
              recovered: recovered.findings.length,
              rejected_wrong_subject: rejectedWrongKind - wrongKindBefore,
              rejected_insufficient_evidence:
                rejectedInsufficientEvidence - insufficientEvidenceBefore,
            })
          }
          if (out.length === 0) {
            const fallback = processRow({
              claim: 'Analyst produced a diagnosis but no structured findings — see report.',
              rationale: report.slice(0, 1500),
              severity: 'info',
              confidence: 0.3,
              evidence: [{ uri: 'report://summary', excerpt: report.slice(0, 2000) }],
            })
            if (fallback) {
              out.push(toAnalystFinding(spec, version, fallback, { outcome: 'extraction_failed' }))
            } else {
              throw new Error(
                `Trace analyst '${spec.id}' produced a substantive report, but no finding satisfied its acceptance rules`,
              )
            }
          }
        }
        return out
      } finally {
        const usage = await settleUsageReceiptFromCostLedger(costLedger, {
          tags: {
            analystId: spec.id,
            ...(ctx.correlationId ? { analystRunId: ctx.correlationId } : {}),
          },
          timeoutMs: settlementTimeoutMs,
        })
        if (!usage.settled) {
          ctx.log?.(`analyst.kind ${spec.id} provider settlement timed out`, {
            pending_calls: usage.pendingCalls,
            timeout_ms: settlementTimeoutMs,
          })
        }
        ctx.recordUsage?.(usage.receipt)
      }
    },
  }
}

function rejectRemovedKindOptions(spec: TraceAnalystKindSpec): void {
  const supplied = spec as unknown as Record<string, unknown>
  const migrations = [
    ['recursion', 'subqueries'],
    ['responderDescription', 'actorDescription'],
    ['maxDepth', 'subqueries'],
    ['maxParallelSubagents', 'subqueries.maxParallel'],
    ['subagentDescription', 'actorDescription'],
  ] as const
  for (const [removed, replacement] of migrations) {
    if (removed in supplied) {
      throw new TypeError(
        `createTraceAnalystKind: '${removed}' is unsupported; use '${replacement}'`,
      )
    }
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

function toAnalystFinding(
  spec: TraceAnalystKindSpec,
  version: string,
  raw: CanonicalRawAnalystFinding,
  metadata: Record<string, unknown> = {},
): AnalystFinding {
  return makeFinding({
    analyst_id: spec.id,
    area: spec.area,
    subject: raw.subject,
    claim: raw.claim,
    rationale: raw.rationale,
    severity: raw.severity,
    confidence: raw.confidence,
    evidence_refs: evidenceRefsFromRawFinding(raw),
    recommended_action: raw.recommended_action,
    metadata: { kind_version: version, ...metadata },
  })
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

function truncateForContext(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}
