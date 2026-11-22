// A multishot conversation as an optimization dispatch.
//
// `multishotRollout` turns the conversation engine into the
// `agent(surface, scenario, ctx)` function `selfImprove` and
// `compareOptimizationMethods` call per cell. The candidate surface becomes
// the agent's profile; the simulated user is a function of the scenario and
// the rollout's fixed options alone, so every candidate meets the same user on
// the same seed. Every leg is a paid call through the cell's `ctx.cost`, the
// transcript is the artifact, and a code-checked outcome is the objective part
// of the score. There is one conversation loop: `runMultishotConversation`.

import type { AgentProfile } from '@tangle-network/agent-interface'
import type { DispatchContext, MutableSurface, Scenario } from '../campaign/types'
import type { CostChannel, CostReceiptInput, MaximumCharge } from '../cost-ledger/contract'
import { hashCanonical, jsonDocument } from '../ledger-core/canonical'
import type { PersonaRigor } from '../types'
import { runMultishotConversation } from './conversation'
import { defaultShapeFromProfile } from './shape-defaults'
import type {
  MultishotArtifact,
  MultishotMessage,
  MultishotPersona,
  MultishotShape,
  MultishotToolDefinition,
  MultishotToolExecutor,
  MultishotTransport,
  MultishotTransportRequest,
  MultishotTransportResponse,
} from './types'

/** A scenario a simulated user plays: its persona, and optionally a plan. */
export interface ConversationScenario<TPersona extends MultishotPersona = MultishotPersona>
  extends Scenario {
  persona: TPersona
  /** What the simulated user sets out to do in this scenario, appended to its
   *  prompt. Part of the simulated-user identity. */
  userPlan?: string
  /** Set on a scenario an adversarial-user search emitted. Such a scenario
   *  trains the agent side and never enters a held-out split. */
  origin?: { kind: 'adversarial-user'; sourceScenarioId: string; planDigest: string }
}

/** The code-checked outcome of one conversation: the objective part of its score. */
export interface ConversationOutcome {
  passed: boolean
  detail: string
}

/** How a conversation ended. `turn` is the agent turn after which it ended. */
export interface ConversationEnding {
  kind: 'signed-off' | 'gave-up' | 'turn-cap'
  turn: number
}

export type UserEndingClassification =
  | { kind: 'continue' }
  | { kind: 'signed-off' | 'gave-up'; message: string }

/** How the simulated user ends a conversation before the turn cap. */
export interface UserEndingProtocol {
  /** Stable name of `classify`'s rule. Part of the simulated-user identity. */
  ref: string
  /** Appended to the simulated user's prompt. Part of its identity. */
  instructions: string
  /** Reads one simulated-user message. An ending returns the message with its
   *  protocol marker removed: the marker is protocol, never something the
   *  agent sees or the user said. */
  classify(message: string): UserEndingClassification
}

const SIGNED_OFF = '[[signed-off]]'
const GAVE_UP = '[[gave-up]]'

/** Ends on `[[signed-off]]` when the user's problem is resolved and on
 *  `[[gave-up]]` when the user would stop using the service. */
export const DEFAULT_USER_ENDING: UserEndingProtocol = {
  ref: 'agent-eval:user-ending-markers:v1',
  instructions: [
    `When your problem is resolved to your standard, end your message with ${SIGNED_OFF}.`,
    `If you would stop using this service now because the agent is not getting anywhere, end your message with ${GAVE_UP}.`,
    'Otherwise use neither marker.',
  ].join('\n'),
  classify(message) {
    for (const [marker, kind] of [
      [SIGNED_OFF, 'signed-off'],
      [GAVE_UP, 'gave-up'],
    ] as const) {
      if (message.includes(marker)) return { kind, message: message.split(marker).join('').trim() }
    }
    return { kind: 'continue' }
  },
}

/** How each rigor level asks the simulated user to push back, as
 *  `PersonaRigor` defines them. */
