import { createHash } from 'node:crypto'

import {
  type AgentImprovementMeasuredComparison,
  agentImprovementMeasuredComparisonSchema,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import type { Scenario } from '../campaign/types'
import { type PairedArmRow, pairArms } from '../paired-arms'
import { pairedBootstrap } from '../statistics'
import { canonicalJson } from '../verdict-cache'
import type { SelfImproveResult } from './self-improve'

export interface MeasuredComparisonFromSelfImproveResultOptions<
  TScenario extends Scenario,
  TArtifact,
> {
  result: SelfImproveResult<TScenario, TArtifact>
  benchmark: AgentImprovementMeasuredComparison['benchmark']
  baselineProfileDigest: Sha256Digest
  candidateBundleDigest: Sha256Digest
}

/** Convert one paired self-improvement result into the portable Interface evidence record. */
export function measuredComparisonFromSelfImproveResult<TScenario extends Scenario, TArtifact>(
  options: MeasuredComparisonFromSelfImproveResultOptions<TScenario, TArtifact>,
): AgentImprovementMeasuredComparison {
  const { result } = options
  const power = result.power
  if (!power) throw new Error('agent improvement comparison requires heldout power analysis')
  if (result.provenance.gate.reasons.length === 0) {
    throw new Error('agent improvement comparison requires measured decision reasons')
  }
  const pairs = pairMeasuredCells(
    result.raw.baselineOnHoldout.cells,
    result.raw.winnerOnHoldout.cells,
  )
  const composite = measuredObjective(
    {
      kind: 'objective',
      name: 'composite',
      direction: 'higher-is-better',
      unit: 'score',
    },
    pairs,
    measuredComposite,
  )
  assertMeasuredNumber(result.lift, composite.delta, 'heldout lift')
  assertMeasuredNumber(result.baseline.compositeMean, composite.baseline, 'heldout baseline')
  assertMeasuredNumber(result.winner.compositeMean, composite.candidate, 'heldout candidate')
  assertMeasuredNumber(result.provenance.heldOutLift, composite.delta, 'provenance heldout lift')
  if (
    result.gateDecision !== result.provenance.gate.decision ||
    power.n !== composite.n ||
    power.confidence !== 0.95
  ) {
    throw new Error('agent improvement measurement sources do not agree')
  }

  return agentImprovementMeasuredComparisonSchema.parse({
    schemaVersion: 1,
    kind: 'agent-improvement-measured-comparison',
    benchmark: options.benchmark,
    baselineProfileDigest: options.baselineProfileDigest,
    candidateBundleDigest: options.candidateBundleDigest,
    overall: {
      name: 'composite',
      baseline: composite.baseline,
      candidate: composite.candidate,
      delta: composite.delta,
      confidenceInterval: composite.confidenceInterval,
      n: composite.n,
      direction: 'higher-is-better',
      unit: 'score',
    },
    objectives: measuredObjectives(pairs),
    ...(result.winner.label || result.winner.rationale
      ? {
          candidate: {
            ...(result.winner.label ? { label: result.winner.label } : {}),
            ...(result.winner.rationale ? { rationale: result.winner.rationale } : {}),
          },
        }
      : {}),
    decision: {
      outcome: result.gateDecision,
      reasons: result.provenance.gate.reasons,
      contributingChecks: result.provenance.gate.contributingGates.map((check) => ({
        name: check.name,
        passed: check.passed,
      })),
    },
    power: {
      sufficient: power.scaleAssumed && !power.underpowered,
      n: power.n,
      minimumDetectableDelta: power.mde,
      confidenceLevel: power.confidence,
      scaleAssumed: power.scaleAssumed,
      sharedScorerChannel: power.sharedChannelCaveat !== undefined,
      reason: power.recommendation,
    },
    provenance: {
      kind: 'agent-eval-loop',
      schema: result.provenance.schema,
      runId: result.provenance.runId,
      recordDigest: digest(result.provenance),
      baselineContentHash: result.provenance.baselineContentHash,
      candidateContentHash: result.provenance.winnerContentHash,
    },
    diff: result.diff,
    evaluation: {
      generationsExplored: result.generationsExplored,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
    },
  })
}

interface MeasuredEvaluationCell {
  scenarioId: string
  rep: number
  judgeScores: Record<
    string,
    { composite: number; dimensions: Record<string, number>; failed?: true }
  >
  costUsd: number
  tokenUsage?: { input: number; output: number }
  durationMs: number
  error?: string
}

function measuredObjectives(
  pairs: ReadonlyArray<readonly [MeasuredEvaluationCell, MeasuredEvaluationCell]>,
): AgentImprovementMeasuredComparison['objectives'] {
  const qualityColumns = new Map<string, MeasuredQualityColumn>()
  for (const [baseline, candidate] of pairs) {
    for (const cell of [baseline, candidate]) {
      for (const [objective, score] of Object.entries(cell.judgeScores)) {
        if (score.failed) continue
        qualityColumns.set(`objective:${objective}`, {
          kind: 'objective',
          name: objective,
          direction: 'higher-is-better',
          unit: 'score',
        })
        for (const name of Object.keys(score.dimensions)) {
          qualityColumns.set(`dimension:${objective}:${name}`, {
            kind: 'dimension',
            objective,
            name,
            direction: 'higher-is-better',
            unit: 'score',
          })
        }
      }
    }
  }
  return [
    ...[...qualityColumns.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, column]) =>
        measuredObjective(column, pairs, (cell) => measuredQuality(cell, column)),
      ),
    measuredCostObjective(pairs),
    measuredObjective(
      {
        kind: 'latency',
        name: 'latency',
        direction: 'lower-is-better',
        unit: 'milliseconds',
      },
      pairs,
      (cell) => cell.durationMs,
    ),
  ]
}

