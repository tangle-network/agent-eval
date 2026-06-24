/**
 * Treatment-applied gate — "did the treatment's tool actually fire this run?"
 *
 * A tool-treatment A/B (mount a search provider, a browser, a code-exec
 * sandbox, a retrieval MCP — anything one arm gets and the other doesn't) only
 * means something on the treatment arm if that arm actually EXERCISED the tool.
 * A treatment run that never called the mounted tool is not a weak data point
 * — it is a NON-data-point: the manipulation never happened, so the run cannot
 * speak to the treatment and must be excluded from the objective, the same way
 * an infra-tainted run is excluded.
 *
 * This is the manipulation/validity precondition that protects the paired A/B
 * tests downstream (`mcnemar`, `pairedRiskDifference`): they must only ever see
 * runs where the treatment was applied, or they measure noise and report it as
 * an effect.
 *
 * Shape mirrors `authenticity`'s `gateRealness`: a pure predicate over already-
 * computed signals, with explicit fail-open/fail-closed discipline. It is not a
 * trace parser — the tool-call telemetry it reads is the deterministic
 * `toolHistogram` that `computeTraceMetrics(spans)` already produces (OTLP
 * tool-name extraction via `TOOL_NAME_ATTR_KEYS`), or the `ToolSpan[]` a
 * `toolSpans(store, runId)` query returns. The gate never re-derives either.
 *
 * General by construction:
 *   - The "which tool counts as the treatment" decision is a `matches` PARAMETER
 *     — a `(toolName: string) => boolean`. There is no `search`/`web`/`fetch`
 *     literal anywhere in this module; a search A/B passes its own matcher.
 *   - The "is THIS run a treatment arm (vs a control)" decision is the caller's
 *     policy and stays at the call site. The gate only answers the narrower,
 *     domain-free question: "given this run's telemetry, did a matching tool
 *     fire?" — so it generalizes to any tool-treatment, not search.
 *
 * Fail-open on telemetry absence: when NO tool calls were captured at all
 * (`sum(toolHistogram) === 0`), the gate cannot distinguish "the agent used no
 * tools" from "this harness's tool calls weren't recorded". Quarantining on a
 * telemetry gap would silently delete real runs, so the default is
 * applied=true / gated=false. Pass `failOpenWhenNoTelemetry: false` to flip to
 * fail-closed for harnesses where tool capture is guaranteed.
 */

import type { RunRecord } from './run-record'
import type { ToolSpan } from './trace/schema'
import type { BehavioralMetrics } from './trace-analyst/behavioral-metrics'
import { computeTraceMetrics } from './trace-analyst/behavioral-metrics'
import type { TraceAnalystSpan } from './trace-analyst/types'

/** A tool-name matcher: does this tool name belong to the treatment under test?
 *  The caller supplies it — the substrate ships no `search` (or any) literal. */
export type ToolMatcher = (toolName: string) => boolean

export interface TreatmentGateInput {
  /** Tool-call counts by tool name — exactly `computeTraceMetrics(spans).toolHistogram`.
   *  The gate consumes this; it does not parse spans itself. */
  toolHistogram: Readonly<Record<string, number>>
  /** Which tool names count as the treatment firing. A parameter, never baked in. */
  matches: ToolMatcher
}

export interface TreatmentGateOptions {
  /** When the histogram is empty (no tool telemetry captured), treat the run as
   *  applied rather than quarantining it. Default true — a telemetry gap must
   *  never be mistaken for "treatment not applied". Set false only when tool
   *  capture is guaranteed for this harness. */
  failOpenWhenNoTelemetry?: boolean
}

export interface TreatmentGate {
  /** True iff the treatment's tool is considered to have fired this run. False
   *  ONLY when telemetry was present and no matching call appears. */
  applied: boolean
  /** Objective-exclusion flag, parallel to `outcome.realness.gated`: a gated run
   *  is dropped from the objective denominator and reported as
   *  treatment-not-applied (like infra-loss). `gated === !applied`. */
  gated: boolean
  reason?: string
  /** How many recorded tool calls matched the treatment matcher. */
  matchedCalls: number
  /** Total recorded tool calls (`sum(toolHistogram)`) — 0 means no telemetry. */
  observedTools: number
}

