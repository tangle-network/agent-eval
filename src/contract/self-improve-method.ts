import { fileURLToPath } from 'node:url'
import { openAutoPr } from '../campaign/auto-pr'
import { campaignSplitDigest } from '../campaign/coverage'
import { evaluationUnitMap } from '../campaign/final-evidence'
import { defaultProductionGate } from '../campaign/gates/default-production-gate'
import {
  type ComparisonCost,
  combineComparisonCosts,
  costFromLedgerSummary,
} from '../campaign/optimization-cost'
import type { OptimizationMethodResult } from '../campaign/optimization-method'
import { executeOptimizationMethod } from '../campaign/optimization-method'
import { runFinalComparison } from '../campaign/presets/run-final-comparison'
import { campaignMeasurementDigest, canonicalDigest } from '../campaign/provenance'
import type { CampaignComparisonUnits } from '../campaign/score-utils'
import type { SearchHistoryCoverageRow } from '../campaign/search-history-receipt'
import type { CampaignStorage } from '../campaign/storage'
import { surfaceContentHash, surfaceHash } from '../campaign/surface-identity'
import type { MutableSurface, Scenario } from '../campaign/types'
import type { CostLedgerHandle, CostLedgerSummary } from '../cost-ledger'
import { createCampaignEvidenceReceipt } from '../experiment/campaign-evidence'
import type { EvaluationClaim } from '../experiment/claim'
import type { EvidenceReceipt } from '../experiment/evidence-receipt'
import { shipBestEffort, shipSearchLedger } from '../hosted/search-shipper'
import { analyzeRuns } from './analyze-runs'
import type {
  SelfImproveMethodOptions,
  SelfImproveOptions,
  SelfImproveProposerResult,
} from './self-improve'
import { cellsToRunRecords, pairedCompositeSummary } from './self-improve-reporting'

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
  claim?: EvaluationClaim
  evidence: {
    trainSplitDigest: `sha256:${string}`
    selectionSplitDigest: `sha256:${string}`
    holdoutSplitDigest: `sha256:${string}`
    baselineCampaignDigest: `sha256:${string}`
    winnerCampaignDigest: `sha256:${string}`
    costReceiptsDigest: `sha256:${string}`
    neutralizedCampaignDigest?: `sha256:${string}`
    holdoutObservations?: CampaignComparisonUnits
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
  evidence?: { baseline: EvidenceReceipt; winner: EvidenceReceipt }
  searchHistoryCoverage: SearchHistoryCoverageRow
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

type MethodRunArgs<TScenario extends Scenario, TArtifact> = {
  opts: SelfImproveOptions<TScenario, TArtifact> &
    Pick<SelfImproveMethodOptions<TScenario, TArtifact>, 'method'>
  train: TScenario[]
  selection: TScenario[]
  holdout: TScenario[]
  costLedger: CostLedgerHandle
  storage: CampaignStorage
  runDir: string
  startedAt: number
}

type FinalComparison<TScenario extends Scenario, TArtifact> = Awaited<
  ReturnType<typeof runFinalComparison<TScenario, TArtifact>>
>

type HoldoutReport = ReturnType<typeof pairedCompositeSummary>

const METHOD_FINAL_PHASE = 'selfImprove.method-final'

/** Complete methods own search and selection; this path only measures their final choice. */
export async function runSelfImproveMethod<TScenario extends Scenario, TArtifact>(
  args: MethodRunArgs<TScenario, TArtifact>,
): Promise<SelfImproveMethodResult<TScenario, TArtifact>> {
  const { opts, holdout, costLedger, startedAt } = args
  const budget = opts.budget ?? {}
  assertAutoPrTarget(opts)
  const evidenceContext = captureEvidenceContext(opts, budget)
  const baselineSurface = structuredClone(opts.baselineSurface)
  const { selected, cost: methodCost, history } = await searchWithMethod(args, baselineSurface)
  const totalCost = (): ComparisonCost => methodTotalCost(opts.method.name, methodCost, costLedger)
  const comparison = await measureMethodWinner(args, baselineSurface, selected, totalCost)
  const evidence = evidenceContext
    ? methodEvidenceReceipts(comparison, baselineSurface, selected, evidenceContext)
    : undefined
  const deferred = comparison.holdout === 'deferred'
  const report = deferred
    ? null
    : pairedCompositeSummary(
        comparison.baselineOnHoldout,
        comparison.winnerOnHoldout,
        opts.claim ? evaluationUnitMap(opts.claim, holdout) : undefined,
      )
  const baseline = report?.baseline ?? null
  const winner = report?.winner ?? null
  const lift = baseline && winner ? winner.compositeMean - baseline.compositeMean : undefined
  const insight = deferred
    ? undefined
    : await analyzeMethodHoldout(args, comparison, baselineSurface, selected)
  const cost = totalCost()
  const optimization = {
    name: opts.method.name,
    cost: methodCost,
    ...(selected.durationMs === undefined ? {} : { durationMs: selected.durationMs }),
    ...(selected.provenance === undefined ? {} : { provenance: selected.provenance }),
  }
  const durationMs = Date.now() - startedAt
  const receipts = costLedger.list()
  const provenance = recordMethodProvenance({
    args,
    comparison,
    baselineSurface,
    selected,
    report,
    lift,
    optimization,
    cost,
    durationMs,
    receipts,
  })
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
    ...(evidence ? { evidence } : {}),
    mode: 'method',
    ...(opts.claim ? { claim: opts.claim } : {}),
    ...(comparison.finalEvidence ? { finalEvidence: comparison.finalEvidence } : {}),
    searchHistoryCoverage: history,
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
  await shipMethodSearchLedger(opts, selected)
  return result
}

/** An auto-PR needs a target repository before any spend. */
function assertAutoPrTarget(opts: { autoOnPromote?: string; ghOwner?: string; ghRepo?: string }) {
  if (opts.autoOnPromote === 'pr' && (!opts.ghOwner || !opts.ghRepo)) {
    throw new Error("selfImprove: autoOnPromote='pr' requires ghOwner + ghRepo")
  }
}

/** Detach the caller's evidence context; receipts need a measured holdout. */
function captureEvidenceContext<TScenario extends Scenario, TArtifact>(
  opts: MethodRunArgs<TScenario, TArtifact>['opts'],
  budget: NonNullable<SelfImproveOptions<TScenario, TArtifact>['budget']>,
) {
  const evidenceContext = opts.evidence === undefined ? undefined : structuredClone(opts.evidence)
  if (evidenceContext && budget.holdout === 'deferred')
    throw new Error('selfImprove: evidence receipts require measured holdout')
  return evidenceContext
}

/** Let the method search and select a winner on the train and selection splits. */
function searchWithMethod<TScenario extends Scenario, TArtifact>(
  args: MethodRunArgs<TScenario, TArtifact>,
  baselineSurface: MutableSurface,
) {
  const { opts, train, selection, costLedger, storage, runDir } = args
  const budget = opts.budget ?? {}
  return executeOptimizationMethod({
    method: opts.method,
    storage,
    searchHistoryPolicy: opts.searchHistoryPolicy,
    searchHistoryVerification: opts.searchHistoryVerification,
    input: {
      baselineSurface,
      trainScenarios: train,
      selectionScenarios: selection,
      dispatchWithSurface: opts.agent,
      judges: [opts.judge],
      runDir: `${runDir}/optimization/${opts.method.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      seed: 42,
      runOptions: {
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
      },
      costLedger,
    },
  })
}

/** Spend on the final holdout comparison, read back from the shared ledger. */
function methodFinalCost(costLedger: CostLedgerHandle): ComparisonCost {
  return combineComparisonCosts(
    ['holdout.baseline', 'holdout.winner', 'holdout.neutralized', 'promotion.gate'].map(
      (phase) => ({
        label: phase,
        cost: costFromLedgerSummary(
          costLedger.summary({ phase: `${METHOD_FINAL_PHASE}.${phase}` }),
        ),
      }),
    ),
  )
}

/** The method's own spend plus the final comparison's. */
function methodTotalCost(
  methodName: string,
  methodCost: ComparisonCost,
  costLedger: CostLedgerHandle,
): ComparisonCost {
  return combineComparisonCosts([
    { label: methodName, cost: methodCost },
    { label: 'final comparison', cost: methodFinalCost(costLedger) },
  ])
}

/** Measure baseline and winner on the holdout; the gate holds when spend breaks the budget. */
function measureMethodWinner<TScenario extends Scenario, TArtifact>(
  args: MethodRunArgs<TScenario, TArtifact>,
  baselineSurface: MutableSurface,
  selected: OptimizationMethodResult,
  totalCost: () => ComparisonCost,
) {
  const { opts, holdout, costLedger, storage, runDir } = args
  const budget = opts.budget ?? {}
  const gate =
    opts.gate ??
    defaultProductionGate<TArtifact, TScenario>({
      holdoutScenarios: holdout,
      deltaThreshold: opts.claim?.minimumEffect ?? 0.05,
      independentUnitByScenarioId: opts.claim ? evaluationUnitMap(opts.claim, holdout) : undefined,
    })
  return runFinalComparison({
    claim: opts.claim,
    finalEvidence: opts.finalEvidence,
    baselineSurface,
    winnerSurface: selected.winnerSurface,
    scenarios: holdout,
    dispatchWithSurface: opts.agent,
    dispatchRef: opts.dispatchRef,
    judges: [opts.judge],
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
    costPhase: METHOD_FINAL_PHASE,
    reps: budget.reps,
    maxConcurrency: budget.maxConcurrency ?? 2,
    dispatchTimeoutMs: opts.dispatchTimeoutMs,
    cellRetry: opts.cellRetry,
    cellPlacement: opts.cellPlacement,
    expectUsage: opts.expectUsage ?? 'assert',
    label: 'selfImprove',
  })
}

/** Evidence receipts for the baseline and winner holdout campaigns. */
function methodEvidenceReceipts<TScenario extends Scenario, TArtifact>(
  comparison: FinalComparison<TScenario, TArtifact>,
  baselineSurface: MutableSurface,
  selected: OptimizationMethodResult,
  evidenceContext: NonNullable<SelfImproveOptions<TScenario, TArtifact>['evidence']>,
) {
  return {
    baseline: createCampaignEvidenceReceipt({
      campaign: comparison.baselineOnHoldout,
      surface: baselineSurface,
      context: evidenceContext,
    }),
    winner: createCampaignEvidenceReceipt({
      campaign: comparison.winnerOnHoldout,
      surface: selected.winnerSurface,
      context: evidenceContext,
    }),
  }
}

/** Analyze the measured holdout runs; a winner that is the baseline adds no second candidate. */
function analyzeMethodHoldout<TScenario extends Scenario, TArtifact>(
  args: MethodRunArgs<TScenario, TArtifact>,
  comparison: FinalComparison<TScenario, TArtifact>,
  baselineSurface: MutableSurface,
  selected: OptimizationMethodResult,
) {
  const { opts, holdout, runDir } = args
  return analyzeRuns({
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
    independentUnitByScenarioId: opts.claim ? evaluationUnitMap(opts.claim, holdout) : undefined,
    decisionThreshold: opts.claim?.minimumEffect ?? 0.05,
    ...(comparison.winnerOnHoldout === comparison.baselineOnHoldout
      ? {}
      : { candidateCandidateId: 'winner' }),
  })
}

/** Build, persist and return the digest-sealed provenance record. */
function recordMethodProvenance<TScenario extends Scenario, TArtifact>(input: {
  args: MethodRunArgs<TScenario, TArtifact>
  comparison: FinalComparison<TScenario, TArtifact>
  baselineSurface: MutableSurface
  selected: OptimizationMethodResult
  report: HoldoutReport | null
  lift: number | undefined
  optimization: SelfImproveMethodProvenance['optimizationMethod']
  cost: ComparisonCost
  durationMs: number
  receipts: ReturnType<CostLedgerHandle['list']>
}): SelfImproveMethodProvenance {
  const { args, comparison, baselineSurface, selected, report, lift, optimization } = input
  const { opts, train, selection, holdout, storage, runDir, startedAt } = args
  const budget = opts.budget ?? {}
  const baseline = report?.baseline ?? null
  const winner = report?.winner ?? null
  const record = {
    schema: 'tangle.method-improvement' as const,
    runId: `${runDir}#${startedAt}`,
    runDir,
    timestamp: new Date(startedAt).toISOString(),
    baselineContentHash: surfaceContentHash(baselineSurface),
    winnerContentHash: surfaceContentHash(selected.winnerSurface),
    diff: comparison.promotedDiff,
    optimizationMethod: optimization,
    ...(opts.claim ? { claim: opts.claim } : {}),
    evidence: {
      trainSplitDigest: campaignSplitDigest(train, budget.reps ?? 1),
      selectionSplitDigest: campaignSplitDigest(selection, budget.reps ?? 1),
      holdoutSplitDigest: campaignSplitDigest(holdout, budget.reps ?? 1),
      baselineCampaignDigest: campaignMeasurementDigest(comparison.baselineOnHoldout),
      winnerCampaignDigest: campaignMeasurementDigest(comparison.winnerOnHoldout),
      costReceiptsDigest: canonicalDigest(input.receipts),
      ...(report ? { holdoutObservations: report.observations } : {}),
      ...(comparison.neutralizedOnHoldout
        ? { neutralizedCampaignDigest: campaignMeasurementDigest(comparison.neutralizedOnHoldout) }
        : {}),
    },
    gate: comparison.gateResult,
    ...(comparison.holdout === 'deferred' ? { holdout: 'deferred' as const } : {}),
    ...(baseline && winner
      ? {
          baselineHoldoutComposite: baseline.compositeMean,
          winnerHoldoutComposite: winner.compositeMean,
          heldOutLift: lift,
        }
      : {}),
    cost: input.cost,
    totalCostUsd: input.cost.totalCostUsd,
    totalDurationMs: input.durationMs,
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
  return provenance
}

/** Ship the method's search ledger to the hosted tenant, when one is configured. */
async function shipMethodSearchLedger<TScenario extends Scenario, TArtifact>(
  opts: MethodRunArgs<TScenario, TArtifact>['opts'],
  selected: OptimizationMethodResult,
): Promise<void> {
  if (!opts.hostedTenant) return
  const receipt = selected.searchHistory
  if (receipt) {
    const path = fileURLToPath(receipt.ledger.uri)
    await shipBestEffort(
      () =>
        shipSearchLedger({
          tenant: opts.hostedTenant!,
          ledger: { path, searchId: receipt.summary.searchId },
          runKind: 'optimization',
        }),
      path,
    )
  } else {
    console.warn(
      `[agent-eval] hostedTenant: method ${opts.method.name} recorded no search ledger, so nothing was shipped`,
    )
  }
}
