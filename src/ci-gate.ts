/**
 * CI gate — evaluate a corpus against threshold contracts and generate
 * a human-readable PR/build comment.
 *
 * Three layers:
 *   1. `ThresholdContract` declarations (YAML-equivalent TS objects)
 *   2. `evaluateContract` runs the contracts against a TraceStore and
 *      returns a structured report + overall pass/fail.
 *   3. `renderMarkdownReport` formats the report for GitHub PR comments.
 *
 * Consumers wrap this in their own `gh pr comment` / CI integration —
 * we don't ship the GitHub Action binary, just the library call that
 * the action invokes.
 *
 * ## Missing measurements are missing data
 *
 * `extractAll` returns only the runs that reported a finite value for a
 * declared metric. Without a coverage check that set is a SILENT FILTER: a run
 * that crashed, timed out, or simply never emitted the metric left the
 * comparison, and the verdict was computed over whatever survived. Worse, a
 * metric with fewer than two comparable samples was dropped WHOLE, and `pass`
 * was `breaches.length === 0` — so a corpus where nothing was measurable
 * returned `pass: true` with an empty breach list. Measured on the pre-0.134
 * gate: a candidate that reported `score` on 3 of 10 runs passed with verdict
 * "improved" at `candidateMean` 0.99 read off those 3 runs; the same candidate
 * reporting it on 0 of 10 ALSO passed, with `hasUnstable: true` computed and
 * never consulted.
 *
 * The contract now measures COVERAGE per metric before any verdict is read:
 * `answered / dealt` across both arms must reach `minCoverage` (default 1) or
 * the metric breaches by name, with the ratio in the message. Too few
 * comparable samples breaches as well, so a dropped metric can no longer leave
 * `breaches` empty, and a contract that declares neither a metric nor an SLO
 * asserts nothing and cannot pass. `ContractReport.coverage` reports the full
 * accounting on EVERY path, passing or not.
 *
 * A metric whose verdict is `unstable` is deliberately NOT a breach: that is a
 * measurement that happened and came back noisy, not a measurement that is
 * missing. It is reported on `baselineReport.hasUnstable` for a caller who
 * wants to treat it as blocking.
 */

import type { BaselineReport } from './baseline'
import { compareToBaseline, type MetricSamples } from './baseline'
import { checkSlos, type Slo, type SloReport } from './slo'
import { aggregateLlm, llmSpans, runFailureClass } from './trace/query'
import type { Run } from './trace/schema'
import type { RunFilter, TraceStore } from './trace/store'

export interface ContractMetric {
  /** Metric id matching either a predefined key or a custom extractor. */
  metric: string
  higherIsBetter: boolean
  /** Max tolerated regression (e.g. 0.02 = 2pp worse than baseline). */
  maxRegression?: number
  /** Optional extractor if the metric isn't in the default set. */
  extract?: (run: Run, store: TraceStore) => Promise<number | null>
}

export interface ThresholdContract {
  name: string
  baseline: RunFilter
  candidate: RunFilter
  metrics: ContractMetric[]
  slos?: Slo[]
  /**
   * Smallest acceptable `answered / dealt` fraction per declared metric, across
   * both arms. Default 1: every run the contract was dealt must report every
   * declared metric before the contract can pass on it.
   *
   * The default is 1 because a run that reported nothing is missing data, and a
   * verdict computed over "the runs that happened to report" is a verdict
   * computed over a set the candidate selected by failing. Below `minCoverage`
   * the metric breaches by name with the ratio in the message.
   *
   * Lowering it is a real, defensible choice for a caller who accepts a known
   * flake rate — but it must be DECLARED, not inherited: the shrunken
   * denominator then still ships in `ContractReport.coverage`, so the verdict
   * can never be read without it. Must be in [0, 1]; anything else throws
   * rather than clamping.
   */
  minCoverage?: number
}

/**
 * How many of the runs a contract was DEALT actually reported one declared
 * metric. A contract can only pass on the runs it measured, so the ratio ships
 * with the verdict rather than being inferable only from a missing table row.
 */
export interface ContractMetricCoverage {
  metric: string
  /** Baseline runs the contract was dealt. */
  baselineDealt: number
  /** Baseline runs that reported a finite value for this metric. */
  baselineAnswered: number
  /** Candidate runs the contract was dealt. */
  candidateDealt: number
  /** Candidate runs that reported a finite value for this metric. */
  candidateAnswered: number
  /** `answered / dealt` across both arms, or 0 when nothing was dealt. 1 means
   *  every dealt run reported this metric on both arms. */
  coverage: number
}

