import { type AxActorTurn, type AxAIService, type AxFunction, AxJSRuntime, agent } from '@ax-llm/ax'
import {
  TRACE_ANALYST_ACTOR_DESCRIPTION,
  TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION,
  TRACE_ANALYST_SUBAGENT_DESCRIPTION,
} from './prompts'
import type { TraceAnalysisStore } from './store'
import { OtlpFileTraceStore, TraceFileMissingError } from './store-otlp'
import { buildTraceAnalystTools } from './tools'

export interface AnalyzeTracesInput {
  /** The user-facing question. Domain framing belongs here, not in the
   *  actor description. */
  question: string
}

export interface AnalyzeTracesResult {
  /** The responder's prose answer. */
  answer: string
  /** Bulleted findings extracted from the responder's structured output. */
  findings: string[]
  /** Per-actor-turn snapshots captured via `actorTurnCallback`. */
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
  turn: number
  isError: boolean
  /** The JS code the actor produced for this turn. */
  code: string
  /** The formatted action-log entry the actor sees on the next turn. */
  output: string
  /** Provider thought (when `actorOptions.showThoughts` is true and the
   *  provider returns it). */
  thought?: string
}

export interface AnalyzeTracesOptions {
  /** Trace data source. Pass either an OTLP-JSONL path or a custom store. */
  source: string | TraceAnalysisStore
  /** Caller-provided AxAIService. */
  ai: AxAIService
  /** Model id forwarded to actor + responder. */
  model?: string
  /** Recursion depth. 0 = no sub-agent dispatch. Default 1. */
  maxDepth?: number
  /** Maximum actor turns. Default 12. */
  maxTurns?: number
  /** Maximum parallel sub-agent calls in batched llmQuery. Default 2. */
  maxParallelSubagents?: number
  /** Override the actor description. */
  actorDescription?: string
  /** Override the subagent description. */
  subagentDescription?: string
  /** Per-turn observability hook. */
  onTurn?: (turn: AnalyzeTracesTurnSnapshot) => void | Promise<void>
  /** Override max runtime characters per turn. Default 6000. */
  maxRuntimeChars?: number
  /** When set, every turn's snapshot is appended to this JSONL file
   *  immediately. If the analyst crashes mid-loop (provider 503,
   *  network error, validator reject) the partial reasoning is still
   *  on disk. Replay the file with the responder afterward to recover
   *  evidence. */
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

  const actorTurnCallback = async (turn: AxActorTurn): Promise<void> => {
    const snap: AnalyzeTracesTurnSnapshot = {
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

  const maxDepth = options.maxDepth ?? 1
  const maxTurns = options.maxTurns ?? 12
  const maxParallelSubagents = options.maxParallelSubagents ?? 2
  const maxRuntimeChars = options.maxRuntimeChars ?? 6000
  const functions = tools as unknown as NonNullable<Parameters<typeof agent>[1]>['functions']

  const analyst = agent<{ question: string }, { answer: string; findings: string[] }>(
    // `reasoning!` is an internal (Ax `!`) scratchpad field: generated first to
    // force reason-before-conclude, stripped from the returned output — so the
    // consumed shape stays { answer, findings }. Brings the trace-analyst to the
    // same prose-first CoT ordering the kind-factory gets from its `report` field.
    'question:string -> reasoning!:string, answer:string, findings:string[]',
    {
      agentIdentity: {
        name: 'TraceAnalyst',
        description:
          'Analyzes OTLP-shaped JSONL traces using bounded discovery tools to identify systemic failure modes.',
      },
      contextFields: ['question'],
      runtime: new AxJSRuntime({
        permissions: [],
        blockDynamicImport: true,
        allowedModules: [],
        freezeIntrinsics: true,
        blockShadowRealm: true,
        // RLM stdout mode relies on runtime bindings persisting across turns.
        preventGlobalThisExtensions: false,
      }),
      mode: maxDepth > 0 ? 'advanced' : 'simple',
      recursionOptions: maxDepth > 0 ? { maxDepth } : undefined,
      maxTurns,
      maxRuntimeChars,
      maxBatchedLlmQueryConcurrency: maxParallelSubagents,
      promptLevel: 'detailed',
      // Trace analysis depends on exact prior tool results and runtime variables.
      contextPolicy: { preset: 'full', budget: 'balanced' },
      functions,
      actorOptions: {
        description: options.actorDescription ?? TRACE_ANALYST_ACTOR_DESCRIPTION,
        ...(options.model ? { model: options.model } : {}),
        // Keep actor messages tool-call/content shaped across reasoning models.
        showThoughts: false,
        thinkingTokenBudget: 'none',
      },
      responderOptions: {
        ...(options.model ? { model: options.model } : {}),
        description: options.subagentDescription ?? TRACE_ANALYST_SUBAGENT_DESCRIPTION,
        showThoughts: false,
      },
      actorTurnCallback,
      bubbleErrors: [TraceFileMissingError],
    },
  )

  let result: { answer: unknown; findings: unknown }
  try {
    result = await analyst.forward(options.ai, { question: input.question })
  } finally {
    if (progressFs) {
      await new Promise<void>((resolve) => progressFs!.end(() => resolve()))
    }
  }

  return {
    answer: typeof result.answer === 'string' ? result.answer : String(result.answer ?? ''),
    findings: Array.isArray(result.findings)
      ? result.findings.filter((s): s is string => typeof s === 'string')
      : [],
    turns,
    turnCount: turns.length,
    usage: normalizeRoleArrays(analyst.getUsage()),
    chatLog: normalizeRoleArrays(analyst.getChatLog()),
    actorPromptVersion: TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION,
  }
}

function normalizeRoleArrays(value: unknown): {
  actor: Record<string, unknown>[]
  responder: Record<string, unknown>[]
} {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    actor: normalizeRecordArray(record.actor),
    responder: normalizeRecordArray(record.responder),
  }
}

function normalizeRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.map((item) =>
    item && typeof item === 'object' ? { ...(item as Record<string, unknown>) } : { value: item },
  )
}
