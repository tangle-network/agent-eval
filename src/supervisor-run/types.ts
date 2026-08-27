/**
 * Supervisor-run analysis — the multi-agent analogue of single-rollout trace
 * analysis. A solo rollout is one invocation with a transcript; a supervisor
 * run is a TREE of invocations (a brain that spawns, steers, and settles
 * workers) plus the event timeline that connects them. `src/trace-analyst`
 * answers "what happened inside one session"; this module answers "what did
 * the tree do" — did the brain steer anyone mid-task, how many spawn waves,
 * how concurrent, how idle, what did each role cost, what came back.
 *
 * The nodes of that tree are NOT a new shape: they are `tangle.rollout.v1`
 * rows (`src/rollout`), keyed by `parent_rollout_id`, with `role` already
 * spanning `supervisor` / `worker`. `supervisorRunRolloutLines` mints them.
 * What rollout rows deliberately do NOT carry is the inter-invocation event
 * timeline (spawn/settle/steer instants), which is what every structural
 * metric here is computed from — so the reader consumes the journal event
 * stream and emits rollout rows, rather than maintaining a parallel node type.
 *
 * ## UNAVAILABLE ≠ ZERO
 *
 * Every metric whose backing artifact can be missing is typed
 * `Measured<T> = T | { unavailable: reason }`. A supervisor that steered
 * nobody reports `steers: 0`; a supervisor whose worker logs were never
 * written reports `steers: unavailable — <reason>`. The two have driven
 * opposite conclusions about the same architecture, so they never collapse.
 */

import type {
  AgentControllerTurnReceipt,
  AgentProviderSessionRef,
} from '@tangle-network/agent-interface'
import type { RolloutLine } from '../rollout/schema'

// ---------------------------------------------------------------------------
// Unavailable-aware metric type.
// ---------------------------------------------------------------------------

/** A metric that could not be computed, with the reason its artifact was missing. */
export interface Unavailable {
  readonly unavailable: string
}

/** A metric value, or the reason it is unknown. NEVER collapse `unavailable` to 0. */
export type Measured<T> = T | Unavailable

export function unavailable(reason: string): Unavailable {
  return { unavailable: reason }
}

export function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === 'object' && v !== null && typeof (v as Unavailable).unavailable === 'string'
}

/** Render a measured scalar for the markdown/headline: `0` and `unavailable` stay distinct. */
export function showMeasured(v: Measured<number | string | boolean | null>): string {
  if (isUnavailable(v)) return `unavailable — ${v.unavailable}`
  if (v === null) return 'null'
  return String(v)
}

// ---------------------------------------------------------------------------
// Source contract — deliberately source-agnostic.
// ---------------------------------------------------------------------------

/** The two invocation roles a recursive supervision tree can contain. */
export type SupervisorRunNodeRole = 'supervisor' | 'worker'

/**
 * One worker's logs, as read. `null` means the artifact did not exist; `''`
 * means the artifact was captured and contained no rows.
 */
export interface WorkerLogSource {
  /**
   * Stable journal node id. Readers should set this whenever their source has
   * one; `label` remains the compatibility join for older stores.
   */
  readonly workerId?: string
  /** Human-readable task label. It is not required to be unique. */
  readonly label: string
  /** Worker event stream — started / progress / finished / message events (JSONL). */
  readonly events: string | null
  /** The durable steer queue — one line per steer request (JSONL). */
  readonly inbox: string | null
  /** Worker patch byte length, or null when absent. */
  readonly patchBytes: number | null
  /** Where this worker's transcript lives, for the rollout row. Null = no such artifact. */
  readonly transcriptRef?: string | null
  /** Where this worker's delivered patch lives. Null = the store keeps no patch per worker. */
  readonly patchPath?: string | null
  /** This worker's own inference tokens, when the store records them per worker. */
  readonly tokensIn?: number | null
  readonly tokensOut?: number | null
  readonly cacheRead?: number | null
  readonly cacheWrite?: number | null
}

