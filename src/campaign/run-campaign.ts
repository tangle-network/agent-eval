/**
 * `runCampaign` — Pass A substrate primitive. ONE function that orchestrates
 * scenarios → dispatch → artifacts → judges → aggregates, with full
 * reproducibility (seed + manifest hash), cell-level resumability, bootstrap
 * CIs, and the `LabeledScenarioStore` capture flywheel.
 *
 * Improvement loops (optimizer / gate / autoOnPromote) ride on top of this
 * primitive but live in `presets/run-improvement-loop.ts`. This file keeps
 * the core orchestrator minimal — Phase 1 of the Pass A track.
 */

import { mapConcurrent } from '../concurrency'
import type { CostLedgerHandle, CostLedgerSummary } from '../cost-ledger'
import { compareCodeUnits } from '../ledger-core/canonical'
import { computeManifestHash, dispatchRefFor } from './campaign-manifest'
import { computeAggregates } from './cell-aggregates'
import { assertScheduleCachesReusable } from './cell-cache'
import { buildCellSchedule } from './cell-schedule'
import { assertCampaignDesign, campaignScenarioIdentity, campaignSplitDigest } from './coverage'
import {
  type CellFailure,
  defaultBuildTraceWriter,
  type ExecuteCellResult,
  executeCell,
} from './execute-cell'
import { resolveRunDir } from './run-dir'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from './storage'
import type {
  CampaignCellResult,
  CampaignResult,
  CampaignTraceWriter,
  DispatchFn,
  JudgeConfig,
  LabeledScenarioStore,
  Scenario,
} from './types'

export {
  type CampaignRunPlan,
  type CampaignRunPlanCell,
  type PlanCampaignRunOptions,
  planCampaignRun,
} from './plan-campaign-run'

