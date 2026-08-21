/**
 * One campaign cell, end to end: cache reuse, dispatch with per-cell abort +
 * timeout, judge scoring, cost settlement proof, failure receipts, and the
 * persisted cell result. `runCampaign` owns the schedule; this module owns
 * everything that happens inside a single cell.
 */

import { join } from 'node:path'
import { CostAccountingIncompleteError, type CostLedgerHandle } from '../cost-ledger'
import { BackendIntegrityError, type BackendIntegrityReport } from '../integrity/backend-integrity'
import {
  cachedCellReceiptProblem,
  cacheIssueRequiresExplicitRerun,
  invalidCachedCellsError,
  modelEvidenceFromReceipts,
  readCachedCell,
  withCurrentAgentModelEvidence,
} from './cell-cache'
import { cellDirectory, stableCostTagsFor } from './cell-schedule'
import { runJudgeCell } from './judge-cell'
import type {
  CampaignCellFailureReceipt,
  CampaignCellRetryPolicy,
  RunCampaignOptions,
} from './run-campaign'
import type { CampaignStorage } from './storage'
import type {
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignTokenUsage,
  CampaignTraceWriter,
  DispatchContext,
  JudgeScore,
  Scenario,
  TraceSpan,
} from './types'

export interface ExecuteCellArgs<TScenario extends Scenario, TArtifact> {
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
  /** 1-based attempt number for this slot under `cellRetry`. */
  attempt: number
  cellRetry?: CampaignCellRetryPolicy
  /** Fires when the cell's failure is final — never for an attempt that
   *  `cellRetry` will dispatch again. */
  onFailure?: (failure: CellFailure) => void
}

export interface CellFailure {
  stage: 'dispatch' | 'judge'
  judge?: string
  cause: unknown
}

export interface ExecuteCellResult<TArtifact> {
  cell: CampaignCellResult<TArtifact>
  artifactsByPath: Record<string, string>
  failure?: CellFailure
  /** True when `cellRetry` will dispatch this slot again: `cell` is not final
   *  and must not enter the campaign result. */
  retry?: boolean
}

export async function executeCell<TScenario extends Scenario, TArtifact>(
  args: ExecuteCellArgs<TScenario, TArtifact>,
): Promise<ExecuteCellResult<TArtifact>> {
  const storage = args.storage
  const cellDir = cellDirectory(args.opts.runDir, args.slot.cellId)
  storage.ensureDir(cellDir)
  const stableCostTags = stableCostTagsFor(args.opts, args.slot)
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
    if (
      cached.status === 'miss' &&
      cacheIssueRequiresExplicitRerun(cached.reason) &&
      !args.opts.rerunInvalidCachedCells
    ) {
      throw invalidCachedCellsError([{ cellId: args.slot.cellId, reason: cached.reason }])
    }
    if (cached.status === 'hit' && (!cached.cell.error || args.opts.reuseFailedCells)) {
      const receiptProblem = cachedCellReceiptProblem(cached.cell, args.costLedger, stableCostTags)
      if (receiptProblem === undefined) {
        const cell = withCurrentAgentModelEvidence(cached.cell, args.costLedger, stableCostTags)
        enforceDispatchUsage(cell, args.opts.expectUsage ?? 'warn')
        return { cell: { ...cell, cached: true }, artifactsByPath: {} }
      }
      if (!args.opts.rerunInvalidCachedCells) {
        throw invalidCachedCellsError([
          {
            cellId: args.slot.cellId,
            reason: 'invalid-cost-receipts',
            detail: receiptProblem,
          },
        ])
      }
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
    runAttemptId: args.runAttemptId,
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
    ...(agentCost.usageComplete ? {} : { tokensKnown: false as const }),
    ...(agentCost.reasoningTokens !== undefined && agentCost.reasoningTokens > 0
      ? { reasoning: agentCost.reasoningTokens }
      : {}),
    ...(agentCost.cachedTokens > 0 ? { cached: agentCost.cachedTokens } : {}),
    ...(agentCost.cacheWriteTokens !== undefined && agentCost.cacheWriteTokens > 0
      ? { cacheWrite: agentCost.cacheWriteTokens }
      : {}),
  }
  const agentModelEvidence = modelEvidenceFromReceipts(agentReceipts)
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
    costProvenance: agentCost.costProvenance,
    costCallIds,
    tokenUsage,
    ...agentModelEvidence,
    durationMs: Date.now() - startMs,
    seed: args.slot.cellSeed,
    cached: false,
    ...(args.attempt > 1 ? { retryAttempts: args.attempt - 1 } : {}),
    ...(failure ? { errorStage: failure.stage } : {}),
    ...(failure?.judge ? { errorJudge: failure.judge } : {}),
    error: errorMessage,
  }

  let retry = false
  if (failure) {
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
    // The retry decision is made where the receipt is written so the receipt
    // name records it: a retried attempt keeps its evidence at
    // `failure-receipt.attempt-<n>.json` and never fires `onFailure` — a
    // retryable failure is not a campaign error until attempts are exhausted.
    // A cancelled campaign and a fatal accounting error are never retried.
    retry =
      args.cellRetry !== undefined &&
      args.attempt < args.cellRetry.attempts &&
      !args.signal.aborted &&
      fatalCellError === undefined &&
      args.cellRetry.retryable(receipt.failure)
    const receiptName = retry
      ? `failure-receipt.attempt-${args.attempt}.json`
      : 'failure-receipt.json'
    const failurePath = join(cellDir, receiptName)
    storage.write(failurePath, JSON.stringify(receipt, null, 2))
    artifactsByPath[`${args.slot.cellId}/${receiptName}`] = failurePath
    if (!retry) args.onFailure?.(failure)
  }

  await trace.flush()

  if (!errorMessage && args.resumable) {
    storage.write(cachePath, JSON.stringify(cell))
  }

  if (fatalCellError !== undefined) throw fatalCellError
  return { cell, artifactsByPath, ...(failure ? { failure } : {}), ...(retry ? { retry } : {}) }
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

export function defaultBuildTraceWriter(
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
