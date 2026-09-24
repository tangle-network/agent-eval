/**
 * The first failure in one run, ranked by a fixed precedence and never read off
 * timing correlation.
 *
 * Precedence:
 *   1. `error-span`: a span with status ERROR or `agent.outcome` "error" that
 *      contains no other such span. A span whose failure is explained by a
 *      failing span inside it does not rank; containment is recorded structure.
 *      Among the rest, the span that ended first ranks first, because its end
 *      is when the failure was recorded.
 *   2. `failed-outcome`: no span errored, but a span carries `agent.outcome`
 *      "fail". The run completed and its graded work failed.
 *   3. `none`: neither exists. This describes the recorded spans. It is not a
 *      verdict that the run succeeded.
 *
 * When the leading candidates end at the same instant, or a candidate has no
 * end time, the result is `ambiguous` and names the candidates. The rank never
 * picks one.
 *
 * The failing span's status message is classified by the failure taxonomy
 * (`classifyFailureReason`), whose `blame` separates machine and provider
 * failures from the agent's own. A span without a message is `unreported` and
 * blamed `unknown`. A failed outcome with no error is blamed on the agent: the
 * machine and the provider recorded no failure, and the graded work failed.
 */

import type { SpanKind } from '@tangle-network/agent-trace-contract'
import {
  classifyFailureReason,
  type FailureBlame,
  type FailureClassification,
} from '../failure-taxonomy'
import type { DiagnosisSpan } from './spans'

/** Span ids listed beside a result; the count carries the rest. */
export const MAX_FIRST_FAILURE_IDS = 8

const OUTCOME_ATTR = 'agent.outcome'

export type FirstFailureStage = 'error-span' | 'failed-outcome'

export interface FirstFailureFound {
  status: 'found'
  traceId: string
  stage: FirstFailureStage
  spanId: string
  name: string
  kind: SpanKind
  /** The span's status message after secret filtering; null when absent or withheld. */
  message: string | null
  /** The taxonomy's reading of `message`; null for a failed outcome, which has none. */
  classification: FailureClassification | null
  blame: FailureBlame
  /** Other candidates at the same stage, in rank order, capped at {@link MAX_FIRST_FAILURE_IDS}. */
  later: string[]
  laterCount: number
}

export interface FirstFailureAmbiguous {
  status: 'ambiguous'
  traceId: string
  stage: FirstFailureStage
  /** The candidates the rank could not order, capped at {@link MAX_FIRST_FAILURE_IDS}. */
  candidates: string[]
  candidateCount: number
  reason: string
}

export interface FirstFailureNone {
  status: 'none'
  traceId: string
  reason: string
}

export type FirstFailure = FirstFailureFound | FirstFailureAmbiguous | FirstFailureNone

/** Rank the first failure of one trace. Throws when the spans belong to more than one trace. */
export function rankFirstFailure(spans: readonly DiagnosisSpan[]): FirstFailure {
  const traceId = spans[0]?.traceId
  if (traceId === undefined) throw new TypeError('rankFirstFailure: no spans')
  if (spans.some((span) => span.traceId !== traceId)) {
    throw new TypeError('rankFirstFailure: spans belong to more than one trace')
  }

  const errors = spans.filter(isErrorSpan)
  if (errors.length > 0) {
    const innermost = withoutFailingDescendants(spans, errors)
    if (innermost.length === 0) {
      return ambiguous(
        traceId,
        'error-span',
        errors,
        'every failing span contains another failing span, so containment is cyclic',
      )
    }
    return rank(traceId, 'error-span', innermost)
  }

  const failed = spans.filter((span) => span.attributes[OUTCOME_ATTR] === 'fail')
  if (failed.length > 0) return rank(traceId, 'failed-outcome', failed)

  return {
    status: 'none',
    traceId,
    reason: `none of ${spans.length} spans has status ERROR or an agent.outcome of error or fail`,
  }
}

function isErrorSpan(span: DiagnosisSpan): boolean {
  return span.status === 'ERROR' || span.attributes[OUTCOME_ATTR] === 'error'
}

/** The failing spans with no failing span beneath them. */
function withoutFailingDescendants(
  spans: readonly DiagnosisSpan[],
  failing: readonly DiagnosisSpan[],
): DiagnosisSpan[] {
  const parentOf = new Map(spans.map((span) => [span.spanId, span.parentSpanId]))
  const explained = new Set<string>()
  for (const span of failing) {
    const seen = new Set([span.spanId])
    let parent = span.parentSpanId
    while (parent !== null && parentOf.has(parent) && !seen.has(parent)) {
      explained.add(parent)
      seen.add(parent)
      parent = parentOf.get(parent) ?? null
    }
  }
  return failing.filter((span) => !explained.has(span.spanId))
}

function rank(
  traceId: string,
  stage: FirstFailureStage,
  candidates: readonly DiagnosisSpan[],
): FirstFailure {
  if (candidates.length > 1) {
    const untimed = candidates.filter((span) => span.endMs === null)
    if (untimed.length > 0) {
      return ambiguous(
        traceId,
        stage,
        candidates,
        `${untimed.length} of ${candidates.length} candidates have no end time, so their order is unknown`,
      )
    }
  }
  const ordered = [...candidates].sort(
    (a, b) => (a.endMs ?? 0) - (b.endMs ?? 0) || a.spanId.localeCompare(b.spanId),
  )
  const first = ordered[0]!
  const tied = ordered.filter((span) => span.endMs === first.endMs)
  if (tied.length > 1) {
    return ambiguous(
      traceId,
      stage,
      tied,
      `${tied.length} candidates ended at the same instant, so none ranks first`,
    )
  }
  const classification = stage === 'error-span' ? classifyFailureReason(first.statusMessage) : null
  const later = ordered.slice(1)
  return {
    status: 'found',
    traceId,
    stage,
    spanId: first.spanId,
    name: first.name,
    kind: first.kind,
    message: first.statusMessage,
    classification,
    blame: classification?.blame ?? 'agent',
    later: later.slice(0, MAX_FIRST_FAILURE_IDS).map((span) => span.spanId),
    laterCount: later.length,
  }
}

function ambiguous(
  traceId: string,
  stage: FirstFailureStage,
  candidates: readonly DiagnosisSpan[],
  reason: string,
): FirstFailureAmbiguous {
  const ids = candidates.map((span) => span.spanId).sort()
  return {
    status: 'ambiguous',
    traceId,
    stage,
    candidates: ids.slice(0, MAX_FIRST_FAILURE_IDS),
    candidateCount: ids.length,
    reason,
  }
}