export interface RunCampaignOptions<TScenario extends Scenario, TArtifact> {
  scenarios: TScenario[]
  dispatch: DispatchFn<TScenario, TArtifact>
  /** Abort active dispatches when the owning operation is cancelled. */
  signal?: AbortSignal
  /**
   * Stable identity for the dispatch behavior, included in the manifest/cache
   * key. Set this when the same function name can run different models,
   * prompts, tools, or external config.
   */
  dispatchRef?: string
  judges?: JudgeConfig<TArtifact, TScenario>[]
  /** Required for reproducibility. Default 42. */
  seed?: number
  /** Per-scenario replicates for CI bands. Default 1; raise to 5+ for
   *  bootstrap-tight intervals on critical eval. */
  reps?: number
  /** When true (default), completed cells are cached by
   *  (manifestHash, scenarioId, rep, generation). Re-runs skip cached cells. */
  resumable?: boolean
  /**
   * Optional explicit cell selection. The campaign manifest and split digest
   * still describe the complete declared scenario × replicate design; this
   * only limits the rows executed by this invocation.
   */
  cellFilter?: (input: { scenario: TScenario; rep: number }) => boolean
  /**
   * Reuse a cached cell that has an error instead of dispatching it again.
   * The default retries failed cells, preserving normal campaign behaviour.
   */
  reuseFailedCells?: boolean
  /**
   * Explicitly rerun only cached cells whose saved result is unreadable or
   * has missing/invalid cost provenance. Valid cached cells remain reusable.
   * Default false refuses to begin work when any such cache entry exists.
   */
  rerunInvalidCachedCells?: boolean
  /** Optional store — when present, every artifact + judge score is captured
   *  with the configured `captureSource`. Capture is default ON; pass `'off'`
   *  to disable. */
  labeledStore?: LabeledScenarioStore | 'off'
  captureSource?: 'production-trace' | 'eval-run' | 'manual' | 'red-team' | 'synthetic'
  captureSourceVersionHash?: string
  /** Hard spend cap. Each paid call reserves its enforced maximum before dispatch. */
  costCeiling?: number
  /** Shared spend account. Improvement loops pass one ledger through every
   *  campaign so the ceiling and returned total are run-wide. */
  costLedger?: CostLedgerHandle
  /** Attribution label for receipts recorded by this campaign. */
  costPhase?: string
  /** Additional immutable receipt tags supplied by an owning workflow. */
  costTags?: Readonly<Record<string, string>>
  /** Max concurrent cells. Default 2. */
  maxConcurrency?: number
  /**
   * Stop after the first dispatch or judge error. The failed cell is persisted
   * before active sibling cells are aborted and drained, then the campaign
   * rejects with the exact error thrown by that dispatch or judge.
   * Default false preserves the normal behavior of returning failed cells and
   * continuing the remaining schedule.
   * With `cellRetry`, a retryable failure is not an error yet: this abort
   * fires only when a cell's final attempt fails.
   */
  abortOnCellError?: boolean
  /**
   * Opt-in bounded in-run retry of a failed cell. Absent by default: a failed
   * cell is final on its first attempt. A retried attempt re-runs the SAME
   * slot — same `cellId`, same `seed`, same cost tags — so the schedule,
   * manifest, and pairing are unchanged. An attempt that failed because the
   * campaign was cancelled is never retried.
   */
  cellRetry?: CampaignCellRetryPolicy<TArtifact>
  /** Once per final persisted cell, including cache hits, in completion order. */
  onCellSettled?: (cell: CampaignCellResult<TArtifact>, scenario: TScenario) => void | Promise<void>
  /**
   * Per-cell dispatch deadline in ms. A `dispatch` that neither resolves nor
   * rejects within this window is a hang (a stalled model request, an
   * exhausted runtime resource, a backend that never closes its stream). When
   * set, the cell's `ctx.signal` is aborted. A dispatch that stops is recorded
   * as an error (`dispatch exceeded <N>ms`). A dispatch that ignores
   * cancellation rejects the campaign without publishing incomplete cost data.
   * `undefined`/`0` means unbounded.
   */
  dispatchTimeoutMs?: number
  /**
   * Time allowed for an aborted dispatch and its paid calls to stop before the
   * campaign rejects without producing a result. Default 5 seconds.
   */
  dispatchShutdownTimeoutMs?: number
  /** Required: where artifacts + traces land. A bare name (not an absolute path)
   *  resolves to the shared `~/.tangle/traces/<repo>/runs/<name>` root so run
   *  bundles never pollute a repo working tree. Pass an absolute path to override. */
  runDir: string
  /** Subject repo for the shared run-dir root (defaults to the CWD basename).
   *  Only consulted when `runDir` is a bare name. */
  repo?: string
  /** Tracing posture. Default is the substrate's `FileSystemTraceStore` rooted
   *  at `<runDir>/traces/`. `'off'` disables capture entirely — substrate
   *  refuses this when the caller wires `autoOnPromote !== 'none'`. */
  tracing?: 'on' | 'off'
  /**
   * Per-cell usage expectation — the early, fine-grained sibling of the
   * batch `assertRealBackend` guard. A cell that produced an artifact (no
   * error) but reported `costUsd === 0` AND zero tokens is a stub: the
   * dispatch never reported LLM activity via `ctx.cost`. Modes:
   *   - `'warn'` (default) — log the offending cell loudly, keep going.
   *   - `'assert'` — throw `BackendIntegrityError` on the first such cell
   *     (fail-fast; recommended for CI campaigns expecting real LLM calls).
   *   - `'off'` — no check (replay / deterministic-only / offline analysis).
   */
  expectUsage?: 'assert' | 'warn' | 'off'
  /** Test seam — override the wall clock for deterministic tests. */
  now?: () => Date
  /** Override the trace writer. The supplied directory belongs to this attempt. */
  buildTraceWriter?: (cellId: string, dir: string) => CampaignTraceWriter
  /** Storage backend for run/cell dirs, the resumability cache, artifacts,
   *  and trace spans. Default: the Node filesystem (`fsCampaignStorage`).
   *  Pass `inMemoryCampaignStorage()` to run in a filesystem-less runtime
   *  (Cloudflare Workers, Deno, edge) — the `CampaignResult` is still
   *  produced; artifacts/traces just aren't persisted to disk. */
  storage?: CampaignStorage
  /**
   * Optional per-cell placement strategy. Returns an opaque string the
   * substrate forwards as `ctx.placement` to the Dispatch — placement-aware
   * Dispatches (e.g. `httpDispatch` from `/adapters/http`) use it to route
   * each cell to the right worker, region, or sandbox. When unset, every
   * cell receives `ctx.placement = undefined` and behaves identically to
   * the in-process case.
   *
   * @example
   *   cellPlacement: ({ scenario }) => scenario.tags?.includes('eu') ? 'eu-west' : 'us-east'
   */
  cellPlacement?: (input: {
    scenario: TScenario
    rep: number
    generation?: number
  }) => string | undefined
}

