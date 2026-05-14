/**
 * Observability adapters — bidirectional parity with production backends.
 *
 * `LangfuseAdapter` maps a Run's spans into Langfuse generation/score
 * records (schema-compatible; we don't depend on the SDK — consumers
 * POST the returned JSON to their Langfuse collector).
 *
 * `PrometheusEmitter` converts a TraceStore into a Prometheus text-
 * exposition-format string (counters + gauges for runs, tool calls,
 * errors, cost). Drop into a `/metrics` handler; no SDK needed.
 *
 * `replayTraceThroughJudge` is the canonical "re-score with a new
 * judge" path — takes an existing run, runs a judge function over
 * each LLM span, emits JudgeVerdict spans back into the store.
 */

import { NotFoundError } from './errors'
import { TraceEmitter } from './trace/emitter'
import { aggregateLlm, llmSpans } from './trace/query'
import type { LlmSpan, Span } from './trace/schema'
import type { TraceStore } from './trace/store'

// ── Langfuse adapter ─────────────────────────────────────────────────

export interface LangfuseGeneration {
  id: string
  traceId: string
  name: string
  model: string
  input: unknown
  output: unknown
  startTime: string
  endTime: string
  usage: { input: number; output: number; total: number; totalCost: number }
  metadata: Record<string, unknown>
}

export interface LangfuseScore {
  id: string
  traceId: string
  observationId: string
  name: string
  value: number
  comment?: string
}

export interface LangfuseEnvelope {
  traceId: string
  generations: LangfuseGeneration[]
  scores: LangfuseScore[]
}

