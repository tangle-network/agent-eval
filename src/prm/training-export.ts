/**
 * Export PRM-graded traces as training data for downstream reward-model
 * fine-tuning. Canonical format is NDJSON of
 * `{ trajectory_text, step_index, rubric, score }` so a small model can
 * learn to predict step rewards from step context.
 *
 * The framework doesn't train the model — we emit the data; callers
 * plug it into their preferred trainer (TRL, Unsloth, custom).
 */

import type { LlmSpan, Span } from '../trace/schema'
import { isLlmSpan, isToolSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { buildTrajectory } from '../trajectory'
import type { PrmGradedTrace } from './rubric'

export interface PrmTrainingSample {
  runId: string
  spanId: string
  rubricId: string
  score: number
  /** Serialized step context — step + surrounding conversation. */
  context: {
    priorTurns: Array<{ role: string; content: string }>
    step: { kind: Span['kind']; text: string }
  }
  /** Optional evidence + rationale for auditability. */
  rationale?: string
  evidence?: string
}

export async function exportTrainingData(
  store: TraceStore,
  graded: PrmGradedTrace[],
  options: { contextWindow?: number } = {},
): Promise<PrmTrainingSample[]> {
  const window = options.contextWindow ?? 5
  const out: PrmTrainingSample[] = []
  for (const g of graded) {
    const trajectory = await buildTrajectory(store, g.runId)
    const spanById = new Map(trajectory.steps.map((s) => [s.span.spanId, s]))
    for (const gs of g.steps) {
      const node = spanById.get(gs.spanId)
      if (!node) continue
      const idx = trajectory.steps.indexOf(node)
      const priorSpans = trajectory.steps.slice(Math.max(0, idx - window), idx).map((s) => s.span)
      out.push({
        runId: g.runId,
        spanId: gs.spanId,
        rubricId: gs.rubricId,
        score: gs.score,
        context: {
          priorTurns: priorSpans
            .map(spanToTurn)
            .filter((t): t is { role: string; content: string } => t !== null),
          step: { kind: node.span.kind, text: spanToText(node.span) },
        },
        rationale: gs.rationale,
        evidence: gs.evidence,
      })
    }
  }
  return out
}

/** NDJSON serialization — write to file or stream directly to a trainer. */
export function toNdjson(samples: PrmTrainingSample[]): string {
  return `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`
}

function spanToTurn(span: Span): { role: string; content: string } | null {
  if (isLlmSpan(span)) {
    const text = span.output ?? span.messages.map((m) => `${m.role}: ${m.content}`).join('\n')
    return { role: 'assistant', content: text }
  }
  if (isToolSpan(span)) {
    return {
      role: 'tool',
      content: `${span.toolName}(${safeStringify(span.args)}) → ${safeStringify(span.result)}`,
    }
  }
  return null
}

function spanToText(span: Span): string {
  if (isLlmSpan(span)) return (span as LlmSpan).output ?? ''
  if (isToolSpan(span))
    return `${span.toolName}(${safeStringify(span.args)}) → ${safeStringify(span.result)}`
  return span.name
}

function safeStringify(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