export interface ContractReport {
  name: string
  baselineReport: BaselineReport
  sloReport?: SloReport
  /** Measured / dealt runs per declared metric — the denominator, stated. */
  coverage: ContractMetricCoverage[]
  breaches: string[]
  pass: boolean
}

export async function evaluateContract(
  store: TraceStore,
  contract: ThresholdContract,
): Promise<ContractReport> {
  if (
    contract.minCoverage !== undefined &&
    !(
      Number.isFinite(contract.minCoverage) &&
      contract.minCoverage >= 0 &&
      contract.minCoverage <= 1
    )
  ) {
    throw new Error(
      `evaluateContract: minCoverage must be a finite fraction in [0, 1], got ${contract.minCoverage}`,
    )
  }
  const minCoverage = contract.minCoverage ?? 1
  const baselineRuns = await store.listRuns(contract.baseline)
  const candidateRuns = await store.listRuns(contract.candidate)
  if (candidateRuns.length === 0) {
    return {
      name: contract.name,
      baselineReport: { metrics: [], hasRegression: false, hasUnstable: true },
      coverage: [],
      breaches: ['no candidate runs matched'],
      pass: false,
    }
  }

  const samples: MetricSamples[] = []
  const coverage: ContractMetricCoverage[] = []
  // A run that reported no value for a declared metric is missing DATA, not an
  // absent run. Skipping it shrinks the denominator to the runs that reported,
  // and skipping the whole metric used to leave `breaches` empty — so a corpus
  // where nothing was measurable returned `pass: true`. Both are recorded here
  // and both breach.
  const unmeasured: string[] = []
  for (const m of contract.metrics) {
    const extract = m.extract ?? defaultExtract(m.metric)
    const baseline = await extractAll(baselineRuns, extract, store)
    const candidate = await extractAll(candidateRuns, extract, store)
    const dealt = baselineRuns.length + candidateRuns.length
    const cov: ContractMetricCoverage = {
      metric: m.metric,
      baselineDealt: baselineRuns.length,
      baselineAnswered: baseline.length,
      candidateDealt: candidateRuns.length,
      candidateAnswered: candidate.length,
      coverage: dealt === 0 ? 0 : (baseline.length + candidate.length) / dealt,
    }
    coverage.push(cov)
    if (cov.coverage < minCoverage) {
      unmeasured.push(
        `metric "${m.metric}" was measured on ${candidate.length}/${candidateRuns.length} candidate ` +
          `and ${baseline.length}/${baselineRuns.length} baseline run(s) (coverage ${cov.coverage.toFixed(4)}, ` +
          `required ${minCoverage.toFixed(4)}) — an unmeasured run cannot be compared, so the contract ` +
          'cannot pass on the subset that reported',
      )
      continue
    }
    if (baseline.length < 2 || candidate.length < 2) {
      unmeasured.push(
        `metric "${m.metric}" has too few comparable samples (baseline ${baseline.length}, ` +
          `candidate ${candidate.length}; need ≥2 per arm) — no verdict is available for it`,
      )
      continue
    }
    samples.push({ metric: m.metric, higherIsBetter: m.higherIsBetter, baseline, candidate })
  }

  const baselineReport =
    samples.length >= 1
      ? compareToBaseline(samples)
      : { metrics: [], hasRegression: false, hasUnstable: samples.length === 0 }

  // SLO evaluation against candidate-side aggregate metrics
  let sloReport: SloReport | undefined
  if (contract.slos && contract.slos.length > 0) {
    const agg = await aggregateRunMetrics(candidateRuns, store)
    sloReport = checkSlos(agg, contract.slos)
  }

  const breaches: string[] = [...unmeasured]
  // A contract that declares neither a metric nor an SLO asserts nothing. It
  // used to return `pass: true` on an empty breach list, which is the same
  // silent pass one level up: no evidence is not evidence of no problem.
  if (contract.metrics.length === 0 && (contract.slos ?? []).length === 0) {
    breaches.push(
      'contract declares no metrics and no SLOs — nothing was asserted, so nothing can pass',
    )
  }
  for (const metric of baselineReport.metrics) {
    const decl = contract.metrics.find((m) => m.metric === metric.metric)
    if (!decl) continue
    if (metric.verdict === 'regressed') {
      const magnitude = Math.abs(metric.delta)
      if (decl.maxRegression === undefined || magnitude > decl.maxRegression) {
        breaches.push(
          `metric "${metric.metric}" regressed by ${metric.delta.toFixed(4)} (d=${formatEffectSize(metric.cohensD)}, p=${metric.welchP.toExponential(2)})`,
        )
      }
    }
  }
  if (sloReport) {
    for (const r of sloReport.criticalBreaches) {
      breaches.push(`SLO "${r.slo.id}" breached: ${r.detail}`)
    }
  }

  return {
    name: contract.name,
    baselineReport,
    sloReport,
    coverage,
    breaches,
    pass: breaches.length === 0,
  }
}