function measuredCostObjective(
  pairs: ReadonlyArray<readonly [MeasuredEvaluationCell, MeasuredEvaluationCell]>,
): AgentImprovementMeasuredComparison['objectives'][number] {
  const cells = pairs.flat()
  for (const cell of cells) finiteMeasuredValue(cell.costUsd, 'cost:cost')
  const reported = cells.some(
    (cell) =>
      cell.costUsd !== 0 ||
      (cell.tokenUsage !== undefined && (cell.tokenUsage.input > 0 || cell.tokenUsage.output > 0)),
  )
  if (!reported) {
    return {
      kind: 'cost',
      name: 'cost',
      availability: 'unavailable',
      reason: 'heldout cells did not report model usage or cost',
      direction: 'lower-is-better',
      unit: 'usd',
    }
  }
  return measuredObjective(
    {
      kind: 'cost',
      name: 'cost',
      direction: 'lower-is-better',
      unit: 'usd',
    },
    pairs,
    (cell) => cell.costUsd,
  )
}

function measuredComposite(cell: MeasuredEvaluationCell): number {
  const values = Object.values(cell.judgeScores)
    .filter((score) => !score.failed)
    .map((score) => score.composite)
    .filter(Number.isFinite)
  if (values.length === 0) {
    throw new Error(`heldout cell ${measuredCellKey(cell)} has no successful composite score`)
  }
  return measuredMean(values)
}

function pairMeasuredCells(
  baselineCells: readonly MeasuredEvaluationCell[],
  candidateCells: readonly MeasuredEvaluationCell[],
): Array<readonly [MeasuredEvaluationCell, MeasuredEvaluationCell]> {
  type MeasuredArmRow = PairedArmRow & { cell: MeasuredEvaluationCell }
  const rows: MeasuredArmRow[] = [
    ...baselineCells
      .filter((cell) => !cell.error)
      .map((cell) => ({
        pairKey: cell.scenarioId,
        repKey: String(cell.rep),
        arm: 'baseline',
        cell,
      })),
    ...candidateCells
      .filter((cell) => !cell.error)
      .map((cell) => ({
        pairKey: cell.scenarioId,
        repKey: String(cell.rep),
        arm: 'candidate',
        cell,
      })),
  ]
  const paired = pairArms(rows, { baselineArm: 'baseline', treatmentArm: 'candidate' })
  if (
    paired.pairs.length === 0 ||
    paired.unpairedBaseline.length > 0 ||
    paired.unpairedTreatment.length > 0
  ) {
    throw new Error('measured objectives require the same non-empty paired heldout cells')
  }
  return paired.pairs.map(
    (pair) =>
      [(pair.baseline as MeasuredArmRow).cell, (pair.treatment as MeasuredArmRow).cell] as const,
  )
}

