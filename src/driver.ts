import type { TCloud } from '@tangle-network/tcloud'
import type { ProductClient } from './client'
import { ConvergenceTracker } from './convergence'
import { MetricsCollector } from './metrics'
import type { DriverResult, DriverState, PersonaConfig, TurnMetrics } from './types'

export interface AgentDriverConfig {
  client: ProductClient
  driverModel?: string
  /** System prompt context for the driver LLM to understand the product */
  productContext?: string
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

    for (let turn = 1; turn <= persona.maxTurns; turn++) {
      // Get current product state
      const state = await metrics.getState()

      // Ask driver LLM what to say
      const userMessage = await this.decideNextMessage(persona, state, conversationHistory)

      if (userMessage === 'DONE') {
        completed = true
        turnsToCompletion = turn - 1
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

      if (conv.complete) {
        completed = true
        turnsToCompletion = turn
        console.log(`  COMPLETE at turn ${turn}`)
        break
      }
    }

    const finalState = await metrics.getState()

    return {
      personaId: persona.id,
      completed,
      turnsToCompletion,
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
          content: `You are playing the role of a ${persona.role} testing an AI agent.
Your goal: ${persona.goal}

${this.productContext ? `Product context:\n${this.productContext}\n` : ''}
Current state:
- Tasks: ${state.tasks}
- Events: ${state.events}
- Proposals: pending=${state.proposals.pending}, approved=${state.proposals.approved}, rejected=${state.proposals.rejected}
- Vault files: ${state.vaultFiles.length} (${state.vaultFiles.slice(0, 10).join(', ')}${state.vaultFiles.length > 10 ? '...' : ''})

Completion criteria met: ${this.describeCompletion(persona, state)}

Decide what to do next:
1. If completion is 100% — respond with exactly "DONE"
2. If a proposal is pending — approve or reject it (with reason)
3. If the agent is on track — push for the next deliverable
4. If the agent is off track — give specific corrective feedback
5. If this is the first message — start with a clear, actionable request

Output ONLY your next message to the agent. Be specific. Be realistic.
Don't be patient — a real ${persona.role} wouldn't accept vague answers.`,
        },
        {
          role: 'user',
          content: recentHistory
            ? `Recent conversation:\n${recentHistory}\n\nThe agent just said:\n${lastResponse}`
            : 'No conversation yet. Send your opening message.',
        },
      ],
      temperature: 0.5,
      maxTokens: 500,
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

  /** Describe which completion criteria are met */
  private describeCompletion(persona: PersonaConfig, state: DriverState): string {
    const results = persona.completionCriteria.map((c) => {
      const met = c.check(state)
      return `${c.name}: ${met ? 'MET' : 'NOT MET'}`
    })
    const metCount = results.filter((r) => r.includes('MET') && !r.includes('NOT')).length
    return `${metCount}/${persona.completionCriteria.length} — ${results.join(', ')}`
  }
}
