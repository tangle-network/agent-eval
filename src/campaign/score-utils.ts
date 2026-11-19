/**
 * Shared campaign-score reductions used by every optimizer preset
 * (`runOptimization`, external optimization methods, `compareOptimizationMethods`).
 * "composite of a campaign" and "per-scenario / per-dimension breakdown" so
 * the optimizers cannot drift on how a surface's score is computed.
 */

import { excerptEvidence } from '../reflective-mutation'
import { assertJsonValue } from './external-optimizer-contracts'
import { aggregatePairedHoldout, pairHoldout } from './gates/statistical-heldout'
import { projectCampaignCellQuality } from './run-record'
import type { CampaignCellResult, CampaignResult, JudgeScore, Scenario } from './types'

export interface CampaignComparisonUnits {
  pairedCellN: number
  unitIds: string[]
  /** Cells with no complete quality score on either arm. */
  unscoredCellIds: string[]
  /** Present when repetitions and source variants share an independent unit. */
  independentUnitByScenarioId?: Record<string, string>
}

/** Reduce complete paired cells using the same observation units as held-out inference. */
export function pairedCampaignComposites<TArtifact, TScenario extends Scenario>(
  baseline: CampaignResult<TArtifact, TScenario>,
  candidate: CampaignResult<TArtifact, TScenario>,
  independentUnitByScenarioId?: ReadonlyMap<string, string>,
): {
  before: number[]
  after: number[]
  beforeMean: number
  afterMean: number
  observations: CampaignComparisonUnits
} {
  const scoresByCell = (campaign: CampaignResult<TArtifact, TScenario>) => {
    const scores = new Map<string, Record<string, JudgeScore>>()
    for (const cell of campaign.cells) {
      if (scores.has(cell.cellId)) {
        throw new Error(`pairedCampaignComposites: duplicate cell '${cell.cellId}'`)
      }
      const quality = projectCampaignCellQuality(cell)
      scores.set(cell.cellId, quality.score === undefined ? {} : quality.successfulJudgeScores)
    }
    return scores
  }
  const scenarioIds = new Set(
    [...baseline.cells, ...candidate.cells].map((cell) => cell.scenarioId),
  )
  const paired = pairHoldout(
    scoresByCell(candidate),
    scoresByCell(baseline),
    scenarioIds,
    (score) => score.composite,
  )
  const observations = aggregatePairedHoldout(paired, independentUnitByScenarioId)
  const scoredCellIds = new Set(paired.cellIds)
  if (observations.before.length === 0) {
    throw new Error('pairedCampaignComposites: campaigns have no paired quality scores')
  }
  return {
    before: observations.before,
    after: observations.after,
    beforeMean:
      observations.before.reduce((sum, score) => sum + score, 0) / observations.before.length,
    afterMean:
      observations.after.reduce((sum, score) => sum + score, 0) / observations.after.length,
    observations: {
      pairedCellN: paired.cellIds.length,
      unitIds: observations.unitIds,
      unscoredCellIds: baseline.cells
        .filter((cell) => !scoredCellIds.has(cell.cellId))
        .map((cell) => cell.cellId)
        .sort(),
      ...(independentUnitByScenarioId
        ? {
            independentUnitByScenarioId: Object.fromEntries(
              [...scenarioIds].sort().map((id) => [id, independentUnitByScenarioId.get(id)!]),
            ),
          }
        : {}),
    },
  }
}

/** Mean composite across cells with complete task-quality evidence.
 *  Partial judge results remain on their cells but never enter this value.
 *  A campaign with no complete score has no numeric mean and fails loudly. */
export function campaignMeanComposite<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): number {
  const mean = campaignMeanCompositeOrNull(campaign)
  if (mean === null) {
    throw new Error('campaignMeanComposite: campaign has no complete cell-quality scores')
  }
  return mean
}

/** Nullable campaign mean for wire and report fields that represent missing quality. */
export function campaignMeanCompositeOrNull<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
): number | null {
  const scores = campaign.cells.flatMap((cell) => {
    const score = projectCampaignCellQuality(cell).score
    return score === undefined ? [] : [score]
  })
  return scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length
}

export interface CampaignBreakdown {
  /** Mean score per judge dimension across all cells. */
  dimensions: Record<string, number>
  /** Per-scenario composite (mean over reps + judges) + the judge's free-form
   *  `notes` for that scenario (the "why" a reflective proposer grounds on) +
   *  an optional `emitted` excerpt of the candidate's raw output (the "what it
   *  actually did" a reflective proposer grounds on). */
  scenarios: Array<{ scenarioId: string; composite: number; notes?: string; emitted?: string }>
}

/** How a caller describes a non-string artifact to an optimizer. The same hook
 *  serves the native reflective path and the GEPA and SkillOpt callbacks. */
export type DescribeArtifact<TArtifact, TScenario extends Scenario> = (
  artifact: TArtifact,
  scenario: TScenario,
) => unknown

export interface ArtifactEvidenceOptions<TArtifact, TScenario extends Scenario> {
  /** Describes a non-string artifact. Without it, a non-string artifact shows nothing. */
  describeArtifact?: DescribeArtifact<TArtifact, TScenario>
  /** The scenarios the campaign ran, which `describeArtifact` receives. Required with it. */
  scenarios?: readonly TScenario[]
}