/** Durable `<attempt>/failure-receipt.json` written before a failed cell can
 * trigger campaign-wide cancellation. The cell records dispatch measurements;
 * `cost` covers every settled agent and judge call attributed to this exact run
 * attempt. */
export interface CampaignCellFailureReceipt<TArtifact = unknown> {
  schemaVersion: 1
  runAttemptId: string
  recordedAt: string
  failure: {
    stage: 'dispatch' | 'judge'
    judge?: string
    error: {
      name: string
      message: string
      stack?: string
    }
  }
  cell: CampaignCellResult<TArtifact>
  cost: CostLedgerSummary
}

/**
 * Bounded in-run retry of failed cells. Every attempt dispatches the same
 * slot and charges the shared cost ledger, so the final cell's `costUsd`,
 * `tokenUsage`, and `costCallIds` cover all attempts. Each retried attempt
 * keeps its artifacts, trace, result, and failure receipt in a separate
 * execution directory, including attempts resumed in a later invocation.
 * The final cell records the retry count as `retryAttempts`.
 */
export interface CampaignCellRetryPolicy<TArtifact = unknown> {
  /** Total attempts per cell, including the first. A positive safe integer. */
  attempts: number
  /** Decides whether a failed attempt is dispatched again. Receives the
   *  receipt's `failure` record. `transientDispatchFailure()` is the
   *  ready-made predicate for infrastructure hiccups (502/503/504, dropped
   *  streams, admission rejections). */
  retryable: (failure: CampaignCellFailureReceipt['failure']) => boolean
  /** Retry a measured artifact without classifying it as a dispatch failure. */
  retryResult?: (artifact: TArtifact) => boolean
}

/**
 * Core campaign orchestrator: fan scenarios through dispatch, score with judges, aggregate bootstrap CIs, and persist reproducible `CampaignResult` records.
 */
