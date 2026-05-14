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
}

export interface ContractReport {
  name: string
  baselineReport: BaselineReport
  sloReport?: SloReport
  breaches: string[]
  pass: boolean
}

export async function evaluateContract(
  store: TraceStore,
  contract: ThresholdContract,
): Promise<ContractReport> {
  const baselineRuns = await store.listRuns(contract.baseline)
  const candidateRuns = await store.listRuns(contract.candidate)
  if (candidateRuns.length === 0) {
    return {
      name: contract.name,
      baselineReport: { metrics: [], hasRegression: false, hasUnstable: true },
      breaches: ['no candidate runs matched'],
      pass: false,
    }
  }

  const samples: MetricSamples[] = []
  for (const m of contract.metrics) {
    const extract = m.extract ?? defaultExtract(m.metric)
    const baseline = await extractAll(baselineRuns, extract, store)
    const candidate = await extractAll(candidateRuns, extract, store)
    if (baseline.length < 2 || candidate.length < 2) continue
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

  const breaches: string[] = []
  for (const metric of baselineReport.metrics) {
    const decl = contract.metrics.find((m) => m.metric === metric.metric)
    if (!decl) continue
    if (metric.verdict === 'regressed') {
      const magnitude = Math.abs(metric.delta)
      if (decl.maxRegression === undefined || magnitude > decl.maxRegression) {
        breaches.push(
          `metric "${metric.metric}" regressed by ${metric.delta.toFixed(4)} (d=${metric.cohensD.toFixed(2)}, p=${metric.welchP.toExponential(2)})`,
        )
      }
    }
  }
  if (sloReport) {
    for (const r of sloReport.criticalBreaches) {
      breaches.push(`SLO "${r.slo.id}" breached: ${r.detail}`)
    }
  }

  return { name: contract.name, baselineReport, sloReport, breaches, pass: breaches.length === 0 }
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
    if (r.baselineReport.metrics.length > 0) {
      lines.push('')
      lines.push('| metric | baseline | candidate | Δ | Cohen d | p | verdict |')
      lines.push('|---|---|---|---|---|---|---|')
      for (const m of r.baselineReport.metrics) {
        lines.push(
          `| ${m.metric} | ${m.baselineMean.toFixed(4)} | ${m.candidateMean.toFixed(4)} | ${m.delta.toFixed(4)} | ${m.cohensD.toFixed(2)} | ${m.welchP.toExponential(2)} | ${m.verdict} |`,
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
