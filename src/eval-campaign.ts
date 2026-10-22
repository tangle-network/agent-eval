/**
 * EvalCampaign — opinionated matrix runner that wires the four
 * capture-integrity directives by construction.
 *
 * The canonical benchmark shape — matrix runner → for each
 * (variant, scenario, seed) → start a TraceEmitter → call LLMs → end the
 * run → analyze — has a bug class at the integration boundary: raw
 * events not captured, route silently wrong, integrity not asserted,
 * analyst never run. The directives in `SKILL.md § Capture integrity`
 * are the mitigations.
 *
 * `EvalCampaign` is the structural fix — consumers don't wire the
 * integrity surface themselves; the campaign owns it. Specifically:
 *
 *   - constructs a per-run `TraceStore` and `RawProviderSink` via factories
 *   - builds the run's `ChatClient` through `chatFactory`, handing it the
 *     run's raw sink and trace context — a transport built any other way has
 *     no raw HTTP envelope, and `assertRunCaptured` says so
 *   - calls `assertRunCaptured` after every `endRun` and routes failures
 *     through a configurable policy (`throw` / `mark_failed` / `log`)
 *   - assembles per-run `RunRecord`s and runs `researchReport` at the end
 *     so the campaign artifact is launch-decision-grade by default
 *   - embeds the campaign fingerprint (a SHA-256 over the canonicalised
 *     run set) and optional `preregistrationHash` in the report
 *
 * The runner contract is intentionally narrow: produce a `CampaignRunOutcome`
 * given a fully-wired `CampaignRunContext`. Everything orchestration-shaped
 * lives in the campaign. This is the inversion-of-control point — consumers
 * stop writing matrix runners and start writing scenario-runners.
 *
 * Out of scope for v1 (tracked in `docs/research-report-methodology.md`):
 *
 *   - Distributed/cluster execution (concurrency is local async)
 *   - Adaptive sampling / sequential interim looks
 *   - Resume from partial state across crashes
 *   - LLM-call retry beyond what the caller's transport already does
 */

import {
  type AgentProfileCell,
  type AgentProfileCellInput,
  buildAgentProfileCell,
  verifyAgentProfileCell,
} from './agent-profile-cell'
import type { ChatClient } from './analyst/chat-client'
import { hashJson } from './pre-registration'
import type {
  JudgeScoresRecord,
  RunCostProvenance,
  RunJudgeMetadata,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTaskFailure,
  RunTokenUsage,
} from './run-record'
import { validateRunRecord } from './run-record'
import { type ResearchReport, type ResearchReportOptions, researchReport } from './summary-report'
import type { RunCompleteHook } from './trace/emitter'
import { TraceEmitter } from './trace/emitter'
import {
  assertRunCaptured,
  RunIntegrityError,
  type RunIntegrityExpectations,
  type RunIntegrityReport,
} from './trace/integrity'
import { FileSystemRawProviderSink, type RawProviderSink } from './trace/raw-provider-sink'
import type { TraceStore } from './trace/store'

// ── Public types ─────────────────────────────────────────────────────────

export interface CampaignVariant<V> {
  id: string
  payload: V
}

export interface CampaignScenario {
  scenarioId: string
  /** Free-form metadata propagated to runs and reports. */
  tags?: Record<string, string>
}

export interface CampaignRunContext<V> {
  /** Stable run id. The campaign generates this; the runner does not. */
  runId: string
  /** Logical experiment id (campaignId by default; overridable per-run via opts). */
  experimentId: string
  variant: V
  variantId: string
  scenarioId: string
  scenarioTags: Record<string, string>
  seed: number
  splitTag: RunSplitTag
  /**
   * The TraceEmitter for this run, with `onRunComplete` hooks pre-wired
   * (analyst auto-execution if configured, plus integrity check). The
   * runner MUST call `emitter.startRun` before doing any work and either
   * `emitter.endRun` or `emitter.abortRun` before returning.
   */
  emitter: TraceEmitter
  store: TraceStore
  rawSink: RawProviderSink
  /**
   * The run's model transport, built by `chatFactory` with this run's
   * `rawSink` and `runId` already bound.
   */
  chat: ChatClient
}