export async function runCampaign<TScenario extends Scenario, TArtifact>(
  opts: RunCampaignOptions<TScenario, TArtifact>,
): Promise<CampaignResult<TArtifact, TScenario>> {
  const seed = opts.seed ?? 42
  const reps = opts.reps ?? 1
  const resumable = opts.resumable ?? true
  const now = opts.now ?? (() => new Date())
  const judges = opts.judges ?? []
  const storage = opts.storage ?? fsCampaignStorage()
  const costPhase = opts.costPhase ?? 'campaign'
  const dispatchShutdownTimeoutMs = opts.dispatchShutdownTimeoutMs ?? 5_000

  assertCampaignDesign(opts.scenarios, reps)
  if (!Number.isSafeInteger(dispatchShutdownTimeoutMs) || dispatchShutdownTimeoutMs <= 0) {
    throw new Error('runCampaign: dispatchShutdownTimeoutMs must be a positive safe integer')
  }
  const cellRetry = opts.cellRetry
  if (cellRetry !== undefined) {
    if (!Number.isSafeInteger(cellRetry.attempts) || cellRetry.attempts < 1) {
      throw new Error(
        'runCampaign: cellRetry.attempts must be a positive safe integer (total attempts, including the first)',
      )
    }
    if (typeof cellRetry.retryable !== 'function') {
      throw new Error('runCampaign: cellRetry.retryable must be a function')
    }
    if (cellRetry.retryResult !== undefined && typeof cellRetry.retryResult !== 'function') {
      throw new Error('runCampaign: cellRetry.retryResult must be a function')
    }
  }

  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('runCampaign: runDir is required and must be a non-empty string')
  }
  opts.runDir = resolveRunDir(opts.runDir, opts.repo)
  storage.ensureDir(opts.runDir)
  const costLedger =
    opts.costLedger ??
    createRunCostLedger({
      storage,
      runDir: opts.runDir,
      costCeilingUsd: opts.costCeiling,
    })
  if (opts.costCeiling !== undefined && costLedger.costCeilingUsd !== opts.costCeiling) {
    throw new Error('runCampaign: costCeiling must match the shared CostLedger ceiling')
  }
  const maxConcurrency = opts.maxConcurrency ?? 2

  const manifestHash = computeManifestHash({
    scenarios: opts.scenarios,
    judges: judges as unknown as JudgeConfig<unknown>[],
    dispatchRef: dispatchRefFor(opts.dispatch, opts.dispatchRef),
    seed,
    reps,
  })
  const splitDigest = campaignSplitDigest(opts.scenarios, reps)

  const startedAt = now()
  const runAttemptId = globalThis.crypto.randomUUID()
  const cells: CampaignCellResult<TArtifact>[] = []
  const artifactsByPath: Record<string, string> = {}

  // Build the cell schedule (scenario × rep).
  const schedule = buildCellSchedule(opts.scenarios, seed, reps).filter((slot) =>
    opts.cellFilter ? opts.cellFilter({ scenario: slot.scenario, rep: slot.rep }) : true,
  )

  if (resumable) {
    // Execution reads each cache again so another process cannot replace a
    // checked file between this whole-schedule refusal and per-cell reuse.
    assertScheduleCachesReusable({
      schedule,
      runDir: opts.runDir,
      manifestHash,
      storage,
      costLedger,
      costTags: opts.costTags,
      rerunInvalidCachedCells: opts.rerunInvalidCachedCells ?? false,
    })
  }

  // Concurrency-limited execution.
  const campaignAbort = new AbortController()
  const onOwnerAbort = (): void => campaignAbort.abort(opts.signal?.reason)
  if (opts.signal?.aborted) campaignAbort.abort(opts.signal.reason)
  else opts.signal?.addEventListener('abort', onOwnerAbort, { once: true })
  const campaignSignal = campaignAbort.signal
  const cellsRef = cells
  let firstLaneFailure: { cause: unknown } | undefined
  let firstCellFailure: CellFailure | undefined
  try {
    await mapConcurrent(
      schedule,
      maxConcurrency,
      async (slot, _index, signal) => {
        try {
          let attempt = 1
          let result: ExecuteCellResult<TArtifact>
          while (true) {
            result = await executeCell({
              slot,
              opts,
              manifestHash,
              resumable,
              now,
              storage,
              buildTraceWriter: opts.buildTraceWriter ?? defaultBuildTraceWriter(storage),
              signal,
              dispatchTimeoutMs: opts.dispatchTimeoutMs,
              dispatchShutdownTimeoutMs,
              costLedger,
              costPhase,
              runAttemptId,
              attempt,
              cellRetry,
              onFailure: opts.abortOnCellError
                ? (failure) => {
                    if (firstCellFailure === undefined) {
                      firstCellFailure = failure
                      campaignAbort.abort(failure.cause)
                    }
                  }
                : undefined,
            })
            Object.assign(artifactsByPath, result.artifactsByPath)
            if (!result.retry) break
            attempt += 1
          }
          cellsRef.push(result.cell)
          await opts.onCellSettled?.(result.cell, slot.scenario)
          if (opts.labeledStore && opts.labeledStore !== 'off' && !result.cell.error) {
            await opts.labeledStore
              .observe({
                scenario: slot.scenario,
                artifact: result.cell.artifact,
                judgeScores: result.cell.judgeScores,
                source: opts.captureSource ?? 'eval-run',
                sourceVersionHash: opts.captureSourceVersionHash ?? 'unknown',
                capturedAt: now().toISOString(),
                redactionStatus: 'raw',
              })
              .catch((error) => {
                console.warn(
                  `[runCampaign] capture failed for ${result.cell.cellId}: ${error instanceof Error ? error.message : String(error)}`,
                )
              })
          }
        } catch (error) {
          firstLaneFailure ??= { cause: error }
          campaignAbort.abort(error)
          throw error
        }
      },
      campaignSignal,
    )
  } catch (error) {
    if (firstCellFailure) throw firstCellFailure.cause
    if (firstLaneFailure) throw firstLaneFailure.cause
    // Owner cancellation returns the settled prefix, as the campaign always has.
    if (!opts.signal?.aborted) throw error
  } finally {
    opts.signal?.removeEventListener('abort', onOwnerAbort)
  }

  const endedAt = now()
  cellsRef.sort((a, b) => compareCodeUnits(a.cellId, b.cellId))

  const campaignCost = costLedger.summary({ tags: { runDir: opts.runDir } })
  const aggregates = computeAggregates(
    cellsRef,
    judges as unknown as JudgeConfig<TArtifact>[],
    seed,
    campaignCost,
  )

  return {
    manifestHash,
    splitDigest,
    seed,
    reps,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    cells: cellsRef,
    aggregates,
    runDir: opts.runDir,
    artifactsByPath,
    scenarios: opts.scenarios.map(campaignScenarioIdentity),
  }
}
