/**
 * ROUND-4 ADVERSARY PROBE K — the owner's PR-#457 closing claim, checked at the
 * pushed head: "24.75% false promotion at n=3 on a paired-binary
 * noninferiority boundary".
 *
 * `minProductiveRuns` defaults to 3, `bench/rung2` ships
 * `pairedDeltaThreshold: -0.05`, and at a negative threshold the sign-flip veto
 * is switched off by construction. This enumerates EVERY binary outcome of 3
 * pairs exactly (no sampling) and reports which ones promote, then weights them
 * by the null that makes the true risk difference equal the margin.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { build } from './fixtures'

function decide(before: number[], after: number[], thr: number) {
  const { candidate, baseline } = build(before, after)
  return new HeldOutGate({
    baselineKey: 'base',
    pairedDeltaThreshold: thr,
    confidence: 0.95,
    seed: 1337,
    overfitGapThreshold: 1e9,
  }).evaluate(candidate, baseline)
}

const THR = -0.05
console.log(`n=3, binary {0,1}, threshold ${THR}, confidence 0.95, seed fixed, all other defaults.`)
console.log('Enumerating all 4^3 = 64 (baseline, candidate) pass/fail patterns.\n')
console.log('pattern (b→c per pair)        deltas          promote  code                  trueΔ')

let promotedPatterns = 0
let promotedWithNegativeMean = 0
const rows: string[] = []
for (let mask = 0; mask < 64; mask++) {
  const before: number[] = []
  const after: number[] = []
  for (let i = 0; i < 3; i++) {
    before.push((mask >> (2 * i)) & 1)
    after.push((mask >> (2 * i + 1)) & 1)
  }
  const d = decide(before, after, THR)
  const deltas = before.map((b, i) => after[i]! - b)
  const mean = deltas.reduce((s, x) => s + x, 0) / 3
  if (d.promote) {
    promotedPatterns++
    if (mean < THR) promotedWithNegativeMean++
    rows.push(
      `${before.map((b, i) => `${b}→${after[i]}`).join(' ').padEnd(28)} ` +
        `[${deltas.map((x) => String(x).padStart(2)).join(',')}]   ` +
        `${String(d.promote).padEnd(7)} ${String(d.rejectionCode ?? 'null').padEnd(20)} ${mean.toFixed(4)}` +
        (mean < THR ? '   <<< PROMOTED BELOW THE MARGIN' : ''),
    )
  }
}
for (const r of rows) console.log(r)
console.log(
  `\n${promotedPatterns} of 64 patterns promote; ${promotedWithNegativeMean} of those have a true paired mean Δ strictly below the margin.`,
)

// Weighted false-promotion rate under nulls whose TRUE risk difference equals
// the margin (candidate worse by exactly 0.05 in expectation).
console.log('\nfalse-promotion rate under a null with true RD = the margin (exact enumeration):')
console.log('  tie prob t   win prob w   loss prob l    P(promote)   P(promote & trueΔ<margin)')
for (const t of [0.0, 0.2, 0.4, 0.6, 0.8, 0.9]) {
  const rest = 1 - t
  // w - l = -0.05 (true risk difference = the margin), w + l = rest
  const l = (rest + 0.05) / 2
  const w = rest - l
  if (w < 0 || l < 0) continue
  let pPromote = 0
  let pPromoteBad = 0
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      for (let c = 0; c < 3; c++) {
        const codes = [a, b, c] // 0 = tie, 1 = win, 2 = loss
        const before: number[] = []
        const after: number[] = []
        let prob = 1
        for (const k of codes) {
          if (k === 0) {
            before.push(0)
            after.push(0)
            prob *= t
          } else if (k === 1) {
            before.push(0)
            after.push(1)
            prob *= w
          } else {
            before.push(1)
            after.push(0)
            prob *= l
          }
        }
        if (prob === 0) continue
        const d = decide(before, after, THR)
        const mean = before.reduce((s, x, i) => s + (after[i]! - x), 0) / 3
        if (d.promote) {
          pPromote += prob
          if (mean < THR) pPromoteBad += prob
        }
      }
    }
  }
  console.log(
    `  ${t.toFixed(2).padStart(9)}   ${w.toFixed(4).padStart(9)}   ${l.toFixed(4).padStart(9)}    ` +
      `${(pPromote * 100).toFixed(2).padStart(8)}%   ${(pPromoteBad * 100).toFixed(2).padStart(8)}%`,
  )
}