/** What the campaign binds into the run's transport. */
export interface CampaignChatWiring {
  /**
   * Raw provider sink for this run. Bind it into the transport: the campaign's
   * integrity check requires every LLM span to carry a matching raw request
   * event, so a transport built without it fails `assertRunCaptured`.
   */
  rawSink: RawProviderSink
  runId: string
}

interface CampaignRunOutcomeFields {
  /** Did the run pass? Mirrors `RunOutcome.pass` semantics. */
  pass: boolean
  /** Score for the run on its split. Maps to `searchScore` or `holdoutScore`. */
  score: number
  /** Cost in USD, or null when the runner could not capture it. */
  costUsd: number | null
  /** Source of the cost amount. */
  costProvenance: RunCostProvenance
  tokenUsage: RunTokenUsage
  /** Snapshot model id (e.g. `claude-sonnet-4-6@2025-04-15`). */
  model: string
  /** sha256 of the effective prompt sent to the model. */
  promptHash: string
  /** sha256 of the effective config (model, temperature, tools, judges, splits). */
  configHash: string
  /** Optional extra numeric metrics to land in `outcome.raw`. */
  raw?: Record<string, number>
  /** Optional judge metadata when a judge was used. */
  judgeMetadata?: RunJudgeMetadata
  /**
   * Optional per-judge / per-dim breakdown for ensemble-judged runs.
   * Propagated to `outcome.judgeScores` on the resulting `RunRecord`.
   * Single-judge or scalar-only runs leave this unset.
   */
  judgeScores?: JudgeScoresRecord
  /**
   * Agent profile cell observed by the runner. When supplied, it overrides
   * `EvalCampaignOptions.agentProfile` for this run and must match the
   * outcome's `model` and `promptHash`.
   */
  agentProfile?: AgentProfileCell | AgentProfileCellInput
}

/** Campaign result with the same task-failure invariant as `RunRecord`. */
export type CampaignRunOutcome = CampaignRunOutcomeFields & RunTaskFailure

export type CampaignRunner<V> = (ctx: CampaignRunContext<V>) => Promise<CampaignRunOutcome>

export type CampaignIntegrityPolicy = 'throw' | 'mark_failed' | 'log'

