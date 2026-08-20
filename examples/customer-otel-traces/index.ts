/**
 * Analyze production OpenTelemetry traces.
 *
 * Run with: pnpm tsx examples/customer-otel-traces/index.ts
 *
 * Synthesises 40 production agent runs as OTel `TraceSpanEvent[]`, runs them
 * through `fromOtelSpans()` to get RunRecord[], then calls analyzeRuns().
 * No improvement loop is required. This is the first path for teams with logs but
 * no eval discipline.
 */

import { analyzeRuns, fromOtelSpans } from '../../src/contract'
import type { TraceSpanEvent } from '../../src/hosted/types'

const N_RUNS = 40

function synthesise(): TraceSpanEvent[] {
  const spans: TraceSpanEvent[] = []
  for (let i = 0; i < N_RUNS; i++) {
    const runId = `run-${i + 1}`
    const failed = i % 7 === 0 // ~14% failure rate
    const baseTime = 1_700_000_000_000_000_000n + BigInt(i) * 1_000_000_000n
    const duration = BigInt(Math.floor(pseudoRand(`${runId}d`) * 5_000_000_000))
    const cost = 0.05 + pseudoRand(runId) * 0.12 // $0.05 .. $0.17
    const score = failed
      ? 0.2 + pseudoRand(`${runId}s`) * 0.2
      : 0.6 + pseudoRand(`${runId}s`) * 0.35
    const inputTokens = 800 + Math.floor(pseudoRand(`${runId}i`) * 1400)
    const outputTokens = 200 + Math.floor(pseudoRand(`${runId}o`) * 600)

    spans.push({
      traceId: `trace-${i}`,
      spanId: `span-root-${i}`,
      name: failed && i % 14 === 0 ? 'tool.search' : 'agent.turn',
      startTimeUnixNano: baseTime.toString(),
      endTimeUnixNano: (baseTime + duration).toString(),
      attributes: {
        'tangle.runId': runId,
        'tangle.model': 'deepseek-v4-flash@2026-07-01',
        'tangle.cost.usd': cost,
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokens,
        'tangle.score': score,
      },
      status: { code: failed ? 'ERROR' : 'OK' },
    })
  }
  return spans
}

function pseudoRand(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 0) / 0xffffffff
}

function formatMetric(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits)
}

function formatUsd(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(3)}`
}

async function main() {
  const spans = synthesise()
  const runs = fromOtelSpans({ spans })
  const report = await analyzeRuns({ runs })

  console.log('Production trace report')
  console.log()
  console.log(`Runs analyzed:     ${report.n}`)
  console.log(
    `Composite mean:    ${formatMetric(report.composite.mean)} ` +
      `(p50: ${formatMetric(report.composite.p50)}, ` +
      `p95: ${formatMetric(report.composite.p95)}, ` +
      `stddev: ${formatMetric(report.composite.stddev)})`,
  )
  console.log(
    `Cost mean:         ${formatUsd(report.costQuality.cost.mean)} ` +
      `(p95: ${formatUsd(report.costQuality.cost.p95)})`,
  )
  console.log()

  // Failure surface: the intake counts error spans per run; the report's
  // recommendations name the dominant failure class.
  const failed = runs.filter((r) => Number(r.outcome.raw.error_span_count ?? 0) > 0)
  console.log(`Runs with error spans: ${failed.length}`)
  console.log()

  console.log('Cost and quality')
  console.log(
    `${report.costQuality.pareto.points.length} candidate(s) plotted; ` +
      `${report.costQuality.pareto.points.filter((p) => p.onFrontier).length} on the frontier`,
  )
  for (const p of report.costQuality.pareto.points) {
    console.log(
      `  ${p.candidateId}: cost=$${p.cost.toFixed(3)} quality=${p.quality.toFixed(3)}` +
        `${p.onFrontier ? '  (frontier)' : ''}`,
    )
  }
  console.log()

  console.log('Recommendations')
  if (report.recommendations.length === 0) console.log('(none)')
  for (const r of report.recommendations) {
    console.log(`[${r.priority}] ${r.kind}: ${r.title}`)
    console.log(`  ${r.detail}`)
  }
  console.log()
  console.log('End')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
