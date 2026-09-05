import { openAutoPr } from '../campaign/auto-pr'
import { campaignSplitDigest } from '../campaign/coverage'
import { defaultProductionGate } from '../campaign/gates/default-production-gate'
import { createMethodCostScope } from '../campaign/optimization-cost'
import {
  assertOptimizationResult,
  type ComparisonCost,
  combineComparisonCosts,
  costFromLedgerSummary,
  type OptimizationMethodResult,
} from '../campaign/presets/compare-optimization-methods'
import { runFinalComparison } from '../campaign/presets/run-final-comparison'
import { campaignMeasurementDigest, canonicalDigest } from '../campaign/provenance'
import {
  campaignCellExecutionEvidence,
  campaignCellJudgeDimensions,
  campaignCellTaskScore,
} from '../campaign/run-record'
import type { CampaignStorage } from '../campaign/storage'
import { surfaceContentHash, surfaceHash } from '../campaign/surface-identity'
import type { Scenario } from '../campaign/types'
import type { CostLedgerHandle, CostLedgerSummary } from '../cost-ledger'
import { createHostedClient } from '../hosted/client'
import type { EvalRunGenerationSnapshot } from '../hosted/types'
import { analyzeRuns } from './analyze-runs'
import type {
  SelfImproveMethodOptions,
  SelfImproveOptions,
  SelfImproveProposerResult,
} from './self-improve'
import { cellsToRunRecords, meanComposite } from './self-improve-reporting'

export interface SelfImproveMethodProvenance {
  schema: 'tangle.method-improvement'
  recordDigest: `sha256:${string}`
  runId: string
  runDir: string
  timestamp: string
  baselineContentHash: string
  winnerContentHash: string
  diff: string
  optimizationMethod: NonNullable<SelfImproveProposerResult<Scenario, unknown>['optimization']>
  evidence: {
    trainSplitDigest: `sha256:${string}`
    selectionSplitDigest: `sha256:${string}`
    holdoutSplitDigest: `sha256:${string}`
    baselineCampaignDigest: `sha256:${string}`
    winnerCampaignDigest: `sha256:${string}`
    costReceiptsDigest: `sha256:${string}`
    neutralizedCampaignDigest?: `sha256:${string}`
  }
  gate: Awaited<ReturnType<typeof runFinalComparison>>['gateResult']
  holdout?: 'deferred'
  baselineHoldoutComposite?: number
  winnerHoldoutComposite?: number
  heldOutLift?: number
  cost: ComparisonCost
  totalCostUsd: number
  totalDurationMs: number
}

export interface SelfImproveMethodResult<TScenario extends Scenario, TArtifact>
  extends Omit<
    SelfImproveProposerResult<TScenario, TArtifact>,
    | 'mode'
    | 'baseline'
    | 'winner'
    | 'provenance'
    | 'generationsExplored'
    | 'cost'
    | 'raw'
    | 'optimization'
    | 'insight'
  > {
  mode: 'method'
  /** No final measurement exists when holdout is deferred. */
  baseline: SelfImproveProposerResult<TScenario, TArtifact>['baseline'] | null
  winner: Omit<SelfImproveProposerResult<TScenario, TArtifact>['winner'], 'compositeMean'> & {
    compositeMean: number | null
  }
  provenance: SelfImproveMethodProvenance
  optimization: NonNullable<SelfImproveProposerResult<TScenario, TArtifact>['optimization']>
  /** Includes the method's reported cost and final measurements without double counting receipts. */
  cost: ComparisonCost
  /** Only calls actually recorded by the shared ledger have token and channel breakdowns. */
  ledgerCost: CostLedgerSummary
  insight?: SelfImproveProposerResult<TScenario, TArtifact>['insight']
  raw: Awaited<ReturnType<typeof runFinalComparison<TScenario, TArtifact>>> & {
    kind: 'method'
    baselineSurface: SelfImproveProposerResult<TScenario, TArtifact>['raw']['baselineSurface']
    winnerSurface: SelfImproveProposerResult<TScenario, TArtifact>['raw']['winnerSurface']
    winnerSurfaceHash: string
    method: OptimizationMethodResult
    cost: ComparisonCost
    prResult?: ReturnType<typeof openAutoPr>
  }
}

