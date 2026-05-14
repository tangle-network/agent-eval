/**
 * AgenticJourneyRunner — give an LLM a goal + a toolbox of HTTP calls
 * against your product, let it drive the journey, record the whole
 * thing as a meta-layer Run with per-step app-runtime children.
 *
 * This is the primitive behind "one real user does the 9-step journey"
 * without needing a human. The driver LLM decides what to call next
 * given the goal + results so far. Each tool call becomes a ToolSpan;
 * each assistant decision becomes an LlmSpan. The run's outcome score
 * is the fraction of `completionCriteria` that passed.
 *
 * Generic over product: you supply the tools (their shape, what they
 * call, what they return). The driver doesn't know or care about the
 * underlying product beyond the toolbox + the goal.
 *
 *   const runner = new AgenticJourneyRunner({
 *     goal: 'Sign up, create an agent, publish it, and verify it works.',
 *     tools: [...],
 *     completionCriteria: [...],
 *     chat: async ({ messages, tools }) => { ... call your LLM ... },
 *   })
 *   const report = await runner.run(traceStore)
 *
 * The `chat` callback is framework-agnostic — wire it to anthropic SDK,
 * openai, tangle-router, whatever. Return an assistant message with
 * zero or more tool calls. The runner orchestrates the loop.
 */

import type { FailureClass, LlmSpan, ToolSpan, TraceStore } from './trace'
import { TraceEmitter } from './trace'

// ── Types ────────────────────────────────────────────────────────────

export interface JourneyTool {
  /** Stable name shown to the driver LLM. */
  name: string
  /** Human-friendly description. Goes into the LLM's tool list. */
  description: string
  /** JSON Schema for the args the driver will produce. */
  parameters: Record<string, unknown>
  /** Handler invoked with parsed args. Must return a JSON-stringifiable result. */
  handler: (args: Record<string, unknown>, ctx: JourneyContext) => Promise<unknown>
}

export interface JourneyContext {
  /** Mutable scratch the tool handlers can share (session cookies, agent
   *  IDs, URLs picked up along the way). */
  state: Record<string, unknown>
  /** Emit a custom diagnostic span — useful for tools that do multi-step work. */
  note(message: string, detail?: Record<string, unknown>): void
  /** Abort signal propagated from the top-level runner (timeouts, SIGINT). */
  abortSignal: AbortSignal
}

export interface CompletionCriterion {
  id: string
  description: string
  /** Returns true when the criterion is satisfied given the current context. */
  check: (ctx: JourneyContext) => boolean | Promise<boolean>
}

export interface JourneyChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  toolCallId?: string
}

export interface JourneyChatResponse {
  content: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  model?: string
  finishReason?: string
}

export interface JourneyChatRequest {
  messages: JourneyChatMessage[]
  tools: Array<Pick<JourneyTool, 'name' | 'description' | 'parameters'>>
  abortSignal: AbortSignal
}

export type JourneyChatFn = (req: JourneyChatRequest) => Promise<JourneyChatResponse>

export interface AgenticJourneyConfig {
  /** Goal description given to the driver LLM. Be explicit about what "done" means. */
  goal: string
  /** Tools the driver can call. */
  tools: JourneyTool[]
  /** Criteria the runner checks at each turn + at end. Fraction passed = outcome score. */
  completionCriteria: CompletionCriterion[]
  /** LLM chat function. Framework-agnostic — wire your SDK. */
  chat: JourneyChatFn
  /** Max turns before the runner aborts with failureClass='budget_exceeded'. Default 20. */
  maxTurns?: number
  /** Wall-clock cap in ms. Default 5 minutes. */
  maxWallMs?: number
  /** Additional system-prompt text appended after the canonical framing. */
  systemPromptAddendum?: string
  /** Scenario id for the Run. Default 'agentic-journey'. */
  scenarioId?: string
  /** Project id for the Run. */
  projectId?: string
  /** Variant id (used to distinguish prompt/model versions). */
  variantId?: string
}

