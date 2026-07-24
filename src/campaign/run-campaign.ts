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

import { join } from 'node:path'
import {
  CostAccountingIncompleteError,
  type CostLedgerHandle,
  type CostLedgerSummary,
} from '../cost-ledger'
import { BackendIntegrityError, type BackendIntegrityReport } from '../integrity/backend-integrity'
import { confidenceInterval } from '../statistics'
import { contentHash } from '../verdict-cache'
import { assertCampaignDesign, campaignScenarioIdentity, campaignSplitDigest } from './coverage'
import { resolveRunDir } from './run-dir'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from './storage'
import type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
  CampaignTokenUsage,
  CampaignTraceWriter,
  DispatchContext,
  DispatchFn,
  JudgeAggregate,
  JudgeConfig,
  JudgeScore,
  LabeledScenarioStore,
  Scenario,
  ScenarioAggregate,
  TraceSpan,
} from './types'

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
   */
  abortOnCellError?: boolean
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
  /** Test seam — override per-cell trace writer factory. */
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

/** Durable `<cell>/failure-receipt.json` written before a failed cell can
 * trigger campaign-wide cancellation. The cell keeps its dispatch-only usage
 * fields for compatibility; `cost` covers every settled agent and judge call
 * attributed to this exact run attempt. */
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
  const schedule = buildCellSchedule(opts.scenarios, seed, reps)

  // Concurrency-limited execution.
  const campaignAbort = new AbortController()
  const onOwnerAbort = (): void => campaignAbort.abort(opts.signal?.reason)
  if (opts.signal?.aborted) campaignAbort.abort(opts.signal.reason)
  else opts.signal?.addEventListener('abort', onOwnerAbort, { once: true })
  const campaignSignal = campaignAbort.signal
  // Concurrency lanes that drain the cell schedule. Named "lanes" — not
  // "workers" — to avoid clashing with the taxonomy's worker (= the agent
  // harness in a sandbox, invoked behind `dispatch`). See loop-taxonomy.md.
  const lanes: Promise<void>[] = []
  let nextIdx = 0
  const cellsRef = cells
  let firstLaneError: unknown
  let firstCellFailure: CellFailure | undefined

  for (let i = 0; i < maxConcurrency; i++) {
    lanes.push(
      (async () => {
        try {
          while (true) {
            if (campaignSignal.aborted) return
            const myIdx = nextIdx++
            if (myIdx >= schedule.length) return
            const slot = schedule[myIdx]!
            const result = await executeCell({
              slot,
              opts,
              manifestHash,
              resumable,
              now,
              storage,
              buildTraceWriter: opts.buildTraceWriter ?? defaultBuildTraceWriter(storage),
              signal: campaignSignal,
              dispatchTimeoutMs: opts.dispatchTimeoutMs,
              dispatchShutdownTimeoutMs,
              costLedger,
              costPhase,
              runAttemptId,
              onFailure: opts.abortOnCellError
                ? (failure) => {
                    if (firstCellFailure === undefined) {
                      firstCellFailure = failure
                      campaignAbort.abort(failure.cause)
                    }
                  }
                : undefined,
            })
            cellsRef.push(result.cell)
            Object.assign(artifactsByPath, result.artifactsByPath)
            // Capture into LabeledScenarioStore unless explicitly disabled.
            if (opts.labeledStore && opts.labeledStore !== 'off' && !result.cell.error) {
              await captureToStore({
                store: opts.labeledStore,
                cell: result.cell,
                scenario: slot.scenario,
                opts,
                now,
              }).catch((err) => {
                // Capture failures are non-fatal — log but don't crash the campaign.
                // (Trace would normally land here.)
                console.warn(
                  `[runCampaign] capture failed for ${result.cell.cellId}: ${err instanceof Error ? err.message : String(err)}`,
                )
              })
            }
            if (opts.abortOnCellError && result.failure) {
              return
            }
          }
        } catch (error) {
          if (firstLaneError === undefined) {
            firstLaneError = error
            campaignAbort.abort(error)
          }
          throw error
        }
      })(),
    )
  }
  const laneResults = await Promise.allSettled(lanes)
  opts.signal?.removeEventListener('abort', onOwnerAbort)
  const failedLane = laneResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (firstCellFailure) throw firstCellFailure.cause
  if (failedLane) throw firstLaneError ?? failedLane.reason

  const endedAt = now()
  cellsRef.sort((a, b) => a.cellId.localeCompare(b.cellId))

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

