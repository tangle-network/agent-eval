/**
 * `runOptimization` runs a caller-owned candidate generator for a bounded
 * number of rounds. Each candidate is measured on the same cases, and only a
 * candidate that beats the current best becomes the incumbent. By default the
 * incumbent is also the parent every generation mutates; a `selectParent`
 * policy draws the parent from the Pareto frontier instead.
 * The same loop accepts deterministic, model-backed, or agent-backed
 * proposers; they differ only in how `propose()` picks candidates.
 *
 * `runImprovementLoop` adds a separate final comparison, a release decision,
 * and optional pull request creation.
 */

import { assertProposalFindings } from '../../analyst/proposal-findings'
import type { ProposalFinding } from '../../analyst/types'
import { mapConcurrent } from '../../concurrency'
import type { CostLedgerHandle, CostLedgerSummary } from '../../cost-ledger'
import { type Objective, paretoFrontier } from '../../pareto'
import { computeManifestHash } from '../campaign-manifest'
import {
  assertCampaignSplitIdentity,
  type CampaignCoverage,
  campaignCoverage,
  campaignSplitDigest,
  formatCoverageFailures,
} from '../coverage'
import type { ParentSelector } from '../parent-selection'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import {
  assertFiniteRankKey,
  campaignBreakdown,
  campaignMeanComposite,
  campaignMeanCompositeOrNull,
  compareRankKeys,
} from '../score-utils'
import type { SearchHistoryReceipt } from '../search-history-receipt'
import { type SearchLedgerBinding, SearchRecorder } from '../search-ledger-recording'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceDispatchRef, surfaceHash, surfaceHashMatches } from '../surface-identity'
import {
  type CampaignResult,
  type GenerationRecord,
  isProposedCandidate,
  type MutableSurface,
  type ParetoParent,
  type ProposeContext,
  type ProposedCandidate,
  type Scenario,
  type ScoredSurfaceOutcome,
  type SurfaceProposer,
} from '../types'

export interface PremeasuredOptimizationBaseline<TArtifact, TScenario extends Scenario> {
  /** Hash of the exact surface that produced `campaign`. */
  surfaceHash: string
  /** Complete prior measurement reused by identity, including artifactsByPath. */
  campaign: CampaignResult<TArtifact, TScenario>
}

