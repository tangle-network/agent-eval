// Generic judge runner — domain consumers configure dimensions + prompts.
//
// Three judge slots are conventional for multishot eval:
//   - conversation (scores the full transcript)
//   - codeReview (scores each code artifact)
//   - contentQuality (scores each non-code artifact)
//
// But the runJudge primitive is fully generic — any T → JudgeScore mapping.

import { defaultRouterBaseUrl, requireRouterApiKey, routerCompletion } from './router'

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
  /** Model used for this judge. */
  model?: string
  /** 0-10 scored dimensions. */
  dimensions: JudgeDimension[]
  /** Judge system prompt — sets persona + JSON-only constraint. */
  systemPrompt: string
  /** Build the user prompt from the typed input. Must include "Respond with
   *  ONLY this JSON: { ... }" listing each dimension key. */
  buildPrompt: (input: TInput) => string
  /** Optional model + api overrides. */
  apiKey?: string
  baseUrl?: string
}

export interface JudgeScore {
  /** Per-dimension 0-10 score. Missing dims default to 0. */
  dimensions: Record<string, number>
  /** Mean across dimensions. */
  composite: number
  /** Free-form 1-2 sentence critique from the judge (when provided). */
  notes: string
}

const ZERO_SCORE: JudgeScore = { dimensions: {}, composite: 0, notes: 'parse failed' }

export async function runJudge<TInput>(
  judge: JudgeConfig<TInput>,
  input: TInput,
): Promise<JudgeScore> {
  const apiKey = judge.apiKey ?? requireRouterApiKey()
  const baseUrl = judge.baseUrl ?? defaultRouterBaseUrl()
  const model = judge.model ?? process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL
  const prompt = judge.buildPrompt(input)
  let raw = ''
  try {
    const { message } = await routerCompletion({
      apiKey,
      baseUrl,
      model,
      temperature: 0,
      maxTokens: 1500,
      messages: [
        { role: 'system', content: judge.systemPrompt },
        { role: 'user', content: prompt },
      ],
    })
    raw = (message.content ?? '').trim()
  } catch (err) {
    return {
      ...ZERO_SCORE,
      notes: `judge ${judge.name} call failed: ${err instanceof Error ? err.message : String(err)}`,
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
    return { ...ZERO_SCORE, notes: `judge ${judge.name} returned non-JSON: ${raw.slice(0, 200)}` }
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
    dimensions,
    composite: judge.dimensions.length === 0 ? 0 : sum / judge.dimensions.length,
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
  }
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