// ── Internals ─────────────────────────────────────────────────────────

interface ExecuteCellArgs<TScenario extends Scenario, TArtifact> {
  slot: { scenario: TScenario; rep: number; cellId: string; cellSeed: number }
  opts: RunCampaignOptions<TScenario, TArtifact>
  manifestHash: string
  resumable: boolean
  now: () => Date
  storage: CampaignStorage
  buildTraceWriter: (cellId: string, dir: string) => CampaignTraceWriter
  signal: AbortSignal
  dispatchTimeoutMs?: number
  dispatchShutdownTimeoutMs: number
  costLedger: CostLedgerHandle
  costPhase: string
  runAttemptId: string
  onFailure?: (failure: CellFailure) => void
}

interface CellFailure {
  stage: 'dispatch' | 'judge'
  judge?: string
  cause: unknown
}

interface ExecuteCellResult<TArtifact> {
  cell: CampaignCellResult<TArtifact>
  artifactsByPath: Record<string, string>
  failure?: CellFailure
}

async function executeCell<TScenario extends Scenario, TArtifact>(
  args: ExecuteCellArgs<TScenario, TArtifact>,
): Promise<ExecuteCellResult<TArtifact>> {
  const storage = args.storage
  const cellDir = join(args.opts.runDir, args.slot.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  storage.ensureDir(cellDir)
  const stableCostTags = {
    ...(args.opts.costTags ?? {}),
    runDir: args.opts.runDir,
    cellId: args.slot.cellId,
    scenarioId: args.slot.scenario.id,
    rep: String(args.slot.rep),
  }
  const costTags = { ...stableCostTags, runAttemptId: args.runAttemptId }

  // Resumability: cache key = (manifestHash, scenarioId, rep)
  const cachePath = join(cellDir, 'cached-result.json')
  if (args.resumable) {
    const cached = readCachedCell<TArtifact>({
      storage,
      cachePath,
      cellId: args.slot.cellId,
      manifestHash: args.manifestHash,
    })
    if (cached.status === 'hit') {
      enforceDispatchUsage(cached.cell, args.opts.expectUsage ?? 'warn')
      const cachedHasUsage =
        cached.cell.costUsd > 0 ||
        cached.cell.tokenUsage.input > 0 ||
        cached.cell.tokenUsage.output > 0
      if (cached.cell.costCallIds === undefined) {
        if (cachedHasUsage || Object.keys(cached.cell.judgeScores).length > 0) {
          throw new CostAccountingIncompleteError(
            `runCampaign: cached cell '${args.slot.cellId}' does not identify its ledger receipts`,
          )
        }
      } else if (
        !Array.isArray(cached.cell.costCallIds) ||
        cached.cell.costCallIds.some(
          (callId) => typeof callId !== 'string' || callId.trim().length === 0,
        ) ||
        new Set(cached.cell.costCallIds).size !== cached.cell.costCallIds.length
      ) {
        throw new CostAccountingIncompleteError(
          `runCampaign: cached cell '${args.slot.cellId}' has invalid ledger receipt IDs`,
        )
      } else {
        const restoredCallIds = new Set(
          args.costLedger.list({ tags: stableCostTags }).map((receipt) => receipt.callId),
        )
        const missingCallIds = cached.cell.costCallIds.filter(
          (callId) => !restoredCallIds.has(callId),
        )
        if (missingCallIds.length > 0) {
          throw new CostAccountingIncompleteError(
            `runCampaign: cached cell '${args.slot.cellId}' is missing ledger receipt(s): ${missingCallIds.join(', ')}`,
          )
        }
      }
      return { cell: { ...cached.cell, cached: true }, artifactsByPath: {} }
    }
  }

  const startMs = Date.now()
  const trace = args.buildTraceWriter(args.slot.cellId, cellDir)
  const artifactsByPath: Record<string, string> = {}
  let paidCallStarted = false
  const artifacts: CampaignArtifactWriter = {
    async write(path, content) {
      const fullPath = join(cellDir, path)
      storage.ensureDir(join(fullPath, '..'))
      storage.write(fullPath, content)
      artifactsByPath[`${args.slot.cellId}/${path}`] = fullPath
      return fullPath
    },
    async writeJson(path, value) {
      return artifacts.write(path, JSON.stringify(value, null, 2))
    },
  }
  const cost: CampaignCostMeter = {
    async runPaidCall(input) {
      paidCallStarted = true
      const result = await args.costLedger.runPaidCall({
        ...input,
        channel: input.channel ?? 'agent',
        phase: args.costPhase,
        actor: input.actor,
        tags: costTags,
        signal: cellAbort.signal,
      })
      if (result.receipt) {
        trace.span(`cost.${result.receipt.actor}`, { amountUsd: result.receipt.costUsd }).end()
      }
      return result
    },
  }

  const placement = args.opts.cellPlacement?.({
    scenario: args.slot.scenario,
    rep: args.slot.rep,
  })

  // Per-cell abort signal, chained to the campaign signal. The dispatch sees
  // THIS signal so a timeout (below) can abort just this cell's in-flight work
  // without tearing down sibling cells — and a signal-honoring dispatch
  // releases its open request instead of leaking it past the deadline.
  const cellAbort = new AbortController()
  const onCampaignAbort = () => cellAbort.abort((args.signal as { reason?: unknown }).reason)
  if (args.signal.aborted) cellAbort.abort((args.signal as { reason?: unknown }).reason)
  else args.signal.addEventListener('abort', onCampaignAbort, { once: true })

  const ctx: DispatchContext = {
    cellId: args.slot.cellId,
    rep: args.slot.rep,
    seed: args.slot.cellSeed,
    signal: cellAbort.signal,
    trace,
    artifacts,
    cost,
    placement,
  }

  let artifact: TArtifact | undefined
  let errorMessage: string | undefined
  let failure: CellFailure | undefined
  let fatalCellError: unknown
  let dispatched: Promise<TArtifact> | undefined
  const timeoutMs = args.dispatchTimeoutMs
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: () => void = () => undefined
  try {
    dispatched = Promise.resolve(args.opts.dispatch(args.slot.scenario, ctx))
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => {
        const reason = cellAbort.signal.reason
        reject(reason instanceof Error ? reason : new Error(String(reason ?? 'dispatch aborted')))
      }
      if (cellAbort.signal.aborted) {
        rejectAbort()
        return
      }
      cellAbort.signal.addEventListener('abort', rejectAbort, { once: true })
      removeAbortListener = () => cellAbort.signal.removeEventListener('abort', rejectAbort)
    })
    if (timeoutMs !== undefined && timeoutMs > 0) {
      // A dispatch that never settles (stalled model request, exhausted runtime
      // resource, a stream that never closes) must NOT hang the cell — and with
      // it the lane, the campaign, the loop, the CI job — forever. Race it
      // against the deadline; on timeout, abort the cell and fail it LOUD.
      artifact = await Promise.race([
        dispatched,
        aborted,
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            const timeoutError = new Error(
              `dispatch exceeded ${timeoutMs}ms for cell '${args.slot.cellId}' — aborted and failed loud (no silent hang)`,
            )
            reject(timeoutError)
            cellAbort.abort(timeoutError)
          }, timeoutMs)
          if (typeof (timeoutTimer as { unref?: () => void }).unref === 'function')
            (timeoutTimer as { unref: () => void }).unref()
        }),
      ])
    } else {
      artifact = await Promise.race([dispatched, aborted])
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
    failure = { stage: 'dispatch', cause: err }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    removeAbortListener()
    args.signal.removeEventListener('abort', onCampaignAbort)
  }

  if (dispatched) {
    const dispatchSettled = await settlesWithin(dispatched, args.dispatchShutdownTimeoutMs)
    if (!dispatchSettled) {
      await trace.flush()
      throw new CostAccountingIncompleteError(
        `dispatch for cell '${args.slot.cellId}' ignored cancellation and did not stop within ${args.dispatchShutdownTimeoutMs}ms; no campaign result was produced`,
      )
    }
  }
  if (paidCallStarted) {
    if (typeof args.costLedger.waitForIdle !== 'function') {
      await trace.flush()
      throw new CostAccountingIncompleteError(
        `cost ledger for cell '${args.slot.cellId}' cannot prove that paid calls stopped`,
      )
    }
    const paidCallsSettled = await args.costLedger.waitForIdle({
      timeoutMs: args.dispatchShutdownTimeoutMs,
      filter: { channel: 'agent', phase: args.costPhase, tags: costTags },
    })
    if (!paidCallsSettled) {
      await trace.flush()
      throw new CostAccountingIncompleteError(
        `paid calls for cell '${args.slot.cellId}' did not settle within ${args.dispatchShutdownTimeoutMs}ms; no campaign result was produced`,
      )
    }
  }

  const agentReceipts = args.costLedger.list({ channel: 'agent', tags: costTags })
  const agentCost = args.costLedger.summary({ channel: 'agent', tags: costTags })
  const tokenUsage: CampaignTokenUsage = {
    input: agentCost.inputTokens,
    output: agentCost.outputTokens,
    ...(agentCost.cachedTokens > 0 ? { cached: agentCost.cachedTokens } : {}),
  }
  const resolvedModel = agentReceipts.at(-1)?.model
  const dispatchResult = {
    cellId: args.slot.cellId,
    artifact,
    error: errorMessage,
    costUsd: agentCost.totalCostUsd,
    tokenUsage,
  }
  try {
    enforceDispatchUsage(dispatchResult, args.opts.expectUsage ?? 'warn')
  } catch (error) {
    await trace.flush()
    throw error
  }

  // Run judges (only if we have an artifact). A judge that throws invalidates
  // the cell — recorded as `error`, NOT folded into a fake composite:0 (a fake
  // zero is indistinguishable from a real zero and poisons every aggregate).
  const judgeScores: Record<string, JudgeScore> = {}
  if (artifact !== undefined) {
    for (const judge of args.opts.judges ?? []) {
      if (judge.appliesTo && !judge.appliesTo(args.slot.scenario)) continue
      try {
        const score = await runJudgeCell(judge, {
          artifact,
          scenario: args.slot.scenario,
          signal: args.signal,
          costLedger: args.costLedger,
          costPhase: args.costPhase,
          costTags,
        })
        judgeScores[judge.name] = score
      } catch (err) {
        errorMessage = `judge '${judge.name}' failed: ${err instanceof Error ? err.message : String(err)}`
        failure = { stage: 'judge', judge: judge.name, cause: err }
        if (err instanceof CostAccountingIncompleteError) fatalCellError = err
        break
      }
    }
  }

  if (failure) {
    await waitForFailedCellCostSettlement({
      costLedger: args.costLedger,
      costPhase: args.costPhase,
      costTags,
      cellId: args.slot.cellId,
      timeoutMs: args.dispatchShutdownTimeoutMs,
    })
  }
  const costCallIds = args.costLedger
    .list({ tags: costTags })
    .map((receipt) => receipt.callId)
    .sort()

  const cell: CampaignCellResult<TArtifact> = {
    manifestHash: args.manifestHash,
    cellId: args.slot.cellId,
    scenarioId: args.slot.scenario.id,
    rep: args.slot.rep,
    artifact: (artifact ?? null) as TArtifact,
    judgeScores,
    costUsd: agentCost.totalCostUsd,
    costEstimated: agentReceipts.some(
      (receipt) => receipt.actualCostUsd === undefined && !receipt.costUnknown,
    ),
    costCallIds,
    tokenUsage,
    ...(resolvedModel ? { resolvedModel } : {}),
    durationMs: Date.now() - startMs,
    seed: args.slot.cellSeed,
    cached: false,
    error: errorMessage,
  }

  if (failure) {
    const failurePath = join(cellDir, 'failure-receipt.json')
    const receipt: CampaignCellFailureReceipt<TArtifact> = {
      schemaVersion: 1,
      runAttemptId: args.runAttemptId,
      recordedAt: args.now().toISOString(),
      failure: {
        stage: failure.stage,
        ...(failure.judge ? { judge: failure.judge } : {}),
        error: serializeCellError(failure.cause),
      },
      cell,
      cost: args.costLedger.summary({ phase: args.costPhase, tags: costTags }),
    }
    storage.write(failurePath, JSON.stringify(receipt, null, 2))
    artifactsByPath[`${args.slot.cellId}/failure-receipt.json`] = failurePath
    args.onFailure?.(failure)
  }

  await trace.flush()

  if (!errorMessage && args.resumable) {
    storage.write(cachePath, JSON.stringify(cell))
  }

  if (fatalCellError !== undefined) throw fatalCellError
  return { cell, artifactsByPath, ...(failure ? { failure } : {}) }
}