export interface RunOptimizationBaseOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch'> {
  /** Initial mutable surface (typically system prompt or addendum). */
  baselineSurface: MutableSurface
  /**
   * Complete prior measurement of `baselineSurface`. When present,
   * `runOptimization` validates its surface, scenario split, seed, reps, and
   * normal campaign coverage, then skips the baseline campaign entirely — no
   * dispatch or resumability-cache lookup. Candidate campaigns still run
   * normally. Prior spend remains in the imported campaign aggregates and is
   * not added again to this continuation's CostLedger.
   */
  premeasuredBaseline?: PremeasuredOptimizationBaseline<TArtifact, TScenario>
  /** Dispatcher that takes the CURRENT surface + scenario → artifact. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  /** The candidate-generation strategy. */
  proposer: SurfaceProposer<ProposalFinding>
  populationSize: number
  maxGenerations: number
  /** Candidate campaigns run at once. Default 1. Total concurrent cells are
   *  bounded by candidateConcurrency * maxConcurrency. */
  candidateConcurrency?: number
  /** DEPTH knob forwarded to the proposer's `propose()` — max iterations the
   *  agentic generator may take per candidate. */
  maxImprovementShots?: number
  /** Search or observed-production findings forwarded to candidate generation. */
  findings?: ReadonlyArray<ProposalFinding>
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
      composite: number | null
    }>
    history: GenerationRecord[]
    /** Shared run spend account and receipt attribution phase. */
    costLedger?: CostLedgerHandle
    costPhase?: string
  }) => Promise<ReadonlyArray<ProposalFinding>>
  /**
   * Optional override for how the WINNER is selected among coverage-complete
   * candidates (and how the incumbent bar is set). Returns a lexicographic rank
   * key — each element higher-is-better; candidates are ranked by descending key
   * (`compareRankKeys`) and the top must STRICTLY beat the incumbent's key to
   * promote. Defaults to `[campaignMeanComposite(campaign)]`, i.e. the historical
   * scalar-mean ranking (single-element key ⇒ identical behavior).
   *
   * A binary-with-replicates consumer (e.g. swe-arena, whose ship-gate counts an
   * instance resolved only when EVERY replicate resolved) passes a fail-closed
   * key built from the SAME reduction its gate uses, so winner-selection and the
   * ship-gate rank on the identical metric and can never invert — the selector
   * cannot promote a flaky per-cell-mean candidate the gate would reject over a
   * fail-closed candidate the gate would accept. Only the winner CHOICE changes;
   * the descriptive `composite` (mean) on every record and the Pareto objective
   * vectors are untouched, so proposer diversity and reporting are unaffected.
   */
  selectionRankKey?: (campaign: CampaignResult<TArtifact, TScenario>) => number[]
  /**
   * Optional policy for which scored surface the next generation MUTATES.
   * Absent, every generation mutates the global incumbent, so the recorded
   * `parentSurfaceHash` lineage is a chain. Present, the selector receives the
   * Pareto frontier so far, the measured incumbent, the generation history,
   * and the generation index, and returns one frontier parent; the loop hands
   * that parent to `propose()` as `currentSurface` + `parentOutcome` and
   * records it as every candidate's `parentSurfaceHash`. Promotion is
   * unchanged: a candidate still has to beat the incumbent. The loop refuses
   * a parent it has not measured to completion. `crowdedFrontierParent` is
   * the provided seeded policy.
   */
  selectParent?: ParentSelector
  /**
   * Record this search into a durable `SearchLedger`. The loop emits the plan,
   * each candidate-generation operation, each candidate registration with its
   * measured parent, one task attempt per designed cell, one decision per
   * candidate, and the terminal event, then returns a bounded
   * `searchHistory` receipt over the exact ledger bytes.
   *
   * `identity` declares what the ledger requires and a campaign cannot infer:
   * immutable revisions for the agent, proposer, and search implementations,
   * and the model the agent runs when a cell reports none.
   */
  searchLedger?: SearchLedgerBinding
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
  /** Frozen snapshot of the exact starting surface measured by `baselineCampaign`. */
  baselineSurface: MutableSurface
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
  /** Bounded proof envelope over the canonical search ledger. Present only
   *  when `searchLedger` was supplied. `complete` is false when the search was
   *  interrupted or a candidate left a designed cell unscored. */
  searchHistory?: SearchHistoryReceipt
  /** The GEPA Pareto frontier across every scored surface (baseline + all
   *  generations) by per-scenario objective vector — the non-dominated set.
   *  Each generation's `propose()` received the frontier-so-far as
   *  `ctx.paretoParents`; this is the final frontier. A surface here that is
   *  NOT the winner is uniquely best on some scenario the winner loses on. */
  paretoFrontier: ParetoParent[]
}

/**
 * Improvement loop body: N generations of propose → campaign → rank, maintaining a Pareto frontier and one global incumbent across generations. The parent each generation mutates is the incumbent unless `selectParent` draws it from the frontier.
 */
