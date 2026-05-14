/**
 * Run-completion integrity check — at end of run, verify the expected event
 * types were actually captured. The point is the launch-review failure mode:
 * a run *appears* successful but the raw provider events were never written,
 * so a downstream reviewer can't reconstruct what happened.
 *
 * Pattern:
 *
 *   const report = await assertRunCaptured(store, runId, {
 *     llmSpansMin: 1,
 *     judgeSpansMin: 1,
 *     rawSink: providerSink,                  // must have ≥ 1 event for this run
 *     requireRawCoverageOfLlmSpans: true,     // every llm span has matching raw events
 *   })
 *   if (!report.ok) throwIfRunIncomplete(report)  // or mark run failed and continue
 *
 * The function is read-only on the store and returns a structured report;
 * the caller chooses the failure mode (throw, mark run failed, log warning).
 * `throwIfRunIncomplete` is the convenient strict mode.
 */

import type { RawProviderSink } from './raw-provider-sink'
import type { TraceStore } from './store'

export interface RunIntegrityExpectations {
  /** Minimum LLM span count. Default 0 (no requirement). */
  llmSpansMin?: number
  /** Minimum judge span count. Default 0. */
  judgeSpansMin?: number
  /** Minimum tool span count. Default 0. */
  toolSpansMin?: number
  /**
   * Raw provider sink to consult for capture verification. When present,
   * the check requires at least one raw event for the run.
   */
  rawSink?: RawProviderSink
  /** Minimum raw provider event count. Default 0; ignored when `rawSink` absent. */
  rawProviderEventsMin?: number
  /**
   * Every LLM span must have at least one matching raw `request` event
   * (matched by spanId). Catches the common bug where the structured span
   * was emitted but the raw HTTP capture was wired to a different sink.
   */
  requireRawCoverageOfLlmSpans?: boolean
  /** Run outcome must be set (not null/undefined). Default false. */
  requireOutcome?: boolean
}

export type RunIntegrityIssueCode =
  | 'no_run'
  | 'missing_llm_spans'
  | 'missing_judge_spans'
  | 'missing_tool_spans'
  | 'missing_raw_events'
  | 'no_raw_sink'
  | 'orphan_llm_span'
  | 'missing_outcome'

export interface RunIntegrityIssue {
  code: RunIntegrityIssueCode
  message: string
  detail?: Record<string, unknown>
}

export interface RunIntegrityReport {
  ok: boolean
  runId: string
  llmSpanCount: number
  judgeSpanCount: number
  toolSpanCount: number
  rawProviderEventCount: number
  /**
   * Coverage of LLM spans by raw provider events keyed on spanId.
   * `total` is the number of LLM spans; `covered` is the count with at
   * least one matching `request` raw event.
   */
  rawSpanCoverage: { covered: number; total: number }
  issues: RunIntegrityIssue[]
}

export class RunIntegrityError extends Error {
  constructor(public readonly report: RunIntegrityReport) {
    super(
      `Run ${report.runId} failed integrity check: ${report.issues.map((i) => i.code).join(', ')}`,
    )
    this.name = 'RunIntegrityError'
  }
}

export async function assertRunCaptured(
  store: TraceStore,
  runId: string,
  expectations: RunIntegrityExpectations = {},
): Promise<RunIntegrityReport> {
  const issues: RunIntegrityIssue[] = []
  const run = await store.getRun(runId)
  if (!run) {
    return {
      ok: false,
      runId,
      llmSpanCount: 0,
      judgeSpanCount: 0,
      toolSpanCount: 0,
      rawProviderEventCount: 0,
      rawSpanCoverage: { covered: 0, total: 0 },
      issues: [{ code: 'no_run', message: `Run ${runId} not found in store.` }],
    }
  }

  const spans = await store.spans({ runId })
  const llmSpans = spans.filter((s) => s.kind === 'llm')
  const judgeSpans = spans.filter((s) => s.kind === 'judge')
  const toolSpans = spans.filter((s) => s.kind === 'tool')

  const llmMin = expectations.llmSpansMin ?? 0
  const judgeMin = expectations.judgeSpansMin ?? 0
  const toolMin = expectations.toolSpansMin ?? 0

  if (llmSpans.length < llmMin) {
    issues.push({
      code: 'missing_llm_spans',
      message: `Expected ≥ ${llmMin} LLM spans, found ${llmSpans.length}.`,
      detail: { expected: llmMin, found: llmSpans.length },
    })
  }
  if (judgeSpans.length < judgeMin) {
    issues.push({
      code: 'missing_judge_spans',
      message: `Expected ≥ ${judgeMin} judge spans, found ${judgeSpans.length}.`,
      detail: { expected: judgeMin, found: judgeSpans.length },
    })
  }
  if (toolSpans.length < toolMin) {
    issues.push({
      code: 'missing_tool_spans',
      message: `Expected ≥ ${toolMin} tool spans, found ${toolSpans.length}.`,
      detail: { expected: toolMin, found: toolSpans.length },
    })
  }

  let rawEventCount = 0
  let coverage = { covered: 0, total: llmSpans.length }

  if (expectations.rawSink) {
    if (!expectations.rawSink.list) {
      issues.push({
        code: 'no_raw_sink',
        message: 'Provided rawSink does not implement list(); cannot verify capture.',
      })
    } else {
      const events = await expectations.rawSink.list({ runId })
      rawEventCount = events.length
      const rawMin = expectations.rawProviderEventsMin ?? 1
      if (rawEventCount < rawMin) {
        issues.push({
          code: 'missing_raw_events',
          message: `Expected ≥ ${rawMin} raw provider events, found ${rawEventCount}.`,
          detail: { expected: rawMin, found: rawEventCount },
        })
      }
      if (expectations.requireRawCoverageOfLlmSpans) {
        const requestEventsBySpan = new Set(
          events.filter((e) => e.direction === 'request' && e.spanId).map((e) => e.spanId!),
        )
        const orphaned = llmSpans.filter((s) => !requestEventsBySpan.has(s.spanId))
        coverage = { covered: llmSpans.length - orphaned.length, total: llmSpans.length }
        if (orphaned.length > 0) {
          issues.push({
            code: 'orphan_llm_span',
            message: `${orphaned.length} LLM span(s) have no matching raw provider request event.`,
            detail: { orphanedSpanIds: orphaned.map((s) => s.spanId) },
          })
        }
      }
    }
  } else if (expectations.requireRawCoverageOfLlmSpans || expectations.rawProviderEventsMin) {
    issues.push({
      code: 'no_raw_sink',
      message: 'Raw coverage required but no rawSink supplied to the integrity check.',
    })
  }

  if (expectations.requireOutcome && (run.outcome === undefined || run.outcome === null)) {
    issues.push({
      code: 'missing_outcome',
      message: `Run ${runId} has no outcome recorded.`,
    })
  }

  return {
    ok: issues.length === 0,
    runId,
    llmSpanCount: llmSpans.length,
    judgeSpanCount: judgeSpans.length,
    toolSpanCount: toolSpans.length,
    rawProviderEventCount: rawEventCount,
    rawSpanCoverage: coverage,
    issues,
  }
}

/** Strict mode: throws `RunIntegrityError` when the report isn't ok. */
export function throwIfRunIncomplete(report: RunIntegrityReport): void {
  if (!report.ok) throw new RunIntegrityError(report)
}