/**
 * What a scored cell shows an optimizer about what the agent did. A string
 * artifact is the evidence itself, excerpted to its head and tail; any other
 * artifact is what `describeArtifact` returns for it, a JSON value kept whole
 * (it may carry structure such as inline images); without the hook a
 * non-string artifact, and a blank string, show nothing.
 */
export function cellArtifactEvidence<TArtifact, TScenario extends Scenario>(
  artifact: TArtifact,
  scenario: TScenario,
  describeArtifact?: DescribeArtifact<TArtifact, TScenario>,
): unknown {
  if (typeof artifact === 'string') {
    return artifact.trim().length > 0 ? excerptEvidence(artifact) : undefined
  }
  if (!describeArtifact) return undefined
  const described = structuredClone(describeArtifact(artifact, scenario))
  if (described === undefined) return undefined
  assertJsonValue(described, `described artifact for '${scenario.id}'`)
  return typeof described === 'string' ? excerptEvidence(described) : described
}

/** Evidence as reflection-prompt text: a string as is, a described value as its
 *  JSON, excerpted to the same bound. */
export function artifactEvidenceText(evidence: unknown): string | undefined {
  if (evidence === undefined) return undefined
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence)
  return text.trim().length > 0 ? excerptEvidence(text) : undefined
}

/** Each scenario's lowest-composite scored cell: the one whose output the
 *  scenario's evidence shows, because reflection grounds on the failure. */
export function evidenceCellByScenario<TArtifact>(
  cells: ReadonlyArray<CampaignCellResult<TArtifact>>,
): Map<string, CampaignCellResult<TArtifact>> {
  const worst = new Map<string, { composite: number; cell: CampaignCellResult<TArtifact> }>()
  for (const cell of cells) {
    const score = projectCampaignCellQuality(cell).score
    if (score === undefined) continue
    const previous = worst.get(cell.scenarioId)
    if (!previous || score < previous.composite) {
      worst.set(cell.scenarioId, { composite: score, cell })
    }
  }
  return new Map([...worst].map(([scenarioId, { cell }]) => [scenarioId, cell]))
}

/** Per-candidate evidence a reflective/patch proposer grounds its next proposal
 *  on: mean score per judge dimension + per-scenario composite, notes and the
 *  evidence of the scenario's worst cell (`cellArtifactEvidence`). */
export function campaignBreakdown<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
  options: ArtifactEvidenceOptions<TArtifact, TScenario> = {},
): CampaignBreakdown {
  const dimSums: Record<string, number> = {}
  const dimCounts: Record<string, number> = {}
  const byScenario = new Map<string, number[]>()
  const notesByScenario = new Map<string, Set<string>>()
  const scenarioById = new Map((options.scenarios ?? []).map((scenario) => [scenario.id, scenario]))
  const emittedByScenario = new Map<string, string>()
  for (const [scenarioId, cell] of evidenceCellByScenario(campaign.cells)) {
    let scenario = scenarioById.get(scenarioId)
    if (scenario === undefined) {
      if (options.describeArtifact && typeof cell.artifact !== 'string') {
        throw new Error(
          `campaignBreakdown: describeArtifact needs scenario '${scenarioId}', which the supplied scenarios lack`,
        )
      }
      scenario = { id: scenarioId } as TScenario
    }
    const text = artifactEvidenceText(
      cellArtifactEvidence(cell.artifact, scenario, options.describeArtifact),
    )
    if (text !== undefined) emittedByScenario.set(scenarioId, text)
  }
  for (const cell of campaign.cells) {
    const quality = projectCampaignCellQuality(cell)
    if (quality.score === undefined) continue
    const judgeScores = Object.values(quality.successfulJudgeScores)
    const cellComposite = quality.score
    const arr = byScenario.get(cell.scenarioId) ?? []
    arr.push(cellComposite)
    byScenario.set(cell.scenarioId, arr)
    // Collect the judges' free-form notes per scenario (deduped) — the failure
    // evidence the reflective proposer grounds on. Generalizable by contract;
    // the judge must not put case-specific ground truth here.
    for (const s of judgeScores) {
      if (s.notes?.trim()) {
        const set = notesByScenario.get(cell.scenarioId) ?? new Set<string>()
        set.add(s.notes.trim())
        notesByScenario.set(cell.scenarioId, set)
      }
    }
    for (const score of judgeScores) {
      for (const [key, value] of Object.entries(score.dimensions)) {
        if (!Number.isFinite(value)) continue
        dimSums[key] = (dimSums[key] ?? 0) + value
        dimCounts[key] = (dimCounts[key] ?? 0) + 1
      }
    }
  }
  const dimensions: Record<string, number> = {}
  for (const key of Object.keys(dimSums)) {
    const count = dimCounts[key] ?? 0
    dimensions[key] = count > 0 ? (dimSums[key] ?? 0) / count : 0
  }
  const scenarios = [...byScenario.entries()].map(([scenarioId, comps]) => {
    const notesSet = notesByScenario.get(scenarioId)
    const notes = notesSet && notesSet.size > 0 ? [...notesSet].join(' | ') : undefined
    const emitted = emittedByScenario.get(scenarioId)
    return {
      scenarioId,
      composite: comps.reduce((a, b) => a + b, 0) / comps.length,
      ...(notes ? { notes } : {}),
      ...(emitted ? { emitted } : {}),
    }
  })
  return { dimensions, scenarios }
}
