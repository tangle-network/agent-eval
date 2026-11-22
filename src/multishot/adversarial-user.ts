// The simulated user as a second optimizable role.
//
// An adversarial user searches for the plans a fixed agent fails under: its
// objective is the agent's failure rate, nothing else. A plan is admitted only
// when a calibrated realism judge cannot tell it from real users above a
// floor, so the search finds failures real users would cause, not failures of
// a user no one is. What an admitted plan breaks becomes new train scenarios
// for the agent side; they never enter a held-out split.
//
// The objective is fixed by construction: this entry builds the judge itself
// and refuses a caller judge, `conversationJudge` refuses every user-side
// conversation, and the user-side dispatch is not public.

import type { AgentProfile } from '@tangle-network/agent-interface'
import type { OptimizationMethod } from '../campaign/optimization-method'
import type { CampaignStorage } from '../campaign/storage'
import type { JudgeConfig, SurfaceProposer } from '../campaign/types'
import {
  type SelfImproveBudget,
  type SelfImproveResult,
  selfImprove,
} from '../contract/self-improve'
import type { CostLedgerHandle } from '../cost-ledger/contract'
import { hashCanonical, jsonDocument } from '../ledger-core/canonical'
import { listSome, UserSideObjectiveError } from './conversation-conditions'
import { describeConversation } from './conversation-evidence'
import {
  measureSimulatorRealism,
  type RecordedUserTurn,
  type SimulatorRealismJudge,
  type SimulatorRealismReport,
  simulatedUserDriver,
} from './realism'
import {
  type ConversationArtifact,
  type ConversationScenario,
  type MultishotRolloutOptions,
  userSideRollout,
} from './rollout'

/** Scenarios for the user-side search would reach the agent's held-out split. */
export class AdversarialSplitError extends Error {
  readonly scenarioIds: string[]
  constructor(scenarioIds: string[]) {
    super(
      `adversarial user search would use ${scenarioIds.length} scenario(s) that share an id ` +
        `or persona with the agent's held-out split (${listSome(scenarioIds)})`,
    )
    this.name = 'AdversarialSplitError'
    this.scenarioIds = scenarioIds
  }
}

export interface AdversarialUserOptions<TScenario extends ConversationScenario> {
  /** The conversation; the agent side is fixed to `agentProfile`. */
  rollout: Omit<MultishotRolloutOptions<TScenario>, 'profile'>
  agentProfile: AgentProfile
  /** The plan the search starts from: the user's surface. */
  baselinePlan: string
  /** Personas the search runs on, held-out cases included. */
  scenarios: TScenario[]
  /** The agent side's held-out scenarios. No scenario of this search may share
   *  an id or a persona with them. */
  agentHeldOut: readonly TScenario[]
  proposer?: SurfaceProposer
  method?: OptimizationMethod<TScenario, ConversationArtifact>
  selectionScenarios?: TScenario[]
  budget?: SelfImproveBudget
  runDir?: string
  storage?: CampaignStorage
  expectUsage?: 'assert' | 'warn' | 'off'
  /** Snapshot model id, for an agent leg that reports no receipt model. */
  model?: string
  /** The admission floor, measured on the winning plan. */
  realism: {
    turns: readonly RecordedUserTurn[]
    judge: SimulatorRealismJudge
    runId: string
    at?: string
    /** The persona the user plays for a recorded conversation. */
    persona: (turn: RecordedUserTurn) => TScenario['persona']
    /** Highest judge accuracy, at the interval's upper end, a plan may reach
     *  and still count as realistic. 0.5 is indistinguishable. */
    maxJudgeAccuracy: number
    sample?: number
    confidence?: number
    resamples?: number
    seed?: number
    costLedger?: CostLedgerHandle
  }
}

export interface AdversarialUserResult<TScenario extends ConversationScenario> {
  /** The user-side search, scored on the agent's failure rate. */
  improvement: SelfImproveResult<TScenario, ConversationArtifact>
  /** The selected plan. */
  plan: string
  /** Realism of the selected plan; null when the search did not ship. */
  realism: SimulatorRealismReport | null
  admitted: boolean
  reasons: string[]
  /** One per held-out conversation the admitted plan made the agent fail:
   *  the source scenario with the plan as its `userPlan`. Train only. */
  trainScenarios: TScenario[]
}

/**
 * Search for a simulated-user plan that makes a fixed agent fail, admit it
 * only above a realism floor, and emit what it breaks as agent train scenarios.
 */
