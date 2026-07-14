/**
 * Analyst contract — the missing orchestration layer over agent-eval's
 * existing analyzers (analyzeTraces, MultiLayerVerifier, RunCritic,
 * SemanticConceptJudge, JudgeFn, ...).
 *
 * Each existing primitive returns its own output shape. The Analyst
 * contract is the single envelope every primitive lifts into, so a
 * registry can run N analysts against a run and a single renderer can
 * compose findings without knowing which analyzer produced them.
 *
 * The contract is intentionally domain-agnostic: nothing here knows
 * about code, voice, RAG, or any particular agent stack. Analysts
 * declare what INPUT KIND they need (a trace store, an artifact dir,
 * a RunRecord, a JudgeInput, or `custom`), and the registry routes
 * the matching input from `AnalystRunInputs`.
 */

import { createHash } from 'node:crypto'
import type { CostLedgerHandle } from '../cost-ledger'
import type { RunCostProvenance, RunRecord, RunTokenUsage } from '../run-record'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { JudgeInput } from '../types'
import type { ChatClient } from './chat-client'

/**
 * Unified envelope every analyst emits. Schema-versioned so renderers
 * and time-series diffs survive future field additions.
 */
export interface AnalystFinding {
  schema_version: '1.0.0'
  /**
   * Stable hash over identity-defining fields (analyst_id + canonical
   * claim + area + optional subject). Two findings from two runs that
   * "are the same finding" share this id — that's what `diffFindings`
   * uses to compute appeared/disappeared sets across runs.
   */
  finding_id: string
  analyst_id: string
  produced_at: string
  severity: AnalystSeverity
  /**
   * Coarse classification. Renderers group by this. Free-form so
   * domain-specific analysts can introduce categories without a
   * schema change ('agent-reasoning', 'verification', 'cost',
   * 'tool-use', 'safety', 'latency', 'data-quality', ...).
   */
  area: string
  claim: string
  rationale?: string
  evidence_refs: EvidenceRef[]
  recommended_action?: string
  validation_plan?: string
  /** 0..1 — the analyst's own confidence. Not calibrated across analysts. */
  confidence: number
  /**
   * Optional subject the finding is about — leaf id, agent id, request
   * id. Included in finding_id when present so per-subject findings
   * diff cleanly across runs.
   */
  subject?: string
  /** FIREWALL provenance (docs/learning-flywheel.md): true iff this finding was
   *  lifted from a JUDGE verdict (an acceptance score), not OBSERVED from the
   *  agent's behavior. A judge-derived finding must NEVER be admitted as a
   *  steering input — that is the held-out judge leaking into the loop. Set at
   *  the lift site (createJudgeAdapter); checked by `assertNoJudgeVerdict`.
   *  Provenance, not evidence presence, is the correct discriminator: an
   *  evidence-less trace-analyst observation legitimately steers, while a judge
   *  verdict that happens to cite an artifact must not. */
  derived_from_judge?: boolean
  /** Analyst-private extras; renderers ignore unless they know the analyst. */
  metadata?: Record<string, unknown>
}

export type AnalystSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface EvidenceRef {
  /**
   * Where the evidence lives. `span` and `event` refer to OTLP trace
   * elements; `artifact` to a file inside the run's artifact tree;
   * `finding` to another AnalystFinding (cross-analyst chaining);
   * `metric` to a named scalar reading the renderer knows how to read.
   */
  kind: 'span' | 'event' | 'artifact' | 'finding' | 'metric'
  uri: string
  excerpt?: string
}

// ── Analyst contract ─────────────────────────────────────────────────

/**
 * The discriminator the registry uses to pass the right input.
 * `custom` is the escape hatch — analysts that need something else
 * (e.g. an embedding cache, a partner SDK handle) read it from
 * `AnalystRunInputs.custom[<analyst id>]`.
 */
export type AnalystInputKind =
  | 'trace-store'
  | 'artifact-dir'
  | 'run-record'
  | 'judge-input'
  | 'custom'

export interface AnalystCost {
  /** `deterministic` analysts MUST NOT call the LLM. */
  kind: 'deterministic' | 'llm'
  /** Optional declared upper bound; the registry can enforce a budget. */
  est_usd_per_run?: number
  /** Models the analyst expects to use (informational). */
  models?: string[]
}