export interface EvalCampaignOptions<V> {
  /**
   * Stable id for the campaign. Used as the default `experimentId` on
   * every run, and folded into the campaign fingerprint.
   */
  campaignId: string
  variants: CampaignVariant<V>[]
  scenarios: CampaignScenario[]
  /** Default `[0, 1, 2]`. */
  seeds?: number[]
  /** Default `'holdout'` — the split that anchors a launch decision. */
  splitTag?: RunSplitTag
  /** Git SHA the campaign is run against. Mandatory; `RunRecord` rejects unset. */
  commitSha: string
  /**
   * Build the model transport for one run. agent-eval executes no paid model:
   * the caller owns the transport and the credential never enters this
   * package. The campaign calls this once per run and passes the run's raw
   * provider sink and `runId`, so a transport that binds them captures the
   * raw HTTP envelope `assertRunCaptured` checks for.
   */
  chatFactory: (wiring: CampaignChatWiring) => ChatClient
  /**
   * Caller-declared identity of the execution route, folded into the campaign
   * fingerprint so two campaigns run against different endpoints do not share
   * one identity. agent-eval no longer knows the endpoint; the owner of
   * execution names it.
   */
  executionRef?: string
  /**
   * Per-run TraceStore factory. Common shape: a fresh store per run keyed
   * on `runId`. Implementations that share a store across the campaign
   * are valid — the campaign only writes through `emitter`.
   */
  storeFactory: (params: CampaignFactoryParams) => TraceStore
  /**
   * Per-run RawProviderSink factory. Defaults to `FileSystemRawProviderSink`
   * rooted at `${workDir}/raw-events/${runId}` if `workDir` is supplied;
   * otherwise required. Forensic capture is non-negotiable in a campaign
   * run — pass `NoopRawProviderSink` explicitly if you want to opt out.
   */
  rawSinkFactory?: (params: CampaignFactoryParams) => RawProviderSink
  /**
   * Filesystem root for default `rawSinkFactory`. Ignored if
   * `rawSinkFactory` is supplied.
   */
  workDir?: string
  /**
   * Extra `onRunComplete` hooks the campaign appends (after its own
   * integrity-check hook). Pass `traceAnalystOnRunComplete(...)` here.
   */
  onRunComplete?: RunCompleteHook[]
  /**
   * Per-run integrity expectations. Defaults to:
   *   `{ llmSpansMin: 1, requireRawCoverageOfLlmSpans: true, requireOutcome: true }`.
   * Override (e.g. `{ llmSpansMin: 0 }`) for runs that don't call LLMs.
   */
  integrity?: RunIntegrityExpectations
  /** Behaviour when integrity fails. Default `'mark_failed'`. */
  onIntegrityFailure?: CampaignIntegrityPolicy
  /**
   * Per-run runner. Receives a fully-wired context; produces an outcome
   * the campaign converts into a `RunRecord`.
   */
  runner: CampaignRunner<V>
  /**
   * If set, the campaign computes `researchReport` at the end. `comparator`
   * is a `variantId`. Other fields are forwarded verbatim.
   */
  report?: { comparator?: string } & Omit<
    ResearchReportOptions,
    'comparator' | 'preregistrationHash' | 'generatedAt'
  >
  /**
   * Hash of a signed `HypothesisManifest` (see `pre-registration.ts`).
   * Embedded in the campaign fingerprint and the research report.
   */
  preregistrationHash?: string
  /** Local concurrency. Default `1` (sequential). */
  concurrency?: number
  /**
   * Override the time source. Tests pass a mock to make wallMs deterministic.
   */
  now?: () => number
  /** Override the runId generator. Tests pin this. */
  runId?: (params: CampaignFactoryParams) => string
  /**
   * Agent profile cell for campaign runs. Static profiles can pass an object;
   * routers or variant-specific harnesses can pass a factory. The campaign
   * stamps the built cell onto every `RunRecord` and rejects profile/model or
   * profile/prompt contradictions.
   */
  agentProfile?:
    | AgentProfileCell
    | AgentProfileCellInput
    | ((
        params: CampaignFactoryParams & {
          variant: V
          scenarioTags: Record<string, string>
        },
      ) =>
        | AgentProfileCell
        | AgentProfileCellInput
        | Promise<AgentProfileCell | AgentProfileCellInput>)
}

export interface CampaignFactoryParams {
  campaignId: string
  runId: string
  variantId: string
  scenarioId: string
  seed: number
}

export interface FailedRun {
  runId: string
  variantId: string
  scenarioId: string
  seed: number
  reason: string
  error?: string
}

export interface EvalCampaignResult {
  campaignId: string
  /** SHA-256 over canonicalised `(variantIds, scenarioIds, seeds, comparator, splitTag, executionRef, preregistrationHash)`. */
  campaignFingerprint: string
  preregistrationHash: string | null
  /** Successful runs only. Failed runs land in `failedRuns`. */
  runs: RunRecord[]
  /** Integrity reports for every successful run. */
  integrityReports: RunIntegrityReport[]
  failedRuns: FailedRun[]
  /** Computed when `report` is set on options. */
  report?: ResearchReport
  startedAt: string
  endedAt: string
}

// ── Implementation ───────────────────────────────────────────────────────

const DEFAULT_INTEGRITY: RunIntegrityExpectations = {
  llmSpansMin: 1,
  requireRawCoverageOfLlmSpans: true,
  requireOutcome: true,
}

type CampaignCell<V> = { variant: CampaignVariant<V>; scenario: CampaignScenario; seed: number }

type CampaignRunResult = { record: RunRecord; integrity: RunIntegrityReport }