export interface JourneyTurn {
  turnIndex: number
  assistantMessage: string
  toolCalls: Array<{
    name: string
    args: Record<string, unknown>
    result: unknown
    ok: boolean
    error?: string
  }>
  criteriaPassed: number
  criteriaTotal: number
}

export interface JourneyReport {
  runId: string
  completed: boolean
  turnCount: number
  turns: JourneyTurn[]
  criteriaResults: Array<{ id: string; description: string; passed: boolean }>
  score: number
  failureClass?: FailureClass
  wallMs: number
  terminalState: Record<string, unknown>
}

// ── Runner ───────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are a realistic user driving a software product through its onboarding journey.

You have a goal, a set of tools you can call, and a scratch state you can
read. Your job is to achieve the goal by calling tools in the right
sequence.

Rules:
- ALWAYS prefer calling a tool over narrating. If you need to make the
  journey progress, you must issue a tool call.
- Read the results of your prior tool calls carefully. State (IDs, URLs,
  tokens) accumulates across turns — reference it when choosing your
  next call.
- When you believe every criterion is satisfied, respond with a single
  message: "DONE — <one-sentence summary>". Do NOT call tools on that turn.
- If a tool fails, try again with adjusted args OR call a different tool.
- Never invent fields the schema doesn't include.`

