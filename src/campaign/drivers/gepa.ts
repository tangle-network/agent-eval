/**
 * @experimental
 *
 * `gepaDriver` — a reflective `ImprovementDriver` for prompt-tier surfaces.
 * Each generation it reflects on the prior best candidate's per-scenario
 * scores + weakest dimensions (the `GenerationCandidate` evidence from
 * `runOptimization`), asks an LLM to propose targeted rewrites of the current
 * surface, and returns them as the next population.
 *
 * This is the substrate's best-in-class prompt optimizer: surface-agnostic, so
 * ANY string surface in ANY consumer opts in by selecting it — system prompts,
 * prompt addenda, judge/reviewer prompts, even a driver's own reflection
 * prompt. It reuses the generic reflection primitive (`buildReflectionPrompt` /
 * `parseReflectionResponse`) and the router client; it has NO dependency on the
 * legacy `runMultiShotOptimization` / `prompt-evolution` orchestration.
 *
 * It earns its keep where there is real per-instance signal (which the
 * dimensional + per-scenario evidence + the `LabeledScenarioStore` flywheel
 * now provide). For thin-signal surfaces it degrades to plain reflection — so
 * it is a SELECTABLE driver, never a forced default. On generation 0 (no
 * history) it reflects on the current surface against the mutation primitives
 * alone.
 */

import { callLlm, type LlmClientOptions } from '../../llm-client'
import {
  buildReflectionPrompt,
  parseReflectionResponse,
  type TrialTrace,
} from '../../reflective-mutation'
import type { ImprovementDriver, MutableSurface, ProposeContext } from '../types'

const REFLECTION_SYSTEM =
  'You are an expert prompt engineer. Output ONLY a JSON object of shape ' +
  '{"proposals":[{"label":string,"rationale":string,"payload":string}]} where ' +
  'each `payload` is the FULL improved surface text. No prose outside the JSON.'

export interface GepaDriverOptions {
  /** Router transport (apiKey/baseUrl). */
  llm: LlmClientOptions
  /** Model that performs the reflection. */
  model: string
  /** What is being optimized — appears in the reflection prompt for orientation. */
  target: string
  /** Surface-specific mutation levers offered to the model. */
  mutationPrimitives?: string[]
  /** Top/bottom scenarios surfaced as evidence each generation. Default 3. */
  evidenceK?: number
  /** Reflection sampling temperature. Default 0.7. */
  temperature?: number
  /** Reflection max tokens. Default 6000. */
  maxTokens?: number
}

export function gepaDriver(opts: GepaDriverOptions): ImprovementDriver {
  const evidenceK = opts.evidenceK ?? 3
  return {
    kind: 'gepa',
    async propose(ctx: ProposeContext): Promise<MutableSurface[]> {
      const parent =
        typeof ctx.currentSurface === 'string'
          ? ctx.currentSurface
          : JSON.stringify(ctx.currentSurface)
      const { top, bottom, target } = buildEvidence(ctx, evidenceK, opts.target)

      const userPrompt = buildReflectionPrompt({
        target,
        parentPayload: parent,
        topTrials: top,
        bottomTrials: bottom,
        childCount: ctx.populationSize,
        mutationPrimitives: opts.mutationPrimitives,
      })

      const result = await callLlm(
        {
          model: opts.model,
          messages: [
            { role: 'system', content: REFLECTION_SYSTEM },
            { role: 'user', content: userPrompt },
          ],
          jsonMode: true,
          temperature: opts.temperature ?? 0.7,
          maxTokens: opts.maxTokens ?? 6000,
        },
        opts.llm,
      )

      const proposals = parseReflectionResponse(result.content, ctx.populationSize)
      const out: MutableSurface[] = []
      for (const proposal of proposals) {
        const text = typeof proposal.payload === 'string' ? proposal.payload.trim() : ''
        if (text && text !== parent && !out.includes(text)) out.push(text)
      }
      return out
    },
  }
}

/** Turn the prior generation's best candidate into reflective evidence:
 *  top/bottom scenarios by composite + a weakest-dimensions note on the target.
 *  Empty on generation 0 — the model reflects on the surface alone. */
function buildEvidence(
  ctx: ProposeContext,
  evidenceK: number,
  baseTarget: string,
): { top: TrialTrace[]; bottom: TrialTrace[]; target: string } {
  const last = ctx.history.at(-1)
  if (!last || last.candidates.length === 0) {
    return { top: [], bottom: [], target: baseTarget }
  }
  const best = [...last.candidates].sort((a, b) => b.composite - a.composite)[0]
  if (!best) return { top: [], bottom: [], target: baseTarget }

  const byScore = [...best.scenarios].sort((a, b) => b.composite - a.composite)
  const toTrace = (s: { scenarioId: string; composite: number }): TrialTrace => ({
    id: s.scenarioId,
    score: s.composite,
  })
  const top = byScore.slice(0, evidenceK).map(toTrace)
  const bottom = byScore.slice(-evidenceK).reverse().map(toTrace)

  const weakest = Object.entries(best.dimensions)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([dim, value]) => `${dim} (${value.toFixed(2)})`)
  const target =
    weakest.length > 0 ? `${baseTarget} — weakest dimensions: ${weakest.join(', ')}` : baseTarget

  return { top, bottom, target }
}