export interface AnalystRequirements {
  /** Min number of shots / samples the analyst needs to produce signal. */
  min_shots?: number
  /** Capabilities the runtime must supply (e.g. ['network', 'gpu']). */
  capabilities?: string[]
}

/**
 * What's passed to every analyst call. The registry resolves which
 * field the analyst's `inputKind` selects and asserts it's present.
 */
export interface AnalystRunInputs {
  traceStore?: TraceAnalysisStore
  artifactDir?: string
  runRecord?: RunRecord
  judgeInput?: JudgeInput
  /** Keyed by analyst id; populated by callers that registered custom analysts. */
  custom?: Record<string, unknown>
}

export interface AnalystContext {
  runId: string
  /** Stable correlation id so logs from a single registry.run() share a tag. */
  correlationId: string
  /** Wall-clock deadline (epoch ms). Analysts SHOULD honor for graceful cancel. */
  deadlineMs?: number
  /** Per-analyst USD budget. Analysts MAY check before issuing LLM calls. */
  budgetUsd?: number
  /** Shared paid-call account when the analyst runs inside a larger campaign. */
  costLedger?: CostLedgerHandle
  /** Attribution phase used when writing to the shared paid-call account. */
  costPhase?: string
  /**
   * Shared chat client. Analysts that call an LLM go through this so
   * the operator picks transport (sandbox-sdk | router | cli-bridge |
   * direct-provider | mock) at the registry boundary without touching
   * analyst code.
   */
  chat?: ChatClient
  /**
   * Findings from a prior run the operator wants the analyst to see as
   * retrieval context. Kinds that take advantage of cross-run memory
   * (failure-mode "I saw this cluster last run", knowledge-gap "the wiki
   * page I asked for is still missing") render these into the actor's
   * working set. Filtering is the operator's job: pass the slice that
   * matches the analyst's id, or pass everything and let the kind
   * filter. Empty / absent means no cross-run context.
   */
  priorFindings?: ReadonlyArray<AnalystFinding>
  /**
   * Findings emitted by analysts that completed earlier in this registry run.
   * This is separate from `priorFindings`: upstream findings are dependency
   * context for the current pass, while prior findings are cross-run memory.
   * The registry populates this only when `RegistryRunOpts.chainFindings` is on.
   */
  upstreamFindings?: ReadonlyArray<AnalystFinding>
  /**
   * Report metered work independently of findings. This keeps an empty finding
   * set from erasing token/cost telemetry. Multiple receipts are accumulated.
   */
  recordUsage?: (receipt: AnalystUsageReceipt) => void
  /** Free-form runtime tags (env, host, op). Findings can echo these into metadata. */
  tags?: Record<string, string>
  /** Logger callback — analysts SHOULD prefer this over console.* for testability. */
  log?: (msg: string, fields?: Record<string, unknown>) => void
  /** Optional abort signal. Analysts SHOULD pass it through to LLM calls. */
  signal?: AbortSignal
}

/**
 * The minimal contract. Concrete analysts can refine `TInput` so
 * implementations stay type-safe (e.g. a trace analyst's `TInput` is
 * `TraceAnalysisStore`); the registry passes the right field from
 * `AnalystRunInputs` based on `inputKind`.
 */
export interface Analyst<TInput = unknown> {
  /** Stable identifier — appears in finding_id, telemetry, and registry exclusion lists. */
  readonly id: string
  /** Human-readable. One sentence. */
  readonly description: string
  readonly inputKind: AnalystInputKind
  readonly cost: AnalystCost
  readonly requires?: AnalystRequirements
  /** Bump on breaking changes to claim wording or area so old finding_ids don't collide. */
  readonly version: string
  analyze(input: TInput, ctx: AnalystContext): Promise<AnalystFinding[]>
}

/** Metered work performed by one analyst call. */
export interface AnalystUsageReceipt {
  /** Number of model-usage records observed at the provider boundary. */
  calls: number | null
  /** Null when the provider did not return token accounting. */
  tokens: RunTokenUsage | null
  /** Observed, estimated, or explicitly uncaptured dollar cost. */
  cost: RunCostProvenance
  /** Known lower bound when one or more calls have uncaptured cost. */
  knownCostUsd?: number
}

// ── finding_id stability ─────────────────────────────────────────────

