/**
 * Cell resumability: reading, validating, and refusing cached cell results.
 * A cache entry is reusable only when its cost receipts are identified and
 * restorable — an unidentifiable receipt blocks the campaign rather than
 * silently re-spending or silently reusing unaccounted work.
 */

import type { CostLedgerHandle, CostReceipt } from '../cost-ledger'
import { CostAccountingIncompleteError } from '../cost-ledger'
import { type CellScheduleSlot, cellCachePath, stableCostTagsFor } from './cell-schedule'
import { campaignCellCostProvenance } from './run-record'
import type { CampaignStorage } from './storage'
import type { CampaignCellResult, Scenario } from './types'

export function assertScheduleCachesReusable<TScenario extends Scenario>(args: {
  schedule: CellScheduleSlot<TScenario>[]
  runDir: string
  manifestHash: string
  storage: CampaignStorage
  costLedger: CostLedgerHandle
  costTags?: Readonly<Record<string, string>>
  rerunInvalidCachedCells: boolean
}): void {
  const blocked: InvalidCachedCell[] = []
  for (const slot of args.schedule) {
    const cached = readCachedCell<unknown>({
      storage: args.storage,
      cachePath: cellCachePath(args.runDir, slot.cellId),
      cellId: slot.cellId,
      manifestHash: args.manifestHash,
    })
    if (cached.status === 'hit') {
      const receiptProblem = cachedCellReceiptProblem(
        cached.cell,
        args.costLedger,
        stableCostTagsFor({ runDir: args.runDir, costTags: args.costTags }, slot),
      )
      if (receiptProblem !== undefined && !args.rerunInvalidCachedCells) {
        blocked.push({
          cellId: slot.cellId,
          reason: 'invalid-cost-receipts',
          detail: receiptProblem,
        })
      }
    } else if (cacheIssueRequiresExplicitRerun(cached.reason) && !args.rerunInvalidCachedCells) {
      blocked.push({ cellId: slot.cellId, reason: cached.reason })
    }
  }
  if (blocked.length > 0) throw invalidCachedCellsError(blocked)
}

export function modelEvidenceFromReceipts(
  receipts: ReadonlyArray<Pick<CostReceipt, 'model'>>,
): Pick<CampaignCellResult<unknown>, 'resolvedModels' | 'resolvedModel'> {
  const models = [...new Set(receipts.map((receipt) => receipt.model))]
  if (models.length === 0) return {}
  return {
    resolvedModels: models,
    ...(models.length === 1 ? { resolvedModel: models[0] } : {}),
  }
}

export function withCurrentAgentModelEvidence<TArtifact>(
  cached: CampaignCellResult<TArtifact>,
  costLedger: CostLedgerHandle,
  stableCostTags: Record<string, string>,
): CampaignCellResult<TArtifact> {
  const cachedCallIds = new Set(cached.costCallIds ?? [])
  const receipts = costLedger
    .list({ channel: 'agent', tags: stableCostTags })
    .filter((receipt) => cachedCallIds.has(receipt.callId))
  const cell = { ...cached }
  delete cell.resolvedModel
  delete cell.resolvedModels
  return Object.assign(cell, modelEvidenceFromReceipts(receipts))
}

export function cachedCellReceiptProblem(
  cached: CampaignCellResult<unknown>,
  costLedger: CostLedgerHandle,
  stableCostTags: Record<string, string>,
): string | undefined {
  const reportsPaidActivity =
    cached.costProvenance.kind !== 'observed' ||
    cached.costUsd > 0 ||
    cached.tokenUsage.input > 0 ||
    cached.tokenUsage.output > 0
  if (cached.costCallIds === undefined) {
    // Legacy caches did not distinguish a deterministic judge from an
    // unrecorded paid judge, so any saved judge result still needs IDs there.
    if (reportsPaidActivity || Object.keys(cached.judgeScores).length > 0) {
      return 'does not identify its ledger receipts'
    }
    return undefined
  }
  if (
    !Array.isArray(cached.costCallIds) ||
    cached.costCallIds.some((callId) => typeof callId !== 'string' || callId.trim().length === 0) ||
    new Set(cached.costCallIds).size !== cached.costCallIds.length
  ) {
    return 'has invalid ledger receipt IDs'
  }
  // Current caches write [] explicitly when every dispatch and judge was free.
  if (cached.costCallIds.length === 0 && reportsPaidActivity) {
    return 'does not identify its ledger receipts'
  }
  const restoredCallIds = new Set(
    costLedger.list({ tags: stableCostTags }).map((receipt) => receipt.callId),
  )
  const missingCallIds = cached.costCallIds.filter((callId) => !restoredCallIds.has(callId))
  if (missingCallIds.length > 0) {
    return `is missing ledger receipt(s): ${missingCallIds.join(', ')}`
  }
  return undefined
}

export type CacheIssueReason =
  | 'missing'
  | 'manifest-mismatch'
  | 'cell-mismatch'
  | 'missing-cost-provenance'
  | 'invalid-cost-provenance'
  | 'invalid-cost-receipts'
  | 'corrupt'

export type CacheRead<TArtifact> =
  | { status: 'hit'; cell: CampaignCellResult<TArtifact> }
  | { status: 'miss'; reason: CacheIssueReason }

export function readCachedCell<TArtifact>(args: {
  storage: CampaignStorage
  cachePath: string
  cellId: string
  manifestHash: string
}): CacheRead<TArtifact> {
  const raw = args.storage.read(args.cachePath)
  if (raw === undefined) {
    return {
      status: 'miss',
      reason: args.storage.exists(args.cachePath) ? 'corrupt' : 'missing',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'miss', reason: 'corrupt' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'miss', reason: 'corrupt' }
  }
  const cached = parsed as CampaignCellResult<TArtifact>
  if (cached.cellId !== args.cellId) return { status: 'miss', reason: 'cell-mismatch' }
  if (cached.manifestHash !== args.manifestHash) {
    return { status: 'miss', reason: 'manifest-mismatch' }
  }
  try {
    campaignCellCostProvenance(cached)
    return { status: 'hit', cell: cached }
  } catch {
    return {
      status: 'miss',
      reason:
        cached.costProvenance === undefined ? 'missing-cost-provenance' : 'invalid-cost-provenance',
    }
  }
}

export function cacheIssueRequiresExplicitRerun(reason: CacheIssueReason): boolean {
  return (
    reason === 'cell-mismatch' ||
    reason === 'missing-cost-provenance' ||
    reason === 'invalid-cost-provenance' ||
    reason === 'invalid-cost-receipts' ||
    reason === 'corrupt'
  )
}

export interface InvalidCachedCell {
  cellId: string
  reason: CacheIssueReason
  detail?: string
}

export function invalidCachedCellsError(
  cells: ReadonlyArray<InvalidCachedCell>,
): CostAccountingIncompleteError {
  const details = cells
    .map((cell) => `${cell.cellId} (${cell.reason}${cell.detail ? `: ${cell.detail}` : ''})`)
    .join(', ')
  return new CostAccountingIncompleteError(
    `runCampaign: cached cell(s) require explicit paid re-dispatch: ${details}; ` +
      'refusing to begin campaign. Inspect planCampaignRun, then set ' +
      'rerunInvalidCachedCells: true to rerun only these cells while retaining valid caches, ' +
      'or resumable: false when a full rerun is intended.',
  )
}