export async function improveAdversarialUser<TScenario extends ConversationScenario>(
  opts: AdversarialUserOptions<TScenario>,
): Promise<AdversarialUserResult<TScenario>> {
  if ('judge' in opts || 'gate' in opts) {
    throw new UserSideObjectiveError(
      "improveAdversarialUser: the user side's objective is the agent's failure rate; it accepts no judge or gate",
    )
  }
  if (!(opts.realism.maxJudgeAccuracy >= 0.5 && opts.realism.maxJudgeAccuracy <= 1)) {
    throw new RangeError('improveAdversarialUser: realism.maxJudgeAccuracy must be in [0.5, 1]')
  }
  assertDisjointFromHeldOut(
    [...opts.scenarios, ...(opts.selectionScenarios ?? [])],
    opts.agentHeldOut,
  )

  const rollout = userSideRollout(opts.rollout, opts.agentProfile)
  const shared = {
    agent: rollout.agent,
    dispatchRef: rollout.dispatchRef,
    scenarios: opts.scenarios,
    judge: agentFailureJudge<TScenario>(),
    describeArtifact: describeConversation,
    baselineSurface: opts.baselinePlan,
    ...(opts.selectionScenarios ? { selectionScenarios: opts.selectionScenarios } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.runDir ? { runDir: opts.runDir } : {}),
    ...(opts.storage ? { storage: opts.storage } : {}),
    ...(opts.expectUsage ? { expectUsage: opts.expectUsage } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  }
  const improvement: SelfImproveResult<TScenario, ConversationArtifact> = opts.method
    ? await selfImprove<TScenario, ConversationArtifact>({ ...shared, method: opts.method })
    : await selfImprove<TScenario, ConversationArtifact>({
        ...shared,
        ...(opts.proposer ? { proposer: opts.proposer } : {}),
      })
  const plan = String(improvement.winner.surface)
  if (improvement.gateDecision !== 'ship') {
    return {
      improvement,
      plan,
      realism: null,
      admitted: false,
      reasons: [`the user-side search did not ship (${improvement.gateDecision})`],
      trainScenarios: [],
    }
  }

  const realism = await measureSimulatorRealism({
    turns: opts.realism.turns,
    driver: simulatedUserDriver({
      user: opts.rollout.user,
      persona: opts.realism.persona,
      plan,
    }),
    judge: opts.realism.judge,
    runId: opts.realism.runId,
    ...pick(opts.realism, ['at', 'sample', 'confidence', 'resamples', 'seed', 'costLedger']),
  })
  const reasons: string[] = []
  if (!realism.judge.calibrated) {
    reasons.push(
      'realism judge is not calibrated on this question and served model; a plan is admitted only by a calibrated judge',
    )
  }
  if (realism.accuracy.high > opts.realism.maxJudgeAccuracy) {
    reasons.push(
      `realism: judge accuracy reaches ${realism.accuracy.high.toFixed(3)} at the interval's upper end, above the floor ${opts.realism.maxJudgeAccuracy}`,
    )
  }
  const admitted = reasons.length === 0
  return {
    improvement,
    plan,
    realism,
    admitted,
    reasons,
    trainScenarios: admitted ? emittedScenarios(improvement, opts.scenarios, plan) : [],
  }
}

/** Score of the user side: 1 when the agent failed the outcome check. */
function agentFailureJudge<TScenario extends ConversationScenario>(): JudgeConfig<
  ConversationArtifact,
  TScenario
> {
  return {
    name: 'agent-failure',
    judgeVersion: 'agent-eval:agent-failure:v1',
    dimensions: [
      { key: 'agent_failure', description: '1 when the agent failed the code-checked outcome' },
    ],
    score({ artifact }) {
      if (artifact.optimizedRole !== 'user') {
        throw new UserSideObjectiveError('agent-failure scores user-side conversations only')
      }
      const failed = artifact.outcome.passed ? 0 : 1
      return {
        dimensions: { agent_failure: failed },
        composite: failed,
        notes: artifact.outcome.detail,
      }
    },
  }
}

function assertDisjointFromHeldOut<TScenario extends ConversationScenario>(
  scenarios: readonly TScenario[],
  heldOut: readonly TScenario[],
): void {
  const ids = new Set(heldOut.map((scenario) => scenario.id))
  const personas = new Set(heldOut.map((scenario) => personaDigest(scenario)))
  const overlap = scenarios
    .filter((scenario) => ids.has(scenario.id) || personas.has(personaDigest(scenario)))
    .map((scenario) => scenario.id)
  if (overlap.length > 0) throw new AdversarialSplitError([...new Set(overlap)])
}

function personaDigest(scenario: ConversationScenario): string {
  return hashCanonical(jsonDocument(scenario.persona))
}

function emittedScenarios<TScenario extends ConversationScenario>(
  improvement: SelfImproveResult<TScenario, ConversationArtifact>,
  scenarios: readonly TScenario[],
  plan: string,
): TScenario[] {
  const planDigest = hashCanonical(plan)
  const emitted = new Map<string, TScenario>()
  for (const cell of improvement.raw.winnerOnHoldout.cells) {
    if (cell.error !== undefined || cell.artifact.outcome.passed) continue
    if (emitted.has(cell.scenarioId)) continue
    const source = scenarios.find((scenario) => scenario.id === cell.scenarioId)
    if (!source) continue
    emitted.set(cell.scenarioId, {
      ...structuredClone(source),
      id: `${source.id}~adversarial-${planDigest.slice('sha256:'.length, 'sha256:'.length + 12)}`,
      // The plan the failing conversation ran: the scenario's own, then the found one.
      userPlan: [source.userPlan, plan].filter(Boolean).join('\n\n'),
      origin: { kind: 'adversarial-user', sourceScenarioId: source.id, planDigest },
    })
  }
  return [...emitted.values()]
}

function pick<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {}
  for (const key of keys) if (value[key] !== undefined) picked[key] = value[key]
  return picked
}