async function waitForFailedCellCostSettlement(input: {
  costLedger: CostLedgerHandle
  costPhase: string
  costTags: Record<string, string>
  cellId: string
  timeoutMs: number
}): Promise<void> {
  const filter = { phase: input.costPhase, tags: input.costTags }
  if (input.costLedger.summary(filter).pendingCalls === 0) return
  if (typeof input.costLedger.waitForIdle !== 'function') {
    throw new CostAccountingIncompleteError(
      `cost ledger for failed cell '${input.cellId}' cannot prove that paid calls stopped`,
    )
  }
  const settled = await input.costLedger.waitForIdle({
    timeoutMs: input.timeoutMs,
    filter,
  })
  if (!settled || input.costLedger.summary(filter).pendingCalls > 0) {
    throw new CostAccountingIncompleteError(
      `paid calls for failed cell '${input.cellId}' did not settle within ${input.timeoutMs}ms; no complete failure receipt was produced`,
    )
  }
}

function serializeCellError(error: unknown): {
  name: string
  message: string
  stack?: string
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  return { name: 'NonErrorThrown', message: String(error) }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let completed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: boolean): void => {
      if (completed) return
      completed = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    promise.then(
      () => finish(true),
      () => finish(true),
    )
  })
}

export interface CampaignRunPlanCell {
  cellId: string
  scenarioId: string
  rep: number
  seed: number
  cachePath: string
  status: 'cached' | 'run'
  reason?: 'missing' | 'manifest-mismatch' | 'cell-mismatch' | 'corrupt' | 'resumable-off'
}

