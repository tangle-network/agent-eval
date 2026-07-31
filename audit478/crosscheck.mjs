/** Cross-check `pairedRiskDifferenceScore` against the independent scipy
 *  reference in tango_reference.py, and against two analytic identities. */
import { execFileSync } from 'node:child_process'
import { pairedRiskDifferenceScore, mcnemar } from '../dist/index.js'

function armsFrom(b, c, n) {
  const control = []
  const treat = []
  for (let i = 0; i < b; i++) {
    control.push(0)
    treat.push(1)
  }
  for (let i = 0; i < c; i++) {
    control.push(1)
    treat.push(0)
  }
  // Concordant filler, split between pass/pass and fail/fail.
  for (let i = control.length; i < n; i++) {
    const v = i % 2 === 0 ? 1 : 0
    control.push(v)
    treat.push(v)
  }
  return { control, treat }
}

const ref = JSON.parse(
  execFileSync('./clients/python/.venv/bin/python', ['audit478/tango_reference.py'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  }),
)

console.log('=== CROSS-CHECK: pairedRiskDifferenceScore (TS) vs scipy reference (Python) ===')
console.log(
  '  b    c    n |        TS lower        ref lower |        TS upper        ref upper |   max abs diff',
)
let worst = 0
for (const row of ref) {
  const { control, treat } = armsFrom(row.b, row.c, row.n)
  const ts = pairedRiskDifferenceScore(control, treat, 0.95)
  const dLo = Math.abs(ts.lower - row.lower)
  const dHi = Math.abs(ts.upper - row.upper)
  worst = Math.max(worst, dLo, dHi)
  console.log(
    `${String(row.b).padStart(3)}  ${String(row.c).padStart(3)}  ${String(row.n).padStart(3)} | ` +
      `${ts.lower.toFixed(12).padStart(16)} ${row.lower.toFixed(12).padStart(16)} | ` +
      `${ts.upper.toFixed(12).padStart(16)} ${row.upper.toFixed(12).padStart(16)} | ` +
      `${Math.max(dLo, dHi).toExponential(3)}`,
  )
}
console.log(`\n  worst absolute disagreement over ${ref.length} shapes = ${worst.toExponential(3)}\n`)

// Analytic identity 1: at delta = 0 Tango's score reduces to McNemar's normal
// statistic (b-c)/sqrt(b+c), so 0 falls inside the interval exactly when
// |(b-c)/sqrt(b+c)| < 1.96.
console.log('=== IDENTITY: 0 inside the score interval  <=>  |(b-c)/sqrt(b+c)| < z ===')
let identityFailures = 0
for (let b = 0; b <= 12; b++) {
  for (let c = 0; c <= 12; c++) {
    const n = 40
    if (b + c > n) continue
    const { control, treat } = armsFrom(b, c, n)
    const s = pairedRiskDifferenceScore(control, treat, 0.95)
    const m = b + c
    const zStat = m === 0 ? 0 : (b - c) / Math.sqrt(m)
    const containsZero = s.lower <= 0 && s.upper >= 0
    const predicted = Math.abs(zStat) < 1.959963984540054
    if (containsZero !== predicted) {
      identityFailures++
      console.log(`  MISMATCH b=${b} c=${c}: CI=[${s.lower}, ${s.upper}] z=${zStat}`)
    }
  }
}
console.log(`  mismatches over 169 (b,c) shapes at n=40: ${identityFailures}\n`)

// Analytic identity 2: the interval must contain its own point estimate.
console.log('=== IDENTITY: interval contains the point estimate, over 1000 random shapes ===')
let containFailures = 0
let a = 12345
const rnd = () => {
  a = (a + 0x6d2b79f5) >>> 0
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
for (let i = 0; i < 1000; i++) {
  const n = 2 + Math.floor(rnd() * 300)
  const b = Math.floor(rnd() * (n + 1))
  const c = Math.floor(rnd() * (n - b + 1))
  const { control, treat } = armsFrom(b, c, n)
  const s = pairedRiskDifferenceScore(control, treat, 0.95)
  if (!(s.lower <= s.riskDifference + 1e-12 && s.upper >= s.riskDifference - 1e-12)) {
    containFailures++
    if (containFailures < 6) {
      console.log(`  MISMATCH b=${b} c=${c} n=${n}: RD=${s.riskDifference} CI=[${s.lower}, ${s.upper}]`)
    }
  }
}
console.log(`  containment failures over 1000 random shapes: ${containFailures}\n`)
