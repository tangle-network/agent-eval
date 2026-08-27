import type { AxAgentActorTurnCallbackArgs, AxAIService, AxFunction } from '@ax-llm/ax'
import { runTraceAnalysisLoop, type TraceAnalysisLoopResult } from './loop'
import { TRACE_ANALYST_ACTOR_DESCRIPTION, TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION } from './prompts'
import type { TraceAnalysisStore } from './store'
import { OtlpFileTraceStore } from './store-otlp'
import { buildTraceAnalystTools } from './tools'

export interface AnalyzeTracesInput {
  /** The user-facing question. Domain framing belongs here, not in the
   *  actor description. */
  question: string
}

export interface AnalyzeTracesResult {
  /** The actor's submitted prose answer. */
  answer: string
  /** Bulleted findings from the actor's structured completion. */
  findings: string[]
  /** Per-turn snapshots captured via `actorTurnCallback`. */
  turns: AnalyzeTracesTurnSnapshot[]
  /** Total turns the actor took. */
  turnCount: number
  /** Token usage by role. */
  usage: TraceAnalystUsage
  /** Full system + assistant + tool message log by role. */
  chatLog: TraceAnalystChatLog
  /** Prompt version that produced this run. */
  actorPromptVersion: string
}

export interface TraceAnalystUsage {
  actor: TraceAnalystUsageEntry[]
  responder: TraceAnalystUsageEntry[]
}

export interface TraceAnalystUsageEntry {
  [key: string]: unknown
}

export interface TraceAnalystChatLog {
  actor: TraceAnalystChatMessage[]
  responder: TraceAnalystChatMessage[]
}

export interface TraceAnalystChatMessage {
  [key: string]: unknown
}

export interface AnalyzeTracesTurnSnapshot {
  stage: AxAgentActorTurnCallbackArgs['stage']
  turn: number
  isError: boolean
  /** The JS code the actor produced for this turn. */
  code: string
  /** The formatted action-log entry the actor sees on the next turn. */
  output: string
  /** Provider thought (when `executorOptions.showThoughts` is true and the
   *  provider returns it). */
  thought?: string
}

export interface AnalyzeTracesOptions {
  /** Trace data source. Pass either an OTLP-JSONL path or a custom store. */
  source: string | TraceAnalysisStore
  /** Caller-provided AxAIService. */
  ai: AxAIService
  /** Model id forwarded to the actor. */
  model?: string
  /** Maximum model subqueries. 0 disables model fan-out. Default 4. */
  maxSubqueries?: number
  /** Maximum actor turns. Default 12. */
  maxTurns?: number
  /** Maximum parallel model subqueries. Default 2. */
  maxParallelSubqueries?: number
  /** Cancels in-flight model and tool work. */
  signal?: AbortSignal
  /** Override the actor description. */
  actorDescription?: string
  /** Per-turn observability hook. */
  onTurn?: (turn: AnalyzeTracesTurnSnapshot) => void | Promise<void>
  /** Override max runtime characters per turn. Default 6000. */
  maxRuntimeChars?: number
  /** When set, every turn's snapshot is appended to this JSONL file
   *  immediately. If the analyst crashes mid-loop (provider 503,
   *  network error, validator reject) the partial reasoning is still
   *  on disk for diagnosis and recovery. */
  progressLogPath?: string
}

/**
 * Run the trace analyst.
 *
 * Throws:
 *   - `TraceFileMissingError` if `source` is a path and doesn't exist.
 *   - `AxAgentClarificationError` if the analyst asks for clarification.
 *   - Provider errors (auth, rate limits) propagate from the AI service.
 */
export async function analyzeTraces(
  input: AnalyzeTracesInput,
  options: AnalyzeTracesOptions,
): Promise<AnalyzeTracesResult> {
  if (!input.question || typeof input.question !== 'string') {
    throw new TypeError('analyzeTraces: input.question must be a non-empty string')
  }
  rejectRemovedOptions(options)

  const store: TraceAnalysisStore =
    typeof options.source === 'string'
      ? new OtlpFileTraceStore({ path: options.source })
      : options.source

  // Pre-warm file stores so missing inputs fail before the RLM starts.
  if (store instanceof OtlpFileTraceStore) {
    await store.ensureIndexed()
  }

  const tools: AxFunction[] = buildTraceAnalystTools({ store })
  const turns: AnalyzeTracesTurnSnapshot[] = []

  // Persist each turn as JSONL so interrupted analyst runs keep useful evidence.
  let progressFs: import('node:fs').WriteStream | undefined
  if (options.progressLogPath) {
    const { createWriteStream } = await import('node:fs')
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(options.progressLogPath), { recursive: true })
    progressFs = createWriteStream(options.progressLogPath, { flags: 'a' })
  }

  const actorTurnCallback = async (turn: AxAgentActorTurnCallbackArgs): Promise<void> => {
    const snap: AnalyzeTracesTurnSnapshot = {
      stage: turn.stage,
      turn: turn.turn,
      isError: turn.isError,
      code: turn.code,
      output: turn.output,
      thought: turn.thought,
    }
    turns.push(snap)
    if (progressFs) {
      try {
        progressFs.write(`${JSON.stringify({ ...snap, ts: Date.now() })}\n`)
      } catch {
        // Progress logging must never fail the analyst.
      }
    }
    if (options.onTurn) await options.onTurn(snap)
  }

  const maxSubqueries = options.maxSubqueries ?? 4
  const maxTurns = options.maxTurns ?? 12
  const maxParallelSubqueries = options.maxParallelSubqueries ?? 2
  const maxRuntimeChars = options.maxRuntimeChars ?? 6000
  let completed: TraceAnalysisLoopResult<string>
  try {
    completed = await runTraceAnalysisLoop({
      id: 'TraceAnalyst',
      description:
        'Analyzes OTLP-shaped JSONL traces using bounded discovery tools to identify systemic failure modes.',
      prompt: `${options.actorDescription ?? TRACE_ANALYST_ACTOR_DESCRIPTION}

The report must answer the user's question, and findings must be an array of concise evidence-backed strings.`,
      question: input.question,
      ai: options.ai,
      ...(options.model ? { model: options.model } : {}),
      tools,
      findingType: 'string',
      maxSubqueries,
      maxParallelSubqueries,
      maxTurns,
      maxRuntimeChars,
      ...(options.signal ? { signal: options.signal } : {}),
      onTurn: actorTurnCallback,
    })
  } finally {
    if (progressFs) {
      await new Promise<void>((resolve) => progressFs!.end(() => resolve()))
    }
  }

  return {
    answer: completed.report,
    findings: completed.findings,
    turns,
    turnCount: turns.length,
    usage: { actor: normalizeRecordArray(completed.usage), responder: [] },
    chatLog: { actor: normalizeRecordArray(completed.chatLog), responder: [] },
    actorPromptVersion: TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION,
  }
}

function rejectRemovedOptions(options: AnalyzeTracesOptions): void {
  const supplied = options as unknown as Record<string, unknown>
  const migrations = [
    ['maxDepth', 'maxSubqueries'],
    ['maxParallelSubagents', 'maxParallelSubqueries'],
    ['subagentDescription', 'actorDescription'],
  ] as const
  for (const [removed, replacement] of migrations) {
    if (removed in supplied) {
      throw new TypeError(`analyzeTraces: '${removed}' is unsupported; use '${replacement}'`)
    }
  }
}

function normalizeRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    item && typeof item === 'object' ? { ...(item as Record<string, unknown>) } : { value: item },
  )
}
