/**
 * ROUND-4 ADVERSARY PROBE G — is each finding a NEW regression, or inherited?
 * Branch source vs origin/main's gate vs published 0.125.0, same inputs.
 */
import { HeldOutGate } from '../src/held-out-gate'
import { HeldOutGate as MainGate } from './gate-main'
import { rec, build } from './fixtures'
import type { RunRecord } from '../src/run-record'

// biome-ignore lint/suspicious/noExplicitAny: cross-version comparison
const published: any = await import(
  '/home/drew/code/supervisor-lab/.claude/worktrees/profile-kb-arena/node_modules/.pnpm/@tangle-network+agent-eval@0.125.0_typescript@6.0.3/node_modules/@tangle-network/agent-eval/dist/index.js'
)

// biome-ignore lint/suspicious/noExplicitAny: cross-version comparison
function ev(Gate: any, candidate: RunRecord[], baseline: RunRecord[], cfg: Record<string, unknown>) {
  try {
    const g = new Gate({
      baselineKey: 'base',
      pairedDeltaThreshold: 0,
      confidence: 0.95,
      seed: 1234,
      overfitGapThreshold: 1e9,
      ...cfg,
    })
    const d = g.evaluate(candidate, baseline)
    return `${String(d.promote).padEnd(5)} ${String(d.rejectionCode ?? 'null').padEnd(20)}`
  } catch (e) {
    return `THREW ${(e as Error).message.slice(0, 30)}`
  }
}

// ── A. the median escape hatch ───────────────────────────────────────
{
  const before: number[] = []
  const after: number[] = []
  for (let i = 0; i < 20; i++) {
    before.push(0.5)
    after.push(0.5 + 0.01 + i * 0.0005)
  }
  for (let i = 0; i < 6; i++) {
    before.push(1.0)
    after.push(0.0)
  }
  const { candidate, baseline } = build(before, after)
  console.log('A. 26 pairs: 20 gains of ~+0.015, 6 collapses of −1.0.  TRUE MEAN Δ = −0.2194')
  for (const thr of [0, -0.05]) {
    console.log(
      `   thr=${String(thr).padStart(5)}  branch(mean)   ${ev(HeldOutGate, candidate, baseline, { pairedDeltaThreshold: thr })}` +
        `  branch(median) ${ev(HeldOutGate, candidate, baseline, { pairedDeltaThreshold: thr, deltaStatistic: 'median' })}` +
        `  main ${ev(MainGate, candidate, baseline, { pairedDeltaThreshold: thr })}` +
        `  pub0.125 ${ev(published.HeldOutGate, candidate, baseline, { pairedDeltaThreshold: thr })}`,
    )
  }
}

// ── B. the items the candidate never answered ────────────────────────
{
  const candidate: RunRecord[] = []
  const baseline: RunRecord[] = []
  for (let i = 0; i < 6; i++) {
    const sid = `ok${i}`
    const a = 0.5 + 0.01 + i * 0.002
    baseline.push(rec('base', sid, 'search', 0.5), rec('base', sid, 'holdout', 0.5))
    candidate.push(rec('cand', sid, 'search', a), rec('cand', sid, 'holdout', a))
  }
  for (let i = 0; i < 20; i++) {
    const sid = `hard${i}`
    baseline.push(rec('base', sid, 'search', 0.5), rec('base', sid, 'holdout', 0.5))
  }
  console.log(
    '\nB. candidate answered 6 of 26 held-out items (+0.015 each) and produced NOTHING on 20 the',
  )
  console.log('   baseline scored 0.5 on.  TRUE MEAN Δ over the full holdout set = −0.3812')
  for (const thr of [0, -0.05]) {
    console.log(
      `   thr=${String(thr).padStart(5)}  branch ${ev(HeldOutGate, candidate, baseline, { pairedDeltaThreshold: thr })}` +
        `  main ${ev(MainGate, candidate, baseline, { pairedDeltaThreshold: thr })}` +
        `  pub0.125 ${ev(published.HeldOutGate, candidate, baseline, { pairedDeltaThreshold: thr })}`,
    )
  }
}

// ── C. minProductiveRuns disabled by NaN, tiny n, negative threshold ─
{
  const { candidate, baseline } = build([0.5, 0.5], [0.5 - 0.001, 0.5 - 0.002])
  console.log('\nC. n=2 pairs, BOTH worse (−0.001, −0.002), minProductiveRuns: NaN, thr −0.05')
  console.log(
    `   branch ${ev(HeldOutGate, candidate, baseline, { pairedDeltaThreshold: -0.05, minProductiveRuns: Number.NaN })}` +
      `  main ${ev(MainGate, candidate, baseline, { pairedDeltaThreshold: -0.05, minProductiveRuns: Number.NaN })}` +
      `  pub0.125 ${ev(published.HeldOutGate, candidate, baseline, { pairedDeltaThreshold: -0.05, minProductiveRuns: Number.NaN })}`,
  )
  console.log(
    `   (control, minProductiveRuns default 3) branch ${ev(HeldOutGate, candidate, baseline, { pairedDeltaThreshold: -0.05 })}`,
  )
}
