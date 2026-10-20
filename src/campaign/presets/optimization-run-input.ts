/** Optimization inputs, immutable proposal snapshots, and imported baseline validation. */

import type { ProposalFinding } from '../../analyst/types'
import type { CostLedgerHandle, CostLedgerSummary } from '../../cost-ledger'
import { computeManifestHash } from '../campaign-manifest'
import {
  assertCampaignSplitIdentity,
  campaignCoverage,
  campaignSplitDigest,
  formatCoverageFailures,
} from '../coverage'
import type { RunCampaignOptions } from '../run-campaign'
import type { SearchHistoryReceipt } from '../search-history-receipt'
import type { SearchLedgerBinding } from '../search-ledger-recording'
import type { SearchPolicy } from '../search-policy'
import { surfaceHashMatches } from '../surface-identity'
import type {
  CampaignResult,
  GenerationRecord,
  MutableSurface,
  ParetoParent,
  Scenario,
  SurfaceProposer,
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
   * normal campaign coverage, then records its cells as the root's instead of
   * dispatching them. Prior spend stays in the imported campaign aggregates and
   * is not added again to this run's CostLedger.
   */
  premeasuredBaseline?: PremeasuredOptimizationBaseline<TArtifact, TScenario>
  /** Dispatcher that takes a surface and a scenario to an artifact. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: Parameters<RunCampaignOptions<TScenario, TArtifact>['dispatch']>[1],
  ) => Promise<TArtifact>
  /** The candidate-generation strategy. */
  proposer: SurfaceProposer<ProposalFinding>
  /** Candidates asked of each proposal. */
  populationSize: number
  /** Proposals the search may make. */
  maxGenerations: number
  /** Scales the run's cell lanes: at most `candidateConcurrency *
   * maxConcurrency` cells run at once. Default 1. */
  candidateConcurrency?: number
  /** DEPTH knob forwarded to the proposer's `propose()`: max iterations the
   *  agentic generator may take per candidate. */
  maxImprovementShots?: number
  /** Search or observed-production findings forwarded to candidate generation. */
  findings?: ReadonlyArray<ProposalFinding>
  /** Findings producer. Before each proposal it runs on the previous
   *  generation's measured candidates (the baseline, as `generation: -1`,
   *  before the first), and what it returns REPLACES `ctx.findings` for that
   *  proposal. The substrate does not import an analyst: the consumer plugs its
   *  trace-analyst registry here, reading the per-candidate `runDir` traces.
   *  When absent, findings stay the static `opts.findings`. Its spend is
   *  booked to the proposal's operation. */
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
  /** Which node each proposal extends, and which node the run keeps. Default
   *  `incumbent()`: the hill climb. `crowdedFrontierParent({ seed })` draws
   *  the parent from the Pareto frontier instead; `aide()` drafts, debugs and
   *  improves with Thompson-sampled parents, and `beam({ width })` expands the
   *  top nodes in turn. Every policy ranks on the scenarios, and the run keeps
   *  the `uniform` allocator, because the proposer reads every candidate's
   *  score on every scenario. */
  policy?: SearchPolicy
  /** Where the search ledger goes and the identities it records. Default: a
   *  ledger at `<runDir>/search/ledger.jsonl`, held in `storage` unless that is
   *  the filesystem, whose identities are the dispatch ref's and proposer's
   *  digests. */
  searchLedger?: SearchLedgerBinding
}

export type RunOptimizationOptions<
  TScenario extends Scenario,
  TArtifact,
> = RunOptimizationBaseOptions<TScenario, TArtifact>

export interface RunOptimizationResult<TArtifact, TScenario extends Scenario> {
  /** One entry per proposal, with the candidates it registered. */
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
  /** Proposer label for the kept surface; absent when the winner is the baseline. */
  winnerLabel?: string
  /** Proposer rationale for the kept surface, as stored: redacted with the
   *  share profile. Absent when the winner is the baseline. */
  winnerRationale?: string
  baselineCampaign: CampaignResult<TArtifact, TScenario>
  /** Run-wide spend, including agents, proposers, analysts, and judges. */
  cost: CostLedgerSummary
  /** Bounded proof envelope over the search ledger. */
  searchHistory: SearchHistoryReceipt
  /** The non-dominated set of measured surfaces by per-scenario composite. */
  paretoFrontier: ParetoParent[]
}

export function immutableProposalSnapshot<T>(value: T, label: string): T {
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

export function validatedPremeasuredBaseline<TScenario extends Scenario, TArtifact>(args: {
  input: PremeasuredOptimizationBaseline<TArtifact, TScenario>
  baselineSurface: MutableSurface
  scenarios: TScenario[]
  reps: number
  seed: number
  judges: NonNullable<RunCampaignOptions<TScenario, TArtifact>['judges']>
  dispatchRef: string
  requireJudgeScore: boolean
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
  const coverage = campaignCoverage(
    campaign.cells,
    args.scenarios,
    args.reps,
    args.requireJudgeScore,
  )
  if (!coverage.complete) {
    throw new Error(
      `runOptimization: premeasured baseline is incomplete (${coverage.scorableCellIds.length}/${coverage.expectedCellIds.length} designed cells scorable) — ${formatCoverageFailures(coverage)}. Refusing to optimize against an incomplete incumbent.`,
    )
  }
  return campaign
}