const RIGOR_STANCE: Record<PersonaRigor, string> = {
  cooperative:
    'Your stance: a forgiving early adopter. Accept a reasonable answer and move on; push back only when the agent is clearly wrong or stuck.',
  demanding:
    'Your stance: an experienced professional. Reject vague or hedged answers and ask for specifics before you accept anything.',
  relentless:
    'Your stance: you are reviewing this for someone who will hold you to it. Interrogate every claim and accept nothing the agent has not defended.',
}

/** The simulated user. Its options never depend on the candidate surface. */
export interface SimulatedUserOptions<TPersona extends MultishotPersona = MultishotPersona> {
  model: string
  /** Tried in order when a model returns an empty message twice. */
  fallbackModels?: string[]
  transport: MultishotTransport
  /** Default `'demanding'`. */
  rigor?: PersonaRigor
  /** How the user refers to the agent. Fixed for the simulated user: its
   *  prompt never derives from the candidate profile. Default `'an AI agent'`. */
  agentDescription?: string
  /** Overrides the derived opener and prompt; requires `shapeRef`. */
  shape?: MultishotShape<TPersona>
  /** Stable name for `shape`'s callbacks. Part of the simulated-user identity. */
  shapeRef?: string
  /** Maximum output tokens per simulated-user message. Default 600. */
  maxTokens?: number
  /** Default `DEFAULT_USER_ENDING`. */
  ending?: UserEndingProtocol
  /** Recognizes a user message that pushes back on the agent's last reply.
   *  Without it the first pushback turn is reported as undetermined. */
  pushback?: (message: string) => boolean
}

/** The agent leg: everything about the agent except the candidate surface. */
export interface ConversationAgentOptions {
  model: string
  transport: MultishotTransport
  /** Tools advertised to the agent. Default: none. */
  tools?: MultishotToolDefinition[]
  /** Required with `tools`. Paid work runs through the executor's
   *  `ctx.transport`, which is metered; other executor spend is not. */
  toolExecutors?: Record<string, MultishotToolExecutor>
  artifactTypeFor?: (toolName: string) => string | undefined
  /** Default: `transport`. */
  toolTransport?: MultishotTransport
  maxTokens?: number
  toolFollowupMaxTokens?: number
  maxToolDispatches?: number
}

/** What the outcome check reads. */
export interface ConversationRecord {
  transcript: MultishotMessage[]
  artifacts: MultishotArtifact[]
  ending: ConversationEnding
}

export type ConversationLeg = 'agent' | 'user' | 'tool'

export interface MultishotRolloutOptions<TScenario extends ConversationScenario> {
  agent: ConversationAgentOptions
  /** The agent profile a candidate surface becomes. Default: a text surface
   *  is the agent's system prompt; any other surface needs this mapping. */
  profile?: (surface: MutableSurface, scenario: TScenario) => AgentProfile
  user: SimulatedUserOptions<TScenario['persona']>
  /** Agent turns at most. The simulated user may end the conversation sooner. */
  maxTurns: number
  /** Decides by code whether the conversation reached its goal. */
  outcome: (conversation: ConversationRecord, scenario: TScenario) => ConversationOutcome
  /** Hard maximum for one leg's call, required by a capped campaign. */
  maximumCharge?: (
    leg: ConversationLeg,
    request: MultishotTransportRequest,
  ) => MaximumCharge | undefined
  /** Version of behavior the options cannot show, such as tool executor code
   *  or the outcome rule. Part of `dispatchRef`. */
  revision?: string
}

/** Who the agent talked to. Equal digests mean the same simulated user: model,
 *  fallbacks, rigor, persona, prompt, opener and ending protocol. */
export interface SimulatedUserIdentity {
  digest: string
  model: string
  fallbackModels: string[]
  rigor: PersonaRigor
  personaId: string
  personaDigest: string
  promptDigest: string
  openerDigest: string
  endingRef: string
  shapeRef: string
  maxTokens: number
}

export type PushbackReading = { determined: false } | { determined: true; firstTurn: number | null }