export interface CampaignRunPlan {
  manifestHash: string
  splitDigest: `sha256:${string}`
  totalCells: number
  cellsCached: number
  cellsToRun: number
  cells: CampaignRunPlanCell[]
}

export interface PlanCampaignRunOptions<TScenario extends Scenario, TArtifact> {
  scenarios: TScenario[]
  dispatch?: DispatchFn<TScenario, TArtifact>
  dispatchRef?: string
  judges?: JudgeConfig<TArtifact, TScenario>[]
  seed?: number
  reps?: number
  resumable?: boolean
  runDir: string
  /** Subject repo for the shared run-dir root (see RunCampaignOptions.repo). */
  repo?: string
  storage?: CampaignStorage
}

/**
 * Plan a campaign WITHOUT dispatching: computes the manifest hash and the per-cell
 * run-vs-cached schedule so callers can preview cost and resumability before spending.
 */
export function planCampaignRun<TScenario extends Scenario, TArtifact>(
  opts: PlanCampaignRunOptions<TScenario, TArtifact>,
): CampaignRunPlan {
  const seed = opts.seed ?? 42
  const reps = opts.reps ?? 1
  const resumable = opts.resumable ?? true
  const storage = opts.storage ?? fsCampaignStorage()

  assertCampaignDesign(opts.scenarios, reps)

  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('planCampaignRun: runDir is required and must be a non-empty string')
  }
  opts.runDir = resolveRunDir(opts.runDir, opts.repo)

  const manifestHash = computeManifestHash({
    scenarios: opts.scenarios,
    judges: (opts.judges ?? []) as unknown as JudgeConfig<unknown>[],
    dispatchRef: dispatchRefFor(opts.dispatch, opts.dispatchRef),
    seed,
    reps,
  })
  const splitDigest = campaignSplitDigest(opts.scenarios, reps)

  const cells = buildCellSchedule(opts.scenarios, seed, reps).map((slot): CampaignRunPlanCell => {
    const cachePath = join(
      opts.runDir,
      slot.cellId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      'cached-result.json',
    )
    if (!resumable) {
      return {
        cellId: slot.cellId,
        scenarioId: slot.scenario.id,
        rep: slot.rep,
        seed: slot.cellSeed,
        cachePath,
        status: 'run',
        reason: 'resumable-off',
      }
    }

    const cached = readCachedCell<unknown>({
      storage,
      cachePath,
      cellId: slot.cellId,
      manifestHash,
    })
    if (cached.status === 'hit') {
      return {
        cellId: slot.cellId,
        scenarioId: slot.scenario.id,
        rep: slot.rep,
        seed: slot.cellSeed,
        cachePath,
        status: 'cached',
      }
    }

    return {
      cellId: slot.cellId,
      scenarioId: slot.scenario.id,
      rep: slot.rep,
      seed: slot.cellSeed,
      cachePath,
      status: 'run',
      reason: cached.reason,
    }
  })

  const cellsCached = cells.filter((cell) => cell.status === 'cached').length
  return {
    manifestHash,
    splitDigest,
    totalCells: cells.length,
    cellsCached,
    cellsToRun: cells.length - cellsCached,
    cells,
  }
}

