/** Harvest selection scores and persist weighted, macro, and micro comparisons. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Digest } from '../../src/analyst/benchmark-verification-artifacts'
import type { GepaOptimizationRecipe } from '../../src/campaign/gepa-optimization-method'
import type { DispatchContext } from '../../src/campaign/types'
import {
  SMOKE,
  FAMILY,
  RUN_DIR,
  ROUND,
  SEED,
  MODEL,
  BASE_URL,
  MAX_EVALUATIONS,
  EVAL_COST_PHASE,
  FAMILY_SPLIT_PLAN_PATH,
  BASELINE,
  SCORE_LEDGER_PATH,
} from './configuration'
import type {
  GepaAnalystScenario,
  MatchCounts,
  LedgerScoreRow,
  GoldMassWeight,
} from './contract'
import type { CostLedgerHandle } from '../../src/cost-ledger'
import type { OptimizationMethodResult } from '../../src/campaign/optimization-method'
import type { createCampaignEvaluation } from './evaluation'
import type { PreparedCampaignScenarios } from './scenarios'

function microFromCounts(rows: readonly MatchCounts[]): {
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
} {
  const tp = rows.reduce((total, row) => total + row.tp, 0)
  const fp = rows.reduce((total, row) => total + row.fp, 0)
  const fn = rows.reduce((total, row) => total + row.fn, 0)
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, precision, recall, f1 }
}

export async function writeCampaignSummary(input: CampaignSummaryInput): Promise<void> {
  const { scenarios, poolProvenance, trainScenarios, selectionScenarios, stratification,
    maxGoldMass, goldMassWeight, dispatchWithSurface, judge, recipe, boundaryBurst,
    result, winner, winnerSha256, baselineSha256, started, costLedger } = input
  interface HarvestRow {
    rawComposite: number
    weighted: number
    f1: number
    counts: MatchCounts
  }
  const harvest = new Map<string, HarvestRow>()
  for (const line of readFileSync(SCORE_LEDGER_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as LedgerScoreRow
    harvest.set(`${row.surfaceSha256}:${row.scenarioId}`, {
      rawComposite: row.rawComposite,
      weighted: row.composite,
      f1: row.f1,
      counts: row.counts,
    })
  }
  const scoreDirect = async (
    surface: string,
    scenario: GepaAnalystScenario,
  ): Promise<HarvestRow> => {
    const controller = new AbortController()
    const ctx = {
      cellId: `selection-topup:${sha256Digest(surface).slice(0, 12)}:${scenario.id}`,
      rep: 0,
      seed: SEED,
      signal: controller.signal,
    } as unknown as DispatchContext
    const artifact = await dispatchWithSurface(surface, scenario, ctx)
    const verdict = await judge.score({
      artifact,
      scenario,
      signal: controller.signal,
    })
    return {
      rawComposite: verdict.dimensions.raw_composite ?? 0,
      weighted: verdict.composite,
      f1: verdict.dimensions.f1 ?? 0,
      counts: artifact.matchCounts,
    }
  }
  const comparison: Array<{
    scenarioId: string
    pool: string
    stratum: string
    goldMass: number
    baseline: HarvestRow
    winner: HarvestRow
    deltaWeighted: number
    deltaRaw: number
    deltaF1: number
  }> = []
  for (const scenario of selectionScenarios) {
    const baselineRow =
      harvest.get(`${baselineSha256}:${scenario.id}`) ?? (await scoreDirect(BASELINE, scenario))
    const winnerRow =
      winnerSha256 === baselineSha256
        ? baselineRow
        : (harvest.get(`${winnerSha256}:${scenario.id}`) ?? (await scoreDirect(winner, scenario)))
    comparison.push({
      scenarioId: scenario.id,
      pool: scenario.pool,
      stratum: scenario.stratum,
      goldMass: scenario.goldMass,
      baseline: baselineRow,
      winner: winnerRow,
      deltaWeighted: winnerRow.weighted - baselineRow.weighted,
      deltaRaw: winnerRow.rawComposite - baselineRow.rawComposite,
      deltaF1: winnerRow.f1 - baselineRow.f1,
    })
  }
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
  const comparisonBlock = (rows: readonly (typeof comparison)[number][]) => ({
    n: rows.length,
    weighted: {
      baselineMean: mean(rows.map((row) => row.baseline.weighted)),
      winnerMean: mean(rows.map((row) => row.winner.weighted)),
      deltaMean: mean(rows.map((row) => row.deltaWeighted)),
    },
    plainMacroComposite: {
      baselineMean: mean(rows.map((row) => row.baseline.rawComposite)),
      winnerMean: mean(rows.map((row) => row.winner.rawComposite)),
      deltaMean: mean(rows.map((row) => row.deltaRaw)),
    },
    plainMacroF1: {
      baselineMean: mean(rows.map((row) => row.baseline.f1)),
      winnerMean: mean(rows.map((row) => row.winner.f1)),
      deltaMean: mean(rows.map((row) => row.deltaF1)),
    },
    microF1: {
      baseline: microFromCounts(rows.map((row) => row.baseline.counts)),
      winner: microFromCounts(rows.map((row) => row.winner.counts)),
    },
  })
  const selectionPools = [...new Set(selectionScenarios.map((scenario) => scenario.pool))]
  const summary = {
    kind: 'agent-eval/gepa-analyst-campaign-summary',
    round: ROUND,
    scenarioFamily: FAMILY ? 'oht2' : null,
    recipeKind: recipe.kind,
    smoke: SMOKE,
    seed: SEED,
    model: MODEL,
    baseUrl: BASE_URL,
    runDir: RUN_DIR,
    ...(FAMILY ? { splitPlanPath: FAMILY_SPLIT_PLAN_PATH } : {}),
    pools: poolProvenance,
    stratification,
    scenarioCounts: {
      pool: scenarios.length,
      train: trainScenarios.length,
      selection: selectionScenarios.length,
    },
    trainScenarioIds: trainScenarios.map((scenario) => scenario.id),
    selectionScenarioIds: selectionScenarios.map((scenario) => scenario.id),
    weighting: FAMILY
      ? { scheme: 'none — plain per-case judge composite (weight identically 1)' }
      : {
          scheme: 'goldMass / maxGoldMass over the full 32-scenario pool',
          maxGoldMass,
          perScenario: Object.fromEntries(
            scenarios.map((scenario) => [scenario.id, goldMassWeight(scenario)]),
          ),
        },
    maxEvaluations: MAX_EVALUATIONS,
    evaluationsUsed: result.provenance?.evaluationCount,
    ...(FAMILY
      ? {
          budgetGeometry: {
            upstreamEvaluationTarget: MAX_EVALUATIONS,
            boundaryBurst,
            callbackCapPerRun: MAX_EVALUATIONS + boundaryBurst,
            execution: 'serial (engine parallel=false)',
          },
        }
      : {}),
    baselineSha256,
    winnerSha256,
    winnerChanged: winnerSha256 !== baselineSha256,
    // All metrics below are over the (spent) selection split; none certify.
    selectionComparison: {
      note:
        'paired per-scenario metrics over the selection split. weighted = the signal GEPA ' +
        'optimized (gold-mass-weighted judge composite in round 2; identical to the plain ' +
        'composite in family mode); plainMacroComposite = unweighted judge composite; ' +
        'plainMacroF1 = mean per-scenario f1; microF1 = pooled per-step counts. Weighted ' +
        'and plain metrics are different quantities — never compare one arm on weighted ' +
        'against another on plain.',
      ...comparisonBlock(comparison),
      perPool: Object.fromEntries(
        selectionPools.map((pool) => [
          pool,
          comparisonBlock(comparison.filter((row) => row.pool === pool)),
        ]),
      ),
      perScenario: comparison,
    },
    methodCost: result.cost,
    provenance: result.provenance,
    ledger: {
      total: costLedger.summary(),
      evaluation: costLedger.summary({ phase: EVAL_COST_PHASE }),
      optimizerModel: costLedger.summary({ phase: 'gepa.optimizer-model' }),
    },
    durationMs: Date.now() - started,
  }
  writeFileSync(join(RUN_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary.selectionComparison, null, 2))
  console.log(
    `[gepa-analyst-r${ROUND}] total ledger cost=$${costLedger.summary().totalCostUsd.toFixed(4)} ` +
      `summary=${join(RUN_DIR, 'summary.json')}`,
  )
}

interface CampaignSummaryInput extends Omit<PreparedCampaignScenarios, 'storesById'> {
  goldMassWeight: GoldMassWeight
  dispatchWithSurface: ReturnType<typeof createCampaignEvaluation>['dispatchWithSurface']
  judge: ReturnType<typeof createCampaignEvaluation>['judge']
  recipe: GepaOptimizationRecipe
  boundaryBurst: number
  result: OptimizationMethodResult
  winner: string
  winnerSha256: string
  baselineSha256: string
  started: number
  costLedger: CostLedgerHandle
}
