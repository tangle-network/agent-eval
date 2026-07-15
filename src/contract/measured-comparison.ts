import {
  type AgentImprovementMeasuredComparison,
  agentImprovementMeasuredComparisonSchema,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import { assertCampaignSplitIdentity, campaignCoverage } from '../campaign/coverage'
import { powerPreflight } from '../campaign/gates/power-preflight'
import {
  buildLoopProvenanceRecord,
  canonicalDigest,
  loopProvenanceArgsFromResult,
  verifyLoopProvenanceRecord,
} from '../campaign/provenance'
import { campaignBreakdown, campaignMeanComposite } from '../campaign/score-utils'
import { renderSurfaceDiff, surfaceContentHash } from '../campaign/surface-identity'
import type {
  CampaignCellResult,
  CampaignResult,
  MutableSurface,
  Scenario,
} from '../campaign/types'
import { CostLedger, type CostReceipt } from '../cost-ledger'
import { assertRealAgentReceipts } from '../integrity/backend-integrity'
import { type PairedArmRow, pairArms } from '../paired-arms'
import { pairedBootstrap } from '../statistics'
import type { SelfImproveResult } from './self-improve'

export interface MeasuredComparisonFromSelfImproveResultOptions<
  TScenario extends Scenario,
  TArtifact,
> {
  result: SelfImproveResult<TScenario, TArtifact>
  benchmark: AgentImprovementMeasuredComparison['benchmark']
  /** Canonical digest verified by the runtime that owns the baseline profile. */
  baselineProfileDigest: Sha256Digest
  /** Canonical digest verified by the runtime that owns candidate sealing. */
  candidateBundleDigest: Sha256Digest
  /** Exact baseline surface; contradictory recorded provenance is rejected. */
  baselineSurface: MutableSurface
}

/** Convert one paired self-improvement result into the portable Interface evidence record. */
export function measuredComparisonFromSelfImproveResult<TScenario extends Scenario, TArtifact>(
  options: MeasuredComparisonFromSelfImproveResultOptions<TScenario, TArtifact>,
): AgentImprovementMeasuredComparison {
  const { result } = options
  verifyLoopProvenanceRecord(result.provenance)
  const power = result.power
  if (!power) throw new Error('agent improvement comparison requires heldout power analysis')
  if (result.provenance.gate.reasons.length === 0) {
    throw new Error('agent improvement comparison requires measured decision reasons')
  }
  const receiptLedger = new CostLedger({ receipts: result.receipts })
  const receiptCost = receiptLedger.summary()
  const receipts = receiptLedger.list()
  assertRealAgentReceipts(receipts, { allowMixed: false })
  const receiptsById = new Map(receipts.map((receipt) => [receipt.callId, receipt]))
  const receiptIdsByCell = indexReceiptIdsByCell(receipts)
  assertCompleteMeasuredCampaign(
    result.raw.baselineOnHoldout,
    'heldout baseline',
    receiptsById,
    receiptIdsByCell,
  )
  assertCompleteMeasuredCampaign(
    result.raw.winnerOnHoldout,
    'heldout candidate',
    receiptsById,
    receiptIdsByCell,
  )
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
  const baselineContentHash = surfaceContentHash(options.baselineSurface)
  const candidateContentHash = surfaceContentHash(result.winner.surface)
  const canonicalDiff =
    baselineContentHash === candidateContentHash
      ? ''
      : renderSurfaceDiff(result.raw.winnerSurface, options.baselineSurface)
  assertMeasuredIdentity(result.gateDecision, result.raw.gateResult.decision, 'raw decision')
  assertMeasuredIdentity(
    candidateContentHash,
    surfaceContentHash(result.raw.winnerSurface),
    'raw winner surface',
  )
  assertMeasuredIdentity(result.diff, canonicalDiff, 'surface diff')
  assertMeasuredIdentity(result.raw.promotedDiff, canonicalDiff, 'raw surface diff')
  if (
    result.gateDecision === 'ship' &&
    (baselineContentHash === candidateContentHash || result.diff.trim().length === 0)
  ) {
    throw new Error('a shipped improvement requires a changed surface and non-empty diff')
  }
  assertMeasuredIdentity(
    canonicalDigest(power),
    canonicalDigest(
      powerPreflight({
        baselineComposites: pairs.map(([cell]) => measuredComposite(cell)),
        sharedScorerChannel: true,
      }),
    ),
    'power analysis',
  )
  assertMeasuredNumber(power.n, composite.n, 'power sample size')
  assertMeasuredNumber(power.confidence, 0.95, 'power confidence')
  assertCompleteMeasuredCampaign(
    result.raw.baselineCampaign,
    'search baseline',
    receiptsById,
    receiptIdsByCell,
  )
  assertGenerationMeasurements(result.raw.generations, receiptsById, receiptIdsByCell)
  if (
    (result.raw.neutralizedOnHoldout === undefined) !==
    (result.raw.neutralizedSurface === undefined)
  ) {
    throw new Error('neutralized surface and campaign must be supplied together')
  }
  if (result.raw.neutralizedOnHoldout) {
    assertCompleteMeasuredCampaign(
      result.raw.neutralizedOnHoldout,
      'heldout neutralized',
      receiptsById,
      receiptIdsByCell,
    )
    pairMeasuredCells(result.raw.baselineOnHoldout.cells, result.raw.neutralizedOnHoldout.cells)
  }
  const rebuiltProvenance = buildLoopProvenanceRecord(
    loopProvenanceArgsFromResult({
      runId: result.provenance.runId,
      runDir: result.provenance.runDir,
      timestamp: result.provenance.timestamp,
      baselineSurface: options.baselineSurface,
      result: result.raw,
      costReceipts: receipts,
      totalCostUsd: result.totalCostUsd,
      totalDurationMs: result.durationMs,
    }),
  )
  assertMeasuredIdentity(
    result.provenance.recordDigest,
    rebuiltProvenance.recordDigest,
    'provenance record',
  )
  assertMeasuredIdentity(
    options.benchmark.splitDigest,
    rebuiltProvenance.evidence.holdout.splitDigest,
    'benchmark heldout split',
  )
  const generationsExplored = result.raw.generations.length
  assertMeasuredNumber(result.generationsExplored, generationsExplored, 'generation count')
  assertMeasuredNumber(result.totalCostUsd, result.cost.totalCostUsd, 'cost summary')
  assertMeasuredIdentity(
    canonicalDigest(result.cost),
    canonicalDigest(result.raw.cost),
    'raw cost summary',
  )
  if (!result.cost.accountingComplete) {
    throw new Error(
      `cost accounting is incomplete: ${result.cost.incompleteReasons.join('; ') || 'unknown reason'}`,
    )
  }
  if (!receiptCost.accountingComplete) {
    throw new Error(
      `cost accounting is incomplete: ${receiptCost.incompleteReasons.join('; ') || 'unknown reason'}`,
    )
  }
  assertMeasuredIdentity(
    canonicalDigest(result.cost),
    canonicalDigest(receiptCost),
    'cost receipt summary',
  )
  assertMeasuredNumber(result.totalCostUsd, receiptCost.totalCostUsd, 'cost receipts')
  assertMeasuredOptional(result.winner.label, result.raw.winnerLabel, 'raw winner label')
  assertMeasuredOptional(
    result.winner.rationale,
    result.raw.winnerRationale,
    'raw winner rationale',
  )

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
      reasons: rebuiltProvenance.gate.reasons,
      contributingChecks: rebuiltProvenance.gate.contributingGates.map((check) => ({
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
      schema: rebuiltProvenance.schema,
      runId: rebuiltProvenance.runId,
      recordDigest: rebuiltProvenance.recordDigest,
      baselineContentHash,
      candidateContentHash,
    },
    diff: canonicalDiff,
    evaluation: {
      generationsExplored,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
    },
  })
}

function assertGenerationMeasurements<TScenario extends Scenario, TArtifact>(
  generations: SelfImproveResult<TScenario, TArtifact>['raw']['generations'],
  receiptsById: ReadonlyMap<string, CostReceipt>,
  receiptIdsByCell: ReadonlyMap<string, readonly string[]>,
): void {
  for (const generation of generations) {
    for (const measured of generation.surfaces) {
      const candidate = generation.record.candidates.find(
        (entry) => entry.surfaceHash === measured.surfaceHash,
      )
      if (!candidate) {
        throw new Error(
          `generation ${generation.record.generationIndex} is missing candidate ${measured.surfaceHash}`,
        )
      }
      const composite = campaignMeanComposite(measured.campaign)
      const breakdown = campaignBreakdown(measured.campaign)
      const coverage = campaignCoverage(
        measured.campaign.cells,
        measured.campaign.scenarios,
        measured.campaign.reps,
        true,
      )
      assertScorableMeasuredCells(
        measured.campaign,
        coverage.scorableCellIds,
        receiptsById,
        receiptIdsByCell,
      )
      assertMeasuredNumber(
        candidate.composite,
        composite,
        `candidate ${measured.surfaceHash} composite`,
      )
      if (!candidate.coverage) {
        throw new Error(`candidate ${measured.surfaceHash} does not report campaign coverage`)
      }
      assertMeasuredIdentity(
        canonicalDigest(candidate.coverage),
        canonicalDigest({
          expectedCells: coverage.expectedCellIds.length,
          scorableCells: coverage.scorableCellIds.length,
          unscorableCells: coverage.unscorableCells,
        }),
        `candidate ${measured.surfaceHash} coverage`,
      )
      assertMeasuredIdentity(
        String(candidate.eligibleForPromotion),
        String(coverage.complete),
        `candidate ${measured.surfaceHash} eligibility`,
      )
      assertMeasuredIdentity(
        canonicalDigest(candidate.dimensions),
        canonicalDigest(breakdown.dimensions),
        `candidate ${measured.surfaceHash} dimensions`,
      )
      assertMeasuredIdentity(
        canonicalDigest(candidate.scenarios),
        canonicalDigest(breakdown.scenarios),
        `candidate ${measured.surfaceHash} scenarios`,
      )
    }
  }
}

function assertCompleteMeasuredCampaign<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
  name: string,
  receiptsById: ReadonlyMap<string, CostReceipt>,
  receiptIdsByCell: ReadonlyMap<string, readonly string[]>,
): void {
  assertCampaignSplitIdentity(campaign.scenarios, campaign.reps, campaign.splitDigest)
  const coverage = campaignCoverage(campaign.cells, campaign.scenarios, campaign.reps, true)
  if (!coverage.complete) {
    throw new Error(
      `${name} is incomplete (${coverage.scorableCellIds.length}/${coverage.expectedCellIds.length} designed cells scorable)`,
    )
  }
  assertScorableMeasuredCells(campaign, coverage.scorableCellIds, receiptsById, receiptIdsByCell)
}

