/**
 * Trace-analyst auto-execution hook.
 *
 * Wires `analyzeTraces` into a `TraceEmitter`'s `onRunComplete` so a
 * direct matrix run produces an analysis artifact without an out-of-band
 * step. Designed for the case where the consumer reports "the analyst
 * never ran" — the cause is almost always orchestration, not the analyst.
 *
 * Usage:
 *
 *   const emitter = new TraceEmitter(store, {
 *     onRunComplete: [traceAnalystOnRunComplete({ analyze: opts, save })],
 *   })
 *
 * Hooks are best-effort by default — they never crash the underlying run.
 * The caller decides whether to gate the run on the analysis result via
 * the `gateOn` callback.
 */

import { analyzeTraces, type AnalyzeTracesOptions, type AnalyzeTracesResult } from './analyst'
import type { RunCompleteHook, RunCompleteHookContext } from '../trace/emitter'

export interface TraceAnalystHookOptions {
  /**
   * Options forwarded to `analyzeTraces`. The hook supplies the question
   * if you don't pass one — defaulting to a launch-grade prompt that asks
   * for failure modes, surprising findings, and a recommendation.
   */
  analyze: Omit<AnalyzeTracesOptions, 'source'> & { source?: AnalyzeTracesOptions['source'] }
  /**
   * Override the question. The default is intentionally generic:
   * "Summarise what happened in this run, surface any failure modes,
   *  surprising findings, or evidence the verdict is wrong."
   */
  question?: string
  /**
   * Persist the result. The hook calls this with the analysis output and
   * the run context. Common implementations write to a TraceAnalysisStore
   * or append to a per-run JSONL.
   */
  save?: (result: AnalyzeTracesResult, ctx: RunCompleteHookContext) => Promise<void>
  /**
   * Predicate gating execution per run. Default: every completed run.
   * Use to skip aborted runs, debug runs, or runs without LLM activity.
   */
  shouldRun?: (ctx: RunCompleteHookContext) => boolean
  /**
   * Optional gate: if set and returns false, the hook records the failure
   * as a log event on the run instead of staying quiet. The caller can
   * then trigger downstream alerts off `analyst_gate_failed` log events.
   */
  gateOn?: (result: AnalyzeTracesResult, ctx: RunCompleteHookContext) => boolean
}

const DEFAULT_QUESTION = 'Summarise what happened in this run. Surface any failure modes, surprising findings, or evidence that the run\'s verdict is wrong.'

export function traceAnalystOnRunComplete(opts: TraceAnalystHookOptions): RunCompleteHook {
  return async (ctx: RunCompleteHookContext) => {
    if (opts.shouldRun && !opts.shouldRun(ctx)) return
    const source = opts.analyze.source
    if (source === undefined) {
      // The analyst needs a source. If the caller didn't supply one we don't
      // run — but we do leave a breadcrumb so the absence is visible.
      await ctx.store.appendEvent({
        eventId: `analyst-skip-${ctx.runId}`,
        runId: ctx.runId,
        kind: 'log',
        timestamp: Date.now(),
        payload: { source: 'trace_analyst_hook', reason: 'no source configured' },
      })
      return
    }
    const result = await analyzeTraces(
      { question: opts.question ?? DEFAULT_QUESTION },
      { ...opts.analyze, source } as AnalyzeTracesOptions,
    )
    if (opts.save) await opts.save(result, ctx)
    if (opts.gateOn && !opts.gateOn(result, ctx)) {
      await ctx.store.appendEvent({
        eventId: `analyst-gate-${ctx.runId}`,
        runId: ctx.runId,
        kind: 'log',
        timestamp: Date.now(),
        payload: {
          source: 'trace_analyst_hook',
          reason: 'analyst_gate_failed',
          findings: result.findings,
        },
      })
    }
  }
}
