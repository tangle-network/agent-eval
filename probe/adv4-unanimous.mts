/**
 * ROUND-4 ADVERSARY PROBE H — the fail-closed rule vs its own veto.
 *
 * `deltaSpread <= PAIRED_DELTA_TIE_EPSILON` returns `indeterminate_delta`, and
 * it is checked BEFORE the sign-flip veto. So a candidate that improves EVERY
 * held-out item by the same amount is refused no matter how many items there
 * are and no matter what the exact permutation test says.
 *
 * The extreme case is the shape this whole thread is about: a pass/fail holdout
 * where the baseline fails every item and the candidate passes every item.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { HeldOutGate as MainGate } from './gate-main'
import { build } from './fixtures'
import { signFlipMeanTest } from '../src/statistics'

// biome-ignore lint/suspicious/noExplicitAny: cross-version comparison
const published: any = await import(
  '/home/drew/code/supervisor-lab/.claude/worktrees/profile-kb-arena/node_modules/.pnpm/@tangle-network+agent-eval@0.125.0_typescript@6.0.3/node_modules/@tangle-network/agent-eval/dist/index.js'
)

// biome-ignore lint/suspicious/noExplicitAny: cross-version comparison
function verdict(Gate: any, before: number[], after: number[], thr = 0) {
  const { candidate, baseline } = build(before, after)
  const d = new Gate({
    baselineKey: 'base',
    pairedDeltaThreshold: thr,
    confidence: 0.95,
    seed: 1234,
    overfitGapThreshold: 1e9,
  }).evaluate(candidate, baseline)
  return `${String(d.promote).padEnd(5)} ${String(d.rejectionCode ?? 'null').padEnd(20)}`
}

console.log('Every pair improves by the SAME amount. threshold 0, all defaults.\n')
console.log(
  'case                                                     signflip p      BRANCH                     origin/main               pub 0.125.0',
)
const cases: Array<[string, number[], number[]]> = [
  [
    'binary {0,1}: baseline 0/26, candidate 26/26  (+100pp)',
    Array(26).fill(0),
    Array(26).fill(1),
  ],
  [
    'binary {0,1}: baseline 0/100, candidate 100/100 (+100pp)',
    Array(100).fill(0),
    Array(100).fill(1),
  ],
  [
    'lattice {2/3,1}: bench/rung2 block score, 40 blocks',
    Array(40).fill(2 / 3),
    Array(40).fill(1),
  ],
  [
    'continuous: +0.05 on every one of 100 items',
    Array(100).fill(0.4),
    Array(100).fill(0.45),
  ],
  [
    'CONTROL binary with 1 tie: baseline 1/26, candidate 26/26',
    [1, ...Array(25).fill(0)],
    Array(26).fill(1),
  ],
]
for (const [label, before, after] of cases) {
  const deltas = before.map((b, i) => after[i]! - b)
  const sf = signFlipMeanTest(deltas)
  console.log(
    `${label.padEnd(56)} ${sf.pValue.toExponential(2).padStart(10)}   ` +
      `${verdict(HeldOutGate, before, after).padEnd(26)} ${verdict(MainGate, before, after).padEnd(25)} ` +
      `${verdict(published.HeldOutGate, before, after)}`,
  )
}

console.log('\nSame five cases at threshold −0.05 (bench/rung2 ships this):')
for (const [label, before, after] of cases) {
  console.log(
    `${label.padEnd(56)} ${' '.repeat(10)}   ` +
      `${verdict(HeldOutGate, before, after, -0.05).padEnd(26)} ` +
      `${verdict(MainGate, before, after, -0.05).padEnd(25)} ` +
      `${verdict(published.HeldOutGate, before, after, -0.05)}`,
  )
}
