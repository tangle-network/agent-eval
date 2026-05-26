/**
 * # Hosted-tier wire format — the schema that EVERY orchestrator (ours,
 * a partner's self-hosted one, a future open implementation) must accept.
 *
 * **Stability:** every type in this file is committed under semver. New
 * minors only ADD optional fields. Breaking changes mean a major bump
 * (`HostedWireVersion` literal increment).
 *
 * The wire format is two event streams in one transport:
 *
 *   1. **Eval-run events** (`POST /v1/ingest/eval-runs`). Posted when a
 *      campaign / improvement-loop completes (or per-generation if
 *      streaming). Carries the structured result + per-cell scores +
 *      surface diffs the orchestrator stores for the dashboard.
 *
 *   2. **Trace spans** (`POST /v1/ingest/traces`). Standard OTLP-shaped
 *      spans with a few additional attributes so the orchestrator can
 *      pivot from eval-run → underlying execution. Compatible with any
 *      OTel collector.
 *
 * Both endpoints are authenticated with a bearer token + a tenant id
 * header. Tenants isolate everything downstream of ingest; no tenant
 * ever sees another tenant's data.
 */

import type { GateDecision, MutableSurface } from '../campaign/types'

export const HOSTED_WIRE_VERSION = '2026-05-26.v1' as const
export type HostedWireVersion = typeof HOSTED_WIRE_VERSION

// ── Transport headers ───────────────────────────────────────────────

/** Every ingest request carries these. */
export interface HostedIngestHeaders {
  /** Bearer token. The orchestrator validates against the tenant key. */
  authorization: `Bearer ${string}`
  /** Stable tenant id (the orchestrator-side primary key for the tenant). */
  'x-tangle-tenant-id': string
  /** Wire-version pin so the server can reject incompatible payloads. */
  'x-tangle-wire-version': HostedWireVersion
  /** Optional idempotency key for retry-safe ingest. */
  'idempotency-key'?: string
}

// ── Eval-run event ──────────────────────────────────────────────────

/** Lifecycle stages of an eval-run as the substrate reports them. */
export type EvalRunStatus =
  | 'started'
  | 'baseline-complete'
  | 'generation-complete'
  | 'gate-decided'
  | 'finished'
  | 'errored'

export interface EvalRunCellScore {
  /** Stable scenario id from the consumer's scenario set. */
  scenarioId: string
  /** Repetition index when reps > 1; 0 for the default. */
  rep: number
  /** Composite score across all judges + dimensions for this cell. */
  compositeMean: number
  /** Per-judge → per-dimension scores; null where the judge did not run. */
  dimensions: Record<string, Record<string, number>>
  /** Per-cell error message if the dispatch threw. Null on success. */
  errorMessage?: string
}

export interface EvalRunGenerationSnapshot {
  /** Generation index. 0 is baseline. */
  index: number
  /** Candidate surface fingerprint (stable hash) — pivot key into the
   *  trace stream to fetch the underlying execution. */
  surfaceHash: string
  /** The candidate surface itself. May be omitted to avoid PII when the
   *  consumer prefers not to ship verbatim prompts. */
  surface?: MutableSurface
  /** Per-cell scores for this generation. */
  cells: EvalRunCellScore[]
  /** Aggregate composite mean across all cells in this generation. */
  compositeMean: number
  /** Total $ spent across this generation. */
  costUsd: number
  /** Wall-clock duration of this generation. */
  durationMs: number
}

/**
 * The top-level eval-run event. One ingest call per logical eval-run;
 * generations stream in incrementally via repeated calls with the same
 * `runId`. The orchestrator deduplicates by `(runId, generation.index)`.
 */
export interface EvalRunEvent {
  /** Stable run id (the substrate's `runId`). UUID or substrate-generated. */
  runId: string
  /** Where this run was happening — derived from `RunCampaignOptions.runDir`. */
  runDir: string
  /** ISO-8601 timestamp the substrate recorded the event. */
  timestamp: string
  /** Lifecycle stage this event represents. */
  status: EvalRunStatus
  /** Free-form consumer tags (env, branch, model id, etc.). Searchable. */
  labels: Record<string, string>
  /** Baseline campaign snapshot. Present when status >= baseline-complete. */
  baseline?: EvalRunGenerationSnapshot
  /** Per-generation snapshots. Streams in; orchestrator appends. */
  generations: EvalRunGenerationSnapshot[]
  /** Final gate decision. Present when status >= gate-decided. */
  gateDecision?: GateDecision
  /** Held-out lift = winner-on-holdout - baseline-on-holdout. */
  holdoutLift?: number
  /** Total $ spent across baseline + every generation. */
  totalCostUsd: number
  /** Total wall-clock duration. */
  totalDurationMs: number
  /** Error message if status === 'errored'. */
  errorMessage?: string
}

// ── Trace span event ────────────────────────────────────────────────

/**
 * OTel-shape span with a few additional attributes for eval-run pivoting.
 * Compatible with any OTLP collector — `name`, `traceId`, `spanId`,
 * `startTimeUnixNano`, `endTimeUnixNano`, `attributes` are stock OTel.
 */
export interface TraceSpanEvent {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: number
  endTimeUnixNano: number
  attributes: Record<string, string | number | boolean>
  events?: Array<{
    timeUnixNano: number
    name: string
    attributes?: Record<string, string | number | boolean>
  }>
  status?: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string }
  /** Pivot back into the eval-run stream. */
  'tangle.runId'?: string
  /** Pivot to the specific generation. */
  'tangle.generation'?: number
  /** Pivot to the specific cell. */
  'tangle.cellId'?: string
  /** Pivot to the specific scenario. */
  'tangle.scenarioId'?: string
}

// ── Ingest request bodies ───────────────────────────────────────────

export interface IngestEvalRunsRequest {
  wireVersion: HostedWireVersion
  events: EvalRunEvent[]
}

export interface IngestTracesRequest {
  wireVersion: HostedWireVersion
  spans: TraceSpanEvent[]
}

export interface IngestResponse {
  /** Accepted events / spans count. */
  accepted: number
  /** Rejected events with reasons (validation failures, dup idempotency key, etc.). */
  rejected: Array<{ index: number; reason: string }>
}
