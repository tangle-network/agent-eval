/**
 * Multi-model judge panel — `ensembleJudge` builds a campaign `JudgeConfig`
 * that fans one artifact out to K judge models and reduces their verdicts
 * through `aggregateJudgeVerdicts` (src/judge-ensemble.ts).
 *
 * The panel is the fail-loud composition of the substrate's existing judge
 * primitives:
 *   - `assertCrossFamily` (construction-time) — a single-family panel is
 *     correlated bias, not independent signal.
 *   - `withJudgeRetry` (per model, opt-in) — transient-fault retry with a
 *     typed outcome; a judge that exhausts retries is recorded as failed,
 *     never folded into a zero.
 *   - `aggregateJudgeVerdicts` — the pure reducer; throws when EVERY judge
 *     failed so a silent zero can't reach the gate.
 *
 * The returned `JudgeScore` is on the campaign [0,1] scale and carries the
 * ensemble extras (`maxDisagreement`, `failedJudges`, `perJudge`) declared
 * on the canonical `JudgeScore` in src/campaign/types.ts.
 */

import type { JudgeConfig, JudgeScore } from './campaign/types'
import {
  CostLedger,
  type CostLedgerHandle,
  type CostReceiptInput,
  type MaximumCharge,
} from './cost-ledger'
import { aggregateJudgeVerdicts, type JudgeVerdict } from './judge-ensemble'
import { assertCrossFamily } from './judge-families'
import { type JudgeRetryPolicy, withJudgeRetry } from './judge-retry'
import { contentHash } from './verdict-cache'

export interface EnsembleJudgeOptions<D extends string> {
  /** Judge name — becomes the returned `JudgeConfig.name`. */
  name: string
  /** Rubric dimensions every model scores. Keys of the verdict's `perDimension`. */
  dimensions: D[]
  /** Judge model ids — one `scoreWith` call per entry. List a model twice to
   *  sample it twice (votes are suffix-keyed `model#2` so none overwrite). */
  models: string[]
  /** Explicit scoring revision for closure state not visible in the static panel config. */
  judgeVersion?: string
  /**
   * Score the artifact with one model. Throw (or reject) on failure — the
   * panel records that model as a failed judge; it is never folded into a
   * zero. Verdict scores are clamped to [0,1] by the reducer.
   */
  scoreWith: (
    model: string,
    input: { artifact: unknown; scenario?: unknown; signal: AbortSignal },
  ) => Promise<JudgeVerdict<D>>
  /** Recover usage from a failed provider response when its error retains one. */
  receiptFromError?: (error: Error, model: string) => CostReceiptInput | undefined
  /** Used by direct score calls; campaigns supply their run ledger in score(). */
  costLedger?: CostLedgerHandle
  /** Required per model when the shared ledger has a dollar cap. */
  maximumCharge?: MaximumCharge | ((model: string) => MaximumCharge)
  /**
   * Per-model retry policy, applied via `withJudgeRetry`. The panel's
   * `models` list drives the fan-out, so `retry.models` (the fallback
   * rotation) is overridden to each panel model in turn.
   */
  retry?: JudgeRetryPolicy
  /** Enforce `assertCrossFamily` over `models` at construction. Default true.
   *  Opt out only for deliberate single-family panels (e.g. self-consistency
   *  sampling of one model). */
  crossFamily?: boolean
  /** Composite weights forwarded to `aggregateJudgeVerdicts`: a partial map
   *  selects AND weights exactly the named dimensions. Omit for uniform. */
  weights?: Partial<Record<D, number>>
}

/**
 * Build a campaign-shaped `JudgeConfig` whose `score()` runs every panel
 * model in parallel and reduces the surviving verdicts to one canonical
 * `JudgeScore` in [0,1].
 *
 * Failure semantics: a model whose `scoreWith` throws (or exhausts `retry`)
 * lands in `failedJudges` and is excluded from the means. When EVERY model
 * fails, `aggregateJudgeVerdicts` throws — the campaign engine records a
 * failed cell instead of averaging a fabricated zero.
 */