/**
 * One provider session joined to one invocation in the supervision journal.
 *
 * This is identity metadata only. Provider messages and spans remain in their
 * native trace store and are read by the provider's existing trace adapter.
 */
/** Canonical Interface-owned receipt for one controller-owned provider turn. */
export type RuntimeControllerTurnReceipt = AgentControllerTurnReceipt

/** Canonical Interface-owned provider-session receipt written by Runtime. */
export type SupervisorRunProviderSessionRef = AgentProviderSessionRef

export interface SupervisorRunSessionLineage {
  /** Stable invocation id from the supervision journal. */
  readonly nodeId: string
  readonly parentNodeId: string | null
  readonly depth: number
  readonly childNodeIds: readonly string[]
  /**
   * Exact provider identity when Runtime recorded it.
   *
   * Missing identity is an unavailable measurement for this node, not a reason
   * to discard the Runtime-owned tree around it.
   */
  readonly providerSession?: SupervisorRunProviderSessionRef
}

/**
 * Facts a SOURCE structurally cannot express, each with the reason.
 *
 * The difference between "the artifact is missing" and "this store never
 * records that fact" is the difference between a run that spent $0 and a
 * harness that does not price inference — and the second harness is where a
 * loops-shaped assumption becomes a fabricated zero. A reader declares its
 * limits once; the analyzer reports `unavailable` for everything downstream.
 *
 * `null` on a field means the source DOES carry that fact.
 */
export interface SourceLimits {
  /** Reason manager input/output token totals are unavailable (null = recorded). */
  readonly managerTokens: string | null
  /** Reason worker input/output token totals are unavailable (null = recorded). */
  readonly workerTokens: string | null
  /** Reason inference spend has no price in this store (null = the store prices it). */
  readonly spendUsd: string | null
  /** Reason workers carry no pass/fail verdict (null = verdicts are recorded). */
  readonly workerVerdicts: string | null
  /** Reason no delivered artifact (patch/diff) is retained per worker (null = retained). */
  readonly deliverables: string | null
}

/** A source that carries every fact the analyzer can use. */
export const NO_SOURCE_LIMITS: SourceLimits = {
  managerTokens: null,
  workerTokens: null,
  spendUsd: null,
  workerVerdicts: null,
  deliverables: null,
}

/**
 * Everything the pure analyzer reads — already-read bytes, never paths. Each
 * field is `null` when its artifact was absent, which is what turns the
 * dependent metrics into `unavailable` rather than 0.
 *
 * This is the whole input contract. Any store that can produce these strings
 * (an on-disk loops run, an object-store archive, a database, a test fixture)
 * is a valid source; `loopsSupervisorRunReader` is ONE implementation.
 */
