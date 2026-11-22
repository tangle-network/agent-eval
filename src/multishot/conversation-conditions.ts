// Equivalent conditions for comparing conversations.
//
// A conversation's outcome depends on the simulated user as much as on the
// agent: Seshadri et al. (arXiv 2601.17087) measure agent success moving up
// to 9 points across user models on one benchmark. So the simulated user is
// part of the measurement identity, and two candidates are compared only when
// every paired conversation met the same user on the same seed.
//
// What holds that:
// - The user is outside the candidate surface by construction:
//   `multishotRollout` builds it from the scenario and its fixed options.
// - `dispatchRef` hashes the user options, so caches and premeasured
//   baselines never cross users.
// - `assertSameSimulatedUser` refuses paired cells with different identities
//   or seeds, and `conversationGate` runs it before any decision.
// - `conversationJudge` scores only conversations whose agent side was the
//   candidate, so the user side can never be optimized on the agent's success.

import { defaultProductionGate } from '../campaign/gates/default-production-gate'
import type { Gate, GateContext, JudgeConfig, JudgeScore } from '../campaign/types'
import type { ConversationArtifact, ConversationScenario } from './rollout'

export interface SimulatedUserMismatch {
  cellId: string
  /** `missing`: a cell carries no identity. `simulated-user`: the identities
   *  differ. `seed`: the same user ran on different seeds. */
  reason: 'missing' | 'simulated-user' | 'seed'
  detail: string
}

/** Paired conversations did not meet the same simulated user on the same seed. */
export class SimulatedUserMismatchError extends Error {
  readonly mismatches: SimulatedUserMismatch[]
  constructor(mismatches: SimulatedUserMismatch[]) {
    const shown = listSome(mismatches.map((row) => `${row.cellId}: ${row.detail}`), '; ')
    super(
      `${mismatches.length} paired conversation(s) did not meet the same simulated user ` +
        `on the same seed, so the comparison is refused (${shown})`,
    )
    this.name = 'SimulatedUserMismatchError'
    this.mismatches = mismatches
  }
}

/** A score on the agent's success was asked to read a conversation whose
 *  user side was the candidate. Optimizing the user to raise the agent's
 *  success would teach it to be easy; the user side's objective is the
 *  agent's failure rate, through `improveAdversarialUser` only. */
export class UserSideObjectiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserSideObjectiveError'
  }
}

/** A scenario an adversarial-user search emitted reached a held-out split. */
export class AdversarialScenarioInHeldOutError extends Error {
  readonly scenarioIds: string[]
  constructor(scenarioIds: string[]) {
    super(
      `held-out split contains ${scenarioIds.length} scenario(s) an adversarial-user search ` +
        `emitted (${listSome(scenarioIds)}); they train the agent side and never measure it`,
    )
    this.name = 'AdversarialScenarioInHeldOutError'
    this.scenarioIds = scenarioIds
  }
}

/**
 * Refuse a comparison whose paired conversations (same cell id) met different
 * simulated users or ran on different seeds, or carry no identity to show it.
 */
export function assertSameSimulatedUser(
  baseline: ReadonlyMap<string, ConversationArtifact>,
  candidate: ReadonlyMap<string, ConversationArtifact>,
): void {
  const mismatches: SimulatedUserMismatch[] = []
  for (const [cellId, other] of candidate) {
    const base = baseline.get(cellId)
    if (base === undefined) continue
    const missing = (['baseline', 'candidate'] as const).filter(
      (arm) => !hasIdentity(arm === 'baseline' ? base : other),
    )
    if (missing.length > 0) {
      mismatches.push({
        cellId,
        reason: 'missing',
        detail: `${missing.join(' and ')} carries no simulated-user identity`,
      })
    } else if (base.simulatedUser.digest !== other.simulatedUser.digest) {
      mismatches.push({
        cellId,
        reason: 'simulated-user',
        detail:
          `baseline user ${base.simulatedUser.digest} (${base.simulatedUser.model}), ` +
          `candidate user ${other.simulatedUser.digest} (${other.simulatedUser.model})`,
      })
    } else if (base.seed !== other.seed) {
      mismatches.push({
        cellId,
        reason: 'seed',
        detail: `baseline seed ${base.seed}, candidate seed ${other.seed}`,
      })
    }
  }
  if (mismatches.length > 0) throw new SimulatedUserMismatchError(mismatches)
}

/** The first three items, and an ellipsis when there are more. Package-internal. */
export function listSome(items: readonly string[], separator = ', '): string {
  return [...items.slice(0, 3), ...(items.length > 3 ? ['…'] : [])].join(separator)
}

function hasIdentity(artifact: ConversationArtifact | undefined): boolean {
  return (
    typeof artifact?.simulatedUser?.digest === 'string' &&
    artifact.simulatedUser.digest.length > 0 &&
    Number.isFinite(artifact.seed)
  )
}