/**
 * Compute the stable finding_id from the identity-defining fields.
 * Default implementation hashes {analyst_id, area, subject, normalized claim}.
 * Analysts that emit findings whose claim text varies per run (timestamps,
 * counts) SHOULD either: (a) pass an explicit `id_basis` to fix the hash,
 * or (b) move the variable part into `rationale`/`metadata` and keep the
 * `claim` static.
 */
export function computeFindingId(input: {
  analyst_id: string
  area: string
  subject?: string
  claim: string
  /** Override the claim for hashing — use when the displayed claim has run-specific bits. */
  id_basis?: string
}): string {
  const basis = JSON.stringify({
    a: input.analyst_id,
    r: input.area,
    s: input.subject ?? '',
    c: normalizeClaim(input.id_basis ?? input.claim),
  })
  return `f_${createHash('sha256').update(basis).digest('hex').slice(0, 20)}`
}

function normalizeClaim(c: string): string {
  // Lowercase, collapse whitespace, strip trailing punctuation. Goal:
  // "Leaf X failed install" and "Leaf X failed install." hash the same.
  return c
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:,]+$/g, '')
    .trim()
}

/**
 * Convenience factory: produce a fully-formed AnalystFinding with the
 * id computed automatically. Analyst code stays terse.
 */
export function makeFinding(
  init: Omit<AnalystFinding, 'schema_version' | 'finding_id' | 'produced_at'> & {
    id_basis?: string
    produced_at?: string
  },
): AnalystFinding {
  const { id_basis, produced_at, ...rest } = init
  return {
    schema_version: '1.0.0',
    finding_id: computeFindingId({
      analyst_id: rest.analyst_id,
      area: rest.area,
      subject: rest.subject,
      claim: rest.claim,
      id_basis,
    }),
    produced_at: produced_at ?? new Date().toISOString(),
    ...rest,
  }
}

// ── Registry result envelope ────────────────────────────────────────

export interface AnalystRunSummary {
  analyst_id: string
  status: 'ok' | 'skipped' | 'failed'
  /** Why skipped — missing input, budget exceeded, capability unmet. */
  reason?: string
  findings_count: number
  latency_ms: number
  cost_usd: number
  /**
   * Additive receipt for model usage. Registry-produced summaries populate it
   * even when the analyst emits no findings. `cost_usd` remains the legacy
   * numeric field; inspect `usage.cost` before treating zero as observed.
   */
  usage?: AnalystUsageReceipt
  /** When `status='failed'`: the error class + message, never the full stack. */
  error?: { class: string; message: string }
}

export interface AnalystRunResult {
  run_id: string
  correlation_id: string
  started_at: string
  ended_at: string
  findings: AnalystFinding[]
  per_analyst: AnalystRunSummary[]
  /** Total LLM cost in USD across all analysts in this registry.run(). */
  total_cost_usd: number
  /**
   * Provenance for `total_cost_usd`. When uncaptured, the numeric field is only
   * the known subtotal and must not be treated as the run's total spend.
   */
  total_cost_provenance?: RunCostProvenance
}

// ── Streaming event envelope ────────────────────────────────────────

/**
 * Events emitted by `AnalystRegistry.runStream(...)` in real time as
 * the registry executes. UIs subscribe via `for await (const ev of
 * registry.runStream(...))`; `registry.run(...)` is a thin collector
 * over the same stream, so the two surfaces share their invariants.
 *
 * Per-finding events are intentionally omitted — analyzers are batch
 * operations (an Ax actor returns the full `findings:json[]` at the
 * end of the responder), so streaming inside one analyst would only
 * emit partial JSON consumers can't render. The kind-completion event
 * is the right granularity; subscribers wanting per-finding rendering
 * iterate `event.findings` themselves.
 */
export type AnalystRunEvent =
  | {
      type: 'run-started'
      run_id: string
      correlation_id: string
      started_at: string
      /** The ordered list of analyst ids the registry will run. */
      analyst_ids: ReadonlyArray<string>
    }
  | {
      type: 'analyst-skipped'
      summary: AnalystRunSummary
    }
  | {
      type: 'analyst-started'
      analyst_id: string
      started_at: string
    }
  | {
      type: 'analyst-completed'
      /** `summary.status` is `'ok'` for clean completion or `'failed'` for thrown analysts. */
      summary: AnalystRunSummary
      findings: ReadonlyArray<AnalystFinding>
    }
  | {
      type: 'run-completed'
      result: AnalystRunResult
    }
