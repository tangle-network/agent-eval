/**
 * `runOptimization` — the improvement loop body. Runs N generations: the
 * `SurfaceProposer` proposes K candidate surfaces per generation, each
 * candidate runs a campaign (the measurement), and only a candidate that beats
 * the single global incumbent becomes the next generation's parent.
 * Proposer-agnostic — the same loop runs an evolutionary population mutator
 * (`evolutionaryProposer`) or any reflective / agentic proposer; they differ
 * only in how `propose()` picks candidates.
 *
 * This is `runLoop`'s shape (plan → measure → decide) specialized to surface
 * improvement: `proposer.propose` = plan, `runCampaign` = the measurement
 * (which runs the worker behind `dispatch`), the mean-composite ranking = the
 * validator, `proposer.decide` = the stop check.
 *
 * The gated-promotion shell (`runImprovementLoop`) wraps this with a holdout
 * re-score + release gate + optional PR.
 */

import type { CostLedgerHandle, CostLedgerSummary } from '../../cost-ledger'
import { type Objective, paretoFrontier } from '../../pareto'
import { type CampaignCoverage, campaignCoverage, formatCoverageFailures } from '../coverage'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import { campaignBreakdown, campaignMeanComposite } from '../score-utils'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceHash } from '../surface-identity'
import {
  type CampaignResult,
  type GenerationRecord,
  isProposedCandidate,
  type MutableSurface,
  type ParetoParent,
  type ProposedCandidate,
  type Scenario,
  type ScoredSurfaceOutcome,
  type SurfaceProposer,
} from '../types'

export interface RunOptimizationBaseOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch'> {
  /** Initial mutable surface (typically system prompt or addendum). */
  baselineSurface: MutableSurface
  /** Dispatcher that takes the CURRENT surface + scenario → artifact. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  /** The candidate-generation strategy. Wrap a population `Mutator` via
   *  `evolutionaryProposer({ mutator })`, or pass any reflective / agentic
   *  proposer that implements `SurfaceProposer`. */
  proposer: SurfaceProposer
  populationSize: number
  maxGenerations: number
  /** @deprecated The loop has one global incumbent and can promote only the
   *  single candidate that beats it. Retained for source compatibility. */
  promoteTopK?: number
  /** DEPTH knob forwarded to the proposer's `propose()` — max iterations the
   *  agentic generator may take per candidate. */
  maxImprovementShots?: number
  /** Optional analysis report forwarded to `propose()`. Opaque here; the
   *  proposer types it. */
  report?: unknown
  /** Structured findings forwarded to `propose()` as `ctx.findings`. A
   *  findings producer emits these from the
   *  generation's traces; findings-grounded proposers consume them. Opaque here;
   *  the proposer types its `TFindings`. Empty when no producer is wired. */
  findings?: unknown[]
  /** Per-generation findings producer. Runs once on the BASELINE campaign
   *  (as `generation: -1`, the baseline convention) before generation 0
   *  proposes — so even a single-generation run proposes with trace context —
   *  and then after each generation's candidates are scored with that
   *  generation's results; whatever it returns REPLACES `ctx.findings` for the
   *  NEXT `propose()`, so the diagnosis is refreshed each round instead
   *  of being a static one-shot. Generic by design: the substrate does not
   *  import an analyst — the consumer plugs its trace-analyst registry / HALO
   *  here (reading the per-candidate `runDir` traces). When absent, findings
   *  stay the static `opts.findings`. */
  analyzeGeneration?: (input: {
    generation: number
    runDir: string
    candidates: Array<{
      surfaceHash: string
      campaign: CampaignResult<TArtifact, TScenario>
      composite: number
    }>
    history: GenerationRecord[]
    /** Shared run spend account and receipt attribution phase. */
    costLedger?: CostLedgerHandle
    costPhase?: string
  }) => Promise<unknown[]>
}

export type RunOptimizationOptions<
  TScenario extends Scenario,
  TArtifact,
> = RunOptimizationBaseOptions<TScenario, TArtifact>

