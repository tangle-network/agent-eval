/**
 * ROUND-4 ADVERSARY PROBE F — config the gate cannot possibly understand.
 *
 * "Unknown must mean no." `deltaStatistic` is typed `'mean' | 'median'`, but
 * types are erased: a JSON config, an env var, a JS caller or a `satisfies`-less
 * object literal can hand it anything. Same for `confidence`.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { build } from './fixtures'

// 26 pairs: 20 tiny gains, 6 collapses. mean −0.2194, median +0.0132.
const before: number[] = []
const after: number[] = []
for (let i = 0; i < 20; i++) {
  before.push(0.5)
  after.push(0.5 + 0.01 + i * 0.0005)
}
for (let i = 0; i < 6; i++) {
  before.push(1.0)
  after.push(0.0)
}

function attempt(label: string, config: Record<string, unknown>) {
  const { candidate, baseline } = build(before, after)
  try {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type
    const g = new HeldOutGate({
      baselineKey: 'base',
      pairedDeltaThreshold: 0,
      seed: 1234,
      overfitGapThreshold: 1e9,
      ...config,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type
    } as any)
    const d = g.evaluate(candidate, baseline)
    const e = d.evidence
    console.log(
      `${label.padEnd(40)} promote=${String(d.promote).padEnd(5)} code=${String(d.rejectionCode ?? 'null').padEnd(20)} ` +
        `stat=${String(e.deltaStatistic).padEnd(8)} Δ=${e.decidingDelta === null ? '  null' : e.decidingDelta.toFixed(4)} ` +
        `CI=[${e.pairedCI ? e.pairedCI.low.toFixed(4) : 'n'},${e.pairedCI ? e.pairedCI.high.toFixed(4) : 'n'}] ` +
        `methods=${e.intervalMethods.map((m) => m.method).join('+') || 'none'}`,
    )
  } catch (err) {
    console.log(`${label.padEnd(40)} THREW: ${(err as Error).message.slice(0, 90)}`)
  }
}

console.log('data: 26 pairs, MEAN delta = -0.2194 (catastrophic), MEDIAN delta = +0.0132\n')
console.log('--- deltaStatistic ---')
attempt('deltaStatistic: undefined (default)', {})
attempt("deltaStatistic: 'mean'", { deltaStatistic: 'mean' })
attempt("deltaStatistic: 'median'", { deltaStatistic: 'median' })
attempt("deltaStatistic: 'Median'  (case typo)", { deltaStatistic: 'Median' })
attempt("deltaStatistic: 'medain'  (typo)", { deltaStatistic: 'medain' })
attempt("deltaStatistic: 'trimmed_mean' (new)", { deltaStatistic: 'trimmed_mean' })
attempt('deltaStatistic: null', { deltaStatistic: null })
attempt('deltaStatistic: 0', { deltaStatistic: 0 })

console.log('\n--- confidence ---')
for (const c of [0.95, 0.5, 0, 1, 95, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  attempt(`confidence: ${String(c)}`, { confidence: c })
}

console.log('\n--- minProductiveRuns / threshold ---')
for (const m of [3, 1, 0, -5, Number.NaN]) {
  attempt(`minProductiveRuns: ${String(m)}`, { minProductiveRuns: m })
}
for (const t of [Number.NaN, Number.NEGATIVE_INFINITY, -0]) {
  attempt(`pairedDeltaThreshold: ${String(t)}`, { pairedDeltaThreshold: t })
}