/** One conversation, as the dispatch returns it. */
export interface ConversationArtifact {
  transcript: MultishotMessage[]
  artifacts: MultishotArtifact[]
  toolCalls: number
  agentTurns: number
  ending: ConversationEnding
  outcome: ConversationOutcome
  /** The driver turn at which the user first pushed back on the agent. */
  pushback: PushbackReading
  simulatedUser: SimulatedUserIdentity
  /** The campaign cell seed every leg asked for. */
  seed: number
  /** Which side of the conversation the candidate surface was. A score on
   *  the agent's success only reads `'agent'` conversations. */
  optimizedRole: 'agent' | 'user'
}

export interface MultishotRollout<TScenario extends ConversationScenario> {
  /** The dispatch: run one conversation with `surface` as the agent. */
  agent: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<ConversationArtifact>
  /** Version of everything but the surface, for measurement caches. */
  dispatchRef: string
  /** The simulated user `agent` puts in front of the agent for `scenario`. */
  simulatedUser: (scenario: TScenario) => SimulatedUserIdentity
}

/** The simulated user's opener and system prompt for one persona and plan. */
export interface SimulatedUserSetup {
  opener: string
  driverSystemPrompt: string
  identity: SimulatedUserIdentity
}

/** Builds the simulated user from its options alone. The rollout and the
 *  realism measure both build it here, so a measured driver is the driver a
 *  rollout runs. */
export function simulatedUserSetup<TPersona extends MultishotPersona>(
  user: SimulatedUserOptions<TPersona>,
  persona: TPersona,
  plan?: string,
): SimulatedUserSetup {
  if (user.shape !== undefined && !user.shapeRef) {
    throw new TypeError('simulated user: a custom shape needs a shapeRef naming its callbacks')
  }
  const rigor = user.rigor ?? 'demanding'
  const ending = user.ending ?? DEFAULT_USER_ENDING
  const shape = defaultShapeFromProfile<TPersona>(
    { name: 'agent', description: user.agentDescription ?? 'an AI agent' },
    user.shape,
  )
  const opener = shape.buildOpener(persona)
  const driverSystemPrompt = [
    shape.buildDriverSystemPrompt(persona),
    RIGOR_STANCE[rigor],
    ending.instructions,
    plan ? `Your plan for this conversation:\n${plan}` : '',
  ]
    .filter((block) => block.length > 0)
    .join('\n\n')
  const fields = {
    model: user.model,
    fallbackModels: [...(user.fallbackModels ?? [])],
    rigor,
    personaId: persona.id,
    personaDigest: hashCanonical(jsonDocument(persona)),
    promptDigest: hashCanonical(driverSystemPrompt),
    openerDigest: hashCanonical(opener),
    endingRef: ending.ref,
    shapeRef: user.shapeRef ?? 'agent-eval:default-shape',
    maxTokens: user.maxTokens ?? 600,
  }
  return {
    opener,
    driverSystemPrompt,
    identity: { digest: hashCanonical(jsonDocument(fields)), ...fields },
  }
}

/**
 * Run a multishot conversation as the `agent(surface, scenario, ctx)` dispatch
 * of `selfImprove` and `compareOptimizationMethods`. Pass `dispatchRef` along
 * with `agent`, score with `conversationJudge`, gate with `conversationGate`
 * and show the optimizer `describeConversation`.
 */
export function multishotRollout<TScenario extends ConversationScenario>(
  opts: MultishotRolloutOptions<TScenario>,
): MultishotRollout<TScenario> {
  const profileOf = opts.profile ?? textSurfaceProfile
  return {
    agent: (surface, scenario, ctx) =>
      converse(opts, profileOf(surface, scenario), scenario, scenario.userPlan, 'agent', ctx),
    dispatchRef: rolloutDispatchRef(opts, 'agent'),
    simulatedUser: (scenario) =>
      simulatedUserSetup(opts.user, scenario.persona, scenario.userPlan).identity,
  }
}

