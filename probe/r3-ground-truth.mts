/**
 * ROUND-3 GROUND TRUTH — three defects, measured side by side on three builds.
 *
 *   published  = @tangle-network/agent-eval 0.125.0 (what supervisor-lab resolves)
 *   main       = origin/main's HeldOutGate (median + [0,0] fail-closed, PR #459)
 *   branch     = src/held-out-gate.ts in this worktree
 *
 * Run `bash probe/setup-main-gate.sh` first: it materialises origin/main's gate
 * as probe/gate-main.ts (generated, not committed, so it cannot go stale).
 *
 * D1  SHIFT-DEPENDENCE  — adding the same constant to BOTH arms changes the verdict.
 * D2  VETO-FREE BRANCH  — multi-magnitude deltas skip every significance check.
 * D3  NONZERO MARGIN    — the conditional exact interval is not a CI for RD ≠ 0
 *                          (PR #457 review, drewstone 2026-07-28T02:21:13Z).
 */
import { HeldOutGate as Branch } from '../src/held-out-gate'
import { HeldOutGate as Published } from '/home/drew/code/supervisor-lab/.claude/worktrees/profile-kb-arena/node_modules/@tangle-network/agent-eval/dist/index.js'
import { HeldOutGate as Main } from './gate-main'
import { f, run } from './fixtures'

// biome-ignore lint/suspicious/noExplicitAny: cross-version gate shapes
const builds: Array<[string, any]> = [
  ['published', Published],
  ['main     ', Main],
  ['branch   ', Branch],
]

// biome-ignore lint/suspicious/noExplicitAny: cross-version evidence shapes
const line = (label: string, d: any) =>
  `${label}  promote=${String(d.promote).padEnd(5)} ${String(d.rejectionCode ?? 'null').padEnd(20)}` +
  ` stat=${String(d.evidence.deltaStatistic ?? 'median(implicit)').padEnd(22)}` +
  ` CI=[${f(d.evidence.pairedCI?.low)}, ${f(d.evidence.pairedCI?.high)}]` +
  ` mcnemarP=${d.evidence.mcnemar ? d.evidence.mcnemar.pValue.toFixed(4) : '   n/a'}`

/** k pairs improve by `step`, rest tie; BOTH arms shifted by `offset`. */
function shifted(n: number, k: number, step: number, offset: number) {
  const before: number[] = []
  const after: number[] = []
  for (let i = 0; i < n; i++) {
    before.push(offset)
    after.push(i < k ? offset + step : offset)
  }
  return { before, after }
}

console.log('=== D1 — SHIFT-DEPENDENCE. n=26, 4 wins of +1/3, 22 ties, thr=0, all defaults ===')
console.log('    Every paired delta is byte-identical across the rows. Only the OFFSET differs.')
for (const offset of [0, 1 / 3, 2 / 3, 1, 10]) {
  const { before, after } = shifted(26, 4, 1 / 3, offset)
  const deltas = before.map((b, i) => after[i]! - b)
  const sum = deltas.reduce((s, x) => s + x, 0)
  console.log(`  offset=${offset.toFixed(4)}  sum(delta)=${sum.toFixed(12)}`)
  for (const [name, G] of builds) console.log(`   ${line(name, run(G, before, after, 0))}`)
}

console.log()
console.log('=== D2 — VETO-FREE BRANCH. n=26, 4 winners, thr=0 ===')
console.log('    Same 4 winners, same total lift, but the winners move by TWO different')
console.log('    magnitudes so no two-point/constant-magnitude detector can fire.')
{
  // 3 winners +1/3, 1 winner +2/3, 22 ties. Exact sign test on 4 wins / 0 losses: p=0.125.
  const before = Array.from({ length: 26 }, () => 0)
  const after = before.map((_, i) => (i < 3 ? 1 / 3 : i === 3 ? 2 / 3 : 0))
  const nonzero = after.filter((x) => x > 0).length
  console.log(`  wins=${nonzero} losses=0 ties=${26 - nonzero}  exact sign-test p = 2*0.5^4 = 0.1250`)
  for (const [name, G] of builds) console.log(`   ${line(name, run(G, before, after, 0))}`)
}

console.log()
console.log('=== D3 — NONZERO MARGIN. 76 pairs, 0 wins, 3 losses, 73 ties, thr=-0.05 ===')
console.log('    (the case in the PR #457 review; bench/rung2 ships pairedDeltaThreshold -0.05)')
{
  const before = Array.from({ length: 76 }, (_, i) => (i < 3 ? 1 : 0))
  const after = Array.from({ length: 76 }, () => 0)
  for (const [name, G] of builds) console.log(`   ${line(name, run(G, before, after, -0.05))}`)
}

console.log()
console.log('=== D3b — REPEATED-SAMPLING CALIBRATION AT THE EXACT BOUNDARY ===')
console.log('    True process: P(candidate-only win)=0, P(baseline-only loss)=0.05, n=76.')
console.log('    True risk difference = -0.05 = the threshold. A nominal 95% non-inferiority')
console.log('    rule must promote at most ~5% of repeated samples. reps=2000, seeded.')
{
  let s = 987654321 >>> 0
  const rnd = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
  const reps = 2000
  const counts = new Map<string, number>()
  for (const [name] of builds) counts.set(name, 0)
  for (let r = 0; r < reps; r++) {
    const before: number[] = []
    const after: number[] = []
    for (let i = 0; i < 76; i++) {
      const loss = rnd() < 0.05
      before.push(loss ? 1 : 0)
      after.push(0)
    }
    for (const [name, G] of builds) {
      if (run(G, before, after, -0.05).promote) counts.set(name, counts.get(name)! + 1)
    }
  }
  for (const [name] of builds) {
    const c = counts.get(name)!
    console.log(`   ${name}  promoted ${String(c).padStart(5)}/${reps} = ${((100 * c) / reps).toFixed(1)}%  (nominal max 5.0%)`)
  }
}