export function ensembleJudge<D extends string>(
  opts: EnsembleJudgeOptions<D>,
): JudgeConfig<unknown> {
  if (opts.models.length === 0) {
    throw new Error(`ensembleJudge '${opts.name}': models is empty — nothing to score with`)
  }
  if (opts.dimensions.length === 0) {
    throw new Error(`ensembleJudge '${opts.name}': dimensions is empty — nothing to score`)
  }
  if (opts.crossFamily !== false) {
    assertCrossFamily(opts.models)
  }
  const declaredJudgeVersion = opts.judgeVersion?.trim()
  if (opts.judgeVersion !== undefined && !declaredJudgeVersion) {
    throw new Error(`ensembleJudge '${opts.name}': judgeVersion must be non-empty when provided`)
  }
  const judgeVersion =
    declaredJudgeVersion ??
    contentHash({
      kind: 'ensembleJudge',
      models: opts.models,
      dimensions: opts.dimensions,
      weights: opts.weights ?? null,
      crossFamily: opts.crossFamily ?? true,
      maximumCharge:
        typeof opts.maximumCharge === 'function'
          ? opts.maximumCharge.toString()
          : (opts.maximumCharge ?? null),
      retry: opts.retry
        ? {
            maxAttempts: opts.retry.maxAttempts ?? null,
            timeoutMs: opts.retry.timeoutMs ?? null,
            models: opts.retry.models ?? null,
            backoffMs: opts.retry.backoffMs?.toString() ?? null,
            isRetryable: opts.retry.isRetryable?.toString() ?? null,
          }
        : null,
      scoreWith: opts.scoreWith.toString(),
    })
  const directCostLedger = opts.costLedger ?? new CostLedger()

  const scoreOne = async (args: {
    model: string
    artifact: unknown
    scenario?: unknown
    signal: AbortSignal
    costLedger: CostLedgerHandle
    costPhase: string
    costTags?: Record<string, string>
  }): Promise<JudgeVerdict<D>> => {
    const outcome = await withJudgeRetry(
      async (model, retrySignal) => {
        const paid = await args.costLedger.runPaidCall({
          channel: 'judge',
          phase: args.costPhase,
          actor: `${opts.name}.${model}`,
          model,
          maximumCharge:
            typeof opts.maximumCharge === 'function'
              ? opts.maximumCharge(model)
              : opts.maximumCharge,
          tags: args.costTags,
          signal: AbortSignal.any([args.signal, retrySignal]),
          execute: (signal) =>
            opts.scoreWith(model, { artifact: args.artifact, scenario: args.scenario, signal }),
          receipt: (verdict) => {
            const cachedTokens = verdict.usage?.cachedPromptTokens ?? 0
            const usageUnknown = !verdict.usage || verdict.usage.captured === false
            return {
              model: verdict.model,
              inputTokens: Math.max(0, (verdict.usage?.promptTokens ?? 0) - cachedTokens),
              outputTokens: verdict.usage?.completionTokens ?? 0,
              cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
              usageUnknown,
              ...(verdict.costUsd === undefined ? {} : { actualCostUsd: verdict.costUsd }),
            }
          },
          receiptFromError: (error) => opts.receiptFromError?.(error, model),
        })
        if (!paid.succeeded) throw paid.error
        return paid.value
      },
      opts.retry
        ? { ...opts.retry, models: [args.model] }
        : { maxAttempts: 1, models: [args.model], isRetryable: () => false },
    )
    if (!outcome.succeeded || outcome.value === null) {
      return {
        model: args.model,
        perDimension: null,
        rationale: outcome.error?.message ?? 'judge failed',
      }
    }
    return outcome.value
  }

  return {
    name: opts.name,
    dimensions: opts.dimensions.map((d) => ({ key: d, description: d })),
    judgeVersion,
    async score({
      artifact,
      scenario,
      signal,
      costLedger,
      costPhase,
      costTags,
    }): Promise<JudgeScore> {
      const verdicts = await Promise.all(
        opts.models.map((model) =>
          scoreOne({
            model,
            artifact,
            scenario,
            signal,
            costLedger: costLedger ?? directCostLedger,
            costPhase: costPhase ?? 'judge',
            costTags,
          }),
        ),
      )
      // All-failed throws here — propagate so the engine records a failed cell.
      const agg = aggregateJudgeVerdicts(verdicts, opts.dimensions, opts.weights)
      const score: JudgeScore = {
        dimensions: agg.perDimension,
        composite: agg.composite,
        notes: agg.rationale,
        maxDisagreement: agg.maxDisagreement,
        perJudge: agg.perJudge,
      }
      if (agg.failedJudges.length > 0) score.failedJudges = agg.failedJudges
      return score
    },
  }
}
