/**
 * ROUND-4 ADVERSARY PROBE D — type-I error at the DEFAULT threshold, on a
 * SKEWED null.
 *
 * The gate's veto is the sign-flip permutation test. Sign-flipping is a valid
 * level-α test of "the paired deltas are symmetric about 0", NOT of "the mean
 * paired delta is 0". The two coincide only for symmetric distributions. So a
 * null that is skewed — many small wins, rare large losses, true mean exactly
 * zero — is outside what either the veto or a range-bounded interval can see.
 *
 * The author measured boundary type-I at a NEGATIVE margin (−0.05) with one
 * loss magnitude, and at +0.05. This measures the shipped default: threshold 0,
 * confidence 0.95, deltaStatistic 'mean', on a null with skew.
 *
 * Everything is deterministic given the rep index (seeded LCG), so this
 * reruns byte-identically.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { build } from './fixtures'

function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

type Null = { label: string; draw: (r: () => number) => number }

const JITTER = 1e-4

const nulls: Null[] = [
  {
    // symmetric control: mean 0, sign-flip test is exactly valid here
    label: 'symmetric  ±0.03 (control)',
    draw: (r) => (r() < 0.5 ? 0.03 : -0.03) + (r() - 0.5) * 2 * JITTER,
  },
  {
    // 90% small wins / 10% big losses, mean exactly 0
    label: 'skew q=0.10  +0.01 / −0.09',
    draw: (r) => (r() < 0.1 ? -0.09 : 0.01) + (r() - 0.5) * 2 * JITTER,
  },
  {
    // 95% small wins / 5% big losses, mean exactly 0
    label: 'skew q=0.05  +0.01 / −0.19',
    draw: (r) => (r() < 0.05 ? -0.19 : 0.01) + (r() - 0.5) * 2 * JITTER,
  },
  {
    // mirror image: rare big wins, common small losses. mean exactly 0.
    label: 'skew q=0.10  −0.01 / +0.09',
    draw: (r) => (r() < 0.1 ? 0.09 : -0.01) + (r() - 0.5) * 2 * JITTER,
  },
]

const REPS = 2000
const NOMINAL = 0.05

console.log(
  `Repeated sampling under H0 (true mean paired delta = 0 exactly).\n` +
    `threshold 0, confidence 0.95, deltaStatistic 'mean', all other defaults.\n` +
    `${REPS} reps per cell. Nominal one-sided type-I ceiling: ${(NOMINAL * 100).toFixed(1)}%.\n`,
)
console.log('null                          n     promoted/reps   type-I    verdict')
for (const nul of nulls) {
  for (const n of [26, 76, 200]) {
    let promoted = 0
    let indeterminate = 0
    for (let rep = 0; rep < REPS; rep++) {
      const r = lcg(1000003 * (rep + 1) + n)
      const before: number[] = []
      const after: number[] = []
      for (let i = 0; i < n; i++) {
        const b = 0.5
        before.push(b)
        after.push(b + nul.draw(r))
      }
      const { candidate, baseline } = build(before, after)
      const g = new HeldOutGate({
        baselineKey: 'base',
        pairedDeltaThreshold: 0,
        confidence: 0.95,
        seed: 4242 + rep,
        overfitGapThreshold: 1e9,
      })
      const d = g.evaluate(candidate, baseline)
      if (d.promote) promoted++
      if (d.rejectionCode === 'indeterminate_delta') indeterminate++
    }
    const rate = promoted / REPS
    console.log(
      `${nul.label.padEnd(28)} ${String(n).padStart(3)}   ${String(promoted).padStart(5)}/${REPS}      ` +
        `${(rate * 100).toFixed(1).padStart(5)}%   ${rate > NOMINAL ? `OVER NOMINAL (${(rate / NOMINAL).toFixed(1)}x)` : 'ok'}` +
        (indeterminate ? `   [${indeterminate} indeterminate]` : ''),
    )
  }
}