/**
 * Per-dispatch stub guard. An artifact produced with `costUsd === 0` AND zero
 * tokens means the dispatch never called `ctx.cost` —
 * i.e. it ran against a stub or silently dropped its usage. `'warn'` logs it,
 * `'assert'` throws (fail-fast), and `'off'` skips the check.
 */
function enforceDispatchUsage(
  cell: Pick<
    CampaignCellResult<unknown>,
    'cellId' | 'artifact' | 'error' | 'costUsd' | 'tokenUsage'
  >,
  mode: 'assert' | 'warn' | 'off',
): void {
  if (mode === 'off') return
  if (cell.artifact === null || cell.artifact === undefined) return
  const zeroTokens = cell.tokenUsage.input === 0 && cell.tokenUsage.output === 0
  if (cell.costUsd !== 0 || !zeroTokens) return
  const msg = `cell '${cell.cellId}' produced an artifact but reported zero cost and zero tokens — the dispatch made no paid call through ctx.cost.runPaidCall (a stub cell)`
  if (mode === 'assert') {
    const report: BackendIntegrityReport = {
      totalRecords: 1,
      stubRecords: 1,
      realRecords: 0,
      uncostedRecords: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      verdict: 'stub',
      diagnosis: msg,
    }
    throw new BackendIntegrityError(`expectUsage: ${msg}`, report)
  }
  // eslint-disable-next-line no-console
  console.warn(`[runCampaign] expectUsage: ${msg}`)
}