export interface SupervisorRunSources {
  /** Stable identity of the run being analyzed (a directory, a run id, a URL). */
  readonly runRef: string
  readonly instanceId: string | null
  /** Which arm/variant of a comparison this run is, when the run belongs to one. */
  readonly arm: string | null
  /** Identity of the supervision-tree store this was read from; null = none found. */
  readonly supRunDir: string | null
  /**
   * Supervision journal — spawned / settled / cancelled / metered events (JSONL).
   * Recursive readers put `role: 'supervisor' | 'worker'` on spawned rows;
   * settled `verdict` may be a legacy string or `{ valid, score, ... }`.
   */
  readonly journal: string | null
  /** Per-brain-call tap (JSONL): finish_reason, completion tokens, requested max tokens. */
  readonly brainLog: string | null
  /** Source-specific reason `brainLog` is absent. */
  readonly brainLogMissingReason?: string
  /** Supervisor state document (JSON). */
  readonly state: string | null
  /** Supervisor progress stream (JSONL). */
  readonly progress: string | null
  /** Per-worker logs; `null` = the worker log store itself was missing. */
  readonly workers: readonly WorkerLogSource[] | null
  /** Why `workers` is null (only set when it is). */
  readonly workersMissingReason: string | null
  /** Run result document (JSON). */
  readonly result: string | null
  /**
   * Judge verdict document (JSON), or the matching ledger row re-encoded as
   * one. Runners that write the verdict straight to a ledger leave no judge
   * document, so the ledger row is the same fact from the same run — not a
   * substitute measurement.
   */
  readonly judge: string | null
  /** Where `judge` came from, for the report's provenance line. */
  readonly judgeSource: string | null
  /** Delivered unified-diff patch text. */
  readonly patch: string | null
  /** Outer-driver log (used for the driver's steer verbs + deadline evidence). */
  readonly driverLog: string | null
  /**
   * Worker tokens recovered from a harness session store; null = store unavailable.
   * `store` names the store in the report's provenance line (e.g. `opencode`).
   */
  readonly harnessWorkerTokens: {
    store: string
    sessions: number
    input: number
    output: number
    /** Cached prompt tokens, when the store counts them separately. */
    cacheRead?: number
    cacheWrite?: number
  } | null
  readonly harnessMissingReason: string | null
  /** What this store structurally cannot record. See `SourceLimits`. */
  readonly limits: SourceLimits
  /**
   * Where the ROOT invocation's transcript lives. Undefined lets the rollout
   * minter fall back to the loops layout (`<supRunDir>/journal.jsonl`); any
   * other store must say, or the row points at a path that never existed.
   */
  readonly rootTranscriptRef?: string | null
  /**
   * Provider-session identities joined to journal nodes by exact node id.
   * The entries carry no transcript or span data.
   */
  readonly sessionLineage?: readonly SupervisorRunSessionLineage[]
  /** Why `sessionLineage` is absent for a source that supports the join. */
  readonly sessionLineageMissingReason?: string
  /**
   * The `traces` CLI command that covers this run's harness-session layer.
   * Null falls back to the analyzer's default (an opencode worker fleet).
   */
  readonly traceCommand: string | null
}

/**
 * A source of supervisor-run bytes. Implementations own their storage layout;
 * the analyzer only ever sees `SupervisorRunSources`.
 */
export interface SupervisorRunReader {
  /** Stable identity of what this reader points at (for logs and report labels). */
  readonly runRef: string
  read(): Promise<SupervisorRunSources>
}

// ---------------------------------------------------------------------------
// Report shape.
// ---------------------------------------------------------------------------

export const SUPERVISOR_RUN_SCHEMA = 'tangle.supervisor-run@1'
export const SUPERVISOR_RUN_ROLLUP_SCHEMA = 'tangle.supervisor-run-rollup@1'

export interface SteerBreakdown {
  /** Stable journal node id when the reader retained one. */
  readonly workerId: string | null
  readonly worker: string
  /** Steer requests durably queued to this worker's inbox. */
  readonly queued: number
  /** Steers the worker's executor actually accepted (control event `delivered:true`). */
  readonly delivered: number
}

export interface OrchestrationMetrics {
  readonly workersSpawned: Measured<number>
  readonly workersSettled: Measured<number>
  readonly workersCancelled: Measured<number>
  /** THE HEADLINE: mid-task steers the brain sent to live workers. 0 ≠ unavailable. */
  readonly steers: Measured<number>
  readonly steersDelivered: Measured<number>
  readonly steersByWorker: Measured<readonly SteerBreakdown[]>
  /** Outer-driver `supervisor_steer` tool calls seen in the driver log (a second steer path). */
  readonly driverSteerCalls: Measured<number>
  /**
   * Spawn waves. A wave is a maximal run of worker spawns with no settle/cancel between
   * them: wave N+1 begins at the first spawn issued after at least one worker from an
   * earlier wave has settled. Structural, not a time threshold — no tunable constant.
   */
  readonly waves: Measured<number>
  readonly waveSizes: Measured<readonly number[]>
  readonly maxConcurrency: Measured<number>
  /** Direct-child spawns issued after that parent's first direct-child settlement. */
  readonly respawns: Measured<number>
  /** Labels spawned more than once by the same parent. */
  readonly repeatedLabels: Measured<readonly string[]>
  /** Longest parent chain below the root, in worker hops. */
  readonly delegationDepth: Measured<number>
  readonly timeToFirstSpawnMs: Measured<number>
  readonly supervisorWallMs: Measured<number>
  /** Wall time inside the supervisor run with ZERO live workers. */
  readonly idleMs: Measured<number>
  readonly idlePct: Measured<number>
  /** sum(worker wall) / supervisor wall. >1 means real parallelism. */
  readonly workerUtilization: Measured<number>
}