/** Resolved options shared by every step of one campaign. */
interface CampaignSettings {
  seeds: number[]
  splitTag: RunSplitTag
  concurrency: number
  integrity: RunIntegrityExpectations
  onIntegrityFailure: CampaignIntegrityPolicy
  now: () => number
  executionRef: string | null
  preregistrationHash: string | null
  rawSinkFactory: (params: CampaignFactoryParams) => RawProviderSink
}

/**
 * Mutable state of one campaign's worker pool.
 *
 * A genuine (non-CellExecutionError) error from any worker is a bug, not a
 * run-level failure. We must NOT let `Promise.all` reject mid-flight and
 * orphan the other workers' in-progress runs (emitters never finalized,
 * sinks/handles leak, partial work silently discarded). Instead: capture the
 * first genuine error, stop dispatching new cells so in-flight workers wind
 * down, finalize every still-open run, then re-throw the aggregated error.
 */
interface CampaignPool<V> {
  opts: EvalCampaignOptions<V>
  settings: CampaignSettings
  cells: CampaignCell<V>[]
  cursor: number
  aborting: boolean
  genuineErrors: unknown[]
  /**
   * Emitters for runs that are currently mid-flight, keyed by runId. A worker
   * registers its emitter before invoking the runner and removes it once the
   * run is finalized (via endRun/abortRun, success or failure). Anything left
   * here after the pool settles is an orphan we must abort.
   */
  openRuns: Map<string, TraceEmitter>
  runs: RunRecord[]
  integrityReports: RunIntegrityReport[]
  failedRuns: FailedRun[]
}

export async function runEvalCampaign<V>(
  opts: EvalCampaignOptions<V>,
): Promise<EvalCampaignResult> {
  assertCampaignPreflight(opts)
  const settings = resolveCampaignSettings(opts)
  const campaignFingerprint = await fingerprintCampaign(opts, settings)

  const startedAt = new Date(settings.now()).toISOString()
  const pool: CampaignPool<V> = {
    opts,
    settings,
    cells: planCampaignCells(opts, settings.seeds),
    cursor: 0,
    aborting: false,
    genuineErrors: [],
    openRuns: new Map(),
    runs: [],
    integrityReports: [],
    failedRuns: [],
  }
  await drainCampaignPool(pool)

  const report = await buildCampaignReport(opts, settings, pool.runs)
  const endedAt = new Date(settings.now()).toISOString()

  return {
    campaignId: opts.campaignId,
    campaignFingerprint,
    preregistrationHash: settings.preregistrationHash,
    runs: pool.runs,
    integrityReports: pool.integrityReports,
    failedRuns: pool.failedRuns,
    report,
    startedAt,
    endedAt,
  }
}

/** Reject structurally invalid campaigns before any work starts. */
function assertCampaignPreflight<V>(opts: EvalCampaignOptions<V>): void {
  if (opts.variants.length === 0) {
    throw new Error('runEvalCampaign: variants must be non-empty.')
  }
  if (opts.scenarios.length === 0) {
    throw new Error('runEvalCampaign: scenarios must be non-empty.')
  }
  const variantIds = new Set<string>()
  for (const v of opts.variants) {
    if (variantIds.has(v.id)) {
      throw new Error(`runEvalCampaign: duplicate variant id "${v.id}".`)
    }
    variantIds.add(v.id)
  }
  const scenarioIds = new Set<string>()
  for (const s of opts.scenarios) {
    if (scenarioIds.has(s.scenarioId)) {
      throw new Error(`runEvalCampaign: duplicate scenarioId "${s.scenarioId}".`)
    }
    scenarioIds.add(s.scenarioId)
  }
  if (opts.report?.comparator && !variantIds.has(opts.report.comparator)) {
    throw new Error(
      `runEvalCampaign: report.comparator "${opts.report.comparator}" is not a configured variantId.`,
    )
  }
  if (!opts.commitSha) {
    throw new Error('runEvalCampaign: commitSha is required (every RunRecord needs it).')
  }
}

