/**
 * ROUND-4 ADVERSARY PROBE C — is the verdict a function of the DATA?
 *
 * The gate's headline property is "adding the same constant to both arms
 * cannot move a verdict". Two neighbouring presentations of the identical
 * multiset of paired deltas:
 *
 *   C1. RENAME the scenarios. `pairRunRecords` orders pairs by pairKey, so
 *       renaming permutes the delta vector. Same multiset, same statistics —
 *       but the seeded bootstrap resamples a different sequence.
 *   C2. Leave the seed at its DEFAULT (`undefined` = Math.random) and evaluate
 *       the same input repeatedly.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { rec } from './fixtures'
import type { RunRecord } from '../src/run-record'

function buildNamed(names: string[], before: number[], after: number[]) {
  const candidate: RunRecord[] = []
  const baseline: RunRecord[] = []
  for (let i = 0; i < names.length; i++) {
    const sid = names[i]!
    baseline.push(rec('base', sid, 'search', before[i]!), rec('base', sid, 'holdout', before[i]!))
    candidate.push(rec('cand', sid, 'search', after[i]!), rec('cand', sid, 'holdout', after[i]!))
  }
  return { candidate, baseline }
}

function verdict(
  names: string[],
  before: number[],
  after: number[],
  thr: number,
  seed: number | undefined,
) {
  const { candidate, baseline } = buildNamed(names, before, after)
  const g = new HeldOutGate({
    baselineKey: 'base',
    pairedDeltaThreshold: thr,
    confidence: 0.95,
    ...(seed === undefined ? {} : { seed }),
    overfitGapThreshold: 1e9,
  })
  return g.evaluate(candidate, baseline)
}

// A borderline improvement: mostly small gains, a couple of losses.
const before: number[] = []
const after: number[] = []
const rnd = (() => {
  let s = 20260727
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
})()
const N = 30
for (let i = 0; i < N; i++) {
  const b = 0.4 + rnd() * 0.2
  before.push(b)
  after.push(b + (i < 26 ? 0.004 + rnd() * 0.01 : -0.02 - rnd() * 0.02))
}
const deltas = before.map((b, i) => after[i]! - b)
const mean = deltas.reduce((s, d) => s + d, 0) / N
console.log(`n=${N} mean delta=${mean.toFixed(5)}  (26 small gains, 4 losses)`)

// ---- C1: rename only. Identical multiset of deltas, different pairKey order.
const idA = Array.from({ length: N }, (_, i) => `a${String(i).padStart(2, '0')}`)
// reverse alphabetical order over the same items => pairRunRecords sorts them
// into the opposite sequence; the deltas are the same multiset.
const idB = Array.from({ length: N }, (_, i) => `a${String(N - 1 - i).padStart(2, '0')}`)

console.log('\n--- C1: SAME deltas, scenarios RENAMED (seed fixed at 1234) ---')
for (const thr of [0, 0.004, 0.005, 0.0055, 0.006]) {
  const a = verdict(idA, before, after, thr, 1234)
  const b = verdict(idB, before, after, thr, 1234)
  const flag = a.promote === b.promote ? '' : '   <<< VERDICT FLIPPED ON A RENAME'
  console.log(
    `thr=${thr.toFixed(4)}  names-ascending promote=${String(a.promote).padEnd(5)} ` +
      `CI.low=${a.evidence.pairedCI!.low.toFixed(6)}   ` +
      `names-descending promote=${String(b.promote).padEnd(5)} ` +
      `CI.low=${b.evidence.pairedCI!.low.toFixed(6)}${flag}`,
  )
}

// ---- C2: default seed (undefined => Math.random). Same input, 200 evaluations.
console.log('\n--- C2: DEFAULT seed (undefined = Math.random), same input 200x ---')
for (const thr of [0.004, 0.005, 0.0055]) {
  let promotes = 0
  let minLow = Number.POSITIVE_INFINITY
  let maxLow = Number.NEGATIVE_INFINITY
  for (let r = 0; r < 200; r++) {
    const d = verdict(idA, before, after, thr, undefined)
    if (d.promote) promotes++
    minLow = Math.min(minLow, d.evidence.pairedCI!.low)
    maxLow = Math.max(maxLow, d.evidence.pairedCI!.low)
  }
  console.log(
    `thr=${thr.toFixed(4)}  promoted ${String(promotes).padStart(3)}/200 identical calls  ` +
      `CI.low ranged ${minLow.toFixed(6)} … ${maxLow.toFixed(6)}` +
      (promotes > 0 && promotes < 200 ? '   <<< SAME DATA, BOTH VERDICTS' : ''),
  )
}