export function renderMarkdownReport(reports: ContractReport[]): string {
  const lines: string[] = []
  const overall = reports.every((r) => r.pass)
  lines.push(overall ? '## ✅ agent-eval gate: pass' : '## ❌ agent-eval gate: fail')
  lines.push('')
  for (const r of reports) {
    lines.push(`### ${r.name} ${r.pass ? '✅' : '❌'}`)
    if (r.breaches.length > 0) {
      lines.push('')
      lines.push('**Breaches:**')
      for (const b of r.breaches) lines.push(`- ${b}`)
    }
    // Never a silent 0 — a shrunken denominator has to say by how much.
    const partial = r.coverage.filter(
      (c) => c.baselineAnswered < c.baselineDealt || c.candidateAnswered < c.candidateDealt,
    )
    if (partial.length > 0) {
      lines.push('')
      lines.push('**Coverage (measured / dealt runs):**')
      for (const c of partial) {
        lines.push(
          `- ${c.metric}: candidate ${c.candidateAnswered}/${c.candidateDealt}, baseline ${c.baselineAnswered}/${c.baselineDealt}`,
        )
      }
    }
    if (r.baselineReport.metrics.length > 0) {
      lines.push('')
      lines.push('| metric | baseline | candidate | Δ | Cohen d | p | verdict |')
      lines.push('|---|---|---|---|---|---|---|')
      for (const m of r.baselineReport.metrics) {
        lines.push(
          `| ${m.metric} | ${m.baselineMean.toFixed(4)} | ${m.candidateMean.toFixed(4)} | ${m.delta.toFixed(4)} | ${formatEffectSize(m.cohensD)} | ${m.welchP.toExponential(2)} | ${m.verdict} |`,
        )
      }
    }
    if (r.sloReport && r.sloReport.results.length > 0) {
      lines.push('')
      lines.push('**SLO results:**')
      for (const s of r.sloReport.results) {
        lines.push(`- ${s.slo.id} (${s.slo.severity}): ${s.passed ? 'ok' : 'breach'} — ${s.detail}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** Aggregate per-run metrics into the single record expected by `checkSlos`. */
async function aggregateRunMetrics(
  runs: Run[],
  store: TraceStore,
): Promise<Record<string, number>> {
  if (runs.length === 0) return {}
  const durations: number[] = []
  const scores: number[] = []
  const passes: number[] = []
  const costs: number[] = []
  for (const r of runs) {
    if (r.endedAt) durations.push(r.endedAt - r.startedAt)
    if (r.outcome?.score !== undefined) scores.push(r.outcome.score)
    passes.push(r.outcome?.pass === true ? 1 : 0)
    const llm = await llmSpans(store, r.runId)
    costs.push(aggregateLlm(llm).costUsd)
  }
  return {
    provisionMs: average(durations),
    firstTokenMs: average(durations),
    wallMs: average(durations),
    overallScore: average(scores),
    passRate: average(passes),
    costUsd: average(costs),
  }
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Cohen's d is null when both samples are constant with unequal means — an
 *  unbounded effect, which must not be rendered as a number. */
function formatEffectSize(d: number | null): string {
  return d === null ? 'unbounded (zero pooled spread)' : d.toFixed(2)
}

async function extractAll(
  runs: Run[],
  extract: (r: Run, s: TraceStore) => Promise<number | null>,
  store: TraceStore,
): Promise<number[]> {
  const out: number[] = []
  for (const r of runs) {
    const v = await extract(r, store)
    if (v !== null && Number.isFinite(v)) out.push(v)
  }
  return out
}

function defaultExtract(metric: string): (run: Run, store: TraceStore) => Promise<number | null> {
  return async (run, store) => {
    switch (metric) {
      case 'score':
      case 'overallScore':
        return run.outcome?.score ?? null
      case 'pass':
        return run.outcome?.pass === true ? 1 : 0
      case 'durationMs':
        return run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null
      case 'costUsd': {
        const llm = await llmSpans(store, run.runId)
        return aggregateLlm(llm).costUsd
      }
      case 'successClass':
        return runFailureClass(run) === 'success' ? 1 : 0
      default:
        return null
    }
  }
}
