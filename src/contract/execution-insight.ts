/** Runtime usage, terminal outcomes, execution errors, and cost capture facts. */

import {
  type RunRecord,
  type RunTerminalOutcome,
  type RunTokenUsage,
  validateRunRecord,
} from '../run-record'
import type { CostProvenanceSummary, ExecutionInsight, TokenUsageInsight } from './insight-report'
import { distributionOf } from './quality-insight'

export interface SummarizeExecutionOptions {
  runs: RunRecord[]
  histogramBins?: number
}

export interface ExecutionReport {
  execution: ExecutionInsight
  costProvenance: CostProvenanceSummary
}

/** Summarize runtime facts without interpreting task quality or promotion readiness. */
export function summarizeExecution(opts: SummarizeExecutionOptions): ExecutionReport {
  const runs = opts.runs.map(validateRunRecord)
  const bins = opts.histogramBins ?? 12
  return {
    execution: computeExecutionInsight(runs, bins),
    costProvenance: summarizeCostProvenance(runs),
  }
}

function computeExecutionInsight(runs: RunRecord[], bins: number): ExecutionInsight {
  const aggregateRows = runs.flatMap((run) => {
    const usage = aggregateTokenUsage(run)
    return usage ? [{ usage, costUsd: finiteRaw(run, 'aggregate_cost_usd') }] : []
  })
  const aggregateCosts = aggregateRows.flatMap((row) =>
    row.costUsd !== undefined ? [row.costUsd] : [],
  )
  const modelCounts = new Map<string, number>()
  let executionErrorRuns = 0
  let executionErrorEvents = 0
  let errorReportingRuns = 0
  let errorSpanEvents = 0
  let errorSpanReportingRuns = 0
  const terminalOutcomes: Record<RunTerminalOutcome, number> = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    incomplete: 0,
    unknown: 0,
  }
  const errorsByTerminalOutcome: ExecutionInsight['executionErrors']['byTerminalOutcome'] = {
    succeeded: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    failed: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    cancelled: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    incomplete: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    unknown: { withErrors: 0, withoutErrors: 0, unreported: 0 },
  }
  let modelCallRuns = 0
  let modelCallEvents = 0
  let modelCallReportingRuns = 0

  for (const run of runs) {
    modelCounts.set(run.model, (modelCounts.get(run.model) ?? 0) + 1)
    const terminalOutcome = run.terminalOutcome
    terminalOutcomes[terminalOutcome] += 1
    const modelCalls = nonNegativeCountRaw(run, 'llm_span_count')
    if (modelCalls !== undefined) {
      modelCallEvents += modelCalls
      modelCallReportingRuns += 1
    }
    const usage = run.tokenUsage
    if (
      (modelCalls ?? 0) > 0 ||
      usage.input > 0 ||
      usage.output > 0 ||
      (usage.cached ?? 0) > 0 ||
      (usage.cacheWrite ?? 0) > 0
    ) {
      modelCallRuns += 1
    }
    const errorEvents = reportedExecutionErrorEvents(run)
    if (errorEvents !== undefined) {
      executionErrorEvents += errorEvents
      errorReportingRuns += 1
      if (errorEvents > 0) {
        executionErrorRuns += 1
        errorsByTerminalOutcome[terminalOutcome].withErrors += 1
      } else errorsByTerminalOutcome[terminalOutcome].withoutErrors += 1
    } else errorsByTerminalOutcome[terminalOutcome].unreported += 1
    const reportedErrorSpans = nonNegativeCountRaw(run, 'error_span_count')
    if (reportedErrorSpans !== undefined) {
      errorSpanEvents += reportedErrorSpans
      errorSpanReportingRuns += 1
    }
  }

  return {
    durationMs: distributionOf(
      runs.map((run) => run.wallMs),
      bins,
    ),
    queueMs: distributionOf(
      runs.filter((run) => run.queueMs !== undefined).map((run) => run.queueMs!),
      bins,
    ),
    tokenUsage: summarizeTokenUsage(
      runs.map((run) => run.tokenUsage),
      bins,
    ),
    aggregateUsage: {
      runs: aggregateRows.length,
      tokenUsage: summarizeTokenUsage(
        aggregateRows.map((row) => row.usage),
        bins,
      ),
      costUsd: distributionOf(aggregateCosts, bins),
      totalCostUsd: aggregateCosts.reduce((total, value) => total + value, 0),
    },
    models: [...modelCounts.entries()]
      .map(([model, count]) => ({ model, runs: count }))
      .sort((left, right) => right.runs - left.runs || left.model.localeCompare(right.model)),
    modelCalls: {
      runs: modelCallRuns,
      events: modelCallEvents,
      reportingRuns: modelCallReportingRuns,
    },
    executionErrors: {
      runs: executionErrorRuns,
      fraction: errorReportingRuns > 0 ? executionErrorRuns / errorReportingRuns : null,
      events: executionErrorEvents,
      reportingRuns: errorReportingRuns,
      errorSpanEvents,
      errorSpanReportingRuns,
      byTerminalOutcome: errorsByTerminalOutcome,
    },
    terminalOutcomes,
  }
}