export async function runOptimization<TScenario extends Scenario, TArtifact>(
  opts: RunOptimizationOptions<TScenario, TArtifact>,
): Promise<RunOptimizationResult<TArtifact, TScenario>> {
  const { proposer } = opts
  const candidateConcurrency = opts.candidateConcurrency ?? 1
  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('runOptimization: runDir is required and must be a non-empty string')
  }
  if (!Number.isInteger(candidateConcurrency) || candidateConcurrency < 1) {
    throw new Error('runOptimization: candidateConcurrency must be a positive integer')
  }
  const initialFindings = immutableProposalSnapshot(
    assertProposalFindings(opts.findings ?? [], 'runOptimization initial proposal findings'),
    'initial findings',
  )
  const baselineSurface = immutableProposalSnapshot(opts.baselineSurface, 'baseline surface')
  opts.runDir = resolveRunDir(opts.runDir, opts.repo)
  const storage = opts.storage ?? fsCampaignStorage()
  const costLedger =
    opts.costLedger ??
    createRunCostLedger({
      storage,
      runDir: opts.runDir,
      costCeilingUsd: opts.costCeiling,
    })
  const requireJudgeScore = (opts.judges?.length ?? 0) > 0
  const reps = opts.reps ?? 1
  const premeasuredBaseline = opts.premeasuredBaseline
  const baselineCampaign = premeasuredBaseline
    ? validatedPremeasuredBaseline({
        input: premeasuredBaseline,
        baselineSurface,
        scenarios: opts.scenarios,
        reps,
        seed: opts.seed ?? 42,
        judges: opts.judges ?? [],
        dispatchRef: surfaceDispatchRef(baselineSurface, opts.dispatchRef),
      })
    : await runCampaign<TScenario, TArtifact>({
        ...opts,
        costLedger,
        costPhase: 'search.baseline',
        dispatchRef: surfaceDispatchRef(baselineSurface, opts.dispatchRef),
        dispatch: (scenario, ctx) => opts.dispatchWithSurface(baselineSurface, scenario, ctx),
        runDir: `${opts.runDir}/baseline`,
      })
  const baselineCoverage = campaignCoverage(
    baselineCampaign.cells,
    opts.scenarios,
    reps,
    requireJudgeScore,
  )
  if (!baselineCoverage.complete) {
    const label = opts.premeasuredBaseline ? 'premeasured baseline' : 'baseline'
    throw new Error(
      `runOptimization: ${label} is incomplete (${baselineCoverage.scorableCellIds.length}/${baselineCoverage.expectedCellIds.length} designed cells scorable) — ${formatCoverageFailures(baselineCoverage)}. Refusing to optimize against an incomplete incumbent.`,
    )
  }

  const recorder = opts.searchLedger
    ? await SearchRecorder.open<TScenario, TArtifact>({
        binding: opts.searchLedger,
        storage,
        runDir: opts.runDir,
        scenarios: opts.scenarios,
        reps,
        maxGenerations: opts.maxGenerations,
        populationSize: opts.populationSize,
        splitDigest: baselineCampaign.splitDigest,
        proposerLabel: proposer.kind,
        costLedger,
      })
    : undefined

  const generations: RunOptimizationResult<TArtifact, TScenario>['generations'] = []
  const history: GenerationRecord[] = []
  // Refreshed each generation by `analyzeGeneration`; seeded with the static
  // caller-supplied findings.
  let currentFindings: ReadonlyArray<ProposalFinding> = initialFindings
  // Winner selection ranks candidates by a lexicographic key (higher-is-better
  // per element). Default = the scalar mean composite, so a single-element key
  // reproduces the historical `b.composite - a.composite` ordering exactly. A
  // fail-closed consumer overrides it so selection and its ship-gate rank on the
  // identical metric (see `selectionRankKey` docs).
  const selectionRankKey =
    opts.selectionRankKey ??
    ((campaign: CampaignResult<TArtifact, TScenario>) => [campaignMeanComposite(campaign)])
  let winnerSurface = baselineSurface
  let winnerSurfaceHash = surfaceHash(baselineSurface)
  // A surface identity may enter the population only once. Keep the
  // incumbent in this set so a proposer cannot spend a candidate cell on a
  // no-op or repeat a surface from an earlier generation.
  const admittedCandidateHashes = new Set([winnerSurfaceHash])
  let winnerComposite = campaignMeanComposite(baselineCampaign)
  let winnerRankKey = selectionRankKey(baselineCampaign)
  assertFiniteRankKey(winnerRankKey, 'selectionRankKey for baseline')
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
    toParetoParent(baselineSurface, winnerSurfaceHash, baselineCampaign, -1),
  ]
  // Every complete scored surface by hash, so a parent a `selectParent` policy
  // returns resolves to the exact measured record this run holds for it.
  const measuredByHash = new Map<string, MeasuredSurface>([
    [winnerSurfaceHash, { parent: scored[0]!, outcome: baselineOutcome }],
  ])

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
      runDir: baselineCampaign.runDir,
      candidates: [
        { surfaceHash: winnerSurfaceHash, campaign: baselineCampaign, composite: winnerComposite },
      ],
      history,
      costLedger,
      costPhase: 'analysis.baseline',
    })
    if (!Array.isArray(fresh)) {
      throw new TypeError('runOptimization: analyzeGeneration must return an array')
    }
    currentFindings = immutableProposalSnapshot(
      assertProposalFindings(fresh, 'runOptimization baseline analysis findings'),
      'baseline analysis findings',
    )
  }

  for (let gen = 0; gen < opts.maxGenerations; gen++) {
    const proposalHistory = immutableProposalSnapshot(history, 'history')
    // Decide: the proposer may stop early based on accumulated history.
    if (proposer.decide?.({ history: proposalHistory }).stop) break

    // Plan: the proposer proposes N candidates from the parent surface, the
    // accumulated generation history, the Pareto frontier so far, and any
    // external findings.
    const paretoParents = immutableProposalSnapshot(computeParetoFrontier(scored), 'Pareto parents')
    const incumbentOutcome = immutableProposalSnapshot(winnerOutcome, 'incumbent outcome')
    // The mutation anchor. By default it is the best complete surface seen
    // across the whole run: exploratory losers remain in history/Pareto
    // evidence, but a later generation never compounds a candidate already
    // known to regress. A `selectParent` policy draws the anchor from the
    // frontier instead; promotion below still compares against the incumbent.
    const selected = opts.selectParent
      ? resolveSelectedParent(
          opts.selectParent(
            Object.freeze({
              frontier: paretoParents,
              incumbent: incumbentOutcome,
              history: proposalHistory,
              generation: gen,
            }),
          ),
          measuredByHash,
          gen,
        )
      : undefined
    const parentSurface = selected ? selected.parent.surface : winnerSurface
    const parentSurfaceHash = selected ? selected.parent.surfaceHash : winnerSurfaceHash
    const parentComposite = selected ? selected.outcome.composite : winnerComposite
    const parentOutcome = selected ? selected.outcome : winnerOutcome
    const proposalContext: ProposeContext<ProposalFinding> = Object.freeze({
      currentSurface: immutableProposalSnapshot(parentSurface, 'current surface'),
      history: proposalHistory,
      findings: immutableProposalSnapshot(
        assertProposalFindings(currentFindings, 'runOptimization proposal findings'),
        'findings',
      ),
      populationSize: opts.populationSize,
      generation: gen,
      signal: opts.signal ?? new AbortController().signal,
      baselineOutcome: immutableProposalSnapshot(baselineOutcome, 'baseline outcome'),
      incumbentOutcome,
      parentOutcome: immutableProposalSnapshot(parentOutcome, 'parent outcome'),
      maxImprovementShots: opts.maxImprovementShots,
      paretoParents,
      costLedger,
      costPhase: 'search.proposal',
    })
    const proposed = await proposer.propose(proposalContext)
    if (!Array.isArray(proposed)) {
      throw new TypeError('runOptimization: proposer must return an array')
    }
    const proposalSnapshot = immutableProposalSnapshot(proposed, 'candidate outputs')
    if (proposalSnapshot.length === 0) break

    // Normalize: a proposer may return bare surfaces (blind mutators) or
    // `ProposedCandidate`s carrying {label, rationale}. Keep the rationale so
    // each candidate stays attributable through to the result + provenance.
    const candidates: ProposedCandidate[] = proposalSnapshot.map((p) =>
      isProposedCandidate(p) ? p : { surface: p, label: '', rationale: '' },
    )

    // Validate the complete proposal before dispatching any candidate. This
    // keeps duplicate population entries from becoming separate records or
    // consuming a candidate cell. Use `reps` when measuring one surface again.
    const generationHashes = new Set<string>()
    for (const { surface } of candidates) {
      const hash = surfaceHash(surface)
      if (admittedCandidateHashes.has(hash) || generationHashes.has(hash)) {
        throw new Error(
          `runOptimization: duplicate candidate surface hash "${hash}" in generation ${gen}; candidate surfaces must be unique`,
        )
      }
      generationHashes.add(hash)
    }
    for (const hash of generationHashes) admittedCandidateHashes.add(hash)
    await recorder?.recordGeneration({
      generation: gen,
      parentSurfaceHash,
      candidates: candidates.map(({ surface, label }) => ({
        surface,
        surfaceHash: surfaceHash(surface),
        ...(label ? { label } : {}),
      })),
    })

    // Run each candidate as its own campaign.
    type SurfaceResult = {
      surfaceHash: string
      surface: MutableSurface
      label: string
      rationale: string
      attribution?: Readonly<Record<string, unknown>>
      campaign: CampaignResult<TArtifact, TScenario>
      composite: number | null
      /** Lexicographic winner-selection key (higher-is-better per element). */
      rankKey: number[] | null
      coverage: CampaignCoverage
    }
    const surfaceResults = await mapConcurrent(
      candidates,
      candidateConcurrency,
      async ({ surface, label, rationale, attribution }, i, signal): Promise<SurfaceResult> => {
        const hash = surfaceHash(surface)
        const campaign = await runCampaign<TScenario, TArtifact>({
          ...opts,
          signal,
          costLedger,
          costPhase: 'search.candidate',
          dispatchRef: surfaceDispatchRef(surface, opts.dispatchRef),
          dispatch: (scenario, ctx) => opts.dispatchWithSurface(surface, scenario, ctx),
          runDir: `${opts.runDir}/gen-${gen}/candidate-${i}`,
        })
        const coverage = campaignCoverage(
          campaign.cells,
          opts.scenarios,
          opts.reps ?? 1,
          requireJudgeScore,
        )
        const composite = campaignMeanCompositeOrNull(campaign)
        const rankKey = coverage.complete ? selectionRankKey(campaign) : null
        if (rankKey) {
          assertFiniteRankKey(
            rankKey,
            `selectionRankKey for generation ${gen} candidate ${i}`,
            winnerRankKey.length,
          )
        }
        return {
          surfaceHash: hash,
          surface,
          label,
          rationale,
          ...(attribution ? { attribution } : {}),
          campaign,
          composite,
          rankKey,
          coverage,
        }
      },
      opts.signal,
    )
    for (const result of surfaceResults) {
      const { surface, surfaceHash: hash, campaign, coverage, label, rationale } = result
      if (coverage.complete) {
        // Incomplete candidates retain their raw campaign and history row but
        // cannot gain Pareto value by avoiding a difficult cell.
        const parent = toParetoParent(
          surface,
          hash,
          campaign,
          gen,
          label || undefined,
          rationale || undefined,
        )
        scored.push(parent)
        measuredByHash.set(hash, {
          parent,
          outcome: toScoredSurfaceOutcome(hash, campaign, coverage, gen),
        })
      }
    }

    await recorder?.recordResults(
      surfaceResults.map((result) => ({
        surface: result.surface,
        surfaceHash: result.surfaceHash,
        cells: result.campaign.cells,
        runDir: result.campaign.runDir,
        coverageComplete: result.coverage.complete,
      })),
    )

    // Rank only candidates with the complete designed denominator. Incomplete
    // rows follow the eligible rows for auditability but never promote.
    surfaceResults.sort((a, b) => {
      if (a.coverage.complete !== b.coverage.complete) return a.coverage.complete ? -1 : 1
      if (a.rankKey && b.rankKey) return compareRankKeys(b.rankKey, a.rankKey)
      return a.surfaceHash.localeCompare(b.surfaceHash)
    })
    const eligibleResults = surfaceResults.filter(
      (result): result is SurfaceResult & { composite: number; rankKey: number[] } =>
        result.coverage.complete && result.composite !== null && result.rankKey !== null,
    )
    const top = eligibleResults[0]
    const promoted = top && compareRankKeys(top.rankKey, winnerRankKey) > 0 ? [top] : []
    if (promoted[0]) {
      const top = promoted[0]
      winnerSurface = top.surface
      winnerSurfaceHash = top.surfaceHash
      winnerComposite = top.composite
      winnerRankKey = top.rankKey
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
          ci95: null,
          parentSurfaceHash,
          parentComposite,
          ...(s.coverage.complete
            ? { observedDeltaFromParent: s.composite! - parentComposite }
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
        if (s.attribution) candidate.attribution = s.attribution
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
      if (!Array.isArray(fresh)) {
        throw new TypeError('runOptimization: analyzeGeneration must return an array')
      }
      currentFindings = immutableProposalSnapshot(
        assertProposalFindings(fresh, 'runOptimization generation analysis findings'),
        'generation analysis findings',
      )
    }
  }

  const searchHistory = await recorder?.finish({
    winnerSurfaceHash,
    generationsRun: generations.length,
    runId: opts.runDir,
  })

  return {
    generations,
    baselineSurface,
    winnerSurface,
    winnerSurfaceHash,
    winnerLabel,
    winnerRationale,
    baselineCampaign,
    ...(searchHistory ? { searchHistory } : {}),
    paretoFrontier: computeParetoFrontier(scored),
    cost: costLedger.summary(),
  }
}

