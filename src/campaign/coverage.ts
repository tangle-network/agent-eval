import type { CampaignCellResult, Scenario } from './types'

export interface CampaignCoverage {
  complete: boolean
  expectedCellIds: string[]
  scorableCellIds: string[]
  unscorableCells: Array<{ cellId: string; reason: string }>
}

/** Exact designed-denominator receipt for one campaign. */
export function campaignCoverage<TArtifact, TScenario extends Scenario>(
  cells: readonly CampaignCellResult<TArtifact>[],
  scenarios: readonly TScenario[],
  reps: number,
  requireJudgeScore: boolean,
): CampaignCoverage {
  const expectedCellIds = designedCellIds(scenarios, reps)
  const cellsById = new Map<string, CampaignCellResult<TArtifact>[]>()
  for (const cell of cells) {
    const matches = cellsById.get(cell.cellId) ?? []
    matches.push(cell)
    cellsById.set(cell.cellId, matches)
  }

  const scorableCellIds: string[] = []
  const unscorableCells: Array<{ cellId: string; reason: string }> = []
  for (const cellId of expectedCellIds) {
    const matches = cellsById.get(cellId) ?? []
    if (matches.length === 0) {
      unscorableCells.push({ cellId, reason: 'missing campaign cell' })
      continue
    }
    if (matches.length > 1) {
      unscorableCells.push({ cellId, reason: `duplicate campaign cell (${matches.length})` })
      continue
    }

    const cell = matches[0]!
    const scoreEntries = Object.entries(cell.judgeScores)
    const successfulScores = scoreEntries
      .map(([, score]) => score)
      .filter((score) => score.failed !== true && Number.isFinite(score.composite))
    const nonFiniteScores = scoreEntries.filter(
      ([, score]) =>
        score.failed !== true &&
        (!Number.isFinite(score.composite) ||
          Object.values(score.dimensions).some((value) => !Number.isFinite(value))),
    )
    const reasons: string[] = []
    if (cell.error) reasons.push(cell.error)
    if (cell.artifact === null || cell.artifact === undefined) reasons.push('missing artifact')
    if (!cell.error && requireJudgeScore && successfulScores.length === 0) {
      reasons.push('no successful finite judge score')
    }
    if (scoreEntries.some(([, score]) => score.failed === true)) {
      reasons.push('judge score marked failed')
    }
    if (nonFiniteScores.length > 0) {
      reasons.push(
        `non-finite judge score: ${nonFiniteScores
          .map(([name]) => name)
          .sort()
          .join(', ')}`,
      )
    }

    if (reasons.length > 0) {
      unscorableCells.push({ cellId, reason: reasons.join('; ') })
    } else {
      scorableCellIds.push(cellId)
    }
  }

  const expected = new Set(expectedCellIds)
  for (const cell of cells) {
    if (!expected.has(cell.cellId)) {
      unscorableCells.push({ cellId: cell.cellId, reason: 'unexpected campaign cell' })
    }
  }

  return {
    complete: unscorableCells.length === 0 && scorableCellIds.length === expectedCellIds.length,
    expectedCellIds,
    scorableCellIds,
    unscorableCells,
  }
}

export function formatCoverageFailures(coverage: CampaignCoverage): string {
  const shown = coverage.unscorableCells
    .slice(0, 3)
    .map((cell) => `${cell.cellId}: ${cell.reason}`)
    .join('; ')
  const remainder = coverage.unscorableCells.length - Math.min(3, coverage.unscorableCells.length)
  return remainder > 0 ? `${shown}; +${remainder} more` : shown || 'unknown coverage failure'
}

function designedCellIds<TScenario extends Scenario>(
  scenarios: readonly TScenario[],
  reps: number,
): string[] {
  const ids: string[] = []
  for (const scenario of scenarios) {
    for (let rep = 0; rep < reps; rep++) ids.push(`${scenario.id}:${rep}`)
  }
  return ids
}
