/**
 * ATTACKING MY OWN FIX. Each block is a way the new rule could be wrong.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { empiricalLikelihoodMeanInterval, mcnemar, signFlipMeanTest } from '../src/statistics'
import { run } from './fixtures'

// ── A1. The self-check could REFUSE legitimate promotions if the DP and the
//        log-space binomial ever drift apart at large discordant counts.
{
  let worst = 0
  let worstAt = ''
  for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
    for (const bFrac of [0, 0.1, 0.3, 0.5]) {
      const b = Math.round(m * bFrac)
      const c = m - b
      const deltas = [...Array(b).fill(1), ...Array(c).fill(-1), ...Array(7).fill(0)]
      const sf = signFlipMeanTest(deltas)
      const mc = mcnemar(deltas.map((d) => (d < 0 ? 1 : 0)), deltas.map((d) => (d > 0 ? 1 : 0)))
      const diff = Math.abs(sf.pValue - mc.pValue)
      if (diff > worst) { worst = diff; worstAt = `m=${m} b=${b} c=${c} sf=${sf.pValue} mc=${mc.pValue} method=${sf.method}` }
    }
  }
  console.log(`A1 self-check drift: max |signFlip - mcnemar| over m up to 500 = ${worst.toExponential(3)}`)
  console.log(`   worst case: ${worstAt}`)
  console.log(`   gate refuses when this exceeds 1e-9 -> ${worst > 1e-9 ? 'SPURIOUS REFUSALS POSSIBLE' : 'safe'}`)
}

// ── A2. Non-inferiority at small n: the interval is bounded by the observed
//        data range, so a margin outside that range may be unfalsifiable.
console.log('\nA2 repeated-sampling type-I at the exact boundary, by n (thr=-0.05, true RD=-0.05):')
{
  let s = 24680 >>> 0
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  for (const n of [3, 6, 12, 26, 50, 76, 200]) {
    let promoted = 0, indet = 0
    const reps = 600
    for (let r = 0; r < reps; r++) {
      const before: number[] = [], after: number[] = []
      for (let i = 0; i < n; i++) { before.push(rnd() < 0.05 ? 1 : 0); after.push(0) }
      const d = run(HeldOutGate, before, after, -0.05)
      if (d.promote) promoted++
      if (d.rejectionCode === 'indeterminate_delta') indet++
    }
    const pct = (100 * promoted) / reps
    console.log(`   n=${String(n).padStart(3)}  promoted ${String(promoted).padStart(3)}/${reps} = ${pct.toFixed(1).padStart(5)}%  ${pct > 5 ? '<<< ABOVE NOMINAL 5%' : ''}   (indeterminate ${indet})`)
  }
}

// ── A3. Type-I at a POSITIVE margin (superiority by a stated amount).
console.log('\nA3 repeated-sampling type-I at a POSITIVE margin (thr=+0.05, true RD=+0.05):')
{
  let s = 13579 >>> 0
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  for (const n of [26, 76, 200]) {
    let promoted = 0
    const reps = 400
    for (let r = 0; r < reps; r++) {
      const before: number[] = [], after: number[] = []
      for (let i = 0; i < n; i++) { const u = rnd(); before.push(0); after.push(u < 0.05 ? 1 : 0) }
      if (run(HeldOutGate, before, after, 0.05).promote) promoted++
    }
    console.log(`   n=${String(n).padStart(3)}  promoted ${promoted}/${reps} = ${((100*promoted)/reps).toFixed(1)}%`)
  }
}

// ── A4. SCALE. Multiply scores AND threshold by k: the verdict must not move.
console.log('\nA4 scale-equivariance (scores x k, threshold x k):')
{
  const before = [...Array(15).fill(0), ...Array(5).fill(1), ...Array(56).fill(1)]
  const after  = [...Array(15).fill(1), ...Array(5).fill(0), ...Array(56).fill(1)]
  for (const k of [1e-8, 1e-6, 1e-3, 1, 100, 1e6, 1e9]) {
    const d = run(HeldOutGate, before.map((x) => x * k), after.map((x) => x * k), 0)
    console.log(`   k=${String(k).padEnd(6)} promote=${String(d.promote).padEnd(5)} code=${String(d.rejectionCode ?? 'null').padEnd(20)} p=${d.evidence.signFlip?.pValue.toExponential(2)} tie=${d.evidence.tieFraction?.toFixed(3)}`)
  }
}

// ── A5. Does the Monte-Carlo fallback ever decide a gate verdict, and how close
//        to alpha does it land? A fixed-seed randomised test near alpha is the
//        one place a crafted input could exploit the draw.
console.log('\nA5 when does the sign-flip test fall back to Monte Carlo, and how near alpha:')
{
  let s = 777 >>> 0
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  let mc = 0, exact = 0, nearAlpha = 0, total = 0
  for (const n of [8, 20, 40, 76, 200]) {
    for (let t = 0; t < 60; t++) {
      const before: number[] = [], after: number[] = []
      for (let i = 0; i < n; i++) { before.push(rnd()); after.push(rnd()) } // fully continuous
      const d = run(HeldOutGate, before, after, 0)
      total++
      if (d.evidence.signFlip?.method === 'monte_carlo') mc++; else exact++
      const p = d.evidence.signFlip?.pValue ?? 1
      if (Math.abs(p - 0.05) < 0.01) nearAlpha++
    }
  }
  console.log(`   continuous datasets: ${total}; monte_carlo ${mc}, exact ${exact}; p within 0.01 of alpha: ${nearAlpha}`)
  // deterministic across repeated construction?
  const before = Array.from({ length: 60 }, (_, i) => i / 60)
  const after = before.map((x, i) => x + (i % 3 === 0 ? 0.02 : -0.005))
  const runs = Array.from({ length: 5 }, () => run(HeldOutGate, before, after, 0))
  console.log(`   same input 5x -> p-values identical: ${new Set(runs.map((r) => r.evidence.signFlip?.pValue)).size === 1}, verdicts identical: ${new Set(runs.map((r) => r.promote)).size === 1}`)
}

// ── A6. POWER: did the fix keep promoting the real lifts this repo has?
console.log('\nA6 power on the real lifts (all must still promote):')
{
  const cases: Array<[string, number[], number[], number]> = [
    ['flagship +13.2pp {0,1} n=76', [...Array(15).fill(0), ...Array(5).fill(1), ...Array(56).fill(1)], [...Array(15).fill(1), ...Array(5).fill(0), ...Array(56).fill(1)], 0],
    ['same on 0-100', [...Array(15).fill(0), ...Array(5).fill(100), ...Array(56).fill(100)], [...Array(15).fill(100), ...Array(5).fill(0), ...Array(56).fill(100)], 0],
    ['lattice +12.8pp {2/3,1} n=26', [...Array(15).fill(2/3), ...Array(5).fill(1), ...Array(6).fill(1)], [...Array(15).fill(1), ...Array(5).fill(2/3), ...Array(6).fill(1)], 0],
    ['continuous 8 pairs', [0.5,0.5,0.51,0.5,0.51,0.5,0.51,0.5], [0.7,0.72,0.74,0.71,0.73,0.75,0.76,0.74], 0],
  ]
  for (const [label, before, after, thr] of cases) {
    const d = run(HeldOutGate, before, after, thr)
    console.log(`   ${label.padEnd(30)} promote=${String(d.promote).padEnd(5)} CI=[${d.evidence.pairedCI?.low.toFixed(4)}, ${d.evidence.pairedCI?.high.toFixed(4)}] p=${d.evidence.signFlip?.pValue.toExponential(2)}`)
  }
}

// ── A7. The EL interval cannot leave the data's range. Where the margin is
//        outside that range the interval clears it trivially — is anything else
//        holding the door?
console.log('\nA7 margin outside the observed delta range (EL cannot reach it):')
{
  for (const n of [3, 6, 12, 30]) {
    const before = Array.from({ length: n }, () => 0)
    const after = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.001 : 0))
    const d = run(HeldOutGate, before, after, -0.05)
    const el = empiricalLikelihoodMeanInterval(after.map((a, i) => a - before[i]!), 0.95)
    console.log(`   n=${String(n).padStart(2)} deltas in {0, 0.001}, thr=-0.05 -> promote=${String(d.promote).padEnd(5)} code=${String(d.rejectionCode ?? 'null').padEnd(20)} CI=[${d.evidence.pairedCI?.low.toExponential(2)}, ${d.evidence.pairedCI?.high.toExponential(2)}] EL=[${el.low?.toExponential(2)}, ${el.high?.toExponential(2)}]`)
  }
}