async function runJudgeCell<TArtifact, TScenario extends Scenario>(
  judge: JudgeConfig<TArtifact, TScenario>,
  input: Parameters<JudgeConfig<TArtifact, TScenario>['score']>[0],
): Promise<JudgeScore> {
  const previousJudgeCalls = new Set(
    input.costLedger
      ?.list({ channel: 'judge', tags: input.costTags })
      .map((receipt) => receipt.callId) ?? [],
  )
  try {
    const score = await judge.score(input)
    assertReportedJudgeCallRecorded(judge.name, score, input, previousJudgeCalls)
    return score
  } catch (error) {
    assertReportedJudgeCallRecorded(judge.name, error, input, previousJudgeCalls, error)
    throw error
  }
}

function assertReportedJudgeCallRecorded(
  judgeName: string,
  value: unknown,
  input: Parameters<JudgeConfig<unknown>['score']>[0],
  previousCallIds: ReadonlySet<string>,
  cause?: unknown,
): void {
  if (!hasLlmCall(value)) return
  const recorded = input.costLedger
    ?.list({ channel: 'judge', tags: input.costTags })
    .some((receipt) => !previousCallIds.has(receipt.callId))
  if (recorded) return
  throw new CostAccountingIncompleteError(
    `runCampaign: judge '${judgeName}' reported a paid LLM call without a CostLedger receipt`,
    cause === undefined ? undefined : { cause },
  )
}

