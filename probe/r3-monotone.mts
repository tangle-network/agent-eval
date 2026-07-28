/**
 * Is the verdict MONOTONE in the threshold? Lowering `pairedDeltaThreshold`
 * asks a strictly weaker question, so it must never turn a promotion into a
 * refusal. If it can, a caller who relaxes their bar gets a worse answer, and
 * the negative-threshold carve-out (no significance veto there) would be a hole
 * rather than a deliberate non-inferiority rule.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { run } from './fixtures'

let seed = 99991
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const shapes: Array<[string, number[]]> = [
  ['{0,1}', [0, 1]],
  ['{0,1/3,2/3,1}', [0, 1 / 3, 2 / 3, 1]],
  ['{0,100}', [0, 100]],
  ['continuous', [0.11, 0.37, 0.52, 0.68, 0.94]],
]
const thresholds = [0.2, 0.05, 0.01, 0, -0.01, -0.05, -0.2, -1]
let violations = 0, cases = 0, everPromoted = 0
for (const [label, levels] of shapes) {
  for (const n of [3, 6, 12, 26, 60]) {
    for (let t = 0; t < 12; t++) {
      const before = Array.from({ length: n }, () => levels[Math.floor(rand() * levels.length)]!)
      const after = Array.from({ length: n }, () => levels[Math.floor(rand() * levels.length)]!)
      const verdicts = thresholds.map((thr) => run(HeldOutGate, before, after, thr).promote)
      cases++
      if (verdicts.some(Boolean)) everPromoted++
      for (let i = 1; i < verdicts.length; i++) {
        if (verdicts[i - 1] && !verdicts[i]) {
          violations++
          if (violations <= 5) console.log(`  VIOLATION ${label} n=${n} t=${t}: thr=${thresholds[i-1]} promotes but thr=${thresholds[i]} does not`)
        }
      }
    }
  }
}
console.log(`monotone-in-threshold: ${cases} datasets x ${thresholds.length} thresholds; violations = ${violations}; datasets promoting somewhere = ${everPromoted}`)