/** One complete scored surface: its frontier record and its measured outcome. */
interface MeasuredSurface {
  parent: ParetoParent
  outcome: ScoredSurfaceOutcome
}

/** Resolve the parent a `selectParent` policy returned to the measured record
 *  this run holds for it. Refuses a surface the run never measured to
 *  completion, and a parent whose surface does not hash to its `surfaceHash`. */
function resolveSelectedParent(
  returned: unknown,
  measuredByHash: ReadonlyMap<string, MeasuredSurface>,
  generation: number,
): MeasuredSurface {
  if (
    typeof returned !== 'object' ||
    returned === null ||
    typeof (returned as { surfaceHash?: unknown }).surfaceHash !== 'string'
  ) {
    throw new TypeError(
      `runOptimization: selectParent must return a ParetoParent (generation ${generation})`,
    )
  }
  const parent = returned as ParetoParent
  const measured = measuredByHash.get(parent.surfaceHash)
  if (!measured) {
    throw new Error(
      `runOptimization: selectParent returned surface "${parent.surfaceHash}" in generation ${generation}, which this run has not measured to completion; a parent must be a scored surface from the frontier`,
    )
  }
  if (!surfaceHashMatches(parent.surface, parent.surfaceHash)) {
    throw new Error(
      `runOptimization: selectParent returned a parent whose surface does not match its surfaceHash "${parent.surfaceHash}" (generation ${generation})`,
    )
  }
  return measured
}