/** Apply defaults to the optional campaign options. */
function resolveCampaignSettings<V>(opts: EvalCampaignOptions<V>): CampaignSettings {
  return {
    seeds: opts.seeds ?? [0, 1, 2],
    splitTag: opts.splitTag ?? 'holdout',
    concurrency: Math.max(1, opts.concurrency ?? 1),
    integrity: { ...DEFAULT_INTEGRITY, ...(opts.integrity ?? {}) },
    onIntegrityFailure: opts.onIntegrityFailure ?? 'mark_failed',
    now: opts.now ?? (() => Date.now()),
    executionRef: opts.executionRef ?? null,
    preregistrationHash: opts.preregistrationHash ?? null,
    rawSinkFactory: opts.rawSinkFactory ?? defaultRawSinkFactory(opts.workDir),
  }
}

/** SHA-256 over the canonicalised matrix definition. */
function fingerprintCampaign<V>(
  opts: EvalCampaignOptions<V>,
  settings: CampaignSettings,
): Promise<string> {
  return hashJson({
    campaignId: opts.campaignId,
    variants: opts.variants.map((v) => v.id).sort(),
    scenarios: opts.scenarios.map((s) => s.scenarioId).sort(),
    seeds: [...settings.seeds].sort((a, b) => a - b),
    splitTag: settings.splitTag,
    comparator: opts.report?.comparator ?? null,
    executionRef: settings.executionRef,
    preregistrationHash: settings.preregistrationHash,
  })
}

/** Expand variants x scenarios x seeds, variant-major. */
function planCampaignCells<V>(opts: EvalCampaignOptions<V>, seeds: number[]): CampaignCell<V>[] {
  const cells: CampaignCell<V>[] = []
  for (const variant of opts.variants) {
    for (const scenario of opts.scenarios) {
      for (const seed of seeds) {
        cells.push({ variant, scenario, seed })
      }
    }
  }
  return cells
}

/**
 * Run the bounded-concurrency worker pool to completion, finalize any run left
 * open, and re-throw the genuine errors the workers captured.
 */
async function drainCampaignPool<V>(pool: CampaignPool<V>): Promise<void> {
  const workers = Array.from(
    { length: Math.min(pool.settings.concurrency, pool.cells.length) },
    () => campaignWorker(pool),
  )
  // allSettled (not all): a genuine error in one worker must not reject the
  // pool mid-flight and orphan the others. Each worker captures its own
  // genuine error into `genuineErrors` and returns; we re-throw below.
  await Promise.allSettled(workers)

  // Finalize any run still open after the pool wound down. With the
  // stop-dispatch flag these are the runs that were mid-flight in peer workers
  // when the first genuine error fired — abort them so their emitters finalize
  // (hooks fire, store records a terminal status) instead of leaking.
  for (const [runId, emitter] of pool.openRuns) {
    await finalizeAbort(emitter, runId, 'campaign aborted: genuine error in a sibling run')
  }
  pool.openRuns.clear()

  if (pool.genuineErrors.length > 0) {
    throw pool.genuineErrors.length === 1
      ? pool.genuineErrors[0]
      : new AggregateError(
          pool.genuineErrors,
          `runEvalCampaign: ${pool.genuineErrors.length} runs failed with genuine (non-run-level) errors`,
        )
  }
}

/** Pull cells off the shared cursor until none remain or the pool is aborting. */
async function campaignWorker<V>(pool: CampaignPool<V>): Promise<void> {
  while (!pool.aborting) {
    const i = pool.cursor++
    if (i >= pool.cells.length) return
    const cell = pool.cells[i]!
    try {
      const result = await runCampaignCell(pool, cell)
      pool.runs.push(result.record)
      pool.integrityReports.push(result.integrity)
    } catch (err) {
      if (err instanceof CellExecutionError) {
        pool.failedRuns.push(err.failed)
        if (err.integrity) pool.integrityReports.push(err.integrity)
      } else {
        // Genuine bug — not a runner failure, not an integrity failure.
        // Capture it and stop dispatching so peers wind down gracefully;
        // re-thrown after the pool settles. Do not surface here — that would
        // reject Promise.all and orphan the other workers' runs.
        pool.genuineErrors.push(err)
        pool.aborting = true
        return
      }
    }
  }
}

