/**
 * `defaultProductionGate` — composes the substrate's existing safety
 * primitives (red-team / reward-hacking / canary / heldout) into a single
 * Gate.decide shape. Closes the alignment + Anthropic-SI reviewers' "safety
 * primitives are off the critical path" blocker.
 *
 * The composition is opinionated — when consumers wire `runImprovementLoop`,
 * THIS gate is the default. Consumers can still pass a custom gate to
 * override; the recommended pattern is to compose THIS gate with whatever
 * extra domain-specific gates they need (`composeGate(defaultProductionGate(...), customGate)`).
 */

import type { CanaryOptions } from '../../canary'
import type { RedTeamCase } from '../../red-team'
import type { DetectRewardHackingInput } from '../../rl/reward-hacking'
import type { RunRecord } from '../../run-record'
import type { Gate, GateContext, GateResult, Scenario } from '../types'
import {
  checkBudget,
  checkCanary,
  checkDimensions,
  checkHeldout,
  checkRedTeam,
  checkRewardHacking,
  type GateConfig,
  type GateFindings,
  newFindings,
} from './default-production-checks'

export type DefaultProductionGateCheck =
  | 'dimension-regression'
  | 'budget'
  | 'red-team'
  | 'reward-hacking'
  | 'canary'

export type DefaultProductionRewardHackingOptions = Omit<
  DetectRewardHackingInput,
  'runs' | 'truthOf'
> & {
  truthOf: NonNullable<DetectRewardHackingInput['truthOf']>
}

export interface DefaultProductionGateOptions {
  /** Required: scenarios held out from training; substrate compares
   *  candidate-on-holdout vs baseline-on-holdout. */
  holdoutScenarios: Scenario[]
  /**
   * Independent sampling unit for every held-out scenario. Pair cells first,
   * then average scores within each unit and give units equal weight.
   * Omit only when execution cells on a fixed roster are the observation units.
   */
  independentUnitByScenarioId?: ReadonlyMap<string, string>
  /** Minimum held-out improvement under the shared paired decision rule.
   *  Default 0. The outcome shape and sample count determine the statistical
   *  test. Use native composite units, such as 2 for a 0-100 rubric. */
  deltaThreshold?: number
  /** Confidence level for the held-out + dimension bootstraps. Default 0.95. */
  confidence?: number
  /** Bootstrap resamples. Default 2000. */
  bootstrapResamples?: number
  /** Fixed bootstrap seed for a deterministic verdict. Default 1337. */
  bootstrapSeed?: number
  /** Minimum paired independent units (or cells when unconfigured) before a
   *  significance claim is allowed. The exact small-sample test may require
   *  more observations at the selected confidence. Default 3. */
  minProductiveRuns?: number
  /** Ship statistic for the held-out significance test. Default `'mean'`
   *  (tie-robust — see `heldoutSignificance`). Pass `'median'` for
   *  outlier-robustness at the cost of tie-blindness. */
  heldoutStatistic?: 'mean' | 'median'
  /** Required judge dimensions checked for regression and complete evidence.
   *  A bootstrap lower bound below negative tolerance or a paired test proving
   *  a drop holds the gate. Thin or incomplete coverage is not_evaluated. */
  criticalDimensions?: string[]
  /** Tolerance for the per-dimension regression guard, in the dimension's
   *  native scale. When omitted it auto-scales off observed magnitudes:
   *  0.05 on [0,1], 5 on 0-100. */
  regressionTolerance?: number
  /** Total $ budget for the complete improvement run. Requires
   *  `GateContext.costLedger`; missing or incomplete accounting holds. */
  budgetUsd?: number
  /** Static artifact-screening cases. Only `expected: 'ignore'` cases without
   *  tool assertions are valid because this check does not dispatch case inputs
   *  or observe tool calls. */
  redTeamBattery?: RedTeamCase[]
  /** Shared run history, oldest first. Supplying history does not enable either
   *  monitoring check; configure `rewardHacking` and/or `canary` explicitly. */
  recentRuns?: RunRecord[]
  /** Enable reward-hacking monitoring with a caller-owned independent truth channel. */
  rewardHacking?: DefaultProductionRewardHackingOptions
  /** Enable canary monitoring. Pass `{}` to use the canary defaults. */
  canary?: CanaryOptions
  /** Optional checks that must be evaluated even when their normal input is
   *  absent. Configuring a check's input also makes that check required.
   *  Missing evidence always records `not_evaluated`; required unevaluated
   *  checks hold the release decision. Held-out significance is always required. */
  requiredChecks?: DefaultProductionGateCheck[]
}

/**
 * Opinionated production gate composing held-out significance, red-team, reward-hacking, and canary checks into a single `Gate.decide` decision.
 */
export function defaultProductionGate<TArtifact, TScenario extends Scenario>(
  options: DefaultProductionGateOptions,
): Gate<TArtifact, TScenario> {
  const deltaThreshold = options.deltaThreshold ?? 0
  const confidence = options.confidence ?? 0.95
  const resamples = options.bootstrapResamples ?? 2000
  const seed = options.bootstrapSeed ?? 1337
  const minProductiveRuns = options.minProductiveRuns ?? 3
  const heldoutStatistic = options.heldoutStatistic ?? 'mean'
  const explicitlyRequired = new Set(options.requiredChecks ?? [])
  const scenarioIds = new Set(options.holdoutScenarios.map((scenario) => scenario.id))
  const independentUnitByScenarioId =
    options.independentUnitByScenarioId === undefined
      ? undefined
      : new Map(options.independentUnitByScenarioId)
  if (independentUnitByScenarioId !== undefined) {
    for (const id of scenarioIds) {
      const unit = independentUnitByScenarioId.get(id)
      if (typeof unit !== 'string' || unit.length === 0 || unit.trim() !== unit) {
        throw new Error(
          `defaultProductionGate: missing independent unit for holdout scenario '${id}'`,
        )
      }
    }
  }

  const cfg: GateConfig = {
    options,
    deltaThreshold,
    confidence,
    resamples,
    seed,
    minProductiveRuns,
    heldoutStatistic,
    explicitlyRequired,
    scenarioIds,
    independentUnitByScenarioId,
  }

  return {
    name: 'defaultProductionGate',
    async decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult> {
      const findings = newFindings()
      const delta = checkHeldout(findings, cfg, ctx)
      checkDimensions(findings, cfg, ctx)
      checkBudget(findings, cfg, ctx)
      checkRedTeam(findings, cfg, ctx)
      checkRewardHacking(findings, cfg)
      checkCanary(findings, cfg)
      return verdictOf(findings, delta)
    },
  }
}

/** Hold when any check failed or a required check could not be evaluated; otherwise ship. */
function verdictOf(
  { reasons, contributing, requiredUnavailable }: GateFindings,
  delta: number | undefined,
): GateResult {
  // ── Verdict ─────────────────────────────────────────────────────
  const decision =
    contributing.some((check) => check.status === 'fail') || requiredUnavailable.size > 0
      ? 'hold'
      : 'ship'
  const notEvaluated = contributing
    .filter((check) => check.status === 'not_evaluated')
    .map((check) => check.name)

  return {
    decision,
    reasons:
      reasons.length > 0
        ? reasons
        : notEvaluated.length > 0
          ? [`evaluated checks passed; not evaluated: ${notEvaluated.join(', ')}`]
          : ['all checks passed'],
    contributingGates: contributing,
    delta,
  }
}
