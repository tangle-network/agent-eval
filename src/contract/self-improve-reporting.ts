import { campaignCellToRunRecord } from '../campaign/run-record'
import { pairedCampaignComposites } from '../campaign/score-utils'
import { surfaceContentHash } from '../campaign/surface-identity'
import type {
  CampaignCellResult,
  CampaignResult,
  MutableSurface,
  Scenario,
} from '../campaign/types'
import { ValidationError } from '../errors'
import { modelHasSnapshot, type RunRecord, type RunSplitTag } from '../run-record'

export function pairedCompositeSummary<TArtifact, TScenario extends Scenario>(
  baseline: CampaignResult<TArtifact, TScenario>,
  winner: CampaignResult<TArtifact, TScenario>,
  independentUnitByScenarioId?: ReadonlyMap<string, string>,
) {
  const scores = pairedCampaignComposites(baseline, winner, independentUnitByScenarioId)
  const perScenario = (campaign: CampaignResult<TArtifact, TScenario>) =>
    Object.fromEntries(
      Object.entries(campaign.aggregates.byScenario).map(([id, aggregate]) => [
        id,
        aggregate.meanComposite,
      ]),
    )
  return {
    baseline: { compositeMean: scores.beforeMean, perScenario: perScenario(baseline) },
    winner: { compositeMean: scores.afterMean, perScenario: perScenario(winner) },
    baselineComposites: scores.before,
    observations: scores.observations,
  }
}

/** 32-bit FNV-1a over raw UTF-16 code units, rendered as hex for a cell key.
 *
 *  Frozen: the key names a persisted cell, so a change orphans every cell
 *  already written. This is a cell-key function, not a general-purpose hash. */
function hashString(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Adapt campaign cells into the `RunRecord` shape `analyzeRuns()` consumes.
 * Each cell becomes one run; `candidateId` is the caller-supplied label so
 * baseline + winner pair cleanly on `(experimentId, scenarioId, seed)`.
 *
 * `promptHash` identifies the executed surface; `configHash` identifies the candidate label.
 */
export function cellsToRunRecords<TArtifact>(
  cells: ReadonlyArray<CampaignCellResult<TArtifact>>,
  candidateId: 'baseline' | 'winner',
  runId: string,
  surface: MutableSurface,
  splitTag: RunSplitTag,
  fallbackModel?: string,
): RunRecord[] {
  const promptHash = surfaceContentHash(surface)
  const configHash = surfaceContentHash(candidateId)
  return cells.map((cell) => {
    const receiptModels = cell.resolvedModels ?? (cell.resolvedModel ? [cell.resolvedModel] : [])
    if (receiptModels.length > 1) {
      throw new ValidationError(
        `selfImprove cell ${cell.cellId} used multiple agent models: ${receiptModels.join(', ')}`,
      )
    }
    const model = receiptModels[0] ?? fallbackModel
    if (!model) {
      throw new ValidationError(
        `selfImprove.model is required when cell ${cell.cellId} has no paid-call model receipt`,
      )
    }
    if (!modelHasSnapshot(model)) {
      throw new ValidationError(
        `selfImprove model "${model}" lacks a snapshot version for cell ${cell.cellId}`,
      )
    }
    return campaignCellToRunRecord(cell, {
      runId: `${runId}::${candidateId}::${cell.cellId}`,
      experimentId: runId,
      candidateId,
      // scenarioId is explicit; seed keeps repeated runs distinct.
      seed:
        cell.rep * 1_000_000 +
        hashString(cell.scenarioId)
          .slice(0, 6)
          .split('')
          .reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0),
      model,
      promptHash,
      configHash,
      commitSha: 'cell',
      splitTag,
    })
  })
}
