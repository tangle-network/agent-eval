/** Round-2 of self-attack: the heavy tail, the MC bound, the epsilon boundary. */
import { HeldOutGate } from '../src/held-out-gate'
import { signFlipMeanTest } from '../src/statistics'
import { run } from './fixtures'

// ── B1. RARE, LARGE regressions the sample can miss. True mean is BELOW the
//        margin; the gate promotes whenever the bad draws happen not to appear.
console.log('B1 heavy tail: delta = -1 w.p. 0.06, else U(0, 0.01). True mean = -0.0553 < margin -0.05')
{
  let s = 5150 >>> 0
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  for (const n of [26, 76, 200, 500]) {
    let promoted = 0, sawBad = 0
    const reps = 400
    for (let r = 0; r < reps; r++) {
      const before: number[] = [], after: number[] = []
      let bad = false
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.06) { before.push(1); after.push(0); bad = true }
        else { before.push(0); after.push(rnd() * 0.01) }
      }
      if (bad) sawBad++
      if (run(HeldOutGate, before, after, -0.05).promote) promoted++
    }
    console.log(`   n=${String(n).padStart(3)} promoted ${String(promoted).padStart(3)}/${reps} = ${((100*promoted)/reps).toFixed(1).padStart(5)}%   (samples containing at least one -1: ${sawBad}/${reps})`)
  }
}

// ── B2. Does the MC upper bound actually change verdicts, and by how much?
console.log('\nB2 Monte-Carlo verdicts near alpha, point estimate vs 99.9% upper bound:')
{
  let s = 31337 >>> 0
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  let flipped = 0, mcCases = 0
  for (let t = 0; t < 4000; t++) {
    const n = 30 + Math.floor(rnd() * 60)
    const drift = 0.02 + rnd() * 0.05
    const deltas = Array.from({ length: n }, () => (rnd() - 0.5) * 0.6 + drift)
    const sf = signFlipMeanTest(deltas)
    if (sf.method !== 'monte_carlo') continue
    mcCases++
    if (sf.pValue < 0.05 && !(sf.pValueUpperBound < 0.05)) flipped++
  }
  console.log(`   ${mcCases} monte-carlo tests; ${flipped} would have promoted on the point estimate and are now refused (${((100*flipped)/mcCases).toFixed(2)}%)`)
  const wide = signFlipMeanTest(Array.from({ length: 40 }, (_, i) => 0.5 + i / 100))
  console.log(`   a clearly-significant MC case: p=${wide.pValue.toExponential(2)} upper=${wide.pValueUpperBound.toExponential(2)} -> still rejects: ${wide.pValueUpperBound < 0.05}`)
}

// ── B3. The tie epsilon is ABSOLUTE (1e-9). Below it everything reads as tied.
console.log('\nB3 the absolute tie epsilon: scores x k, threshold x k, real +13.2pp lift')
{
  const before = [...Array(15).fill(0), ...Array(5).fill(1), ...Array(56).fill(1)]
  const after  = [...Array(15).fill(1), ...Array(5).fill(0), ...Array(56).fill(1)]
  for (const k of [1e-8, 1e-9, 1e-10, 1e-12]) {
    const d = run(HeldOutGate, before.map((x) => x * k), after.map((x) => x * k), 0)
    console.log(`   k=${k.toExponential(0).padEnd(6)} delta magnitude ${k.toExponential(0)}  promote=${String(d.promote).padEnd(5)} code=${String(d.rejectionCode ?? 'null').padEnd(20)} tieFraction=${d.evidence.tieFraction}`)
  }
}

// ── B4. Adversarial: can a caller manufacture a promotion by adding pairs?
console.log('\nB4 does adding TIED pairs ever turn a refusal into a promotion?')
{
  let flips = 0, checked = 0
  const base: Array<[number[], number[]]> = [
    [[0,0,0,0,0], [1,1,1,1,1]],
    [[0,0,0,0], [1,1,1,0]],
    [[0,0,0,0,0,0], [1,1,1,1,1,0]],
  ]
  for (const [b0, a0] of base) {
    let prev = run(HeldOutGate, b0, a0, 0).promote
    for (let extra = 1; extra <= 60; extra++) {
      const b = [...b0, ...Array(extra).fill(1)]
      const a = [...a0, ...Array(extra).fill(1)]
      const now = run(HeldOutGate, b, a, 0).promote
      checked++
      if (now && !prev) flips++
      prev = now
    }
  }
  console.log(`   ${checked} (base, padding) combinations; refusal -> promotion transitions caused by adding ties: ${flips}`)
}

// ── B5. Adversarial: split one big improvement into many small ones.
console.log('\nB5 can splitting one improvement across more pairs buy a promotion?')
{
  for (const k of [3, 4, 5, 6, 8, 12]) {
    const before = Array.from({ length: 26 }, () => 0)
    const after = before.map((_, i) => (i < k ? 2 / k : 0)) // total lift held constant at 2
    const d = run(HeldOutGate, before, after, 0)
    console.log(`   ${String(k).padStart(2)} improvers of ${(2/k).toFixed(4)} (total lift 2.0): promote=${String(d.promote).padEnd(5)} p=${d.evidence.signFlip?.pValue.toFixed(4)}`)
  }
}