function immutableProposalSnapshot<T>(value: T, label: string): T {
  try {
    return deepFreeze(structuredClone(value))
  } catch (cause) {
    throw new TypeError(`runOptimization: proposal ${label} must contain snapshot-safe data`, {
      cause,
    })
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

function validatedPremeasuredBaseline<TScenario extends Scenario, TArtifact>(args: {
  input: PremeasuredOptimizationBaseline<TArtifact, TScenario>
  baselineSurface: MutableSurface
  scenarios: TScenario[]
  reps: number
  seed: number
  judges: NonNullable<RunCampaignOptions<TScenario, TArtifact>['judges']>
  dispatchRef: string
}): CampaignResult<TArtifact, TScenario> {
  const { input } = args
  if (!surfaceHashMatches(args.baselineSurface, input.surfaceHash)) {
    throw new Error(
      'runOptimization: premeasured baseline surface hash does not match baselineSurface',
    )
  }

  const campaign = input.campaign
  if (campaign.reps !== args.reps) {
    throw new Error(
      `runOptimization: premeasured baseline reps ${campaign.reps} do not match requested reps ${args.reps}`,
    )
  }
  if (campaign.seed !== args.seed) {
    throw new Error(
      `runOptimization: premeasured baseline seed ${campaign.seed} does not match requested seed ${args.seed}`,
    )
  }

  try {
    assertCampaignSplitIdentity(campaign.scenarios, campaign.reps, campaign.splitDigest)
  } catch (error) {
    throw new Error(
      `runOptimization: premeasured baseline has an invalid retained split identity — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (campaign.splitDigest !== campaignSplitDigest(args.scenarios, args.reps)) {
    throw new Error(
      'runOptimization: premeasured baseline split does not match the requested scenarios',
    )
  }
  const expectedManifest = computeManifestHash({
    scenarios: args.scenarios,
    judges: args.judges,
    dispatchRef: args.dispatchRef,
    seed: args.seed,
    reps: args.reps,
  })
  if (campaign.manifestHash !== expectedManifest) {
    throw new Error(
      'runOptimization: premeasured baseline evaluator identity does not match the requested dispatch and judges',
    )
  }
  return campaign
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