export async function runAgenticJourney(
  store: TraceStore,
  config: AgenticJourneyConfig,
): Promise<JourneyReport> {
  const maxTurns = config.maxTurns ?? 20
  const maxWallMs = config.maxWallMs ?? 5 * 60 * 1000
  const scenarioId = config.scenarioId ?? 'agentic-journey'

  const emitter = new TraceEmitter(store)
  await emitter.startRun({
    scenarioId,
    projectId: config.projectId,
    variantId: config.variantId,
    layer: 'meta',
    tags: {
      goal: config.goal.slice(0, 120),
      toolCount: String(config.tools.length),
      criteriaCount: String(config.completionCriteria.length),
    },
  })

  const abort = new AbortController()
  const wallStart = Date.now()
  const wallTimer = setTimeout(() => abort.abort(new Error('journey wall timeout')), maxWallMs)

  const ctx: JourneyContext = {
    state: {},
    abortSignal: abort.signal,
    note(message, detail) {
      void emitter.emit({ kind: 'log', payload: { message, ...(detail ?? {}) } })
    },
  }

  const systemMessage: JourneyChatMessage = {
    role: 'system',
    content: [
      DEFAULT_SYSTEM_PROMPT,
      `GOAL:\n${config.goal}`,
      `COMPLETION CRITERIA:\n${config.completionCriteria.map((c) => `- ${c.id}: ${c.description}`).join('\n')}`,
      config.systemPromptAddendum ?? '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  }

  const messages: JourneyChatMessage[] = [systemMessage]
  const turns: JourneyTurn[] = []
  let completed = false
  let failureClass: FailureClass | undefined

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (abort.signal.aborted) {
        failureClass = 'timeout'
        break
      }

      // One LLM turn.
      const llmHandle = await emitter.llm({
        name: `driver-turn-${turn}`,
        model: 'agentic-driver',
        messages: messages.map(({ role, content }) => ({
          role: role === 'tool' ? 'tool' : role,
          content,
        })),
      })
      let resp: JourneyChatResponse
      try {
        resp = await config.chat({
          messages,
          tools: config.tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
          abortSignal: abort.signal,
        })
      } catch (err) {
        await llmHandle.fail(err instanceof Error ? err.message : String(err))
        throw err
      }
      await llmHandle.end({
        output: resp.content,
        inputTokens: resp.usage?.inputTokens,
        outputTokens: resp.usage?.outputTokens,
        costUsd: resp.usage?.costUsd,
        model: resp.model ?? 'agentic-driver',
        finishReason: resp.finishReason,
      } as Partial<LlmSpan>)

      const toolCallRecords: JourneyTurn['toolCalls'] = []
      const toolCalls = resp.toolCalls ?? []

      // No tool calls and model said DONE — we're finished (subject to criteria).
      if (toolCalls.length === 0) {
        messages.push({ role: 'assistant', content: resp.content })
        if (/\bDONE\b/.test(resp.content)) {
          completed = true
          const passed = await evaluateCriteria(config.completionCriteria, ctx)
          turns.push({
            turnIndex: turn,
            assistantMessage: resp.content,
            toolCalls: [],
            criteriaPassed: passed.filter((p) => p.passed).length,
            criteriaTotal: passed.length,
          })
          break
        }
        // Model stalled without calling a tool — give it one soft reminder
        // then abort if it still won't act.
        messages.push({
          role: 'user',
          content:
            'You did not call a tool. Call a tool to progress, or respond "DONE" only if the goal is fully met.',
        })
        turns.push({
          turnIndex: turn,
          assistantMessage: resp.content,
          toolCalls: [],
          criteriaPassed: 0,
          criteriaTotal: config.completionCriteria.length,
        })
        continue
      }

      // Execute tool calls.
      messages.push({
        role: 'assistant',
        content: resp.content,
        toolCalls,
      })
      for (const call of toolCalls) {
        const tool = config.tools.find((t) => t.name === call.name)
        if (!tool) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
          })
          toolCallRecords.push({
            name: call.name,
            args: call.args,
            result: null,
            ok: false,
            error: 'unknown tool',
          })
          continue
        }
        const toolHandle = await emitter.tool({
          name: tool.name,
          toolName: tool.name,
          args: call.args,
        })
        let ok = false
        let result: unknown = null
        let error: string | undefined
        try {
          result = await tool.handler(call.args, ctx)
          ok = true
          await toolHandle.end({ result } as Partial<ToolSpan>)
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
          await toolHandle.fail(error)
        }
        toolCallRecords.push({ name: call.name, args: call.args, result, ok, error })
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(ok ? result : { error }),
        })
      }

      const evaluated = await evaluateCriteria(config.completionCriteria, ctx)
      const passedNow = evaluated.filter((p) => p.passed).length
      turns.push({
        turnIndex: turn,
        assistantMessage: resp.content,
        toolCalls: toolCallRecords,
        criteriaPassed: passedNow,
        criteriaTotal: evaluated.length,
      })
      if (passedNow === evaluated.length) {
        completed = true
        break
      }
    }

    if (!completed && !failureClass) {
      failureClass = turns.length >= maxTurns ? 'budget_exceeded' : 'unknown'
    }
  } finally {
    clearTimeout(wallTimer)
  }

  const criteriaResults = await evaluateCriteria(config.completionCriteria, ctx)
  const passedCount = criteriaResults.filter((r) => r.passed).length
  const score = criteriaResults.length > 0 ? passedCount / criteriaResults.length : 0

  await emitter.endRun({
    pass: completed && passedCount === criteriaResults.length,
    score,
    failureClass,
    notes: `${turns.length} turn(s), ${passedCount}/${criteriaResults.length} criteria`,
  })

  return {
    runId: emitter.runId,
    completed,
    turnCount: turns.length,
    turns,
    criteriaResults,
    score,
    failureClass,
    wallMs: Date.now() - wallStart,
    terminalState: ctx.state,
  }
}

async function evaluateCriteria(
  criteria: CompletionCriterion[],
  ctx: JourneyContext,
): Promise<Array<{ id: string; description: string; passed: boolean }>> {
  const out: Array<{ id: string; description: string; passed: boolean }> = []
  for (const c of criteria) {
    try {
      const passed = await c.check(ctx)
      out.push({ id: c.id, description: c.description, passed })
    } catch {
      out.push({ id: c.id, description: c.description, passed: false })
    }
  }
  return out
}

// Re-export types for consumer convenience.
export type { Run, Span } from './trace'
