/**
 * ROUND-4 ADVERSARY PROBE A — the documented invariant on `deltaStatistic:'median'`.
 *
 * held-out-gate.ts:144-145 says of the median escape hatch:
 *   "the sign-flip veto and the fail-closed rule still apply, so it can
 *    only make the gate stricter than the default, never blinder."
 *
 * Test that claim directly: same data, deltaStatistic 'mean' vs 'median',
 * across thresholds. A row where median promotes and mean refuses falsifies it.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { build, f } from './fixtures'

function ev(deltasBefore: number[], deltasAfter: number[], thr: number, stat: 'mean' | 'median') {
  const { candidate, baseline } = build(deltasBefore, deltasAfter)
  const g = new HeldOutGate({
    baselineKey: 'base',
    pairedDeltaThreshold: thr,
    confidence: 0.95,
    seed: 1234,
    overfitGapThreshold: 1e9,
    deltaStatistic: stat,
  })
  return g.evaluate(candidate, baseline)
}

// 20 items improve by a hair; 6 items collapse completely.
// True mean delta is a catastrophic regression; the median is a small gain.
const before: number[] = []
const after: number[] = []
for (let i = 0; i < 20; i++) {
  before.push(0.5)
  after.push(0.5 + 0.01 + i * 0.0005) // +0.0100 … +0.0195, all distinct
}
for (let i = 0; i < 6; i++) {
  before.push(1.0)
  after.push(0.0) // −1.0 each
}
const deltas = before.map((b, i) => after[i]! - b)
const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length
const sorted = [...deltas].sort((a, b) => a - b)
const med = (sorted[12]! + sorted[13]!) / 2
console.log(`n=${deltas.length}  MEAN delta=${mean.toFixed(4)}  MEDIAN delta=${med.toFixed(4)}`)
console.log(`  (20 pairs improve by ~+0.015, 6 pairs collapse by −1.0)`)
console.log()
console.log('thr     stat     promote  code                 CI                       decidingΔ  signFlipP')
for (const thr of [0, -0.05, -0.2]) {
  for (const stat of ['mean', 'median'] as const) {
    const d = ev(before, after, thr, stat)
    const e = d.evidence
    console.log(
      `${String(thr).padStart(6)}  ${stat.padEnd(7)} ${String(d.promote).padEnd(8)} ` +
        `${String(d.rejectionCode ?? 'null').padEnd(20)} ` +
        `[${f(e.pairedCI?.low)},${f(e.pairedCI?.high)}]  ${f(e.decidingDelta)}  ` +
        `${e.signFlip ? e.signFlip.pValue.toExponential(2) : 'n/a'}`,
    )
  }
}
console.log()
console.log('methods used, median path:', JSON.stringify(ev(before, after, 0, 'median').evidence.intervalMethods))
console.log('methods used, mean   path:', JSON.stringify(ev(before, after, 0, 'mean').evidence.intervalMethods))
console.log()
console.log('reason (median, thr=0):', ev(before, after, 0, 'median').reason)