function hasLlmCall(value: unknown): value is { llmCall: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'llmCall' in value &&
    (value as { llmCall?: unknown }).llmCall !== undefined
  )
}

function defaultBuildTraceWriter(
  storage: CampaignStorage,
): (cellId: string, dir: string) => CampaignTraceWriter {
  return (cellId, dir) => {
    const spans: Array<Record<string, unknown>> = []
    return {
      span(name, attributes) {
        const startMs = Date.now()
        const record: Record<string, unknown> = { name, cellId, startMs, ...(attributes ?? {}) }
        const finish: TraceSpan = {
          end(endAttrs) {
            record.durationMs = Date.now() - startMs
            if (endAttrs) Object.assign(record, endAttrs)
            spans.push(record)
          },
          setAttribute(key, value) {
            record[key] = value
          },
        }
        return finish
      },
      async flush() {
        storage.write(join(dir, 'spans.jsonl'), spans.map((s) => JSON.stringify(s)).join('\n'))
      },
    }
  }
}

function buildCellSchedule<TScenario extends Scenario>(
  scenarios: TScenario[],
  seed: number,
  reps: number,
): Array<{ scenario: TScenario; rep: number; cellId: string; cellSeed: number }> {
  const schedule: Array<{ scenario: TScenario; rep: number; cellId: string; cellSeed: number }> = []
  const groupIndexes = new Map<string, number>()
  let nextGroupIndex = 0
  for (const scenario of scenarios) {
    let groupIndex: number
    if (scenario.seedGroup === undefined) {
      groupIndex = nextGroupIndex
      nextGroupIndex += 1
    } else {
      const existing = groupIndexes.get(scenario.seedGroup)
      if (existing !== undefined) {
        groupIndex = existing
      } else {
        groupIndex = nextGroupIndex
        nextGroupIndex += 1
        groupIndexes.set(scenario.seedGroup, groupIndex)
      }
    }
    for (let rep = 0; rep < reps; rep++) {
      const cellId = `${scenario.id}:${rep}`
      const cellSeed = seed + groupIndex * reps + rep
      schedule.push({ scenario, rep, cellId, cellSeed })
    }
  }
  return schedule
}

function dispatchRefFor<TScenario extends Scenario, TArtifact>(
  dispatch: DispatchFn<TScenario, TArtifact> | undefined,
  override: string | undefined,
): string {
  const ref = override ?? dispatch?.name ?? 'anonymous'
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error('runCampaign: dispatchRef must be a non-empty string when provided')
  }
  return ref
}

type CacheRead<TArtifact> =
  | { status: 'hit'; cell: CampaignCellResult<TArtifact> }
  | { status: 'miss'; reason: 'missing' | 'manifest-mismatch' | 'cell-mismatch' | 'corrupt' }

function readCachedCell<TArtifact>(args: {
  storage: CampaignStorage
  cachePath: string
  cellId: string
  manifestHash: string
}): CacheRead<TArtifact> {
  const raw = args.storage.read(args.cachePath)
  if (raw === undefined) return { status: 'miss', reason: 'missing' }

  try {
    const cached = JSON.parse(raw) as CampaignCellResult<TArtifact>
    if (cached.cellId !== args.cellId) return { status: 'miss', reason: 'cell-mismatch' }
    if (cached.manifestHash !== args.manifestHash) {
      return { status: 'miss', reason: 'manifest-mismatch' }
    }
    return { status: 'hit', cell: cached }
  } catch {
    return { status: 'miss', reason: 'corrupt' }
  }
}

interface CaptureArgs<TScenario extends Scenario, TArtifact> {
  store: LabeledScenarioStore
  cell: CampaignCellResult<TArtifact>
  scenario: TScenario
  opts: RunCampaignOptions<TScenario, TArtifact>
  now: () => Date
}

