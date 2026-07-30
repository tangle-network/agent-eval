import {
  type AxAgentActorTurnCallback,
  type AxAIService,
  type AxFunction,
  AxJSRuntime,
  agent,
} from '@ax-llm/ax'
import { TraceFileMissingError } from './store-otlp'

const TRACE_ANALYSIS_TOOL_INSTRUCTION = `Gather the evidence needed for the report with the trace tools.
When the evidence is sufficient, call final(task, evidence) and let the response stage produce the declared report and findings fields.`

const TRACE_ANALYSIS_CONTEXT_INSTRUCTION = `The complete bounded trace data is available as inputs.context.
Inspect it in the runtime, then call respond(task, evidence) and let the response stage produce the declared report and findings fields.`

const TRACE_ANALYSIS_RESPONDER_INSTRUCTION = `Use only evidence produced by the analysis stage.
Do not invent trace ids, span ids, steps, tool results, or final verification outcomes.`

export interface TraceAnalysisLoopResult<TFinding> {
  report: string
  findings: TFinding[]
  usage: {
    actor: readonly unknown[]
    responder: readonly unknown[]
  }
  chatLog: {
    actor: readonly unknown[]
    responder: readonly unknown[]
  }
  turnCount: number
}

export class TraceAnalysisTurnLimitError extends Error {
  readonly analystId: string
  readonly stage: 'distiller' | 'executor'
  readonly maxTurns: number

  constructor(analystId: string, stage: 'distiller' | 'executor', maxTurns: number) {
    super(
      `Trace analyst '${analystId}' reached maxTurns=${maxTurns} in the ${stage} stage without explicit completion`,
    )
    this.name = 'TraceAnalysisTurnLimitError'
    this.analystId = analystId
    this.stage = stage
    this.maxTurns = maxTurns
  }
}

interface TraceAnalysisLoopOptions {
  id: string
  description: string
  prompt: string
  question: string
  context?: string
  ai: AxAIService
  model?: string
  tools: readonly AxFunction[]
  maxSubqueries: number
  maxParallelSubqueries: number
  maxTurns: number
  maxRuntimeChars: number
  signal?: AbortSignal
  onTurn?: AxAgentActorTurnCallback
}

export function runTraceAnalysisLoop(
  options: TraceAnalysisLoopOptions & { findingType: 'string' },
): Promise<TraceAnalysisLoopResult<string>>
export function runTraceAnalysisLoop(
  options: TraceAnalysisLoopOptions & { findingType: 'object' },
): Promise<TraceAnalysisLoopResult<unknown>>
export async function runTraceAnalysisLoop(
  options: TraceAnalysisLoopOptions & { findingType: 'string' | 'object' },
): Promise<TraceAnalysisLoopResult<unknown>> {
  validateLoopLimits(options)

  let turnCount = 0
  const completedStages = new Set<'distiller' | 'executor'>()
  const onTurn: AxAgentActorTurnCallback = async (turn) => {
    if (turn.stage === 'executor') turnCount = Math.max(turnCount, turn.turn)
    if (isExplicitCompletionTurn(turn)) completedStages.add(turn.stage)
    await options.onTurn?.(turn)
    if (turn.turn >= options.maxTurns && !completedStages.has(turn.stage)) {
      throw new TraceAnalysisTurnLimitError(options.id, turn.stage, options.maxTurns)
    }
  }
  const hasPreparedContext = options.context !== undefined
  const config = {
    agentIdentity: { name: options.id, description: options.description },
    contextFields: hasPreparedContext ? (['context'] as const) : ([] as const),
    runtime: new AxJSRuntime({
      permissions: [],
      blockDynamicImport: true,
      allowedModules: [],
      freezeIntrinsics: true,
      blockShadowRealm: true,
      preventGlobalThisExtensions: false,
    }),
    maxSubAgentCalls: options.maxSubqueries,
    maxTurns: options.maxTurns,
    maxRuntimeChars: options.maxRuntimeChars,
    maxBatchedLlmQueryConcurrency: options.maxParallelSubqueries,
    promptLevel: 'detailed' as const,
    contextPolicy: { preset: 'full' as const, budget: 'balanced' as const },
    directResponse:
      hasPreparedContext && options.tools.length === 0 ? ('auto' as const) : ('off' as const),
    functions: options.tools,
    executorOptions: {
      description: `${options.prompt.trim()}\n\n${
        hasPreparedContext ? TRACE_ANALYSIS_CONTEXT_INSTRUCTION : TRACE_ANALYSIS_TOOL_INSTRUCTION
      }`,
      ...(options.model ? { model: options.model } : {}),
      showThoughts: false,
      thinkingTokenBudget: 'none' as const,
    },
    responderOptions: {
      description: `${TRACE_ANALYSIS_RESPONDER_INSTRUCTION}\n\n${options.prompt.trim()}`,
      ...(options.model ? { model: options.model } : {}),
      showThoughts: false,
      thinkingTokenBudget: 'none' as const,
    },
    actorTurnCallback: onTurn,
    bubbleErrors: [TraceFileMissingError],
  }
  const analyst = hasPreparedContext
    ? options.findingType === 'string'
      ? agent('context:string, question:string -> report:string, findings:string[]', config)
      : agent('context:string, question:string -> report:string, findings:json[]', config)
    : options.findingType === 'string'
      ? agent('question:string -> report:string, findings:string[]', config)
      : agent('question:string -> report:string, findings:json[]', config)

  const output = hasPreparedContext
    ? await analyst.forward(
        options.ai,
        { context: options.context!, question: options.question } as never,
        options.signal ? { abortSignal: options.signal } : undefined,
      )
    : await analyst.forward(
        options.ai,
        { question: options.question },
        options.signal ? { abortSignal: options.signal } : undefined,
      )
  assertStageDidNotExhaust(
    options.id,
    'distiller',
    options.maxTurns,
    analyst.distiller?.getState()?.actionLogEntries,
  )
  assertStageDidNotExhaust(
    options.id,
    'executor',
    options.maxTurns,
    analyst.executor?.getState()?.actionLogEntries,
  )
  const completed =
    options.findingType === 'string'
      ? readTraceAnalysisOutput(output, 'string')
      : readTraceAnalysisOutput(output, 'object')
  const usage = analyst.getUsage()
  const chatLog = splitChatLog(analyst.getChatLog())

  return {
    ...completed,
    usage: {
      actor: usage.actor,
      responder: usage.responder,
    },
    chatLog,
    turnCount,
  }
}