/** The user side of the same conversation: the agent profile is fixed and the
 *  candidate surface is the simulated user's plan. Package-internal; the only
 *  public way to optimize it is `improveAdversarialUser`, whose objective is
 *  fixed to the agent's failure rate. */
export function userSideRollout<TScenario extends ConversationScenario>(
  opts: Omit<MultishotRolloutOptions<TScenario>, 'profile'>,
  agentProfile: AgentProfile,
): Omit<MultishotRollout<TScenario>, 'simulatedUser'> {
  return {
    agent: (surface, scenario, ctx) => {
      if (typeof surface !== 'string') {
        throw new TypeError('adversarial user: the plan surface must be text')
      }
      const plan = [scenario.userPlan, surface].filter(Boolean).join('\n\n')
      return converse(opts, agentProfile, scenario, plan, 'user', ctx)
    },
    dispatchRef: rolloutDispatchRef(
      { ...opts, profileDigest: hashCanonical(jsonDocument(agentProfile)) },
      'user',
    ),
  }
}

function textSurfaceProfile(surface: MutableSurface): AgentProfile {
  if (typeof surface !== 'string') {
    throw new TypeError(
      'multishotRollout: a non-text surface needs a `profile` mapping it to an AgentProfile',
    )
  }
  return { name: 'agent', prompt: { systemPrompt: surface } }
}

function rolloutDispatchRef<TScenario extends ConversationScenario>(
  opts: Omit<MultishotRolloutOptions<TScenario>, 'profile'> & { profileDigest?: string },
  role: 'agent' | 'user',
): string {
  const ending = opts.user.ending ?? DEFAULT_USER_ENDING
  return `multishot-rollout:${hashCanonical(
    jsonDocument({
      role,
      maxTurns: opts.maxTurns,
      revision: opts.revision,
      profileDigest: opts.profileDigest,
      agent: {
        model: opts.agent.model,
        tools: opts.agent.tools ?? [],
        maxTokens: opts.agent.maxTokens,
        toolFollowupMaxTokens: opts.agent.toolFollowupMaxTokens,
        maxToolDispatches: opts.agent.maxToolDispatches,
      },
      user: {
        model: opts.user.model,
        fallbackModels: opts.user.fallbackModels ?? [],
        rigor: opts.user.rigor ?? 'demanding',
        agentDescription: opts.user.agentDescription ?? 'an AI agent',
        shapeRef: opts.user.shapeRef ?? 'agent-eval:default-shape',
        maxTokens: opts.user.maxTokens ?? 600,
        endingRef: ending.ref,
        endingInstructions: ending.instructions,
      },
    }),
  )}`
}