type MeasuredObjectiveIdentity =
  | {
      kind: 'objective'
      name: string
      direction: 'higher-is-better'
      unit: 'score'
    }
  | {
      kind: 'dimension'
      objective: string
      name: string
      direction: 'higher-is-better'
      unit: 'score'
    }
  | {
      kind: 'cost'
      name: 'cost'
      direction: 'lower-is-better'
      unit: 'usd'
    }
  | {
      kind: 'latency'
      name: 'latency'
      direction: 'lower-is-better'
      unit: 'milliseconds'
    }

type MeasuredQualityColumn = Extract<MeasuredObjectiveIdentity, { kind: 'objective' | 'dimension' }>

function measuredObjective(
  identity: MeasuredObjectiveIdentity,
  pairs: ReadonlyArray<readonly [MeasuredEvaluationCell, MeasuredEvaluationCell]>,
  value: (cell: MeasuredEvaluationCell) => number,
): Extract<AgentImprovementMeasuredComparison['objectives'][number], { availability: 'measured' }> {
  const key = measuredObjectiveKey(identity)
  const baseline = pairs.map(([cell]) => finiteMeasuredValue(value(cell), key))
  const candidate = pairs.map(([, cell]) => finiteMeasuredValue(value(cell), key))
  const interval = pairedBootstrap(baseline, candidate, {
    confidence: 0.95,
    resamples: 2_000,
    statistic: 'mean',
    seed: measuredSeed(key),
  })
  const baselineMean = measuredMean(baseline)
  const candidateMean = measuredMean(candidate)
  return {
    ...identity,
    availability: 'measured',
    baseline: baselineMean,
    candidate: candidateMean,
    delta: candidateMean - baselineMean,
    confidenceInterval: {
      level: interval.confidence,
      lower: interval.low,
      upper: interval.high,
      method: 'paired-bootstrap',
      statistic: 'mean',
      resamples: interval.resamples,
    },
    n: interval.n,
  }
}

function measuredQuality(cell: MeasuredEvaluationCell, column: MeasuredQualityColumn): number {
  const objective = column.kind === 'objective' ? column.name : column.objective
  const score = cell.judgeScores[objective]
  if (!score || score.failed) {
    throw new Error(
      `heldout cell ${measuredCellKey(cell)} is missing measured objective '${objective}'`,
    )
  }
  const value = column.kind === 'objective' ? score.composite : score.dimensions[column.name]
  if (value === undefined) {
    throw new Error(
      `heldout cell ${measuredCellKey(cell)} is missing '${objective}' dimension '${column.name}'`,
    )
  }
  return finiteMeasuredValue(value, measuredObjectiveKey(column))
}

function measuredObjectiveKey(identity: MeasuredObjectiveIdentity): string {
  return identity.kind === 'dimension'
    ? `${identity.kind}:${identity.objective}:${identity.name}`
    : `${identity.kind}:${identity.name}`
}

function measuredCellKey(cell: Pick<MeasuredEvaluationCell, 'scenarioId' | 'rep'>): string {
  return `${cell.scenarioId}:${cell.rep}`
}

function finiteMeasuredValue(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`measured objective '${name}' is not finite`)
  return value
}

function measuredMean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('measured objective has no paired values')
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function measuredSeed(value: string): number {
  let seed = 0x811c9dc5
  for (const byte of Buffer.from(value, 'utf8')) {
    seed = Math.imul(seed ^ byte, 0x01000193) >>> 0
  }
  return seed
}

function assertMeasuredNumber(actual: number, expected: number, name: string): void {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)) * 8
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    Math.abs(actual - expected) > tolerance
  ) {
    throw new Error(`${name} does not agree across the measured comparison`)
  }
}

function digest(value: unknown): Sha256Digest {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('agent improvement provenance is not serializable')
  return `sha256:${createHash('sha256')
    .update(canonicalJson(JSON.parse(json)))
    .digest('hex')}`
}
