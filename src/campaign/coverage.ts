import { contentHash } from '../verdict-cache'
import type { CampaignCellResult, CampaignScenarioIdentity, Scenario } from './types'

export interface CampaignCoverage {
  complete: boolean
  expectedCellIds: string[]
  scorableCellIds: string[]
  unscorableCells: Array<{ cellId: string; reason: string }>
}

/** Reject campaign designs whose denominator cannot be identified exactly. */
export function assertCampaignDesign<TScenario extends Scenario>(
  scenarios: readonly TScenario[],
  reps: number,
): void {
  if (!Number.isSafeInteger(reps) || reps < 1) {
    throw new Error('campaign design requires reps to be a positive safe integer')
  }
  const scenarioIds = new Set<string>()
  for (const scenario of scenarios) {
    if (typeof scenario.id !== 'string' || scenario.id.trim().length === 0) {
      throw new Error('campaign design requires every scenario to have a non-empty id')
    }
    if (scenarioIds.has(scenario.id)) {
      throw new Error(`campaign design contains duplicate scenario id '${scenario.id}'`)
    }
    if (typeof scenario.kind !== 'string' || scenario.kind.trim().length === 0) {
      throw new Error('campaign design requires every scenario to have a non-empty kind')
    }
    if (
      scenario.seedGroup !== undefined &&
      (typeof scenario.seedGroup !== 'string' || scenario.seedGroup.trim().length === 0)
    ) {
      throw new Error('campaign design requires seedGroup to be a non-empty string when set')
    }
    scenarioIds.add(scenario.id)
  }
}

/** Redacted but independently verifiable identity of one complete scenario. */
export function campaignScenarioIdentity<TScenario extends Scenario>(
  scenario: TScenario,
): CampaignScenarioIdentity & Pick<TScenario, 'id' | 'kind'> {
  assertCampaignDesign([scenario], 1)
  return {
    id: scenario.id,
    kind: scenario.kind,
    scenarioDigest: `sha256:${contentHash(scenario)}`,
  }
}

/** Canonical split identity reconstructed from redacted scenario identities. */
export function campaignSplitDigestFromIdentities(
  scenarios: readonly CampaignScenarioIdentity[],
  reps: number,
): `sha256:${string}` {
  assertCampaignDesign(scenarios, reps)
  for (const scenario of scenarios) {
    if (!/^sha256:[a-f0-9]{64}$/.test(scenario.scenarioDigest)) {
      throw new Error(`campaign scenario '${scenario.id}' has an invalid digest`)
    }
  }
  return `sha256:${contentHash({
    schema: 'tangle.campaign-split',
    scenarios: scenarios.map(({ id, kind, scenarioDigest }) => ({ id, kind, scenarioDigest })),
    reps,
  })}`
}

/** Canonical identity of the exact scenario payloads and replicate count. */
export function campaignSplitDigest<TScenario extends Scenario>(
  scenarios: readonly TScenario[],
  reps: number,
): `sha256:${string}` {
  assertCampaignDesign(scenarios, reps)
  return campaignSplitDigestFromIdentities(scenarios.map(campaignScenarioIdentity), reps)
}

/** Refuse a campaign whose retained task identities contradict its split digest. */
export function assertCampaignSplitIdentity(
  scenarios: readonly CampaignScenarioIdentity[],
  reps: number,
  splitDigest: string,
): void {
  if (campaignSplitDigestFromIdentities(scenarios, reps) !== splitDigest) {
    throw new Error('campaign split digest does not match its retained scenario identities')
  }
}

/** Exact designed-denominator receipt for one campaign. */
export function campaignCoverage<TArtifact, TScenario extends Scenario>(
  cells: readonly CampaignCellResult<TArtifact>[],
  scenarios: readonly TScenario[],
  reps: number,
  requireJudgeScore: boolean,
): CampaignCoverage {
  assertCampaignDesign(scenarios, reps)
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
    if (cell.cellId !== `${cell.scenarioId}:${cell.rep}`) {
      unscorableCells.push({
        cellId: cell.cellId,
        reason: 'campaign cell id does not match scenario id and rep',
      })
      continue
    }
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
