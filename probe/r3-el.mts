/**
 * Can ONE shape-free interval replace the shape branch?
 *
 * Empirical likelihood (Owen 1988) for the mean of the paired deltas: the
 * nonparametric score interval. Depends on the data only through the deltas, so
 * it is shift-invariant by construction, and it needs no notion of "binary".
 * Measured here against Tango (best on binary-equivalent shapes) and the
 * percentile bootstrap (the only currently shape-free option, measured at 7.8%
 * and 9.7% type-I at a nominal-5% nonzero margin).
 */
import { pairedBootstrap, pairedRiskDifferenceExact } from '../src/statistics'

const CHI2_1_95 = 3.841458820694124

/** -2 log EL ratio for H0: mean = mu. Infinity when mu is outside the convex hull. */
function elStat(d: number[], mu: number): number {
  const n = d.length
  const z = d.map((x) => x - mu)
  const min = Math.min(...z)
  const max = Math.max(...z)
  if (!(min < 0 && max > 0)) return Number.POSITIVE_INFINITY
  // solve sum z_i/(1+lambda z_i) = 0 by bisection on lambda in (-1/max, -1/min)
  let lo = -1 / max + 1e-12
  let hi = -1 / min - 1e-12
  const g = (lam: number) => z.reduce((s, x) => s + x / (1 + lam * x), 0)
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (g(mid) > 0) lo = mid
    else hi = mid
  }
  const lam = (lo + hi) / 2
  return 2 * z.reduce((s, x) => s + Math.log(1 + lam * x), 0)
}

function elInterval(d: number[], crit = CHI2_1_95): { low: number; high: number } {
  const mean = d.reduce((s, x) => s + x, 0) / d.length
  const min = Math.min(...d)
  const max = Math.max(...d)
  if (min === max) return { low: mean, high: mean }
  const solve = (lo: number, hi: number) => {
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2
      if (elStat(d, mid) > crit) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  return { low: solve(min, mean), high: solve(max, mean) }
}

let s = 20260727 >>> 0
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }

function boot(d: number[], before: number[], after: number[]) {
  const r = pairedBootstrap(before, after, { confidence: 0.95, resamples: 2000, statistic: 'mean', seed: 1337 })
  return { low: r.low, high: r.high }
}

function sim(label: string, n: number, draw: () => number, thr: number, reps: number) {
  let el = 0, bs = 0, ex = 0, indetEl = 0
  for (let r = 0; r < reps; r++) {
    const before: number[] = [], after: number[] = []
    for (let i = 0; i < n; i++) { const v = draw(); before.push(v < 0 ? -v : 0); after.push(v > 0 ? v : 0) }
    const d = before.map((b, i) => after[i]! - b)
    const e = elInterval(d)
    if (e.low === e.high) indetEl++
    else if (e.low > thr) el++
    const b2 = boot(d, before, after)
    if (b2.low !== b2.high && b2.low > thr) bs++
    const x = pairedRiskDifferenceExact(before, after, 0.95)
    if (x.lower !== x.upper && x.lower > thr) ex++
  }
  console.log(`${label}  n=${n} thr=${thr} reps=${reps}`)
  console.log(`    EL ${(100*el/reps).toFixed(1).padStart(5)}%   bootstrap ${(100*bs/reps).toFixed(1).padStart(5)}%   exact-cond ${(100*ex/reps).toFixed(1).padStart(5)}%   (EL directionless ${indetEl})`)
}

console.log('##### TYPE-I AT THE EXACT BOUNDARY — nominal max 5.0% #####')
sim('B1 binary-equivalent, 0 wins / P(loss)=.05, margin -0.05 ', 76, () => (rnd() < 0.05 ? -1 : 0), -0.05, 2000)
sim('B2 same, n=200                                            ', 200, () => (rnd() < 0.05 ? -1 : 0), -0.05, 1000)
sim('M1 TWO loss magnitudes (-1 @.025, -2 @.0125), margin -0.05', 76, () => { const u = rnd(); return u < 0.025 ? -1 : u < 0.0375 ? -2 : 0 }, -0.05, 2000)
sim('M2 same, n=300                                            ', 300, () => { const u = rnd(); return u < 0.025 ? -1 : u < 0.0375 ? -2 : 0 }, -0.05, 1000)
sim('S1 superiority, no effect, margin 0                       ', 76, () => { const u = rnd(); return u < 0.1 ? 1 : u < 0.2 ? -1 : 0 }, 0, 2000)
sim('S2 superiority, no effect, sparse, margin 0               ', 26, () => { const u = rnd(); return u < 0.02 ? 1 : u < 0.04 ? -1 : 0 }, 0, 2000)

console.log('\n##### POWER on the real lifts (must stay promotable) #####')
function pw(label: string, d: number[], thr: number) {
  const before = d.map((x) => (x < 0 ? -x : 0)), after = d.map((x) => (x > 0 ? x : 0))
  const e = elInterval(d), b2 = boot(d, before, after), x = pairedRiskDifferenceExact(before, after, 0.95)
  console.log(`${label}\n    EL=[${e.low.toFixed(4)}, ${e.high.toFixed(4)}] promote=${e.low !== e.high && e.low > thr}   boot=[${b2.low.toFixed(4)}, ${b2.high.toFixed(4)}] promote=${b2.low > thr}   exact=[${x.lower.toFixed(4)}, ${x.upper.toFixed(4)}] promote=${x.lower !== x.upper && x.lower > thr}`)
}
const rep = (k: number, v: number) => Array.from({ length: k }, () => v)
pw('P1 flagship +13.2pp (15w/5l/56t)      ', [...rep(15, 1), ...rep(5, -1), ...rep(56, 0)], 0)
pw('P2 lattice  +12.8pp (15w/5l/6t, n=26) ', [...rep(15, 1/3), ...rep(5, -1/3), ...rep(6, 0)], 0)
pw('P3 6 wins 0 losses (McNemar p=0.031)  ', [...rep(6, 1), ...rep(5, 0)], 0)
pw('P4 5 wins 0 losses (McNemar p=0.0625) ', [...rep(5, 1), ...rep(5, 0)], 0)
pw('P5 D2 multi-magnitude 4 winners n=26  ', [...rep(3, 1/3), 2/3, ...rep(22, 0)], 0)
pw('P6 continuous 8 pairs, all +~0.22     ', [0.2, 0.22, 0.23, 0.21, 0.22, 0.25, 0.25, 0.24], 0)
