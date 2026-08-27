/**
 * ROUND-4 ADVERSARY PROBE I — the branch's own pinned invariant, re-run with
 * bases its test does not include.
 *
 * tests/held-out-gate.test.ts:1240 "adding TIED pairs never turns a refusal
 * into a promotion", verbatim loop, `flips` collected the same way. Its three
 * bases are 5-improver and 5-improver-plus-tie shapes. Add a base whose
 * improvements are UNANIMOUS and identical and the invariant fails.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { build } from './fixtures'

function decide(before: number[], after: number[], thr: number) {
  const { candidate, baseline } = build(before, after)
  return new HeldOutGate({
    baselineKey: 'base',
    seed: 1337,
    pairedDeltaThreshold: thr,
    overfitGapThreshold: 1e9,
  }).evaluate(candidate, baseline)
}

const bases: Array<[string, number[], number[]]> = [
  // the three the shipped test uses
  ['shipped base 5w/0l', [0, 0, 0, 0, 0], [1, 1, 1, 1, 1]],
  ['shipped base 3w/1t', [0, 0, 0, 0], [1, 1, 1, 0]],
  ['shipped base 5w/1t', [0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 0]],
  // bases the shipped test does not include
  ['NEW base 6w/0l', Array(6).fill(0), Array(6).fill(1)],
  ['NEW base 26w/0l', Array(26).fill(0), Array(26).fill(1)],
  ['NEW base 100w/0l', Array(100).fill(0), Array(100).fill(1)],
  ['NEW base 26w/0l on {2/3,1}', Array(26).fill(2 / 3), Array(26).fill(1)],
]

for (const thr of [0, -0.05]) {
  console.log(`\n=== pairedDeltaThreshold ${thr} ===`)
  for (const [label, b0, a0] of bases) {
    const flips: string[] = []
    let previous = false
    const trace: string[] = []
    for (let padding = 0; padding <= 6; padding++) {
      const before = [...b0, ...Array.from({ length: padding }, () => 1)]
      const after = [...a0, ...Array.from({ length: padding }, () => 1)]
      const d = decide(before, after, thr)
      if (padding <= 2) trace.push(`+${padding}ties:${d.promote ? 'PROMOTE' : d.rejectionCode}`)
      if (d.promote && !previous && padding > 0) {
        flips.push(`${label} + ${padding} ties`)
      }
      previous = d.promote
    }
    console.log(
      `${label.padEnd(28)} ${trace.join('  ').padEnd(64)} flips=${flips.length ? JSON.stringify(flips) : '[]'}`,
    )
  }
}