/** Run one matrix cell: runner, integrity check, then the validated RunRecord. */
async function runCampaignCell<V>(
  pool: CampaignPool<V>,
  cell: CampaignCell<V>,
): Promise<CampaignRunResult> {
  const { opts, settings } = pool
  const runId = (opts.runId ?? defaultRunId)({
    campaignId: opts.campaignId,
    runId: '', // unused by default generator
    variantId: cell.variant.id,
    scenarioId: cell.scenario.scenarioId,
    seed: cell.seed,
  })
  const factoryParams: CampaignFactoryParams = {
    campaignId: opts.campaignId,
    runId,
    variantId: cell.variant.id,
    scenarioId: cell.scenario.scenarioId,
    seed: cell.seed,
  }
  const store = opts.storeFactory(factoryParams)
  const rawSink = settings.rawSinkFactory(factoryParams)

  const emitter = new TraceEmitter(store, {
    runId,
    now: opts.now,
    onRunComplete: opts.onRunComplete,
  })
  // Track this run as open so a genuine error elsewhere in the pool can
  // finalize it instead of orphaning it. Removed in the finally below.
  pool.openRuns.set(runId, emitter)

  const chat = opts.chatFactory({ rawSink, runId })

  const ctx: CampaignRunContext<V> = {
    runId,
    experimentId: opts.campaignId,
    variant: cell.variant.payload,
    variantId: cell.variant.id,
    scenarioId: cell.scenario.scenarioId,
    scenarioTags: cell.scenario.tags ?? {},
    seed: cell.seed,
    splitTag: settings.splitTag,
    emitter,
    store,
    rawSink,
    chat,
  }

  try {
    const wallStart = settings.now()
    const outcome = await invokeCampaignRunner(opts, cell, ctx)
    const wallMs = settings.now() - wallStart

    const integrityReport = await assertRunCaptured(store, runId, {
      ...settings.integrity,
      rawSink,
    })
    if (!integrityReport.ok) admitOrRejectIntegrity(settings, cell, runId, integrityReport)

    const record = buildCampaignRunRecord(opts, settings, cell, runId, outcome, wallMs)
    await stampAgentProfile(opts, cell, record, runId, outcome)
    return { record: validateRunRecord(record), integrity: integrityReport }
  } finally {
    // This run's worker has finished with it (success, run-level failure, or
    // genuine error). It is no longer the pool's job to finalize — drop it so
    // the post-settle sweep doesn't double-abort a finalized run.
    pool.openRuns.delete(runId)
  }
}

