/**
 * ROUND-4 ADVERSARY PROBE J — corroborating the owner's audit on PR #457
 * ("Identical input produced 233 promotions and 267 refusals across 500
 * evaluations because unseeded bootstrap randomness"), independently, at the
 * pushed head 4b94409.
 *
 * `seed` defaults to undefined = Math.random, and the promotion CI is
 * min(percentile_bootstrap.low, empirical_likelihood.low). Whenever the
 * bootstrap is the binding bound, the verdict inherits its draw.
 *
 * Step 1 searches for such a dataset. Step 2 evaluates it 500 times with the
 * shipped default config.
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

function decide(before: number[], after: number[], thr: number, seed?: number) {
  const { candidate, baseline } = build(before, after)
  return new HeldOutGate({
    baselineKey: 'base',
    pairedDeltaThreshold: thr,
    confidence: 0.95,
    overfitGapThreshold: 1e9,
    ...(seed === undefined ? {} : { seed }),
  }).evaluate(candidate, baseline)
}

// ── step 1: find a dataset whose verdict depends on the bootstrap draw ──
let found: { before: number[]; after: number[]; thr: number; n: number } | null = null
search: for (const thr of [0, -0.05]) {
  for (let trial = 0; trial < 4000 && !found; trial++) {
    const r = lcg(7 + trial * 977)
    const n = 6 + Math.floor(r() * 20)
    const q = 0.05 + r() * 0.2
    const win = 0.005 + r() * 0.02
    const loss = -(0.05 + r() * 0.5)
    const before: number[] = []
    const after: number[] = []
    for (let i = 0; i < n; i++) {
      before.push(0.5)
      after.push(0.5 + (r() < q ? loss : win) + (r() - 0.5) * 2e-4)
    }
    let promotes = 0
    for (let s = 0; s < 24; s++) if (decide(before, after, thr, 1000 + s).promote) promotes++
    if (promotes > 2 && promotes < 22) {
      found = { before, after, thr, n }
      break search
    }
  }
}

if (!found) {
  console.log('no seed-sensitive dataset found in the search space')
} else {
  const { before, after, thr, n } = found
  const deltas = before.map((b, i) => after[i]! - b)
  const mean = deltas.reduce((s, d) => s + d, 0) / n
  const neg = deltas.filter((d) => d < 0).length
  console.log(
    `dataset: n=${n}, ${n - neg} small gains, ${neg} losses, mean paired Δ=${mean.toFixed(5)}, threshold ${thr}`,
  )
  const sample = decide(before, after, thr, 1000)
  console.log(`intervalMethods: ${JSON.stringify(sample.evidence.intervalMethods)}`)
  console.log()

  // ── step 2: the SHIPPED default — no seed at all ──
  const REPS = 500
  let promoted = 0
  let lowMin = Number.POSITIVE_INFINITY
  let lowMax = Number.NEGATIVE_INFINITY
  for (let i = 0; i < REPS; i++) {
    const d = decide(before, after, thr, undefined)
    if (d.promote) promoted++
    lowMin = Math.min(lowMin, d.evidence.pairedCI!.low)
    lowMax = Math.max(lowMax, d.evidence.pairedCI!.low)
  }
  console.log(
    `DEFAULT CONFIG (no seed => Math.random), same input evaluated ${REPS} times:\n` +
      `  promote=true  ${promoted}\n` +
      `  promote=false ${REPS - promoted}\n` +
      `  CI.low ranged ${lowMin.toFixed(6)} … ${lowMax.toFixed(6)} across identical input`,
  )
}
