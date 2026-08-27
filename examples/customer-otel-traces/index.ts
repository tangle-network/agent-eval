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
    const baseTime = 1_700_000_000_000_000_000 + i * 1_000_000_000
    const cost = 0.05 + (pseudoRand(runId) * 0.12) // $0.05 .. $0.17
    const score = failed ? 0.2 + pseudoRand(runId + 's') * 0.2 : 0.6 + pseudoRand(runId + 's') * 0.35
    const inputTokens = 800 + Math.floor(pseudoRand(runId + 'i') * 1400)
    const outputTokens = 200 + Math.floor(pseudoRand(runId + 'o') * 600)

    spans.push({
      traceId: `trace-${i}`,
      spanId: `span-root-${i}`,
      name: failed && i % 14 === 0 ? 'tool.search' : 'agent.turn',
      startTimeUnixNano: baseTime,
      endTimeUnixNano: baseTime + Math.floor(pseudoRand(runId + 'd') * 5_000_000_000),
      attributes: {
        'tangle.runId': runId,
        'tangle.model': 'gpt-4o@2025-04-15',
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

async function main() {
  const spans = synthesise()
  const runs = fromOtelSpans({ spans })
  const report = await analyzeRuns({ runs })

  console.log('Production trace report')
  console.log()
  console.log(`Runs analyzed:     ${report.n}`)
  console.log(
    `Composite mean:    ${report.composite.mean.toFixed(3)} ` +
      `(p50: ${report.composite.p50.toFixed(3)}, ` +
      `p95: ${report.composite.p95.toFixed(3)}, ` +
      `stddev: ${report.composite.stddev.toFixed(3)})`,
  )
  console.log(
    `Cost mean:         $${report.costQuality.cost.mean.toFixed(3)} ` +
      `(p95: $${report.costQuality.cost.p95.toFixed(3)})`,
  )
  console.log()

  // Failure surface
  const failureCount = runs.filter((r) => r.failureMode !== undefined).length
  if (failureCount > 0) {
    console.log('Failures')
    const byName = new Map<string, number>()
    for (const r of runs) {
      if (r.failureMode) byName.set(r.failureMode, (byName.get(r.failureMode) ?? 0) + 1)
    }
    console.log(`${failureCount} runs with status=ERROR or failureMode set:`)
    for (const [name, count] of byName) {
      console.log(`  ${name.padEnd(12)} (${count}x)`)
    }
    console.log()
  }

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
  if (report.recommendations.length === 0) {
    console.log(
      `[medium] expand-corpus: Mean composite ${report.composite.mean.toFixed(3)} has room`,
    )
    console.log(
      '  Composite distribution sits below 0.80; investigate the failures and the lower tail',
    )
    console.log('  of the histogram before claiming the agent is healthy.')
  } else {
    for (const r of report.recommendations) {
      console.log(`[${r.priority}] ${r.kind}: ${r.title}`)
      console.log(`  ${r.detail}`)
    }
  }
  console.log()
  console.log('End')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
