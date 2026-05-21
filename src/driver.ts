import type { TCloud } from '@tangle-network/tcloud'
import type { ProductClient } from './client'
import { ConvergenceTracker } from './convergence'
import { MetricsCollector } from './metrics'
import type {
  DriverResult,
  DriverState,
  PersonaConfig,
  PersonaRigor,
  TurnMetrics,
} from './types'

export interface AgentDriverConfig {
  client: ProductClient
  driverModel?: string
  /** System prompt context for the driver LLM to understand the product */
  productContext?: string
}

/**
 * Per-rigor stance the driver LLM adopts. Scales how hard the simulated
 * user interrogates the agent — see `PersonaConfig.rigor`.
 */
const RIGOR_STANCE: Record<PersonaRigor, string> = {
  cooperative:
    'Your stance: a pragmatic early adopter. You accept reasonable answers and only push back on clear gaps or outright errors.',
  demanding:
    'Your stance: an experienced professional with no time to waste. You do not accept vague, hedged, or generic answers — you expect specifics, and you say so plainly when you do not get them.',
  relentless:
    'Your stance: a senior partner reviewing this work for a client who will litigate if it is wrong. You interrogate every claim. You accept nothing undefended. You find the single weakest point in every answer and attack it. Courteous, never satisfied.',
}

/**
 * AgentDriver — meta-agent that plays a persona against the real product.
 *
 * Uses a driver LLM (Claude/GPT-4o) to decide what to say each turn.
 * Not scripted — the driver gets the current product state and decides
 * the next realistic user message.
 */
export class AgentDriver {
  private tc: TCloud
  private client: ProductClient
  private driverModel: string
  private productContext: string

  constructor(tc: TCloud, config: AgentDriverConfig) {
    this.tc = tc
    this.client = config.client
    this.driverModel = config.driverModel ?? 'claude-sonnet-4-6'
    this.productContext = config.productContext ?? ''
  }

  /**
   * Run a persona through the product.
   *
   * Returns metrics on how many turns to completion, cost curve,
   * quality curve, and convergence curve.
   */
  async run(persona: PersonaConfig): Promise<DriverResult> {
    // Setup: create workspace + thread
    const email = `eval-driver-${Date.now()}@test.agent-eval.local`
    await this.client.signup(`Driver ${persona.role}`, email, 'eval-driver-pass')
    await this.client.login(email, 'eval-driver-pass')
    const workspaceId = await this.client.createWorkspace(`${persona.role} Eval`)
    const threadId = await this.client.createThread(workspaceId)

    const metrics = new MetricsCollector(this.client, workspaceId)
    const convergence = new ConvergenceTracker(persona.completionCriteria)
    const turnMetrics: TurnMetrics[] = []
    const conversationHistory: { role: string; content: string }[] = []

    let completed = false
    let turnsToCompletion: number | null = null
    let criteriaMetAtTurn: number | null = null

    for (let turn = 1; turn <= persona.maxTurns; turn++) {
      // Get current product state
      const state = await metrics.getState()

      // Ask driver LLM what to say
      const userMessage = await this.decideNextMessage(persona, state, conversationHistory)

      if (userMessage === 'DONE') {
        completed = true
        turnsToCompletion = turn - 1
        console.log(`  SIGNED OFF by simulated ${persona.role} after turn ${turn - 1}`)
        break
      }

      // Send to product
      const turnStart = Date.now()
      const response = await this.client.chat(workspaceId, threadId, userMessage)
      const latency = Date.now() - turnStart

      conversationHistory.push(
        { role: 'user', content: userMessage },
        { role: 'assistant', content: response.text },
      )

      // Wait for post-processor
      await new Promise((r) => setTimeout(r, 2000))

      // Handle pending approvals
      await this.handleApprovals(persona, workspaceId, state)

      // Check convergence
      const postState = await metrics.getState()
      const conv = convergence.record(turn, postState)

      // Collect metrics
      const codeBlockCount = (response.text.match(/```\w+\n/g) || []).length
      const m = await metrics.collect(
        turn,
        latency,
        response.text.length,
        codeBlockCount,
        response.blocks.length,
        Object.values(conv.criteriaStatus).filter(Boolean).length,
        persona.completionCriteria.length,
      )
      turnMetrics.push(m)

      // Print turn status
      const criteriaStr = Object.entries(conv.criteriaStatus)
        .map(([k, v]) => `${k}:${v ? '+' : '-'}`)
        .join(' ')
      console.log(
        `  [turn ${turn}] ${conv.completionPercent.toFixed(0)}% — ${criteriaStr} (${(latency / 1000).toFixed(1)}s)`,
      )

      // Nominal criteria met is recorded, not a stop condition. The
      // simulated professional keeps pressure-testing until genuinely
      // satisfied — a criteria-met-but-sloppy answer must still be defended.
      if (conv.complete && criteriaMetAtTurn === null) {
        criteriaMetAtTurn = turn
        console.log(`  criteria met at turn ${turn} — driver continues pressure-testing`)
      }
    }

    const finalState = await metrics.getState()

    return {
      personaId: persona.id,
      completed,
      turnsToCompletion,
      criteriaMetAtTurn,
      totalTurns: turnMetrics.length,
      metrics: turnMetrics,
      finalState,
      convergenceCurve: convergence.getCurve(),
      totalCostUsd: 0,
      finalQualityScore: null,
    }
  }

  /** Use the driver LLM to decide what the "user" says next */
  private async decideNextMessage(
    persona: PersonaConfig,
    state: DriverState,
    history: { role: string; content: string }[],
  ): Promise<string> {
    const lastResponse =
      history.length > 0
        ? history[history.length - 1]!.content.slice(0, 2000)
        : '(no conversation yet — this is the first message)'

    const recentHistory = history
      .slice(-6)
      .map((h) => `${h.role}: ${h.content.slice(0, 500)}`)
      .join('\n\n')

    const resp = await this.tc.chat({
      model: this.driverModel,
      messages: [
        {
          role: 'system',
          content: buildDriverSystemPrompt(persona, state, this.productContext),
        },
        {
          role: 'user',
          content: recentHistory
            ? `Recent conversation:\n${recentHistory}\n\nThe agent's latest response:\n${lastResponse}`
            : 'No conversation yet. Send your opening message — in character, phrased as this person actually would.',
        },
      ],
      temperature: 0.5,
      maxTokens: 700,
    })