export interface RunOptimizationResult<TArtifact, TScenario extends Scenario> {
  generations: Array<{
    record: GenerationRecord
    surfaces: Array<{
      surfaceHash: string
      surface: MutableSurface
      campaign: CampaignResult<TArtifact, TScenario>
    }>
  }>
  winnerSurface: MutableSurface
  winnerSurfaceHash: string
  /** Proposer label for the promoted surface. Present when the winning
   *  candidate came from a `ProposedCandidate` (a reflective proposer);
   *  absent when the winner is the baseline or a bare-surface mutator. */
  winnerLabel?: string
  /** Proposer rationale for the promoted surface — the "because Z" that
   *  motivated the winning change. Survives to `SelfImproveResult` and the
   *  emitted provenance record. Absent when the winner is the baseline. */
  winnerRationale?: string
  baselineCampaign: CampaignResult<TArtifact, TScenario>
  /** Run-wide spend, including agents, proposers, analysts, and judges. */
  cost: CostLedgerSummary
  /** The GEPA Pareto frontier across every scored surface (baseline + all
   *  generations) by per-scenario objective vector — the non-dominated set.
   *  Each generation's `propose()` received the frontier-so-far as
   *  `ctx.paretoParents`; this is the final frontier. A surface here that is
   *  NOT the winner is uniquely best on some scenario the winner loses on. */
  paretoFrontier: ParetoParent[]
}

/**
 * Improvement loop body: N generations of propose → campaign → rank, maintaining a Pareto frontier and one global incumbent across generations.
 */
