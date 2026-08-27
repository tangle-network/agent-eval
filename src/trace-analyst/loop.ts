import {
  type AxAgentActorTurnCallback,
  type AxAIService,
  type AxFunction,
  AxJSRuntime,
  agent,
} from '@ax-llm/ax'
import { TraceFileMissingError } from './store-otlp'

export const TRACE_ANALYSIS_FINAL_TASK = 'Submit the completed trace analysis.'

const TRACE_ANALYSIS_COMPLETION_INSTRUCTION = `This host consumes your executor result directly; there is no downstream responder for this run. Ignore generic executor guidance that says a responder will format the answer. You must produce the final report and findings yourself.

Return exactly one executable JavaScript program per turn. Never emit multiple JavaScript or code fences; put every tool call and the final call in that one program.

When the analysis is complete, call \`await final(${JSON.stringify(TRACE_ANALYSIS_FINAL_TASK)}, { report, findings })\` exactly once. Do not return a one-argument string from \`final(...)\`.`

export class TraceAnalysisTurnLimitError extends Error {
  readonly analystId: string
  readonly maxTurns: number

  constructor(analystId: string, maxTurns: number, cause: unknown) {
    super(
      `Trace analyst '${analystId}' reached maxTurns=${maxTurns} without a structured final result`,
      { cause },
    )
    this.name = 'TraceAnalysisTurnLimitError'
    this.analystId = analystId
    this.maxTurns = maxTurns
  }
}

export interface TraceAnalysisLoopResult<TFinding> {
  report: string
  findings: TFinding[]
  usage: readonly unknown[]
  chatLog: readonly unknown[]
  turnCount: number
}

interface TraceAnalysisLoopOptions {
  id: string
  description: string
  prompt: string
  question: string
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
): Promise<TraceAnalysisLoopResult<Record<string, unknown>>>
export async function runTraceAnalysisLoop(
  options: TraceAnalysisLoopOptions & { findingType: 'string' | 'object' },
): Promise<TraceAnalysisLoopResult<string | Record<string, unknown>>> {
  validateLoopLimits(options)

  const config = {
    agentIdentity: { name: options.id, description: options.description },
    contextFields: [] as const,
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
    functions: options.tools,
    executorOptions: {
      description: `${options.prompt.trim()}\n\n${TRACE_ANALYSIS_COMPLETION_INSTRUCTION}`,
      ...(options.model ? { model: options.model } : {}),
      showThoughts: false,
      thinkingTokenBudget: 'none' as const,
    },
    ...(options.onTurn ? { actorTurnCallback: options.onTurn } : {}),
    bubbleErrors: [TraceFileMissingError],
  }
  const analyst =
    options.findingType === 'string'
      ? agent('question:string -> report:string, findings:string[]', config)
      : agent('question:string -> report:string, findings:json[]', config)

  const state = await analyst.executor.run(
    options.ai,
    { question: options.question },
    options.signal ? { abortSignal: options.signal } : undefined,
  )

  let completed: CompletedTraceAnalysis<string | Record<string, unknown>>
  try {
    completed =
      options.findingType === 'string'
        ? readTraceAnalysisCompletion(state.executorResult, 'string')
        : readTraceAnalysisCompletion(state.executorResult, 'object')
  } catch (error) {
    if (state.turnCount >= options.maxTurns) {
      throw new TraceAnalysisTurnLimitError(options.id, options.maxTurns, error)
    }
    throw new Error(`Trace analyst '${options.id}' stopped without a structured final result`, {
      cause: error,
    })
  }

  return {
    ...completed,
    usage: analyst.executor.getUsage(),
    chatLog: analyst.executor.getChatLog(),
    turnCount: state.turnCount,
  }
}

interface CompletedTraceAnalysis<TFinding> {
  report: string
  findings: TFinding[]
}

export function readTraceAnalysisCompletion(
  value: unknown,
  findingType: 'string',
): CompletedTraceAnalysis<string>
export function readTraceAnalysisCompletion(
  value: unknown,
  findingType: 'object',
): CompletedTraceAnalysis<Record<string, unknown>>
export function readTraceAnalysisCompletion(
  value: unknown,
  findingType: 'string' | 'object',
): CompletedTraceAnalysis<string | Record<string, unknown>> {
  if (!value || typeof value !== 'object') {
    throw new Error('Trace analyst did not return a structured final result')
  }
  const completion = value as { type?: unknown; args?: unknown }
  if (
    completion.type !== 'final' ||
    !Array.isArray(completion.args) ||
    completion.args.length !== 2 ||
    completion.args[0] !== TRACE_ANALYSIS_FINAL_TASK
  ) {
    throw new Error('Trace analyst did not return a structured final result')
  }

  const payload = completion.args[1]
  if (!payload || typeof payload !== 'object') {
    throw new Error('Trace analyst final result must contain report and findings')
  }
  const { report, findings } = payload as { report?: unknown; findings?: unknown }
  if (typeof report !== 'string' || !Array.isArray(findings)) {
    throw new Error('Trace analyst final result must contain report and findings')
  }
  if (findingType === 'string') {
    if (findings.some((finding) => typeof finding !== 'string')) {
      throw new Error('Trace analyst final result must contain string findings')
    }
    return { report, findings: findings as string[] }
  }
  if (
    findings.some((finding) => !finding || typeof finding !== 'object' || Array.isArray(finding))
  ) {
    throw new Error('Trace analyst final result must contain object findings')
  }
  return { report, findings: findings as Record<string, unknown>[] }
}

function validateLoopLimits(options: TraceAnalysisLoopOptions): void {
  if (!Number.isSafeInteger(options.maxSubqueries) || options.maxSubqueries < 0) {
    throw new TypeError('maxSubqueries must be a non-negative integer')
  }
  if (!Number.isSafeInteger(options.maxParallelSubqueries) || options.maxParallelSubqueries < 1) {
    throw new TypeError('maxParallelSubqueries must be a positive integer')
  }
}