export interface DecisionMetrics {
  readonly settledByStatus: Measured<Record<string, number>>
  readonly settledVerdicts: Measured<Record<string, number>>
  /** Worker verified its own work green AND produced a patch. */
  readonly accepted: Measured<number>
  /** Worker settled with a failing verify. */
  readonly rejected: Measured<number>
  /** Worker verified green but delivered no patch bytes — output with nothing to accept. */
  readonly emptyPass: Measured<number>
  /** Direct-child settlements a parent observed before issuing its next direct-child spawn. */
  readonly observeThenRespawn: Measured<number>
  /** Parent-local respawns with no direct-child settlement in front of them. */
  readonly respawnWithoutEvidence: Measured<number>
  /** Steer + question traffic on the live down/up legs — the only "review while running" signal. */
  readonly reviewActions: Measured<number>
  readonly workerEvidenceBytes: Measured<number>
}

export interface RoleSpend {
  readonly tokensIn: Measured<number>
  readonly tokensOut: Measured<number>
  /**
   * Cached prompt tokens read/written. On a harness that caches aggressively
   * these dwarf `tokensIn`, so a report that omits them understates the context
   * each invocation actually consumed. `unavailable` = the store has no such counter.
   */
  readonly cacheRead: Measured<number>
  readonly cacheWrite: Measured<number>
  readonly usd: Measured<number>
  readonly source: string
}

export interface PerWorkerRow {
  /** Stable journal node id when the reader retained one. */
  readonly workerId: string | null
  readonly worker: string
  /** Explicit journal role after the worker source was joined to its spawn. */
  readonly role: SupervisorRunNodeRole | null
  /** Exact execution runtime tag from the spawn event. */
  readonly runtime: string | null
  /** Exact canonical AgentProfile digest from the spawn event. */
  readonly profileDigest: string | null
  /** Terminal lifecycle status exactly as recorded. */
  readonly status: string | null
  /** Terminal failure detail exactly as recorded. */
  readonly failure: string | null
  /** Runtime infrastructure classification, when recorded. */
  readonly infra: boolean | null
  readonly wallMs: number | null
  /** `null` = this store does not attribute tokens per worker (NOT "zero tokens"). */
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly usd: number | null
  readonly patchBytes: number | null
  readonly passed: boolean | null
  /** Numeric verdict score exactly as recorded; null means no score was recorded. */
  readonly score: number | null
}

export interface WallDistribution {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p90: number
  readonly max: number
  readonly sum: number
}

export interface EconomicsMetrics {
  /** Driver/brain inference — journal `metered` events. */
  readonly brain: RoleSpend
  /**
   * Brain completions that came back `finish_reason: "length"` — output TRUNCATED. Any value
   * above 0 means the supervisor planned into a wall and then acted on the half-written plan,
   * which is a defect and not a cost figure. The journal's `metered` rows carry token counts
   * but no finish reason, so this reads the per-call brain tap; a run whose supervisor
   * predates that tap reports `unavailable`, never 0.
   */
  readonly brainTruncations: Measured<number>
  /** Worker inference — journal `settled` spend plus the harness session join. */
  readonly workers: RoleSpend
  readonly totalUsd: Measured<number>
  /**
   * Where `totalUsd` came from. CLI-backend workers never price their own inference into
   * the journal, so on those arms the total is BRAIN-ONLY and the worker row's token
   * counts (recovered from the harness store) are the honest worker-side figure.
   */
  readonly totalUsdSource: string
  readonly costPerAcceptedPatchUsd: Measured<number>
  readonly workerWallMsDistribution: Measured<WallDistribution>
  readonly perWorker: Measured<readonly PerWorkerRow[]>
}