export async function runOptimization<TScenario extends Scenario, TArtifact>(
  opts: RunOptimizationOptions<TScenario, TArtifact>,
): Promise<RunOptimizationResult<TArtifact, TScenario>> {
  const { proposer } = opts
  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('runOptimization: runDir is required and must be a non-empty string')
  }
  opts.runDir = resolveRunDir(opts.runDir, opts.repo)
  const storage = opts.storage ?? fsCampaignStorage()
  const costLedger =
    opts.costLedger ??
    createRunCostLedger({
      storage,
      runDir: opts.runDir,
      costCeilingUsd: opts.costCeiling,
    })
  if (opts.promoteTopK !== undefined && opts.promoteTopK !== 1) {
    throw new Error(
      'runOptimization: promoteTopK must be 1 because the loop has one global incumbent',
    )
  }

  // Baseline run
  const baselineCampaign = await runCampaign<TScenario, TArtifact>({
    ...opts,
    costLedger,
    costPhase: 'search.baseline',
    dispatch: (scenario, ctx) => opts.dispatchWithSurface(opts.baselineSurface, scenario, ctx),
    runDir: `${opts.runDir}/baseline`,
  })
  const requireJudgeScore = (opts.judges?.length ?? 0) > 0
  const baselineCoverage = campaignCoverage(
    baselineCampaign.cells,
    opts.scenarios,
    opts.reps ?? 1,
    requireJudgeScore,
  )
  if (!baselineCoverage.complete) {
    throw new Error(
      `runOptimization: baseline is incomplete (${baselineCoverage.scorableCellIds.length}/${baselineCoverage.expectedCellIds.length} designed cells scorable) — ${formatCoverageFailures(baselineCoverage)}. Refusing to optimize against an incomplete incumbent.`,
    )
  }

  const generations: RunOptimizationResult<TArtifact, TScenario>['generations'] = []
  const history: GenerationRecord[] = []
  // Refreshed each generation by `analyzeGeneration`; seeded with the static
  // caller-supplied findings.
  let currentFindings: unknown[] = opts.findings ?? []
  let winnerSurface = opts.baselineSurface
  let winnerSurfaceHash = surfaceHash(opts.baselineSurface)
  let winnerComposite = campaignMeanComposite(baselineCampaign)
  const baselineOutcome = toScoredSurfaceOutcome(
    winnerSurfaceHash,
    baselineCampaign,
    baselineCoverage,
    -1,
  )
  let winnerOutcome = baselineOutcome
  let winnerLabel: string | undefined
  let winnerRationale: string | undefined

  // GEPA frontier accumulator — every scored surface as an objective vector
  // (per-scenario composite). The baseline seeds it as generation -1; each
  // candidate is added after its campaign. The non-dominated set of this list
  // is recomputed before every `propose()` and handed to the proposer.
  const scored: ParetoParent[] = [
    toParetoParent(opts.baselineSurface, winnerSurfaceHash, baselineCampaign, -1),
  ]

  // Diagnose the BASELINE traces before generation 0 proposes. The
  // between-generation producer call below only fires after gen g to feed gen
  // g+1, so without this a single-generation run (maxGenerations = 1)
  // proposes blind even though baseline traces exist. Baseline is
  // `generation: -1` — the same convention the Pareto accumulator uses above.
  // Skipped when the baseline produced no cells (dry/offline modes have no
  // traces to analyze) or there is no generation 0 to feed; `propose()` then
  // sees the static seed findings exactly as before.
  if (opts.analyzeGeneration && opts.maxGenerations > 0 && baselineCampaign.cells.length > 0) {
    const fresh = await opts.analyzeGeneration({
      generation: -1,
      runDir: `${opts.runDir}/baseline`,
      candidates: [
        { surfaceHash: winnerSurfaceHash, campaign: baselineCampaign, composite: winnerComposite },
      ],
      history,
      costLedger,
      costPhase: 'analysis.baseline',
    })
    if (Array.isArray(fresh)) currentFindings = fresh
  }

  for (let gen = 0; gen < opts.maxGenerations; gen++) {
    // Decide: the proposer may stop early based on accumulated history.
    if (proposer.decide?.({ history }).stop) break

    // Plan: the proposer proposes N candidates from the current best surface,
    // the accumulated generation history, the Pareto frontier so far, and any
    // external findings.
    const paretoParents = computeParetoFrontier(scored)
    const parentSurfaceHash = winnerSurfaceHash
    const parentComposite = winnerComposite
    const proposed = await proposer.propose({
      // The mutation anchor is always the best complete surface seen across the
      // whole run. Exploratory losers remain in history/Pareto evidence, but a
      // later generation never compounds a candidate already known to regress.
      currentSurface: winnerSurface,
      history,
      findings: currentFindings,
      populationSize: opts.populationSize,
      generation: gen,
      signal: new AbortController().signal,
      baselineOutcome,
      incumbentOutcome: winnerOutcome,
      report: opts.report,
      dataset: opts.labeledStore && opts.labeledStore !== 'off' ? opts.labeledStore : undefined,
      maxImprovementShots: opts.maxImprovementShots,
      paretoParents,
      costLedger,
      costPhase: 'search.proposal',
    })
    if (proposed.length === 0) break

    // Normalize: a proposer may return bare surfaces (blind mutators) or
    // `ProposedCandidate`s carrying {label, rationale}. Keep the rationale so
    // each candidate stays attributable through to the result + provenance.
    const candidates: ProposedCandidate[] = proposed.map((p) =>
      isProposedCandidate(p) ? p : { surface: p, label: '', rationale: '' },
    )

    // Run each candidate as its own campaign.
    const surfaceResults: Array<{
      surfaceHash: string
      surface: MutableSurface
      label: string
      rationale: string
      candidateRecord?: ProposedCandidate['candidateRecord']
      campaign: CampaignResult<TArtifact, TScenario>
      composite: number
      coverage: CampaignCoverage
    }> = []
    for (let i = 0; i < candidates.length; i++) {
      const { surface, label, rationale, candidateRecord } = candidates[i]!
      const hash = surfaceHash(surface)
      const campaign = await runCampaign<TScenario, TArtifact>({
        ...opts,
        costLedger,
        costPhase: 'search.candidate',
        dispatch: (scenario, ctx) => opts.dispatchWithSurface(surface, scenario, ctx),
        runDir: `${opts.runDir}/gen-${gen}/candidate-${i}`,
      })
      const composite = campaignMeanComposite(campaign)
      const coverage = campaignCoverage(
        campaign.cells,
        opts.scenarios,
        opts.reps ?? 1,
        requireJudgeScore,
      )
      surfaceResults.push({
        surfaceHash: hash,
        surface,
        label,
        rationale,
        ...(candidateRecord ? { candidateRecord } : {}),
        campaign,
        composite,
        coverage,
      })
      if (coverage.complete) {
        // Incomplete candidates retain their raw campaign and history row but
        // cannot gain Pareto value by avoiding a difficult cell.
        scored.push(
          toParetoParent(surface, hash, campaign, gen, label || undefined, rationale || undefined),
        )
      }
    }

    // Rank only candidates with the complete designed denominator. Incomplete
    // rows follow the eligible rows for auditability but never promote.
    surfaceResults.sort((a, b) => {
      if (a.coverage.complete !== b.coverage.complete) return a.coverage.complete ? -1 : 1
      return b.composite - a.composite
    })
    const eligibleResults = surfaceResults.filter((result) => result.coverage.complete)
    const top = eligibleResults[0]
    const promoted = top && top.composite > winnerComposite ? [top] : []
    if (promoted[0]) {
      const top = promoted[0]
      winnerSurface = top.surface
      winnerSurfaceHash = top.surfaceHash
      winnerComposite = top.composite
      winnerOutcome = toScoredSurfaceOutcome(top.surfaceHash, top.campaign, top.coverage, gen)
      winnerLabel = top.label || undefined
      winnerRationale = top.rationale || undefined
    }

    const record: GenerationRecord = {
      generationIndex: gen,
      candidates: surfaceResults.map((s) => {
        const breakdown = campaignBreakdown(s.campaign)
        const candidate: GenerationRecord['candidates'][number] = {
          surfaceHash: s.surfaceHash,
          composite: s.composite,
          ci95: [s.composite, s.composite] as [number, number],
          parentSurfaceHash,
          parentComposite,
          ...(s.coverage.complete
            ? { observedDeltaFromParent: s.composite - parentComposite }
            : {}),
          eligibleForPromotion: s.coverage.complete,
          coverage: {
            expectedCells: s.coverage.expectedCellIds.length,
            scorableCells: s.coverage.scorableCellIds.length,
            unscorableCells: s.coverage.unscorableCells,
          },
          dimensions: breakdown.dimensions,
          scenarios: breakdown.scenarios,
        }
        if (s.label) candidate.label = s.label
        if (s.rationale) candidate.rationale = s.rationale
        if (s.candidateRecord) candidate.candidateRecord = s.candidateRecord
        return candidate
      }),
      promoted: promoted.map((p) => p.surfaceHash),
    }
    history.push(record)
    generations.push({
      record,
      surfaces: surfaceResults.map((s) => ({
        surfaceHash: s.surfaceHash,
        surface: s.surface,
        campaign: s.campaign,
      })),
    })

    // Re-diagnose this generation's results and feed fresh findings to the next
    // generation's propose(). On the last generation there is no
    // next propose(), so skip the (potentially expensive) producer call.
    if (opts.analyzeGeneration && gen < opts.maxGenerations - 1) {
      const fresh = await opts.analyzeGeneration({
        generation: gen,
        runDir: `${opts.runDir}/gen-${gen}`,
        candidates: surfaceResults.map((s) => ({
          surfaceHash: s.surfaceHash,
          campaign: s.campaign,
          composite: s.composite,
        })),
        history,
        costLedger,
        costPhase: 'analysis.generation',
      })
      if (Array.isArray(fresh)) currentFindings = fresh
    }
  }

  return {
    generations,
    winnerSurface,
    winnerSurfaceHash,
    winnerLabel,
    winnerRationale,
    baselineCampaign,
    paretoFrontier: computeParetoFrontier(scored),
    cost: costLedger.summary(),
  }
}