async function converse<TScenario extends ConversationScenario>(
  opts: Omit<MultishotRolloutOptions<TScenario>, 'profile'>,
  profile: AgentProfile,
  scenario: TScenario,
  plan: string | undefined,
  optimizedRole: 'agent' | 'user',
  ctx: DispatchContext,
): Promise<ConversationArtifact> {
  if (!Number.isSafeInteger(opts.maxTurns) || opts.maxTurns < 1) {
    throw new RangeError(
      `multishotRollout: maxTurns must be a positive integer, got ${opts.maxTurns}`,
    )
  }
  if ((opts.agent.tools === undefined) !== (opts.agent.toolExecutors === undefined)) {
    throw new TypeError('multishotRollout: agent tools and toolExecutors go together')
  }
  const user = simulatedUserSetup(opts.user, scenario.persona, plan)
  const ending = opts.user.ending ?? DEFAULT_USER_ENDING
  const metered = (
    leg: ConversationLeg,
    channel: CostChannel,
    actor: string,
    transport: MultishotTransport,
  ): MultishotTransport => {
    return async (req) => {
      const { tools, signal, ...rest } = req
      // The engine advertises an empty tool list when the agent has no tools;
      // a provider may refuse one, so the request leaves it out.
      const request: MultishotTransportRequest = {
        ...rest,
        ...(tools && tools.length > 0 ? { tools } : {}),
        seed: ctx.seed,
      }
      const maximumCharge = opts.maximumCharge?.(leg, request)
      const result = await ctx.cost.runPaidCall({
        channel,
        actor,
        model: request.model,
        signal: signal ?? ctx.signal,
        ...(maximumCharge === undefined ? {} : { maximumCharge }),
        execute: (callSignal) => transport({ ...request, signal: callSignal }),
        receipt: (response) => legReceipt(request.model, response),
      })
      if (!result.succeeded) throw result.error
      return result.value
    }
  }

  const close: { ending?: ConversationEnding; message?: string } = {}
  const result = await runMultishotConversation(
    {
      profile,
      persona: scenario.persona,
      shape: {
        buildOpener: () => user.opener,
        buildDriverSystemPrompt: () => user.driverSystemPrompt,
      },
      tools: opts.agent.tools ?? [],
      toolExecutors: opts.agent.toolExecutors ?? {},
      artifactTypeFor: opts.agent.artifactTypeFor,
      maxTurns: opts.maxTurns,
      agentModel: opts.agent.model,
      driverModel: opts.user.model,
      driverFallbackModels: opts.user.fallbackModels,
      agentMaxTokens: opts.agent.maxTokens,
      toolFollowupMaxTokens: opts.agent.toolFollowupMaxTokens,
      driverMaxTokens: user.identity.maxTokens,
      maxToolDispatches: opts.agent.maxToolDispatches,
      agentTransport: metered('agent', 'agent', 'agent', opts.agent.transport),
      driverTransport: metered('user', 'driver', 'simulated-user', opts.user.transport),
      toolTransport: metered(
        'tool',
        'agent',
        'tool',
        opts.agent.toolTransport ?? opts.agent.transport,
      ),
      signal: ctx.signal,
    },
    async (conversation) => {
      for (let turn = 0; turn < conversation.maxTurns; turn++) {
        await conversation.agentTurn(turn)
        if (turn === conversation.maxTurns - 1) {
          close.ending = { kind: 'turn-cap', turn }
          return
        }
        const { content } = await conversation.driverTurn(turn)
        const classified = ending.classify(content)
        if (classified.kind !== 'continue') {
          close.ending = { kind: classified.kind, turn }
          close.message = classified.message
          return
        }
      }
    },
  )
  const ended = close.ending
  if (ended === undefined) throw new Error('multishotRollout: the conversation never ended')

  const transcript = result.transcript.map((message) => ({ ...message }))
  if (close.message !== undefined) transcript[transcript.length - 1]!.content = close.message
  const userMessages = transcript.filter((message) => message.role === 'user').slice(1)
  const firstPushback = opts.user.pushback
    ? userMessages.findIndex((message) => opts.user.pushback!(message.content))
    : undefined
  const record: ConversationRecord = { transcript, artifacts: result.artifacts, ending: ended }
  const outcome = opts.outcome(record, scenario)
  if (typeof outcome?.passed !== 'boolean' || typeof outcome.detail !== 'string') {
    throw new TypeError('multishotRollout: outcome must return { passed: boolean, detail: string }')
  }
  return {
    transcript,
    artifacts: result.artifacts,
    toolCalls: result.toolCalls,
    agentTurns: ended.turn + 1,
    ending: ended,
    outcome: { passed: outcome.passed, detail: outcome.detail },
    pushback:
      firstPushback === undefined
        ? { determined: false }
        : { determined: true, firstTurn: firstPushback < 0 ? null : firstPushback },
    simulatedUser: user.identity,
    seed: ctx.seed,
    optimizedRole,
  }
}

function legReceipt(requested: string, response: MultishotTransportResponse): CostReceiptInput {
  const usage = response.usage
  return {
    model: response.model ?? requested,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(usage === undefined ? { usageUnknown: true } : {}),
    ...(response.costUsd === undefined ? {} : { actualCostUsd: response.costUsd }),
  }
}
