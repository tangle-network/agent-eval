// Generic judge runner — domain consumers configure dimensions + prompts.
//
// Three judge slots are conventional for multishot eval:
//   - conversation (scores the full transcript)
//   - codeReview (scores each code artifact)
//   - contentQuality (scores each non-code artifact)
//
// But the runJudge primitive is fully generic: any input maps to a score plus
// explicit observed, estimated, or uncaptured cost.

import type { JudgeScore } from '../campaign/types'
import type { CostProvenance } from '../cost-ledger'
import type { LlmCallMetadata, LlmUsage } from '../llm-client'
import { estimateCost, isModelPriced } from '../metrics'
import type { MultishotTransport, MultishotTransportResponse } from './types'

// Canonical declaration lives in campaign/types.ts. Multishot emits the same
// shape on its producer-defined 0-10 scale.
export type { JudgeScore } from '../campaign/types'

export const DEFAULT_JUDGE_MODEL = 'openai/gpt-4o-mini'

export interface JudgeDimension {
  /** JSON field name + score key. */
  key: string
  /** Description shown in the judge's user prompt. */
  description: string
}

export interface JudgeConfig<TInput> {
  /** Display name (for trace + log). */
  name: string
  /** Caller-owned execution for this judge's call. agent-eval issues no
   *  provider request and holds no credential. */
  transport: MultishotTransport
  /** Model used for this judge. */
  model?: string
  /** 0-10 scored dimensions. */
  dimensions: JudgeDimension[]
  /** Judge system prompt — sets persona + JSON-only constraint. */
  systemPrompt: string
  /** Build the user prompt from the typed input. Must include "Respond with
   *  ONLY this JSON: { ... }" listing each dimension key. */
  buildPrompt: (input: TInput) => string
  /** Maximum output tokens for the judge response. Defaults to 1500. */
  maxTokens?: number
}

export interface JudgeRunResult {
  /** Semantic result; failed scores remain non-throwing so matrix aggregation can exclude them. */
  score: JudgeScore
  /** Cost of the completed call, separate from diagnostic provider metadata. */
  cost: CostProvenance
}

export async function runJudge<TInput>(
  judge: JudgeConfig<TInput>,
  input: TInput,
): Promise<JudgeRunResult> {
  const model = judge.model ?? DEFAULT_JUDGE_MODEL
  const prompt = judge.buildPrompt(input)
  let raw = ''
  let llmCall: LlmCallMetadata
  let cost: CostProvenance
  const startedAt = Date.now()
  try {
    const response = await judge.transport({
      model,
      temperature: 0,
      maxTokens: judge.maxTokens ?? 1500,
      messages: [
        { role: 'system', content: judge.systemPrompt },
        { role: 'user', content: prompt },
      ],
    })
    const call = judgeCallMetadata(response, model, Date.now() - startedAt)
    llmCall = call.llmCall
    cost = call.cost
    raw = (response.message.content ?? '').trim()
  } catch (err) {
    // failed:true lets consumers reading `.composite` keep working while
    // aggregators exclude this score from means instead of averaging a zero.
    return {
      score: {
        dimensions: {},
        composite: 0,
        failed: true,
        notes: `judge ${judge.name} call failed: ${err instanceof Error ? err.message : String(err)}`,
        llmCall: unknownJudgeCall(model, Date.now() - startedAt),
      },
      cost: { kind: 'uncaptured', usd: null },
    }
  }

  let parsed: Record<string, unknown> | null = null
  try {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    return {
      score: {
        dimensions: {},
        composite: 0,
        failed: true,
        notes: `judge ${judge.name} returned non-JSON: ${raw.slice(0, 200)}`,
        llmCall,
      },
      cost,
    }
  }

  const dimensions: Record<string, number> = {}
  let sum = 0
  for (const dim of judge.dimensions) {
    const v = Number(parsed[dim.key] ?? 0)
    const clamped = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 0
    dimensions[dim.key] = clamped
    sum += clamped
  }
  return {
    score: {
      dimensions,
      composite: judge.dimensions.length === 0 ? 0 : sum / judge.dimensions.length,
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      llmCall,
    },
    cost,
  }
}

function judgeCallMetadata(
  response: MultishotTransportResponse,
  requestedModel: string,
  durationMs: number,
): {
  llmCall: LlmCallMetadata
  cost: CostProvenance
} {
  const usage = canonicalUsage(response.usage)
  // The transport reports the served identity when it observed one. Falling
  // back to the requested id keeps attribution honest for a transport that
  // reported none; it is not proof that model answered.
  const model = response.model ?? requestedModel
  return {
    llmCall: {
      usage,
      costUsd: response.costUsd ?? null,
      model,
      durationMs,
    },
    cost:
      response.costUsd !== undefined
        ? { kind: 'observed', usd: response.costUsd }
        : usage.captured === false || !isModelPriced(model)
          ? { kind: 'uncaptured', usd: null }
          : {
              kind: 'estimated',
              usd: estimateCost(usage.promptTokens, usage.completionTokens, model),
            },
  }
}

function canonicalUsage(usage: MultishotTransportResponse['usage']): LlmUsage {
  const promptTokens = tokenCount(usage?.prompt_tokens)
  const completionTokens = tokenCount(usage?.completion_tokens)
  const captured = promptTokens !== undefined && completionTokens !== undefined
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
    captured,
  }
}

function unknownJudgeCall(model: string, durationMs: number): LlmCallMetadata {
  return {
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, captured: false },
    costUsd: null,
    model,
    durationMs,
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Convenience: stringified dimension list for inclusion in a judge prompt.
 *  Returns lines like `- audience_fit: Does this match what the audience cares about? (0-10)`. */
export function renderDimensions(dims: readonly JudgeDimension[]): string {
  return dims.map((d) => `- ${d.key}: ${d.description}`).join('\n')
}

/** Convenience: build the "Respond with ONLY this JSON" footer for a judge prompt. */
export function renderJsonFooter(dims: readonly JudgeDimension[]): string {
  const fields = dims.map((d) => `"${d.key}":N`).join(',')
  return `Respond with ONLY this JSON (no markdown, no preamble):\n{${fields},"notes":"1-2 sentence critique"}`
}
