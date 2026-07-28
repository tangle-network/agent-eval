/**
 * Which interval may decide "is the paired delta above margin θ"?
 *
 * Three candidates, measured on the two things that matter:
 *   TYPE-I at the exact boundary (true delta == θ)  — must be <= 1 - confidence
 *   POWER on the real lifts this repo actually has  — must not collapse
 *
 *   exact-cond  Clopper-Pearson on the discordant share, rescaled by m/n
 *               (what the branch decides on today; PR #457 review says it is a
 *               valid test of delta=0 but not a CI at delta != 0)
 *   bootstrap   percentile bootstrap of the MEAN paired delta over all n pairs
 *   tango       Tango (1998) asymptotic score interval for the paired risk
 *               difference; at delta=0 its statistic is exactly McNemar's
 *               uncorrected (b-c)/sqrt(b+c), which is the internal cross-check
 */
import { pairedBootstrap, pairedRiskDifferenceExact } from '../src/statistics'

function tangoBounds(b: number, c: number, n: number, confidence: number) {
  const z = Math.SQRT2 * inverfc(1 - confidence) // two-sided z
  const Z = (delta: number): number => {
    const A = 2 * n
    const B = -b - c + (2 * n - b + c) * delta
    const C = -c * delta * (1 - delta)
    const disc = Math.max(0, B * B - 4 * A * C)
    const p21 = (Math.sqrt(disc) - B) / (2 * A)
    const varTerm = n * (2 * p21 + delta * (1 - delta))
    if (!(varTerm > 0)) return b - c - n * delta > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
    return (b - c - n * delta) / Math.sqrt(varTerm)
  }
  // Z is decreasing in delta; lower bound solves Z(delta) = +z, upper solves Z = -z.
  const solve = (target: number): number => {
    let lo = -1
    let hi = 1
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2
      if (Z(mid) > target) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  return { lower: solve(z), upper: solve(-z), zAtZero: Z(0) }
}

/** inverse complementary error function, enough digits for z at 0.90-0.999 */
function inverfc(p: number): number {
  if (p >= 2) return -100
  if (p <= 0) return 100
  const pp = p < 1 ? p : 2 - p
  const t = Math.sqrt(-2 * Math.log(pp / 2))
  let x = -0.70711 * ((2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t)
  for (let j = 0; j < 2; j++) {
    const err = erfc(x) - pp
    x += err / (1.12837916709551257 * Math.exp(-x * x) - x * err)
  }
  return p < 1 ? x : -x
}
function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 2 / (2 + z)
  const ty = 4 * t - 2
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
    -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
    -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12,
    8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  ]
  let d = 0
  let dd = 0
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d
    d = ty * d - dd + cof[j]!
    dd = tmp
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0]! + ty * d) - dd)
  return x >= 0 ? ans : 2 - ans
}

type Rule = (before: number[], after: number[], conf: number) => { low: number; high: number }

const rules: Array<[string, Rule]> = [
  [
    'exact-cond',
    (b, a, conf) => {
      const r = pairedRiskDifferenceExact(b, a, conf)
      return { low: r.lower, high: r.upper }
    },
  ],
  [
    'bootstrap ',
    (b, a, conf) => {
      const r = pairedBootstrap(b, a, { confidence: conf, resamples: 2000, statistic: 'mean', seed: 1337 })
      return { low: r.low, high: r.high }
    },
  ],
  [
    'tango     ',
    (before, after, conf) => {
      let b = 0
      let c = 0
      for (let i = 0; i < before.length; i++) {
        const d = after[i]! - before[i]!
        if (d > 0) b++
        else if (d < 0) c++
      }
      const t = tangoBounds(b, c, before.length, conf)
      return { low: t.lower, high: t.upper }
    },
  ],
]

// Internal cross-check: Tango's statistic at delta = 0 IS McNemar's uncorrected one.
{
  let worst = 0
  for (let b = 0; b <= 20; b++) {
    for (let c = 0; c <= 20; c++) {
      if (b + c === 0) continue
      const z = tangoBounds(b, c, 60, 0.95).zAtZero
      worst = Math.max(worst, Math.abs(z - (b - c) / Math.sqrt(b + c)))
    }
  }
  console.log(`tango Z(0) vs McNemar (b-c)/sqrt(b+c): max abs diff over 440 shapes = ${worst.toExponential(2)}`)
}