/** Refuse a held-out split that contains an adversarial-user scenario. Run it
 *  on the test cases of any comparison that does not go through `conversationGate`. */
export function assertHeldOutExcludesAdversarial(scenarios: readonly ConversationScenario[]): void {
  const emitted = scenarios.filter((scenario) => scenario.origin?.kind === 'adversarial-user')
  if (emitted.length > 0) {
    throw new AdversarialScenarioInHeldOutError(emitted.map((scenario) => scenario.id))
  }
}

export interface ConversationJudgeOptions<TScenario extends ConversationScenario> {
  /** Scores a passed conversation on [0, 1] for what the outcome check does
   *  not see, such as tone. A failed conversation scores 0 without it. */
  semantic?: JudgeConfig<ConversationArtifact, TScenario>
}

/**
 * Score the agent side of a conversation: 0 when the code-checked outcome
 * failed, else 1, or the semantic judge's composite when one is given. The
 * `outcome` dimension is always the code check. Refuses a conversation whose
 * user side was the candidate.
 */
export function conversationJudge<TScenario extends ConversationScenario>(
  opts: ConversationJudgeOptions<TScenario> = {},
): JudgeConfig<ConversationArtifact, TScenario> {
  const semantic = opts.semantic
  return {
    name: 'conversation-outcome',
    judgeVersion: `agent-eval:conversation-outcome:v1${semantic ? `+${semantic.name}:${semantic.judgeVersion ?? 'unversioned'}` : ''}`,
    dimensions: [
      { key: 'outcome', description: '1 when the code-checked outcome passed, else 0' },
      ...(semantic?.dimensions ?? []).filter((dimension) => dimension.key !== 'outcome'),
    ],
    score(input) {
      if (input.artifact.optimizedRole !== 'agent') {
        throw new UserSideObjectiveError(
          `conversation '${input.scenario.id}' optimized the user side; the agent-success ` +
            'score reads agent-side conversations only, and improveAdversarialUser scores ' +
            "the user side on the agent's failure rate",
        )
      }
      const { passed, detail } = input.artifact.outcome
      if (!passed || !semantic) {
        return { dimensions: { outcome: passed ? 1 : 0 }, composite: passed ? 1 : 0, notes: detail }
      }
      return Promise.resolve(semantic.score(input)).then(
        (score): JudgeScore => ({
          ...score,
          dimensions: { ...score.dimensions, outcome: 1 },
          notes: `${detail}\n${score.notes}`,
        }),
      )
    },
  }
}

export interface ConversationGateOptions<TScenario extends ConversationScenario> {
  /** The decision once conditions hold. Default `defaultProductionGate` over
   *  the gate's held-out scenarios with `deltaThreshold`. */
  inner?: Gate<ConversationArtifact, TScenario>
  /** Default 0.05, as `selfImprove`'s default gate. */
  deltaThreshold?: number
  independentUnitByScenarioId?: ReadonlyMap<string, string>
}

/**
 * The promotion gate for conversations: refuses a held-out split containing
 * adversarial-user scenarios and any comparison whose arms met different
 * simulated users or seeds, then decides with `inner`.
 */
export function conversationGate<TScenario extends ConversationScenario>(
  opts: ConversationGateOptions<TScenario> = {},
): Gate<ConversationArtifact, TScenario> {
  return {
    name: 'conversation',
    async decide(ctx: GateContext<ConversationArtifact, TScenario>) {
      assertHeldOutExcludesAdversarial(ctx.scenarios)
      if (ctx.baselineArtifacts === undefined) {
        throw new SimulatedUserMismatchError([
          {
            cellId: '*',
            reason: 'missing',
            detail: 'the baseline arm carries no simulated-user identity: no baseline artifacts',
          },
        ])
      }
      assertSameSimulatedUser(ctx.baselineArtifacts, ctx.candidateArtifacts)
      if (ctx.neutralizedArtifacts) {
        assertSameSimulatedUser(ctx.baselineArtifacts, ctx.neutralizedArtifacts)
      }
      const inner =
        opts.inner ??
        defaultProductionGate<ConversationArtifact, TScenario>({
          holdoutScenarios: ctx.scenarios,
          deltaThreshold: opts.deltaThreshold ?? 0.05,
          ...(opts.independentUnitByScenarioId
            ? { independentUnitByScenarioId: opts.independentUnitByScenarioId }
            : {}),
        })
      const result = await inner.decide(ctx)
      return {
        ...result,
        contributingGates: [
          {
            name: 'simulated-user-identity',
            status: 'pass' as const,
            detail: { pairedConversations: ctx.candidateArtifacts.size },
          },
          ...result.contributingGates,
        ],
      }
    },
  }
}