function reportedExecutionErrorEvents(run: RunRecord): number | undefined {
  return nonNegativeCountRaw(run, 'execution_error_count')
}

function nonNegativeCountRaw(run: RunRecord, key: string): number | undefined {
  const value = finiteRaw(run, key)
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined
}

function summarizeTokenUsage(usages: RunTokenUsage[], bins: number): TokenUsageInsight {
  const reasoning = usages.flatMap((usage) =>
    usage.reasoning !== undefined ? [usage.reasoning] : [],
  )
  const cached = usages.flatMap((usage) => (usage.cached !== undefined ? [usage.cached] : []))
  const cacheWrite = usages.flatMap((usage) =>
    usage.cacheWrite !== undefined ? [usage.cacheWrite] : [],
  )
  return {
    input: distributionOf(
      usages.map((usage) => usage.input),
      bins,
    ),
    output: distributionOf(
      usages.map((usage) => usage.output),
      bins,
    ),
    reasoning: distributionOf(reasoning, bins),
    cached: distributionOf(cached, bins),
    cacheWrite: distributionOf(cacheWrite, bins),
    totals: {
      input: usages.reduce((total, usage) => total + usage.input, 0),
      output: usages.reduce((total, usage) => total + usage.output, 0),
      reasoning: reasoning.reduce((total, value) => total + value, 0),
      cached: cached.reduce((total, value) => total + value, 0),
      cacheWrite: cacheWrite.reduce((total, value) => total + value, 0),
    },
  }
}

function aggregateTokenUsage(run: RunRecord): RunTokenUsage | undefined {
  const input = finiteRaw(run, 'aggregate_prompt_tokens')
  const output = finiteRaw(run, 'aggregate_completion_tokens')
  const reasoning = finiteRaw(run, 'aggregate_reasoning_tokens')
  const cached = finiteRaw(run, 'aggregate_cached_tokens')
  const cacheWrite = finiteRaw(run, 'aggregate_cache_write_tokens')
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cached === undefined &&
    cacheWrite === undefined
  )
    return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  }
}

function finiteRaw(run: RunRecord, key: string): number | undefined {
  const value = run.outcome.raw[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function summarizeCostProvenance(runs: RunRecord[]): CostProvenanceSummary {
  const summary: CostProvenanceSummary = {
    observed: { n: 0, totalUsd: 0 },
    estimated: { n: 0, totalUsd: 0 },
    lowerBound: { n: 0, floorUsd: 0 },
    uncaptured: { n: 0 },
    knownFraction: 0,
  }
  for (const run of runs) {
    const cost = run.costProvenance
    if (cost.kind === 'uncaptured') {
      summary.uncaptured.n += 1
    } else if (cost.kind === 'lower-bound') {
      summary.lowerBound.n += 1
      summary.lowerBound.floorUsd += cost.knownLowerBoundUsd
    } else {
      summary[cost.kind].n += 1
      summary[cost.kind].totalUsd += cost.usd
    }
  }
  const known = summary.observed.n + summary.estimated.n
  summary.knownFraction = runs.length > 0 ? known / runs.length : 0
  return summary
}

export function diagnoseCostCoverage(runs: RunRecord[], provenance: CostProvenanceSummary): string {
  const unknown = provenance.uncaptured.n + provenance.lowerBound.n
  const known = provenance.observed.n + provenance.estimated.n
  const floor =
    provenance.lowerBound.n > 0
      ? ` (${provenance.lowerBound.n} of them cost at least $${provenance.lowerBound.floorUsd.toFixed(6)} together)`
      : ''
  if (unknown === runs.length) {
    return `USD cost total unknown for all ${runs.length} runs${floor} — no observed or estimated USD values; token and wall-time metrics remain available.`
  }
  return `USD cost total unknown for ${unknown}/${runs.length} runs${floor}; excluded those rows from cost statistics (${known}/${runs.length} retained: ${provenance.observed.n} observed, ${provenance.estimated.n} estimated).`
}
