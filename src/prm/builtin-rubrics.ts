/**
 * Built-in reference rubrics. Consumers combine these with domain
 * rubrics. All are deterministic, rule-based — cheap to run + easy
 * to unit-test. LLM-based rubrics are trivially authored by
 * following the StepRubric contract.
 */

import type { LlmSpan, ToolSpan } from '../trace/schema'
import type { StepRubric } from './rubric'

/** Penalize very short or very long assistant outputs. */
export function outputLengthRubric(
  args: { minChars?: number; maxChars?: number; weight?: number } = {},
): StepRubric {
  const min = args.minChars ?? 20
  const max = args.maxChars ?? 8000
  return {
    id: 'output-length',
    kinds: ['llm'],
    weight: args.weight ?? 0.5,
    async grade({ step }) {
      const llm = step.span as LlmSpan
      const len = (llm.output ?? '').length
      if (len === 0) return { score: 0, rationale: 'empty output' }
      if (len < min)
        return { score: Math.max(0, len / min), rationale: `below min (${len} < ${min})` }
      if (len > max)
        return {
          score: Math.max(0, 1 - (len - max) / max),
          rationale: `above max (${len} > ${max})`,
        }
      return { score: 1, rationale: `${len} chars in bounds` }
    },
  }
}

/** Reward tool calls that succeeded (status='ok') with an informative result. */
export function toolSuccessRubric(args: { weight?: number } = {}): StepRubric {
  return {
    id: 'tool-success',
    kinds: ['tool'],
    weight: args.weight ?? 1,
    async grade({ step }) {
      const tool = step.span as ToolSpan
      if (tool.status === 'error')
        return { score: 0, rationale: `error: ${tool.error ?? 'unknown'}` }
      const r = tool.result
      if (r === null || r === undefined) return { score: 0.3, rationale: 'empty result' }
      const asText = typeof r === 'string' ? r : JSON.stringify(r)
      if (asText.length < 4) return { score: 0.5, rationale: 'tiny result' }
      return { score: 1, rationale: `${tool.toolName} ok` }
    },
  }
}

/** Penalize tool calls that duplicate a prior call with identical args. */
export function toolNonRedundantRubric(args: { weight?: number } = {}): StepRubric {
  const weight = args.weight ?? 0.5
  return {
    id: 'tool-non-redundant',
    kinds: ['tool'],
    weight,
    async grade({ step, prior }) {
      const tool = step.span as ToolSpan
      const priorMatches = prior.filter((p) => {
        if (p.span.kind !== 'tool') return false
        const pt = p.span as ToolSpan
        return (
          pt.toolName === tool.toolName && stableStringify(pt.args) === stableStringify(tool.args)
        )
      })
      if (priorMatches.length === 0) return { score: 1, rationale: 'novel call' }
      return {
        score: Math.max(0, 1 - priorMatches.length * 0.5),
        rationale: `${priorMatches.length} duplicate(s)`,
      }
    },
  }
}

/** Penalize LLM outputs that contain common refusal markers when a refusal
 *  is NOT expected (caller inverts weight for scenarios where refusal IS expected). */
export function nonRefusalRubric(args: { markers?: RegExp[]; weight?: number } = {}): StepRubric {
  const weight = args.weight ?? 1
  const markers = args.markers ?? [
    /\bi\s+(?:can(?:not|'t)|won't|will\s+not)\b/i,
    /\b(?:as\s+an?\s+)?ai\b.*?\b(?:can't|cannot)\b/i,
  ]
  return {
    id: 'non-refusal',
    kinds: ['llm'],
    weight,
    async grade({ step }) {
      const llm = step.span as LlmSpan
      const out = llm.output ?? ''
      const refused = markers.some((re) => re.test(out))
      return refused
        ? { score: 0, rationale: 'refusal marker present' }
        : { score: 1, rationale: 'no refusal' }
    },
  }
}

/** Reward outputs that invoke the next-step tool the trajectory actually uses
 *  (i.e. the LLM span announced "I will call X" and the following tool span IS X). */
export function toolIntentAlignmentRubric(args: { weight?: number } = {}): StepRubric {
  return {
    id: 'tool-intent-alignment',
    kinds: ['llm'],
    weight: args.weight ?? 0.5,
    async grade({ step, next }) {
      const llm = step.span as LlmSpan
      const nextTool = next.find((s) => s.span.kind === 'tool')
      if (!nextTool) return null
      const toolName = (nextTool.span as ToolSpan).toolName
      const out = (llm.output ?? '').toLowerCase()
      const mentioned = out.includes(toolName.toLowerCase())
      return mentioned
        ? { score: 1, rationale: `mentioned "${toolName}" before calling it` }
        : { score: 0.5, rationale: `called "${toolName}" without announcing it` }
    },
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}