async function captureToStore<TScenario extends Scenario, TArtifact>(
  args: CaptureArgs<TScenario, TArtifact>,
): Promise<void> {
  await args.store.observe({
    scenario: args.scenario,
    artifact: args.cell.artifact,
    judgeScores: args.cell.judgeScores,
    source: args.opts.captureSource ?? 'eval-run',
    sourceVersionHash: args.opts.captureSourceVersionHash ?? 'unknown',
    capturedAt: args.now().toISOString(),
    redactionStatus: 'raw',
  })
}

// ── Aggregates + manifest hash ────────────────────────────────────────

function computeManifestHash(input: {
  scenarios: Scenario[]
  judges: JudgeConfig<unknown>[]
  dispatchRef: string
  seed: number
  reps: number
}): string {
  return contentHash({
    scenarios: input.scenarios,
    judges: input.judges.map((judge) => ({
      name: judge.name,
      dims: judge.dimensions,
      version: judgeVersionFor(judge),
    })),
    dispatch: input.dispatchRef,
    seed: input.seed,
    reps: input.reps,
  })
}

function judgeVersionFor(judge: JudgeConfig<unknown>): string {
  if (judge.judgeVersion !== undefined) {
    const version = judge.judgeVersion.trim()
    if (version.length === 0) {
      throw new Error(`runCampaign: judge '${judge.name}' has an empty judgeVersion`)
    }
    return version
  }
  return contentHash({
    score: judge.score.toString(),
    appliesTo: judge.appliesTo?.toString() ?? null,
  })
}

function computeAggregates<TArtifact>(
  cells: CampaignCellResult<TArtifact>[],
  judges: JudgeConfig<TArtifact>[],
  seed: number,
  cost: CostLedgerSummary,
): CampaignAggregates {
  const byJudge: Record<string, JudgeAggregate> = {}
  for (const judge of judges) {
    const scores: number[] = []
    for (const cell of cells) {
      const s = cell.judgeScores[judge.name]
      if (s !== undefined) scores.push(s.composite)
    }
    byJudge[judge.name] = aggregate(scores, seed)
  }
  const byScenario: Record<string, ScenarioAggregate> = {}
  const scenarioGroups = new Map<string, number[]>()
  for (const cell of cells) {
    const composites = Object.values(cell.judgeScores).map((s) => s.composite)
    if (composites.length === 0) continue
    const mean = composites.reduce((a, b) => a + b, 0) / composites.length
    const arr = scenarioGroups.get(cell.scenarioId) ?? []
    arr.push(mean)
    scenarioGroups.set(cell.scenarioId, arr)
  }
  for (const [scenarioId, samples] of scenarioGroups) {
    const ag = aggregate(samples, seed)
    byScenario[scenarioId] = { meanComposite: ag.mean, ci95: ag.ci95, n: ag.n }
  }
  return {
    byJudge,
    byScenario,
    cost,
    totalCostUsd: cost.totalCostUsd,
    cellsExecuted: cells.filter((c) => !c.error).length,
    cellsSkipped: cells.filter((c) => c.error?.startsWith('skipped:')).length,
    cellsCached: cells.filter((c) => c.cached).length,
    cellsFailed: cells.filter((c) => c.error && !c.error.startsWith('skipped:')).length,
  }
}

// Percentile bootstrap CI95 via seeded resampling. Deterministic for a given
// seed — same campaign re-run produces identical CI bands. Falls back to
// degenerate intervals at n<=1 (the bootstrap is undefined there).
function aggregate(samples: number[], seed: number): JudgeAggregate {
  const n = samples.length
  if (n === 0) return { mean: 0, stdev: 0, ci95: [0, 0], n: 0 }
  const mean = samples.reduce((a, b) => a + b, 0) / n
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)
  const stdev = Math.sqrt(variance)
  const ci = confidenceInterval(samples, 0.95, { seed, resamples: 1000 })
  return { mean, stdev, ci95: [ci.lower, ci.upper], n }
}