export async function toLangfuseEnvelope(
  store: TraceStore,
  runId: string,
): Promise<LangfuseEnvelope> {
  const run = await store.getRun(runId)
  if (!run) throw new NotFoundError(`run ${runId} not found`)
  const llm = await llmSpans(store, runId)
  const allSpans = await store.spans({ runId })
  const judges = allSpans.filter((s): s is Extract<Span, { kind: 'judge' }> => s.kind === 'judge')

  const generations: LangfuseGeneration[] = llm.map((s) => ({
    id: s.spanId,
    traceId: run.runId,
    name: s.name,
    model: s.model,
    input: s.messages,
    output: s.output,
    startTime: new Date(s.startedAt).toISOString(),
    endTime: new Date(s.endedAt ?? s.startedAt).toISOString(),
    usage: {
      input: s.inputTokens ?? 0,
      output: s.outputTokens ?? 0,
      total: (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
      totalCost: s.costUsd ?? 0,
    },
    metadata: { finishReason: s.finishReason, cachedTokens: s.cachedTokens },
  }))

  const scores: LangfuseScore[] = judges.map((j) => ({
    id: j.spanId,
    traceId: run.runId,
    observationId: j.targetSpanId,
    name: `${j.judgeId}/${j.dimension}`,
    value: j.score,
    comment: j.rationale,
  }))

  return { traceId: run.runId, generations, scores }
}

// ── Prometheus emitter ───────────────────────────────────────────────

export async function toPrometheusText(store: TraceStore): Promise<string> {
  const runs = await store.listRuns()
  const toolCalls: Record<string, number> = {}
  const toolErrors: Record<string, number> = {}
  let totalLlmInputTokens = 0
  let totalLlmOutputTokens = 0
  let totalCostUsd = 0
  let passedRuns = 0
  let failedRuns = 0
  for (const r of runs) {
    if (r.outcome?.pass === true) passedRuns++
    else if (r.outcome?.pass === false) failedRuns++
    const llm = await llmSpans(store, r.runId)
    const agg = aggregateLlm(llm)
    totalLlmInputTokens += agg.inputTokens
    totalLlmOutputTokens += agg.outputTokens
    totalCostUsd += agg.costUsd
    const tools = await store.spans({ runId: r.runId, kind: 'tool' })
    for (const t of tools) {
      if (t.kind !== 'tool') continue
      toolCalls[t.toolName] = (toolCalls[t.toolName] ?? 0) + 1
      if (t.status === 'error') toolErrors[t.toolName] = (toolErrors[t.toolName] ?? 0) + 1
    }
  }

  const lines: string[] = []
  lines.push('# HELP agent_eval_runs_total Total runs in the trace corpus')
  lines.push('# TYPE agent_eval_runs_total counter')
  lines.push(`agent_eval_runs_total ${runs.length}`)
  lines.push('# HELP agent_eval_runs_passed_total Runs that completed with pass=true')
  lines.push('# TYPE agent_eval_runs_passed_total counter')
  lines.push(`agent_eval_runs_passed_total ${passedRuns}`)
  lines.push('# HELP agent_eval_runs_failed_total Runs that completed with pass=false')
  lines.push('# TYPE agent_eval_runs_failed_total counter')
  lines.push(`agent_eval_runs_failed_total ${failedRuns}`)
  lines.push('# HELP agent_eval_llm_input_tokens_total Aggregate LLM input tokens')
  lines.push('# TYPE agent_eval_llm_input_tokens_total counter')
  lines.push(`agent_eval_llm_input_tokens_total ${totalLlmInputTokens}`)
  lines.push('# HELP agent_eval_llm_output_tokens_total Aggregate LLM output tokens')
  lines.push('# TYPE agent_eval_llm_output_tokens_total counter')
  lines.push(`agent_eval_llm_output_tokens_total ${totalLlmOutputTokens}`)
  lines.push('# HELP agent_eval_cost_usd_total Aggregate LLM cost in USD')
  lines.push('# TYPE agent_eval_cost_usd_total counter')
  lines.push(`agent_eval_cost_usd_total ${totalCostUsd}`)
  lines.push('# HELP agent_eval_tool_calls_total Tool calls by tool name')
  lines.push('# TYPE agent_eval_tool_calls_total counter')
  for (const [name, n] of Object.entries(toolCalls)) {
    lines.push(`agent_eval_tool_calls_total{tool="${escapeLabel(name)}"} ${n}`)
  }
  lines.push('# HELP agent_eval_tool_errors_total Tool errors by tool name')
  lines.push('# TYPE agent_eval_tool_errors_total counter')
  for (const [name, n] of Object.entries(toolErrors)) {
    lines.push(`agent_eval_tool_errors_total{tool="${escapeLabel(name)}"} ${n}`)
  }
  return `${lines.join('\n')}\n`
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// ── Retroactive re-scoring via judge replay ──────────────────────────

export interface JudgeReplayResult {
  spanId: string
  targetSpanId: string
  dimension: string
  score: number
  rationale?: string
}

/**
 * Apply a judge function to every LLM span in a run and record the
 * results as JudgeVerdict spans. This is the canonical "no re-execution"
 * re-scoring path — you supply a pure judge `(llmSpan) → verdict`.
 */
export async function replayTraceThroughJudge(
  store: TraceStore,
  runId: string,
  judge: {
    id: string
    dimension: string
    score: (span: LlmSpan) => Promise<{ score: number; rationale?: string; evidence?: string }>
  },
): Promise<JudgeReplayResult[]> {
  const run = await store.getRun(runId)
  if (!run) throw new NotFoundError(`run ${runId} not found`)
  const llms = await llmSpans(store, runId)
  const emitter = new TraceEmitter(store, { runId })
  const results: JudgeReplayResult[] = []
  for (const span of llms) {
    const { score, rationale, evidence } = await judge.score(span)
    const verdict = await emitter.recordJudge({
      judgeId: judge.id,
      targetSpanId: span.spanId,
      dimension: judge.dimension,
      score,
      rationale,
      evidence,
      name: `${judge.id}/${judge.dimension}`,
    })
    results.push({
      spanId: verdict.spanId,
      targetSpanId: span.spanId,
      dimension: judge.dimension,
      score,
      rationale,
    })
  }
  return results
}