function assertScorableMeasuredCells<TArtifact, TScenario extends Scenario>(
  campaign: CampaignResult<TArtifact, TScenario>,
  scorableCellIds: readonly string[],
  receiptsById: ReadonlyMap<string, CostReceipt>,
  receiptIdsByCell: ReadonlyMap<string, readonly string[]>,
): void {
  const cellsById = new Map(campaign.cells.map((cell) => [cell.cellId, cell]))
  for (const cellId of scorableCellIds) {
    const cell = cellsById.get(cellId)
    if (!cell) throw new Error(`measured campaign is missing scorable cell ${cellId}`)
    assertMeasuredCell(cell, receiptsById, receiptIdsByCell, campaign.runDir)
  }
}

type MeasuredEvaluationCell = CampaignCellResult<unknown>

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
  const cells = [...baselineCells, ...candidateCells]
  const errors = cells.filter((cell) => cell.error)
  if (errors.length > 0) {
    throw new Error(
      `measured objectives cannot publish ${errors.length} errored heldout cells: ${errors
        .map((cell) => measuredCellKey(cell))
        .join(', ')}`,
    )
  }
  type MeasuredArmRow = PairedArmRow & { cell: MeasuredEvaluationCell }
  const rows: MeasuredArmRow[] = [
    ...baselineCells.map((cell) => ({
      pairKey: cell.scenarioId,
      repKey: String(cell.rep),
      arm: 'baseline',
      cell,
    })),
    ...candidateCells.map((cell) => ({
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
  return paired.pairs.map((pair) => {
    const baseline = (pair.baseline as MeasuredArmRow).cell
    const candidate = (pair.treatment as MeasuredArmRow).cell
    if (baseline.seed !== candidate.seed) {
      throw new Error(`heldout cell ${baseline.cellId} does not share one paired seed`)
    }
    return [baseline, candidate] as const
  })
}

function assertMeasuredCell(
  cell: MeasuredEvaluationCell,
  receiptsById: ReadonlyMap<string, CostReceipt>,
  receiptIdsByCell: ReadonlyMap<string, readonly string[]>,
  runDir: string,
): void {
  if (
    !cell.scenarioId.trim() ||
    !Number.isSafeInteger(cell.rep) ||
    cell.rep < 0 ||
    !Number.isSafeInteger(cell.seed) ||
    cell.cellId !== measuredCellKey(cell)
  ) {
    throw new Error(`heldout cell '${cell.cellId}' has an invalid scenario/rep identity`)
  }
  nonnegativeMeasuredValue(cell.costUsd, `heldout cell ${cell.cellId} cost`)
  nonnegativeMeasuredValue(cell.durationMs, `heldout cell ${cell.cellId} latency`)
  if (!cell.tokenUsage) {
    throw new Error(`heldout cell ${cell.cellId} does not report token usage`)
  }
  nonnegativeMeasuredInteger(cell.tokenUsage.input, `heldout cell ${cell.cellId} input tokens`)
  nonnegativeMeasuredInteger(cell.tokenUsage.output, `heldout cell ${cell.cellId} output tokens`)
  if (cell.tokenUsage.cached !== undefined) {
    nonnegativeMeasuredInteger(cell.tokenUsage.cached, `heldout cell ${cell.cellId} cached tokens`)
  }
  if (!Array.isArray(cell.costCallIds)) {
    throw new Error(`heldout cell ${cell.cellId} does not identify its cost receipts`)
  }
  if (new Set(cell.costCallIds).size !== cell.costCallIds.length) {
    throw new Error(`heldout cell ${cell.cellId} repeats a cost receipt`)
  }
  const linkedReceipts = cell.costCallIds.map((callId) => {
    const receipt = receiptsById.get(callId)
    if (!receipt)
      throw new Error(`heldout cell ${cell.cellId} references missing cost receipt ${callId}`)
    if (
      receipt.tags?.runDir !== runDir ||
      receipt.tags.cellId !== cell.cellId ||
      receipt.tags.scenarioId !== cell.scenarioId ||
      receipt.tags.rep !== String(cell.rep)
    ) {
      throw new Error(`heldout cell ${cell.cellId} references a cost receipt from another cell`)
    }
    return receipt
  })
  assertMeasuredIdentity(
    canonicalDigest([...cell.costCallIds].sort()),
    canonicalDigest(
      [
        ...(receiptIdsByCell.get(receiptCellKey(runDir, cell.cellId, cell.scenarioId, cell.rep)) ??
          []),
      ].sort(),
    ),
    `heldout cell ${cell.cellId} cost receipt IDs`,
  )
  const agentReceipts = linkedReceipts.filter((receipt) => receipt.channel === 'agent')
  if (agentReceipts.some((receipt) => receipt.error)) {
    throw new Error(`measured cell ${cell.cellId} links a failed agent receipt`)
  }
  assertRealAgentReceipts(agentReceipts, { allowMixed: false })
  assertMeasuredNumber(
    cell.costUsd,
    agentReceipts.reduce((total, receipt) => total + receipt.costUsd, 0),
    `heldout cell ${cell.cellId} cost receipts`,
  )
  assertMeasuredNumber(
    cell.tokenUsage.input,
    agentReceipts.reduce((total, receipt) => total + receipt.inputTokens, 0),
    `heldout cell ${cell.cellId} input receipts`,
  )
  assertMeasuredNumber(
    cell.tokenUsage.output,
    agentReceipts.reduce((total, receipt) => total + receipt.outputTokens, 0),
    `heldout cell ${cell.cellId} output receipts`,
  )
  assertMeasuredNumber(
    cell.tokenUsage.cached ?? 0,
    agentReceipts.reduce((total, receipt) => total + (receipt.cachedTokens ?? 0), 0),
    `heldout cell ${cell.cellId} cached receipts`,
  )
  for (const [judge, score] of Object.entries(cell.judgeScores)) {
    if (score.failed) {
      throw new Error(`heldout cell ${cell.cellId} contains failed judge '${judge}'`)
    }
    finiteMeasuredValue(score.composite, `objective:${judge}`)
    for (const [dimension, value] of Object.entries(score.dimensions)) {
      finiteMeasuredValue(value, `dimension:${judge}:${dimension}`)
    }
  }
  measuredComposite(cell)
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

function nonnegativeMeasuredValue(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`)
  return value
}

function nonnegativeMeasuredInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
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

function assertMeasuredIdentity(actual: string, expected: string, name: string): void {
  if (actual !== expected) throw new Error(`${name} does not agree across the measured comparison`)
}

function assertMeasuredOptional(
  actual: string | undefined,
  expected: string | undefined,
  name: string,
): void {
  if (actual !== expected) throw new Error(`${name} does not agree across the measured comparison`)
}

function indexReceiptIdsByCell(
  receipts: readonly CostReceipt[],
): ReadonlyMap<string, readonly string[]> {
  const idsByCell = new Map<string, string[]>()
  for (const receipt of receipts) {
    const tags = receipt.tags
    if (!tags?.runDir || !tags.cellId || !tags.scenarioId || tags.rep === undefined) continue
    const key = receiptCellKey(tags.runDir, tags.cellId, tags.scenarioId, tags.rep)
    const ids = idsByCell.get(key) ?? []
    ids.push(receipt.callId)
    idsByCell.set(key, ids)
  }
  return idsByCell
}

function receiptCellKey(
  runDir: string,
  cellId: string,
  scenarioId: string,
  rep: string | number,
): string {
  return JSON.stringify([runDir, cellId, scenarioId, String(rep)])
}