/** Invoke the runner; a throw aborts the run and becomes a run-level failure. */
async function invokeCampaignRunner<V>(
  opts: EvalCampaignOptions<V>,
  cell: CampaignCell<V>,
  ctx: CampaignRunContext<V>,
): Promise<CampaignRunOutcome> {
  try {
    return await opts.runner(ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The runner threw mid-execution. Abort the run so the emitter
    // finalizes. The only benign abortRun failure is "the runner never
    // started the run" (nothing to finalize). A store-write failure (disk
    // full, FS error) is a genuine diagnostic — surface it rather than
    // masking it as a plain runner failure.
    await finalizeAbort(ctx.emitter, ctx.runId, message)
    throw new CellExecutionError({
      runId: ctx.runId,
      variantId: cell.variant.id,
      scenarioId: cell.scenario.scenarioId,
      seed: cell.seed,
      reason: 'runner_threw',
      error: message,
    })
  }
}

/** Apply the integrity-failure policy to a report that is not ok. */
function admitOrRejectIntegrity<V>(
  settings: CampaignSettings,
  cell: CampaignCell<V>,
  runId: string,
  integrityReport: RunIntegrityReport,
): void {
  switch (settings.onIntegrityFailure) {
    case 'throw':
      throw new RunIntegrityError(integrityReport)
    case 'mark_failed':
      throw new CellExecutionError(
        {
          runId,
          variantId: cell.variant.id,
          scenarioId: cell.scenario.scenarioId,
          seed: cell.seed,
          reason: 'integrity_failed',
          error: integrityReport.issues.map((i) => i.code).join(', '),
        },
        integrityReport,
      )
    case 'log':
      // Caller wants the run admitted with a flagged report; fall through.
      break
  }
}

/** Assemble the RunRecord for a successful run, before profile stamping. */
function buildCampaignRunRecord<V>(
  opts: EvalCampaignOptions<V>,
  settings: CampaignSettings,
  cell: CampaignCell<V>,
  runId: string,
  outcome: CampaignRunOutcome,
  wallMs: number,
): RunRecord {
  const recordOutcome: RunOutcome = {
    raw: outcome.raw ?? {},
  }
  if (settings.splitTag === 'holdout') recordOutcome.holdoutScore = outcome.score
  else recordOutcome.searchScore = outcome.score
  if (outcome.judgeScores !== undefined) recordOutcome.judgeScores = outcome.judgeScores

  return {
    runId,
    experimentId: opts.campaignId,
    candidateId: cell.variant.id,
    seed: cell.seed,
    model: outcome.model,
    promptHash: outcome.promptHash,
    configHash: outcome.configHash,
    commitSha: opts.commitSha,
    wallMs,
    costUsd: outcome.costUsd,
    costProvenance: outcome.costProvenance,
    tokenUsage: outcome.tokenUsage,
    terminalOutcome: 'succeeded',
    judgeMetadata: outcome.judgeMetadata,
    outcome: recordOutcome,
    ...(outcome.failureClass ? { failureClass: outcome.failureClass } : {}),
    failureMode: outcome.failureMode,
    splitTag: settings.splitTag,
    scenarioId: cell.scenario.scenarioId,
  }
}

/** Resolve the run's agent profile (outcome first, then options) and stamp it on the record. */
async function stampAgentProfile<V>(
  opts: EvalCampaignOptions<V>,
  cell: CampaignCell<V>,
  record: RunRecord,
  runId: string,
  outcome: CampaignRunOutcome,
): Promise<void> {
  const profileSource =
    outcome.agentProfile ??
    (typeof opts.agentProfile === 'function'
      ? await opts.agentProfile({
          campaignId: opts.campaignId,
          runId,
          variantId: cell.variant.id,
          scenarioId: cell.scenario.scenarioId,
          seed: cell.seed,
          variant: cell.variant.payload,
          scenarioTags: cell.scenario.tags ?? {},
        })
      : opts.agentProfile)
  if (profileSource !== undefined) {
    const agentProfile = await resolveAgentProfileCell(profileSource)
    assertAgentProfileMatchesRun(agentProfile, outcome.model, outcome.promptHash)
    record.agentProfile = agentProfile
  }
}

/** Build the optional research report over the successful runs. */
async function buildCampaignReport<V>(
  opts: EvalCampaignOptions<V>,
  settings: CampaignSettings,
  runs: RunRecord[],
): Promise<ResearchReport | undefined> {
  if (!opts.report) return undefined
  const reportOpts: ResearchReportOptions = {
    ...opts.report,
    comparator: opts.report.comparator,
    split: settings.splitTag === 'dev' ? 'search' : settings.splitTag,
    generatedAt: new Date(settings.now()).toISOString(),
    preregistrationHash: settings.preregistrationHash ?? undefined,
  }
  return researchReport(runs, reportOpts)
}

// ── Internal ─────────────────────────────────────────────────────────────

class CellExecutionError extends Error {
  readonly failed: FailedRun
  readonly integrity?: RunIntegrityReport
  constructor(failed: FailedRun, integrity?: RunIntegrityReport) {
    super(`cell ${failed.variantId}/${failed.scenarioId}@${failed.seed} failed: ${failed.reason}`)
    this.failed = failed
    this.integrity = integrity
  }
}

/**
 * Abort a run whose owning work threw or was orphaned by a sibling's genuine
 * error, finalizing the emitter so hooks fire and the store records a terminal
 * status. Safe to call unconditionally: it only aborts runs that are still
 * `running`. Two no-op cases are intentional and benign:
 *
 *   - the run was never started (absent from the store) — nothing to finalize
 *   - the run is already terminal (`completed` / `failed` / `aborted`) —
 *     finalizing again would overwrite the real outcome (e.g. flip a passed run
 *     to `aborted` with `{ pass: false, notes: reason }`), so we leave it alone
 *
 * Any OTHER failure of the store read or the abort write (disk full, FS fault,
 * backend down) is a genuine diagnostic and propagates rather than being
 * swallowed.
 */
async function finalizeAbort(emitter: TraceEmitter, runId: string, reason: string): Promise<void> {
  const existing = await emitter.traceStore.getRun(runId)
  if (existing === undefined) return // run never started; nothing to abort
  if (existing.status !== 'running') return // already finalized; never overwrite a real outcome
  // The emitter never throws on a failed store write; it counts it. A failed
  // abort write is a genuine diagnostic here, so read the count and surface it.
  const droppedBefore = emitter.captureStats().dropped
  await emitter.abortRun(reason)
  const after = emitter.captureStats()
  if (after.dropped > droppedBefore) {
    throw new Error(`finalizeAbort: run ${runId} could not be finalized: ${after.lastError}`)
  }
}

function defaultRawSinkFactory(workDir: string | undefined) {
  return (params: CampaignFactoryParams): RawProviderSink => {
    if (!workDir) {
      throw new Error(
        'runEvalCampaign: rawSinkFactory not supplied and workDir not set. Pass either to enable raw provider capture, or pass `new NoopRawProviderSink()` via rawSinkFactory to opt out explicitly.',
      )
    }
    return new FileSystemRawProviderSink({
      dir: `${workDir}/raw-events/${params.runId}`,
    })
  }
}

async function resolveAgentProfileCell(
  input: AgentProfileCell | AgentProfileCellInput,
): Promise<AgentProfileCell> {
  if (isAgentProfileCell(input)) {
    if (!(await verifyAgentProfileCell(input))) {
      throw new Error(`runEvalCampaign: agentProfile.cellId does not match its content`)
    }
    return input
  }
  return buildAgentProfileCell(input)
}

function isAgentProfileCell(
  input: AgentProfileCell | AgentProfileCellInput,
): input is AgentProfileCell {
  return 'schemaVersion' in input && 'cellId' in input
}

function assertAgentProfileMatchesRun(
  profile: AgentProfileCell,
  model: string,
  promptHash: string,
): void {
  if (profile.model !== undefined && profile.model !== model) {
    throw new Error(
      `runEvalCampaign: agentProfile.model "${profile.model}" does not match outcome.model "${model}"`,
    )
  }
  if (profile.promptHash !== undefined && profile.promptHash !== promptHash) {
    throw new Error(
      `runEvalCampaign: agentProfile.promptHash "${profile.promptHash}" does not match outcome.promptHash "${promptHash}"`,
    )
  }
}

function defaultRunId(params: CampaignFactoryParams): string {
  // Stable across re-runs: fingerprint of (campaignId, variantId, scenarioId, seed).
  // Caller can override via opts.runId for non-deterministic IDs.
  const base = `${params.campaignId}::${params.variantId}::${params.scenarioId}::${params.seed}`
  // TWO 32-bit FNV-1a accumulators with different offsets, concatenated for a
  // 64-bit-wide id. Not crypto-grade; stability and uniqueness are what this
  // needs. Frozen: the value names a persisted cell, and the second
  // accumulator's offset is part of the identity, so no single-accumulator
  // helper can replace it.
  let h1 = 0x811c9dc5
  let h2 = 0x12345678
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x9e3779b1) >>> 0
  }
  return `run-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}
