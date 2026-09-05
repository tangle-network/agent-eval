import { campaignCellToRunRecord } from '../campaign/run-record'
import { surfaceContentHash } from '../campaign/surface-identity'
import type { CampaignCellResult, MutableSurface } from '../campaign/types'
import { ValidationError } from '../errors'
import { modelHasSnapshot, type RunRecord, type RunSplitTag } from '../run-record'

export function meanComposite(byScenario: Record<string, { meanComposite: number }>): {
  compositeMean: number
  perScenario: Record<string, number>
} {
  const perScenario: Record<string, number> = {}
  const values: number[] = []
  for (const [id, agg] of Object.entries(byScenario)) {
    perScenario[id] = agg.meanComposite
    values.push(agg.meanComposite)
  }
  return {
    compositeMean: values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length,
    perScenario,
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