export interface PatchStats {
  readonly files: number
  readonly linesAdded: number
  readonly linesRemoved: number
  readonly testFilesTouched: readonly string[]
}

export interface OutcomeMetrics {
  readonly supStatus: Measured<string>
  readonly supVerdict: Measured<string>
  readonly delivered: Measured<boolean>
  readonly judgeResolved: Measured<boolean | null>
  readonly judgeScore: Measured<number | null>
  readonly judgePassed: Measured<number | null>
  readonly judgeTotal: Measured<number | null>
  readonly verifyPass: Measured<boolean>
  readonly verifyRc: Measured<number>
  readonly patch: Measured<PatchStats>
  /** Which document the judge fields came from (a judge file, a ledger row, or nothing). */
  readonly judgeSource: string | null
}

export interface SupervisorRunReport {
  readonly schema: typeof SUPERVISOR_RUN_SCHEMA
  /** The `runRef` of the sources this report was computed from. */
  readonly runRef: string
  readonly instanceId: string | null
  readonly arm: string | null
  readonly supervisorId: Measured<string>
  readonly supervisorProfileDigest: Measured<string>
  readonly generatedAt: string
  readonly orchestration: OrchestrationMetrics
  readonly decision: DecisionMetrics
  readonly economics: EconomicsMetrics
  readonly outcome: OutcomeMetrics
  /**
   * Runtime-owned ancestry plus every provider identity Runtime measured.
   * A row without `providerSession` is retained so partial identity coverage
   * cannot erase or rewrite the supervision tree.
   */
  readonly sessionLineage?: Measured<readonly SupervisorRunSessionLineage[]>
  /** Artifacts that were missing, in read order — the provenance of every `unavailable`. */
  readonly gaps: readonly string[]
  /** The `traces` CLI command that covers the harness-session layer for this run. */
  readonly traceCommand: string
}

export interface RollupCellRow {
  readonly instanceId: string | null
  readonly arm: string | null
  readonly steers: Measured<number>
  readonly waves: Measured<number>
  readonly utilization: Measured<number>
  readonly idlePct: Measured<number>
  readonly resolved: Measured<boolean | null>
  readonly usd: Measured<number>
}

export interface SupervisorRunRollup {
  readonly schema: typeof SUPERVISOR_RUN_ROLLUP_SCHEMA
  readonly cells: number
  readonly steersTotal: Measured<number>
  readonly cellsWithSteers: Measured<number>
  readonly cellsWithUnavailableSteers: number
  readonly wavesMean: Measured<number>
  readonly maxConcurrencyMax: Measured<number>
  readonly utilizationMean: Measured<number>
  readonly idlePctMean: Measured<number>
  readonly workersSpawnedTotal: Measured<number>
  readonly acceptedTotal: Measured<number>
  readonly usdTotal: Measured<number>
  readonly resolvedCount: Measured<number>
  readonly perCell: readonly RollupCellRow[]
}

/**
 * A supervision tree expressed in the canonical rollout row type: one
 * `RolloutLine` per invocation, joined by `parent_rollout_id`. The root row
 * carries `role: 'supervisor'`; nested supervisors retain that role and leaf
 * invocations carry `role: 'worker'`.
 */
export interface SupervisorRunTree {
  readonly rootId: string | null
  readonly nodes: readonly RolloutLine[]
  /** Typed reasons a rollout field could not be recovered, in read order. */
  readonly gaps: readonly SupervisorRunTreeGap[]
}

/** Stable machine-readable reasons emitted while minting a supervisor tree. */
export type SupervisorRunTreeGapCode =
  | 'journal-unavailable'
  | 'source-row-malformed'
  | 'root-spawn-unavailable'
  | 'root-reward-unavailable'
  | 'child-reward-unavailable'
  | 'node-role-unavailable'
  | 'node-schema-invalid'

export interface SupervisorRunTreeGap {
  readonly code: SupervisorRunTreeGapCode
  readonly message: string
  readonly nodeId?: string
  readonly count?: number
}
