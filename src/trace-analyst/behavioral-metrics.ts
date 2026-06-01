/**
 * Deterministic behavioral metrics over OTLP spans — pure arithmetic, no LLM.
 *
 * These are the model-independent multiplier: the four trace-quality signals a
 * tolerant analyzer (e.g. HALO) re-derives per run inside the model — token
 * growth, output decay, tool monoculture, missing self-verification — computed
 * here once, in TypeScript, with zero model judgment. A finding that falls out
 * of arithmetic is trivially model-agnostic and cannot hallucinate the trend.
 *
 * General, not trace-specific: the detectors key off token trajectories and
 * tool usage present in any agentic OTLP trace, not any one benchmark.
 */

import type { TraceAnalystSpan } from './types'

export type SuboptimalCode =
  | 'monotonic-input-growth'
  | 'output-length-decay'
  | 'single-tool-dependency'
  | 'no-self-verification'

export interface SuboptimalSignal {
  code: SuboptimalCode
  severity: 'high' | 'medium' | 'low'
  /** Human-readable claim, with the backing numbers inlined. */
  detail: string
  /** The exact figures the detector fired on — auditable, no model in the loop. */
  evidence: Record<string, number | string | boolean>
}

export interface BehavioralMetrics {
  llmCallCount: number
  inputTokenTrajectory: number[]
  outputTokenTrajectory: number[]
  toolHistogram: Record<string, number>
  totalToolCalls: number
  distinctTools: number
  /** distinct/total tool calls; 1.0 when there are no tool calls. */
  toolDiversityRatio: number
  hasSelfVerification: boolean
  signals: SuboptimalSignal[]
}

/** ≥ this input-token growth ratio across a run, with no compression, fires. */
const INPUT_GROWTH_FACTOR = 3
/** Tool-usage signals need at least this many calls to be meaningful. */
const MIN_TOOL_CALLS = 3
/** Tool names matching this are self-verification, not state mutation. */
const VERIFY_RE = /verif|eval|inspect|check|assert|validat|review|confirm/i

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function inputTokensOf(s: TraceAnalystSpan): number | null {
  return num(s.attributes['llm.input_tokens']) ?? num(s.attributes['llm.usage.input_tokens'])
}
function outputTokensOf(s: TraceAnalystSpan): number | null {
  return num(s.attributes['llm.output_tokens']) ?? num(s.attributes['llm.usage.output_tokens'])
}
function stepOf(s: TraceAnalystSpan): number | null {
  return num(s.attributes.step)
}
function toolNameOf(s: TraceAnalystSpan): string | null {
  if (s.tool_name) return s.tool_name
  const t = s.attributes['tool.name']
  return typeof t === 'string' && t.length > 0 ? t : null
}

/**
 * Reduce a span list to behavioral metrics + fired suboptimality signals.
 * Pure + deterministic: same spans → same output, on any machine, no model.
 */
export function computeTraceMetrics(spans: readonly TraceAnalystSpan[]): BehavioralMetrics {
  // Order by step (when present) then start_time so trajectories reflect run order.
  const ordered = [...spans].sort((a, b) => {
    const sa = stepOf(a)
    const sb = stepOf(b)
    if (sa !== null && sb !== null && sa !== sb) return sa - sb
    return a.start_time.localeCompare(b.start_time)
  })

  const inputTokenTrajectory: number[] = []
  const outputTokenTrajectory: number[] = []
  const toolHistogram: Record<string, number> = {}
  let hasSelfVerification = false

  for (const s of ordered) {
    const inT = inputTokensOf(s)
    if (inT !== null) inputTokenTrajectory.push(inT)
    const outT = outputTokensOf(s)
    if (outT !== null) outputTokenTrajectory.push(outT)
    const tool = toolNameOf(s)
    if (tool) {
      toolHistogram[tool] = (toolHistogram[tool] ?? 0) + 1
      if (VERIFY_RE.test(tool)) hasSelfVerification = true
    }
  }

  const totalToolCalls = Object.values(toolHistogram).reduce((a, b) => a + b, 0)
  const distinctTools = Object.keys(toolHistogram).length
  const toolDiversityRatio = totalToolCalls === 0 ? 1 : distinctTools / totalToolCalls

  const signals: SuboptimalSignal[] = []

  if (inputTokenTrajectory.length >= 3) {
    const first = inputTokenTrajectory[0]!
    const last = inputTokenTrajectory[inputTokenTrajectory.length - 1]!
    const growth = first > 0 ? last / first : 0
    if (last > first && growth >= INPUT_GROWTH_FACTOR) {
      signals.push({
        code: 'monotonic-input-growth',
        severity: 'high',
        detail: `LLM input tokens grew ${growth.toFixed(1)}x (${first}→${last}) across ${inputTokenTrajectory.length} calls — full history re-sent each step with no compression.`,
        evidence: {
          first,
          last,
          growth_x: Number(growth.toFixed(2)),
          calls: inputTokenTrajectory.length,
        },
      })
    }
  }

  if (outputTokenTrajectory.length >= 3) {
    const first = outputTokenTrajectory[0]!
    const last = outputTokenTrajectory[outputTokenTrajectory.length - 1]!
    if (last < first) {
      signals.push({
        code: 'output-length-decay',
        severity: 'medium',
        detail: `LLM output tokens shrank ${first}→${last} over ${outputTokenTrajectory.length} calls — less planning/reasoning per step as context grows.`,
        evidence: { first, last, calls: outputTokenTrajectory.length },
      })
    }
  }

  if (totalToolCalls >= MIN_TOOL_CALLS && distinctTools === 1) {
    const only = Object.keys(toolHistogram)[0]!
    signals.push({
      code: 'single-tool-dependency',
      severity: 'medium',
      detail: `All ${totalToolCalls} tool calls are \`${only}\` — no tool diversity and no fallback path.`,
      evidence: { tool: only, calls: totalToolCalls, distinct_tools: 1 },
    })
  }

  if (totalToolCalls >= MIN_TOOL_CALLS && !hasSelfVerification) {
    signals.push({
      code: 'no-self-verification',
      severity: 'medium',
      detail: `${totalToolCalls} tool calls and none verify/inspect/check state — the agent never validates its own actions.`,
      evidence: { tool_calls: totalToolCalls, verification_calls: 0 },
    })
  }

  return {
    llmCallCount: inputTokenTrajectory.length,
    inputTokenTrajectory,
    outputTokenTrajectory,
    toolHistogram,
    totalToolCalls,
    distinctTools,
    toolDiversityRatio,
    hasSelfVerification,
    signals,
  }
}