    const content =
      (resp as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ??
      ''

    return content.trim()
  }

  /** Handle pending approvals based on persona feedback patterns */
  private async handleApprovals(
    persona: PersonaConfig,
    workspaceId: string,
    _state: DriverState,
  ): Promise<void> {
    const approvals = await this.client.getApprovals(workspaceId)
    const pending = approvals.filter((a) => a.status === 'pending')

    for (const action of pending) {
      // Check if any feedback pattern triggers a rejection
      const rejection = persona.feedbackPatterns?.find((fp) => {
        const title = action.title.toLowerCase()
        return title.includes(fp.trigger.toLowerCase())
      })

      if (rejection) {
        await this.client.rejectAction(workspaceId, action.id, rejection.response)
        console.log(`    rejected: ${action.title} — ${rejection.response.slice(0, 60)}`)
      } else {
        await this.client.approveAction(workspaceId, action.id)
        console.log(`    approved: ${action.title}`)
      }
    }
  }

}

/** Describe which nominal completion criteria are met, for the driver prompt. */
function describeCompletion(persona: PersonaConfig, state: DriverState): string {
  const results = persona.completionCriteria.map((c) => {
    const met = c.check(state)
    return `${c.name}: ${met ? 'MET' : 'NOT MET'}`
  })
  const metCount = results.filter((r) => r.includes('MET') && !r.includes('NOT')).length
  return `${metCount}/${persona.completionCriteria.length} — ${results.join(', ')}`
}

/**
 * Build the driver LLM's system prompt. The simulated user is an
 * adversarial senior professional: it judges the agent's last response by a
 * professional standard, refuses vague answers, challenges undefended
 * claims, probes the persona's pressure points without revealing them, and
 * signs off (DONE) only when a real practitioner would act on the work
 * unmodified. Pure function of persona, product state, and product context
 * — exported so harness authors can inspect and regression-test it.
 */
export function buildDriverSystemPrompt(
  persona: PersonaConfig,
  state: DriverState,
  productContext = '',
): string {
  const rigor: PersonaRigor = persona.rigor ?? 'demanding'
  const expertise = persona.expertise ? ` You are ${persona.expertise}.` : ''

  const pressure =
    persona.pressurePoints && persona.pressurePoints.length > 0
      ? `\nA competent ${persona.role} here MUST get the agent to address each of:\n${persona.pressurePoints
          .map((p) => `  - ${p}`)
          .join('\n')}\nDo NOT hand these to the agent. Probe whether it surfaces them itself. If it misses one, press on exactly that gap until it delivers or demonstrably fails.\n`
      : ''

  const curveballs =
    persona.curveballs && persona.curveballs.length > 0
      ? `\nOnce the agent is coasting on easy answers, introduce ONE of these as a genuine new development — never as a quiz:\n${persona.curveballs
          .map((c) => `  - ${c}`)
          .join('\n')}\n`
      : ''

  return `You are role-playing a real ${persona.role} putting an AI agent through its paces.${expertise}
Your objective: ${persona.goal}
You are deciding whether this agent's work is good enough to stake your professional reputation on. Assume it is not — until it proves otherwise.

${RIGOR_STANCE[rigor]}
${productContext ? `Product context:\n${productContext}\n` : ''}Current workspace state:
- Tasks: ${state.tasks} | Events: ${state.events}
- Proposals: pending=${state.proposals.pending}, approved=${state.proposals.approved}, rejected=${state.proposals.rejected}
- Vault files (${state.vaultFiles.length}): ${state.vaultFiles.slice(0, 10).join(', ')}${state.vaultFiles.length > 10 ? ' …' : ''}
- Nominal task criteria: ${describeCompletion(persona, state)}
${pressure}${curveballs}
How to choose your next message:
1. Silently judge the agent's last response the way a ${persona.role} would. Is every claim defended with a specific authority, figure, or mechanism? Or is it vague, hedged, or generic?
2. If it is vague or hand-waved — do NOT move on. Name the gap and demand the specific authority / figure / mechanism. "It depends" is not an answer; force the decision.
3. If it makes a claim you can challenge — challenge it. Make the agent defend or correct it.
4. If it missed something a ${persona.role} would catch — press on exactly that, without naming it for the agent.
5. If it is genuinely solid — escalate: go a layer deeper, or introduce a curveball.
6. First message — state your situation as you really would: realistic, specific, with the messy detail, but do not coach the agent.

Sign-off: respond with exactly "DONE" only when a ${persona.role} would act on this work without redoing it. Nominal task completion is NOT sign-off — sloppy-but-complete still fails. If the agent never gets there, keep pushing; never sign off on weak work.

Output ONLY your next message to the agent — in character, first person, no meta-commentary, no stage directions.`
}
