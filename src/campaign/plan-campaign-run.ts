import type { CostLedgerHandle } from '../cost-ledger'
import { computeManifestHash, dispatchRefFor } from './campaign-manifest'
import {
  type CacheIssueReason,
  cachedCellReceiptProblem,
  cacheIssueRequiresExplicitRerun,
  readCachedCell,
} from './cell-cache'
import { buildCellSchedule, cellCachePath, stableCostTagsFor } from './cell-schedule'
import { assertCampaignDesign, campaignSplitDigest } from './coverage'
import { resolveRunDir } from './run-dir'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from './storage'
import type { DispatchFn, JudgeConfig, Scenario } from './types'

export interface CampaignRunPlanCell {
  cellId: string
  scenarioId: string
  rep: number
  seed: number
  cachePath: string
  status: 'cached' | 'run' | 'blocked'
  reason?: CacheIssueReason | 'resumable-off'
}

export interface CampaignRunPlan {
  manifestHash: string
  splitDigest: `sha256:${string}`
  totalCells: number
  cellsCached: number
  cellsBlocked: number
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
  /** See RunCampaignOptions.rerunInvalidCachedCells. */
  rerunInvalidCachedCells?: boolean
  runDir: string
  /** Subject repo for the shared run-dir root (see RunCampaignOptions.repo). */
  repo?: string
  storage?: CampaignStorage
  /** Spend account used to validate cached receipt identities. */
  costLedger?: CostLedgerHandle
  /** Receipt tags used by the campaign that produced the cached cells. */
  costTags?: Readonly<Record<string, string>>
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
  const costLedger =
    opts.costLedger ?? createRunCostLedger({ storage, runDir: opts.runDir, ensureRunDir: false })

  const manifestHash = computeManifestHash({
    scenarios: opts.scenarios,
    judges: (opts.judges ?? []) as unknown as JudgeConfig<unknown>[],
    dispatchRef: dispatchRefFor(opts.dispatch, opts.dispatchRef),
    seed,
    reps,
  })
  const splitDigest = campaignSplitDigest(opts.scenarios, reps)

  const cells = buildCellSchedule(opts.scenarios, seed, reps).map((slot): CampaignRunPlanCell => {
    const cachePath = cellCachePath(opts.runDir, slot.cellId)
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
      const receiptProblem = cachedCellReceiptProblem(
        cached.cell,
        costLedger,
        stableCostTagsFor({ runDir: opts.runDir, costTags: opts.costTags }, slot),
      )
      if (receiptProblem !== undefined) {
        return {
          cellId: slot.cellId,
          scenarioId: slot.scenario.id,
          rep: slot.rep,
          seed: slot.cellSeed,
          cachePath,
          status: opts.rerunInvalidCachedCells ? 'run' : 'blocked',
          reason: 'invalid-cost-receipts',
        }
      }
      return {
        cellId: slot.cellId,
        scenarioId: slot.scenario.id,
        rep: slot.rep,
        seed: slot.cellSeed,
        cachePath,
        status: 'cached',
      }
    }

    const blocked = cacheIssueRequiresExplicitRerun(cached.reason) && !opts.rerunInvalidCachedCells
    return {
      cellId: slot.cellId,
      scenarioId: slot.scenario.id,
      rep: slot.rep,
      seed: slot.cellSeed,
      cachePath,
      status: blocked ? 'blocked' : 'run',
      reason: cached.reason,
    }
  })

  const cellsCached = cells.filter((cell) => cell.status === 'cached').length
  const cellsBlocked = cells.filter((cell) => cell.status === 'blocked').length
  return {
    manifestHash,
    splitDigest,
    totalCells: cells.length,
    cellsCached,
    cellsBlocked,
    cellsToRun: cells.filter((cell) => cell.status === 'run').length,
    cells,
  }
}
