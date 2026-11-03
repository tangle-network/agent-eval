/**
 * Run authored System One reviews through agent-eval: freeze each review with
 * `prepareSystemOneReview`, ask it once through `systemOneEvaluator`, keep the raw answer,
 * and assess it with `assessSystemOneReview`. Stored reviews and raw answers re-score
 * offline with no model call.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CostLedger } from '../cost-ledger'
import {
  assessSystemOneReview,
  systemOneEvaluator,
  prepareSystemOneReview,
  type SystemOneQuestions,
  type SystemOneReviewCheck,
  type SystemOneReviewReport,
  type SystemOneState,
  type PreparedSystemOneReview,
} from '../systemone'
import type { AppGradeJudge } from './judge'
import { chatSystemOneTransport, SYSTEM_ONE_MAX_OUTPUT_TOKENS, SystemOneTransportError } from './systemone-transport'
import type { TierRole } from './verdict'

export interface ReviewSpec {
  id: string
  questions: SystemOneQuestions
  state: unknown
  checks: Record<string, Omit<SystemOneReviewCheck, 'evidence'> & { evidence: SystemOneReviewCheck['evidence'] }>
  tierRole: Record<string, TierRole>
}

export interface StoredReview {
  id: string
  review: PreparedSystemOneReview
  raw: unknown
  report: SystemOneReviewReport
  tierRole: Record<string, TierRole>
  costUsd: number
}

/** Round-trip through JSON so optional undefined fields never reach the canonical hash. */
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export async function runReviews(input: {
  specs: ReviewSpec[]
  /** Review definition version; part of every review digest. */
  version: string
  /** The judge; its reference is part of every review digest. */
  judge: AppGradeJudge
  costLedger: CostLedger
  dir: string
}): Promise<StoredReview[]> {
  mkdirSync(input.dir, { recursive: true })
  const evaluate = systemOneEvaluator({
    evaluate: chatSystemOneTransport({ judge: input.judge }),
    costLedger: input.costLedger,
    pricing: input.judge.pricing,
    receiptFromError: (error) =>
      error instanceof SystemOneTransportError
        ? {
            model: error.model,
            inputTokens: error.usage.input_tokens,
            outputTokens: error.usage.output_tokens,
            ...(error.costUsd !== null ? { actualCostUsd: error.costUsd } : { customTokenPricing: input.judge.pricing }),
          }
        : undefined,
    // The cost the client reported ($0 on a subscription); the rate card otherwise.
    receipt: (raw) => {
      const value = raw as { model: string; usage: { input_tokens: number; output_tokens: number }; transport?: { costUsd?: number | null } }
      return {
        model: value.model,
        inputTokens: value.usage.input_tokens,
        outputTokens: value.usage.output_tokens,
        ...(typeof value.transport?.costUsd === 'number' ? { actualCostUsd: value.transport.costUsd } : { customTokenPricing: input.judge.pricing }),
      }
    },
  })
  // Reviews are independent questions over stored evidence; ask them at the same time.
  return Promise.all(
    input.specs.map(async (spec): Promise<StoredReview> => {
      const review = prepareSystemOneReview({
        version: input.version,
        request: { model: input.judge.ref, state: json(spec.state) as SystemOneState, questions: json(spec.questions) },
        checks: json(spec.checks) as never,
      })
      const result = await evaluate(review.request, {
        actor: `app-grade-review-${spec.id}`,
        channel: 'judge',
        costPhase: 'review',
        // Hard bound: at most one token per two request characters, plus the output cap.
        maximumCharge: {
          customTokenPricing: input.judge.bound,
          inputTokens: 3 * (Math.ceil(JSON.stringify(review.request).length / 2) + 2_000),
          outputTokens: 3 * SYSTEM_ONE_MAX_OUTPUT_TOKENS,
        },
      })
      const entry: StoredReview = {
        id: spec.id,
        review,
        raw: result.value,
        report: assessSystemOneReview(review, result.value),
        tierRole: spec.tierRole,
        costUsd: result.receipt.costUsd,
      }
      writeFileSync(join(input.dir, `${spec.id}.json`), JSON.stringify(entry, null, 1))
      return entry
    }),
  )
}

/** Offline re-score: same frozen review, same raw answer, no inference. */
export function rescore(entry: Pick<StoredReview, 'review' | 'raw'>): SystemOneReviewReport {
  return assessSystemOneReview(entry.review, entry.raw)
}