/** Build a `ParetoParent` from a scored campaign — objective vector =
 *  per-scenario composite, scalar = mean composite. */
function toParetoParent<TArtifact, TScenario extends Scenario>(
  surface: MutableSurface,
  hash: string,
  campaign: CampaignResult<TArtifact, TScenario>,
  generation: number,
  label?: string,
  rationale?: string,
): ParetoParent {
  const objectives: Record<string, number> = {}
  for (const { scenarioId, composite } of campaignBreakdown(campaign).scenarios) {
    objectives[scenarioId] = composite
  }
  const parent: ParetoParent = {
    surface,
    surfaceHash: hash,
    objectives,
    composite: campaignMeanComposite(campaign),
    generation,
  }
  if (label) parent.label = label
  if (rationale) parent.rationale = rationale
  return parent
}

/** The non-dominated set over the per-scenario objective vectors. Every
 *  scenario seen across the scored set becomes a `maximize` objective.
 *  `runOptimization` admits only complete campaigns to this set; the finite
 *  floor remains a defensive fallback for manually constructed/no-judge
 *  vectors. Delegates dominance to the package-canonical `paretoFrontier`. */
function computeParetoFrontier(scored: ParetoParent[]): ParetoParent[] {
  if (scored.length <= 1) return [...scored]
  const ids = new Set<string>()
  for (const p of scored) for (const id of Object.keys(p.objectives)) ids.add(id)
  if (ids.size === 0) return [...scored]
  const floor: Record<string, number> = {}
  for (const id of ids) {
    let min = Number.POSITIVE_INFINITY
    for (const p of scored) {
      const v = p.objectives[id]
      if (typeof v === 'number' && Number.isFinite(v) && v < min) min = v
    }
    floor[id] = Number.isFinite(min) ? min : 0
  }
  const objectives: Objective<ParetoParent>[] = [...ids].map((id) => ({
    name: id,
    direction: 'maximize',
    value: (p) => {
      const v = p.objectives[id]
      return typeof v === 'number' && Number.isFinite(v) ? v : (floor[id] ?? 0)
    },
  }))
  return paretoFrontier(scored, objectives).frontier
}

function toScoredSurfaceOutcome<TArtifact, TScenario extends Scenario>(
  surfaceHash: string,
  campaign: CampaignResult<TArtifact, TScenario>,
  coverage: CampaignCoverage,
  generation: number,
): ScoredSurfaceOutcome {
  const breakdown = campaignBreakdown(campaign)
  return {
    split: 'search',
    generation,
    surfaceHash,
    composite: campaignMeanComposite(campaign),
    dimensions: breakdown.dimensions,
    scenarios: breakdown.scenarios,
    coverage: {
      expectedCells: coverage.expectedCellIds.length,
      scorableCells: coverage.scorableCellIds.length,
    },
  }
}