/**
 * Core predicate. Gated (treatment-not-applied) ONLY when telemetry was
 * captured AND zero matching calls appear; an empty histogram fails open.
 */
export function gateTreatmentApplied(
  input: TreatmentGateInput,
  opts: TreatmentGateOptions = {},
): TreatmentGate {
  const failOpen = opts.failOpenWhenNoTelemetry ?? true

  let observedTools = 0
  let matchedCalls = 0
  for (const [tool, count] of Object.entries(input.toolHistogram)) {
    const n = Number.isFinite(count) && count > 0 ? count : 0
    observedTools += n
    if (n > 0 && input.matches(tool)) matchedCalls += n
  }

  if (observedTools === 0) {
    return failOpen
      ? {
          applied: true,
          gated: false,
          reason: 'no tool telemetry captured — fail-open (not quarantined)',
          matchedCalls: 0,
          observedTools: 0,
        }
      : {
          applied: false,
          gated: true,
          reason: 'no tool telemetry captured — fail-closed',
          matchedCalls: 0,
          observedTools: 0,
        }
  }

  if (matchedCalls === 0) {
    return {
      applied: false,
      gated: true,
      reason: `treatment tool never fired (${observedTools} tool calls, 0 matched)`,
      matchedCalls: 0,
      observedTools,
    }
  }

  return { applied: true, gated: false, matchedCalls, observedTools }
}

/**
 * Convenience: gate from an already-computed `BehavioralMetrics` (the common
 * case — analysts already hold `computeTraceMetrics(spans)` for the run). Reads
 * the metrics' `toolHistogram`; does no re-derivation.
 */
export function gateTreatmentFromMetrics(
  metrics: Pick<BehavioralMetrics, 'toolHistogram'>,
  matches: ToolMatcher,
  opts?: TreatmentGateOptions,
): TreatmentGate {
  return gateTreatmentApplied({ toolHistogram: metrics.toolHistogram, matches }, opts)
}

/**
 * Convenience: gate directly from analyst spans, reusing the substrate's
 * deterministic histogram builder. For callers holding the trace store's typed
 * `ToolSpan[]` instead, see {@link gateTreatmentFromToolSpans}.
 */
export function gateTreatmentFromSpans(
  spans: readonly TraceAnalystSpan[],
  matches: ToolMatcher,
  opts?: TreatmentGateOptions,
): TreatmentGate {
  return gateTreatmentFromMetrics(computeTraceMetrics(spans), matches, opts)
}

/**
 * Convenience: gate from the trace store's canonical `ToolSpan[]` (e.g. the
 * result of `toolSpans(store, runId)`). Counts by `toolName` — the typed
 * tool-call field — so it needs no OTLP attribute extraction.
 */
export function gateTreatmentFromToolSpans(
  toolSpans: readonly ToolSpan[],
  matches: ToolMatcher,
  opts?: TreatmentGateOptions,
): TreatmentGate {
  const toolHistogram: Record<string, number> = {}
  for (const s of toolSpans) {
    if (s.toolName) toolHistogram[s.toolName] = (toolHistogram[s.toolName] ?? 0) + 1
  }
  return gateTreatmentApplied({ toolHistogram, matches }, opts)
}

/** Measurable runs count toward the objective; treatment-not-applied runs are
 *  excluded (like infra-loss), NOT counted as treatment failures. This is a
 *  partition over the existing exclusion-flag pattern — it adds no new
 *  classification enum. */
export type TreatmentClass = 'measurable' | 'treatment-not-applied'

/**
 * Map a gate verdict onto a single measurable-vs-excluded label keyed on a
 * `RunRecord`, so consumers (paired A/B filters, reporters) read the partition
 * in one place instead of re-implementing the fail-open guard inline. The
 * `RunRecord` is accepted so callers key on the canonical run row, mirroring
 * how `outcome.realness.gated` rides along on the record; the verdict itself is
 * the gate's, not re-derived here.
 */
export function classifyTreatment(_record: RunRecord, gate: TreatmentGate): TreatmentClass {
  return gate.gated ? 'treatment-not-applied' : 'measurable'
}