function isExplicitCompletionTurn(turn: Parameters<AxAgentActorTurnCallback>[0]): boolean {
  return !turn.isError && isExplicitCompletionCode(turn.code)
}

function isExplicitCompletionCode(code: string): boolean {
  const executable = trimLeadingComments(code)
  return /^(?:await\s+)?(?:final|respond|askClarification)\s*\(/.test(executable)
}

function assertStageDidNotExhaust(
  analystId: string,
  stage: 'distiller' | 'executor',
  maxTurns: number,
  entries:
    | readonly {
        code: string
        tags: readonly string[]
      }[]
    | undefined,
): void {
  if (!entries || entries.length < maxTurns) return
  const last = entries.at(-1)
  if (last && !last.tags.includes('error') && isExplicitCompletionCode(last.code)) return
  throw new TraceAnalysisTurnLimitError(analystId, stage, maxTurns)
}

function trimLeadingComments(code: string): string {
  let remaining = code.trimStart()
  while (remaining.startsWith('//') || remaining.startsWith('/*')) {
    if (remaining.startsWith('//')) {
      const lineEnd = remaining.indexOf('\n')
      if (lineEnd === -1) return ''
      remaining = remaining.slice(lineEnd + 1).trimStart()
      continue
    }
    const commentEnd = remaining.indexOf('*/', 2)
    if (commentEnd === -1) return ''
    remaining = remaining.slice(commentEnd + 2).trimStart()
  }
  return remaining
}

function splitChatLog(entries: readonly unknown[]): {
  actor: readonly unknown[]
  responder: readonly unknown[]
} {
  const actor: unknown[] = []
  const responder: unknown[] = []
  for (const entry of entries) {
    const name =
      entry && typeof entry === 'object' && 'name' in entry
        ? (entry as { name?: unknown }).name
        : undefined
    if (typeof name === 'string' && (name === 'responder' || name.endsWith('.responder'))) {
      responder.push(entry)
    } else {
      actor.push(entry)
    }
  }
  return { actor, responder }
}

interface CompletedTraceAnalysis<TFinding> {
  report: string
  findings: TFinding[]
}

export function readTraceAnalysisOutput(
  value: unknown,
  findingType: 'string',
): CompletedTraceAnalysis<string>
export function readTraceAnalysisOutput(
  value: unknown,
  findingType: 'object',
): CompletedTraceAnalysis<unknown>
export function readTraceAnalysisOutput(
  value: unknown,
  findingType: 'string' | 'object',
): CompletedTraceAnalysis<unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('Trace analyst response must contain report and findings')
  }
  const { report, findings } = value as { report?: unknown; findings?: unknown }
  if (typeof report !== 'string' || !Array.isArray(findings)) {
    throw new Error('Trace analyst response must contain report and findings')
  }
  if (findingType === 'string') {
    if (findings.some((finding) => typeof finding !== 'string')) {
      throw new Error('Trace analyst response must contain string findings')
    }
    return { report, findings: findings as string[] }
  }
  return { report, findings }
}

function validateLoopLimits(options: TraceAnalysisLoopOptions): void {
  if (!Number.isSafeInteger(options.maxSubqueries) || options.maxSubqueries < 0) {
    throw new TypeError('maxSubqueries must be a non-negative integer')
  }
  if (!Number.isSafeInteger(options.maxParallelSubqueries) || options.maxParallelSubqueries < 1) {
    throw new TypeError('maxParallelSubqueries must be a positive integer')
  }
}