/** Complete methods own search and selection; this path only measures their final choice. */
export async function runSelfImproveMethod<TScenario extends Scenario, TArtifact>(args: {
  opts: SelfImproveOptions<TScenario, TArtifact> &
    Pick<SelfImproveMethodOptions<TScenario, TArtifact>, 'method'>
  train: TScenario[]
  selection: TScenario[]
  holdout: TScenario[]
  costLedger: CostLedgerHandle
  storage: CampaignStorage
  runDir: string
  startedAt: number
}): Promise<SelfImproveMethodResult<TScenario, TArtifact>> {
  const { opts, train, selection, holdout, costLedger, storage, runDir, startedAt } = args
  const budget = opts.budget ?? {}
  if (opts.autoOnPromote === 'pr' && (!opts.ghOwner || !opts.ghRepo)) {
    throw new Error("selfImprove: autoOnPromote='pr' requires ghOwner + ghRepo")
  }
  const baselineSurface = structuredClone(opts.baselineSurface)
  const judge = {
    ...opts.judge,
    dimensions: opts.judge.dimensions.map((dimension) => Object.freeze({ ...dimension })),
  }
  Object.freeze(judge.dimensions)
  Object.freeze(judge)
  const methodCostScope = createMethodCostScope(costLedger, opts.method.name)
  const method = await opts.method.optimize(
    Object.freeze({
      baselineSurface: structuredClone(baselineSurface),
      trainScenarios: Object.freeze(train.map((scenario) => structuredClone(scenario))),
      selectionScenarios: Object.freeze(selection.map((scenario) => structuredClone(scenario))),
      dispatchWithSurface: opts.agent,
      judges: Object.freeze([judge]),
      runDir: `${runDir}/optimization/${opts.method.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      seed: 42,
      runOptions: Object.freeze({
        storage,
        maxConcurrency: budget.maxConcurrency ?? 2,
        reps: budget.reps,
        dispatchRef: opts.dispatchRef,
        dispatchTimeoutMs: opts.dispatchTimeoutMs,
        cellRetry: opts.cellRetry,
        cellPlacement: opts.cellPlacement,
        labeledStore: opts.labeledStore,
        captureSource: opts.captureSource,
        expectUsage: opts.expectUsage ?? 'assert',
      }),
      costLedger: methodCostScope.ledger,
    }),
  )
  assertOptimizationResult(opts.method.name, method)
  const selected = structuredClone(method)
  const methodCost = methodCostScope.reconcile(selected.cost)
  const finalPhase = 'selfImprove.method-final'
  const finalCost = (): ComparisonCost =>
    combineComparisonCosts(
      ['holdout.baseline', 'holdout.winner', 'holdout.neutralized', 'promotion.gate'].map(
        (phase) => ({
          label: phase,
          cost: costFromLedgerSummary(costLedger.summary({ phase: `${finalPhase}.${phase}` })),
        }),
      ),
    )
  const totalCost = (): ComparisonCost =>
    combineComparisonCosts([
      { label: opts.method.name, cost: methodCost },
      { label: 'final comparison', cost: finalCost() },
    ])
  const gate =
    opts.gate ??
    defaultProductionGate<TArtifact, TScenario>({
      holdoutScenarios: holdout,
      deltaThreshold: 0.05,
    })
  const comparison = await runFinalComparison({
    baselineSurface,
    winnerSurface: selected.winnerSurface,
    scenarios: holdout,
    dispatchWithSurface: opts.agent,
    dispatchRef: opts.dispatchRef,
    judges: [judge],
    holdout: budget.holdout,
    neutralize: opts.neutralize,
    gate: {
      ...gate,
      async decide(context) {
        const cost = totalCost()
        if (
          budget.dollars !== undefined &&
          (!cost.accountingComplete || cost.totalCostUsd > budget.dollars)
        ) {
          return {
            decision: 'hold' as const,
            reasons: ['complete method spend cannot satisfy the declared run budget'],
            contributingGates: [
              {
                name: 'budget',
                status: 'fail' as const,
                detail: { cost, budgetUsd: budget.dollars },
              },
            ],
          }
        }
        return gate.decide(context)
      },
    },
    runDir,
    storage,
    costLedger,
    costPhase: finalPhase,
    reps: budget.reps,
    maxConcurrency: budget.maxConcurrency ?? 2,
    dispatchTimeoutMs: opts.dispatchTimeoutMs,
    cellRetry: opts.cellRetry,
    cellPlacement: opts.cellPlacement,
    expectUsage: opts.expectUsage ?? 'assert',
    label: 'selfImprove',
  })
  const deferred = comparison.holdout === 'deferred'
  const baseline = deferred
    ? null
    : meanComposite(comparison.baselineOnHoldout.aggregates.byScenario)
  const winner = deferred ? null : meanComposite(comparison.winnerOnHoldout.aggregates.byScenario)
  const lift = baseline && winner ? winner.compositeMean - baseline.compositeMean : undefined
  const insight = deferred
    ? undefined
    : await analyzeRuns({
        runs: [
          ...cellsToRunRecords(
            comparison.baselineOnHoldout.cells,
            'baseline',
            runDir,
            baselineSurface,
            'holdout',
            opts.model,
          ),
          ...(comparison.winnerOnHoldout === comparison.baselineOnHoldout
            ? []
            : cellsToRunRecords(
                comparison.winnerOnHoldout.cells,
                'winner',
                runDir,
                selected.winnerSurface,
                'holdout',
                opts.model,
              )),
        ],
        baselineCandidateId: 'baseline',
        ...(comparison.winnerOnHoldout === comparison.baselineOnHoldout
          ? {}
          : { candidateCandidateId: 'winner' }),
      })
  const cost = totalCost()
  const optimization = {
    name: opts.method.name,
    cost: methodCost,
    ...(selected.durationMs === undefined ? {} : { durationMs: selected.durationMs }),
    ...(selected.provenance === undefined ? {} : { provenance: selected.provenance }),
  }
  const durationMs = Date.now() - startedAt
  const receipts = costLedger.list()
  const record = {
    schema: 'tangle.method-improvement' as const,
    runId: `${runDir}#${startedAt}`,
    runDir,
    timestamp: new Date(startedAt).toISOString(),
    baselineContentHash: surfaceContentHash(baselineSurface),
    winnerContentHash: surfaceContentHash(selected.winnerSurface),
    diff: comparison.promotedDiff,
    optimizationMethod: optimization,
    evidence: {
      trainSplitDigest: campaignSplitDigest(train, budget.reps ?? 1),
      selectionSplitDigest: campaignSplitDigest(selection, budget.reps ?? 1),
      holdoutSplitDigest: campaignSplitDigest(holdout, budget.reps ?? 1),
      baselineCampaignDigest: campaignMeasurementDigest(comparison.baselineOnHoldout),
      winnerCampaignDigest: campaignMeasurementDigest(comparison.winnerOnHoldout),
      costReceiptsDigest: canonicalDigest(receipts),
      ...(comparison.neutralizedOnHoldout
        ? { neutralizedCampaignDigest: campaignMeasurementDigest(comparison.neutralizedOnHoldout) }
        : {}),
    },
    gate: comparison.gateResult,
    ...(deferred ? { holdout: 'deferred' as const } : {}),
    ...(baseline && winner
      ? {
          baselineHoldoutComposite: baseline.compositeMean,
          winnerHoldoutComposite: winner.compositeMean,
          heldOutLift: lift,
        }
      : {}),
    cost,
    totalCostUsd: cost.totalCostUsd,
    totalDurationMs: durationMs,
  }
  // The persisted JSON and returned record must have the same canonical content.
  const serialized: Omit<SelfImproveMethodProvenance, 'recordDigest'> = JSON.parse(
    JSON.stringify(record),
  )
  const provenance: SelfImproveMethodProvenance = {
    ...serialized,
    recordDigest: canonicalDigest(serialized),
  }
  storage.ensureDir(runDir)
  storage.write(`${runDir}/method-provenance.json`, JSON.stringify(provenance, null, 2))
  opts.onProvenance?.(provenance)
  opts.onProgress?.({
    kind: 'gate.decided',
    decision: comparison.gateResult.decision,
    ...(lift === undefined ? {} : { lift }),
  })
  const prResult =
    opts.autoOnPromote === 'pr' && comparison.gateResult.decision === 'ship'
      ? openAutoPr({
          result: comparison.winnerOnHoldout,
          gate: comparison.gateResult,
          promotedDiff: comparison.promotedDiff,
          ghOwner: opts.ghOwner!,
          ghRepo: opts.ghRepo!,
        })
      : undefined
  const result: SelfImproveMethodResult<TScenario, TArtifact> = {
    mode: 'method',
    baseline,
    winner: {
      surface: selected.winnerSurface,
      compositeMean: winner?.compositeMean ?? null,
      perScenario: winner?.perScenario ?? {},
      label: opts.method.name,
    },
    ...(lift === undefined ? {} : { lift }),
    diff: comparison.promotedDiff,
    gateDecision: comparison.gateResult.decision,
    provenance,
    optimization,
    cost,
    ledgerCost: costLedger.summary(),
    totalCostUsd: cost.totalCostUsd,
    durationMs,
    receipts,
    ...(insight ? { insight } : {}),
    ...(selected.searchHistory ? { searchHistory: selected.searchHistory } : {}),
    raw: {
      ...comparison,
      kind: 'method',
      baselineSurface,
      winnerSurface: selected.winnerSurface,
      winnerSurfaceHash: surfaceHash(selected.winnerSurface),
      method: selected,
      cost,
      ...(prResult ? { prResult } : {}),
    },
  }
  if (opts.hostedTenant) {
    const snapshot = (
      index: number,
      surface: typeof baselineSurface,
      campaign: typeof comparison.baselineOnHoldout,
    ): EvalRunGenerationSnapshot => ({
      index,
      surfaceHash: surfaceHash(surface),
      surface,
      cells: campaign.cells.map((cell) => {
        const execution = campaignCellExecutionEvidence(cell)
        return {
          scenarioId: cell.scenarioId,
          rep: cell.rep,
          compositeMean: campaignCellTaskScore(cell) ?? null,
          dimensions: campaignCellJudgeDimensions(cell),
          terminalOutcome: execution.terminalOutcome,
          executionErrorCount: execution.executionErrorCount ?? null,
          ...(cell.error ? { errorMessage: cell.error } : {}),
        }
      }),
      compositeMean: deferred ? null : meanComposite(campaign.aggregates.byScenario).compositeMean,
      costUsd: campaign.aggregates.cost.totalCostUsd,
      durationMs: campaign.durationMs,
    })
    try {
      await createHostedClient(opts.hostedTenant).ingestEvalRun({
        runId: provenance.runId,
        runDir,
        timestamp: provenance.timestamp,
        status: 'finished',
        labels: { ...opts.hostedLabels, mode: 'method' },
        baseline: snapshot(0, baselineSurface, comparison.baselineOnHoldout),
        generations: [snapshot(1, selected.winnerSurface, comparison.winnerOnHoldout)],
        gateDecision: result.gateDecision,
        ...(lift === undefined ? {} : { holdoutLift: lift }),
        totalCostUsd: result.totalCostUsd,
        totalDurationMs: durationMs,
        ...(insight ? { insightReport: insight } : {}),
      })
    } catch (error) {
      console.warn(
        `[agent-eval] hosted ingest failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}