let s = 20260727 >>> 0
const rnd = () => {
  s ^= s << 13
  s >>>= 0
  s ^= s >> 17
  s ^= s << 5
  s >>>= 0
  return s / 4294967296
}

function typeI(label: string, n: number, pWin: number, pLoss: number, thr: number, reps: number) {
  const hits = new Map<string, number>()
  for (const [name] of rules) hits.set(name, 0)
  for (let r = 0; r < reps; r++) {
    const before: number[] = []
    const after: number[] = []
    for (let i = 0; i < n; i++) {
      const u = rnd()
      const win = u < pWin
      const loss = !win && u < pWin + pLoss
      before.push(loss ? 1 : 0)
      after.push(win ? 1 : 0)
    }
    for (const [name, rule] of rules) {
      const { low, high } = rule(before, after, 0.95)
      if (low === high) continue // directionless: every candidate rule refuses
      if (low > thr) hits.set(name, hits.get(name)! + 1)
    }
  }
  console.log(`\n${label}   n=${n} pWin=${pWin} pLoss=${pLoss} thr=${thr} reps=${reps}`)
  for (const [name] of rules) {
    const c = hits.get(name)!
    console.log(`   ${name} promoted ${String(c).padStart(5)}/${reps} = ${((100 * c) / reps).toFixed(1)}%`)
  }
}

function power(label: string, wins: number, losses: number, ties: number, thr: number) {
  const before: number[] = []
  const after: number[] = []
  for (let i = 0; i < wins; i++) {
    before.push(0)
    after.push(1)
  }
  for (let i = 0; i < losses; i++) {
    before.push(1)
    after.push(0)
  }
  for (let i = 0; i < ties; i++) {
    before.push(1)
    after.push(1)
  }
  console.log(`\n${label}  wins=${wins} losses=${losses} ties=${ties} thr=${thr}`)
  for (const [name, rule] of rules) {
    const { low, high } = rule(before, after, 0.95)
    const promote = low !== high && low > thr
    console.log(`   ${name} CI=[${low.toFixed(4)}, ${high.toFixed(4)}]  promote=${promote}`)
  }
}

console.log('\n########## TYPE-I AT THE EXACT BOUNDARY (must be <= 5.0%) ##########')
typeI('B1 non-inferiority boundary (PR #457 review case)', 76, 0, 0.05, -0.05, 2000)
typeI('B2 non-inferiority boundary, larger n            ', 200, 0, 0.05, -0.05, 1000)
typeI('B3 superiority boundary, no true effect          ', 76, 0.1, 0.1, 0, 2000)
typeI('B4 superiority boundary, sparse                  ', 26, 0.02, 0.02, 0, 2000)

console.log('\n########## POWER ON THE REAL LIFTS THIS REPO HAS ##########')
power('P1 flagship +13.2pp (15w/5l/56t)         ', 15, 5, 56, 0)
power('P2 lattice   +12.8pp (15w/5l/6t, n=26)   ', 15, 5, 6, 0)
power('P3 6 wins 0 losses (first shape McNemar accepts)', 6, 0, 5, 0)
power('P4 5 wins 0 losses (McNemar p=0.0625, must refuse)', 5, 0, 5, 0)

console.log('\n########## MULTI-MAGNITUDE (bootstrap is the only applicable method) ##########')
function typeIMulti(label: string, n: number, thr: number, reps: number) {
  let hits = 0
  let indet = 0
  for (let r = 0; r < reps; r++) {
    const before: number[] = []
    const after: number[] = []
    for (let i = 0; i < n; i++) {
      const u = rnd()
      before.push(0)
      // true mean delta = -(0.025*1 + 0.0125*2) = -0.05 == thr
      after.push(u < 0.025 ? -1 : u < 0.0375 ? -2 : 0)
    }
    const r2 = pairedBootstrap(before, after, { confidence: 0.95, resamples: 2000, statistic: 'mean', seed: 1337 })
    if (r2.low === r2.high) { indet++; continue }
    if (r2.low > thr) hits++
  }
  console.log(`${label} n=${n} thr=${thr} reps=${reps}: bootstrap promoted ${hits}/${reps} = ${((100*hits)/reps).toFixed(1)}%  (directionless ${indet})`)
}
typeIMulti('M1 two loss magnitudes at the exact boundary', 76, -0.05, 2000)
typeIMulti('M2 same, larger n                           ', 300, -0.05, 1000)
