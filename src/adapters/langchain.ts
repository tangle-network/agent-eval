/**
 * # `@tangle-network/agent-eval/adapters/langchain` — wrap any LangChain
 * Runnable as a `Dispatch` (or `JudgeConfig`).
 *
 * **Why structural, not pinned**: we don't depend on `@langchain/core` at
 * install time. The adapter accepts anything with the canonical LangChain
 * Runnable shape (`invoke(input, config?)`), so it works with their
 * `Runnable`, `RunnableSequence`, `RunnableMap`, `RunnablePassthrough`,
 * and any custom Runnable-shaped object. No version pin, no peer dep,
 * no bundle-bloat risk.
 *
 * **Why this exists**: the most-asked question from foreign agent
 * builders is "I'm already on LangChain — how do I plug in?". The answer
 * is one function. Wrap your existing Runnable, pass the Dispatch into
 * `runEval` / `runImprovementLoop`, ship.
 */

import type { Dispatch, JudgeConfig, JudgeScore, Scenario } from '../contract'

// ── Minimal structural type ──────────────────────────────────────────
//
// Whatever has `invoke(input, config?)` qualifies. We accept any
// config shape (LangChain's RunnableConfig has many optional fields)
// — the only thing we need is the AbortSignal seam, which LangChain's
// RunnableConfig already supports as `signal?: AbortSignal`.

export interface RunnableLike<TInput, TOutput> {
  invoke(input: TInput, config?: { signal?: AbortSignal; [key: string]: unknown }): Promise<TOutput>
}

// ── Dispatch wrapper ────────────────────────────────────────────────

export interface LangchainDispatchOptions<TScenario extends Scenario, TArtifact> {
  /** The Runnable (or RunnableSequence, or anything `.invoke`able). */
  runnable: RunnableLike<TScenario, TArtifact>
  /**
   * Optional config merged into every `invoke` call — tags, metadata,
   * callbacks, runName. The substrate's per-cell `AbortSignal` is
   * always merged in last (and so wins).
   */
  config?: Record<string, unknown>
}

/**
 * Wrap a LangChain Runnable as a `Dispatch`. The Runnable's input must
 * accept the scenario (typically you'll shape it via
 * `RunnableMap`/`RunnableLambda` upstream); its output is the artifact
 * the engine + judges see.
 *
 * @example
 *   const chain = prompt.pipe(model).pipe(parser)
 *   const dispatch = langchainDispatch({ runnable: chain })
 *   await runEval({ scenarios, dispatch, judges: [...], storage, runDir })
 */
export function langchainDispatch<TScenario extends Scenario, TArtifact>(
  opts: LangchainDispatchOptions<TScenario, TArtifact>,
): Dispatch<TScenario, TArtifact> {
  return async (scenario, ctx) => {
    return opts.runnable.invoke(scenario, {
      ...opts.config,
      signal: ctx.signal,
    })
  }
}

// ── Judge wrapper ───────────────────────────────────────────────────

export interface LangchainJudgeOptions<TArtifact, TScenario extends Scenario> {
  /** Judge name; appears in `CampaignResult.aggregates.byJudge`. */
  name: string
  /**
   * Dimensions the judge scores. Used both for the judge's own prompt
   * (if it reads them) and for the aggregator's `byJudge` rollup.
   */
  dimensions: { key: string; description: string }[]
  /**
   * A Runnable that takes `{ artifact, scenario }` and returns a
   * partial `JudgeScore` — the dimensions map at minimum. `composite`
   * is computed by averaging `dimensions` when the Runnable doesn't
   * provide it; `notes` defaults to an empty string.
   */
  runnable: RunnableLike<{ artifact: TArtifact; scenario: TScenario }, Partial<JudgeScore>>
  appliesTo?: (scenario: TScenario) => boolean
}

/**
 * Wrap a LangChain Runnable as a `JudgeConfig`. The Runnable can be any
 * structured-output chain (e.g. `prompt.pipe(model).pipe(StructuredOutputParser)`)
 * that returns a `Partial<JudgeScore>`.
 *
 * The substrate's invariant — throw on judge failure, never silently
 * fold errors into a zero — is preserved: any error from the Runnable
 * propagates and the substrate records a failed cell.
 *
 * @example
 *   const scorePrompt = ChatPromptTemplate.fromTemplate(`...`)
 *   const judgeChain = scorePrompt.pipe(judgeModel).pipe(jsonParser)
 *   const judge = langchainJudge({
 *     name: 'marketing-quality',
 *     dimensions: [{ key: 'hook_strength', description: '...' }, ...],
 *     runnable: judgeChain,
 *   })
 */
export function langchainJudge<TArtifact, TScenario extends Scenario>(
  opts: LangchainJudgeOptions<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  return {
    name: opts.name,
    dimensions: opts.dimensions,
    appliesTo: opts.appliesTo,
    async score({ artifact, scenario, signal }) {
      const result = await opts.runnable.invoke({ artifact, scenario }, { signal })
      const dims = (result.dimensions ?? {}) as Record<string, number>
      const dimValues = Object.values(dims)
      const composite =
        result.composite ??
        (dimValues.length > 0 ? dimValues.reduce((a, b) => a + b, 0) / dimValues.length : 0)
      return {
        dimensions: dims,
        composite,
        notes: result.notes ?? '',
      }
    },
  }
}
