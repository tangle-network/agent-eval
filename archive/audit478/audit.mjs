/**
 * INDEPENDENT AUDIT HARNESS for PR #478 (merge commit 8c04e7d).
 *
 * PROVENANCE: written fresh by the auditor. The audit that closed #457 ran at
 * head 041a53c and its harness is NOT recoverable — the worktree
 * /dev/shm/agent-eval-pr457-head-041a is checked out at 041a53c but
 * `git status --short --untracked-files=all --ignored` is empty, PR #457 has no
 * comment containing the scripts, and nothing on disk matches the reported
 * figures. So these are my numbers, on my construction, against the REAL
 * exported `HeldOutGate.evaluate` from the built package.
 *
 * Run: node audit478/audit.mjs
 */
import { HeldOutGate, pairedRiskDifferenceExact } from '../dist/index.js'

const REPS = Number(process.env.REPS ?? 2000)

function rec(candidateId, scenarioId, split, score) {
  return {
    runId: `${candidateId}-${scenarioId}-${split}`,
    experimentId: 'exp1',
    candidateId,
    seed: 0,
    model: 'm',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1000,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 10, output: 10 },
    terminalOutcome: 'succeeded',
    outcome: split === 'search' ? { searchScore: score, raw: {} } : { holdoutScore: score, raw: {} },
    splitTag: split,
    scenarioId,
  }
}

/** Search scores are copied from holdout, so the overfit-gap gate is neutral
 *  (candidate gap == baseline gap == 0) and split coverage is exactly 1. The
 *  only gate under test is the paired-delta one. */
function arms(before, after) {
  const cand = []
  const base = []
  for (let i = 0; i < before.length; i++) {
    const s = `s${i}`
    cand.push(rec('cand', s, 'search', after[i]), rec('cand', s, 'holdout', after[i]))
    base.push(rec('baseline', s, 'search', before[i]), rec('baseline', s, 'holdout', before[i]))
  }
  return { cand, base }
}

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sweep(label, ns, threshold, draw, seedBase) {
  const rows = []
  for (const n of ns) {
    const r = rng(seedBase + n)
    let promoted = 0
    const codes = new Map()
    for (let rep = 0; rep < REPS; rep++) {
      const { before, after } = draw(n, r)
      const { cand, base } = arms(before, after)
      const gate = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: threshold })
      const d = gate.evaluate(cand, base)
      if (d.promote) promoted++
      const key = d.rejectionCode ?? 'PROMOTED'
      codes.set(key, (codes.get(key) ?? 0) + 1)
    }
    const pct = ((promoted / REPS) * 100).toFixed(2)
    const breakdown = [...codes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    rows.push(`  n=${String(n).padStart(3)}  promote=${pct.padStart(6)}%  ${breakdown}`)
    console.log(rows[rows.length - 1])
  }
  console.log(`  [${label}] done, reps=${REPS} per cell\n`)
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n########## AUDIT OF ${process.env.AUDIT_LABEL ?? 'HEAD'} — reps=${REPS} ##########`)

// A. PAIRED-BINARY NONINFERIORITY BOUNDARY.
// True process: P(candidate wins)=0, P(candidate loses)=0.05, else tie.
// True risk difference = -0.05 = EXACTLY the noninferiority margin. A nominal
// 95% rule must promote at most 5% of repeated samples here.
console.log('=== A. paired-binary noninferiority boundary: true RD = margin = -0.05, nominal 5% ===')
const drawBinary = (n, r) => {
  const before = []
  const after = []
  for (let i = 0; i < n; i++) {
    if (r() < 0.05) {
      before.push(1)
      after.push(0)
    } else {
      const v = i % 2 === 0 ? 1 : 0
      before.push(v)
      after.push(v)
    }
  }
  return { before, after }
}
sweep('A', [3, 6, 10, 20, 40, 76, 200, 500], -0.05, drawBinary, 12345)

// A2. The owner's own witness from PR #457, replayed through this head's gate.
console.log('=== A2. 76 pairs / 0 wins / 3 losses / 73 ties @ threshold -0.05 ===')
{
  const before = []
  const after = []
  for (let i = 0; i < 3; i++) {
    before.push(1)
    after.push(0)
  }
  for (let i = 0; i < 73; i++) {
    const v = i % 2 === 0 ? 1 : 0
    before.push(v)
    after.push(v)
  }
  const { cand, base } = arms(before, after)
  const gate = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: -0.05 })
  const d = gate.evaluate(cand, base)
  console.log(`  promote=${d.promote}  code=${d.rejectionCode}`)
  console.log(`  statistic=${d.evidence.deltaStatistic}`)
  console.log(`  CI=[${d.evidence.pairedCI?.low}, ${d.evidence.pairedCI?.high}]`)
  console.log(`  mcnemar p=${d.evidence.mcnemar?.pValue}  decidingDelta=${d.evidence.decidingDelta}`)
  console.log(`  reason: ${d.reason}\n`)
}

// A3. The raw estimator at n=3, every reachable (b,c), independent of the
// gate's own >=6-pair floor.
console.log('=== A3. pairedRiskDifferenceExact at n=3, every reachable (b,c) ===')
for (const [b, c] of [
  [0, 0],
  [1, 0],
  [0, 1],
  [2, 0],
  [3, 0],
]) {
  const control = []
  const treat = []
  for (let i = 0; i < b; i++) {
    control.push(0)
    treat.push(1)
  }
  for (let i = 0; i < c; i++) {
    control.push(1)
    treat.push(0)
  }
  while (control.length < 3) {
    control.push(1)
    treat.push(1)
  }
  const e = pairedRiskDifferenceExact(control, treat, 0.95)
  console.log(
    `  b=${b} c=${c}  RD=${e.riskDifference.toFixed(6)}  CI=[${e.lower.toFixed(6)}, ${e.upper.toFixed(6)}]  p=${e.pValue.toFixed(6)}`,
  )
}
console.log('')

// B. BOUNDED ASYMMETRIC MEAN-NULL. Deltas bounded in [-1, +g]. With probability
// 0.02 a pair drops by exactly 1.0, otherwise it gains g = 0.02/0.98. The TRUE
// mean paired delta is exactly 0 — the estimand this path decides on — at
// threshold 0. A nominal 95% rule must promote at most 5% of samples.
const P_DROP = 0.02
const GAIN = P_DROP / (1 - P_DROP)
console.log(
  `=== B. bounded asymmetric mean-null: P(drop 1.0)=${P_DROP}, else +${GAIN.toFixed(6)}; true mean=0, threshold 0, nominal 5% ===`,
)
const drawMeanNull = (n, r) => {
  const before = []
  const after = []
  for (let i = 0; i < n; i++) {
    before.push(1)
    after.push(r() < P_DROP ? 0 : 1 + GAIN)
  }
  return { before, after }
}
sweep('B', [20, 26, 40, 76, 200], 0, drawMeanNull, 999)

console.log('=== B2. same null, gains jittered so a no-drop sample has real CI width ===')
const drawMeanNullJitter = (n, r) => {
  const before = []
  const after = []
  for (let i = 0; i < n; i++) {
    before.push(1)
    if (r() < P_DROP) after.push(0)
    else after.push(1 + GAIN * (0.5 + r()))
  }
  return { before, after }
}
sweep('B2', [20, 26, 40, 76, 200], 0, drawMeanNullJitter, 4242)

// C. DETERMINISM. One identical input, evaluated 500 times, no seed configured.
console.log('=== C. determinism: 500 evaluations of one identical input, no seed configured ===')
{
  const n = 24
  const r = rng(7)
  const before = []
  const after = []
  for (let i = 0; i < n; i++) {
    before.push(1)
    after.push(1 + (r() < 0.5 ? 0.02 : -0.014))
  }
  const { cand, base } = arms(before, after)
  const verdicts = new Set()
  const cis = new Set()
  for (let i = 0; i < 500; i++) {
    const gate = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: 0 })
    const d = gate.evaluate(cand, base)
    verdicts.add(`${d.promote}|${d.rejectionCode}`)
    cis.add(`${d.evidence.pairedCI?.low},${d.evidence.pairedCI?.high}`)
  }
  console.log(`  distinct verdicts over 500 = ${verdicts.size} -> ${[...verdicts].join(' | ')}`)
  console.log(`  distinct CIs over 500      = ${cis.size} -> ${[...cis].join(' | ')}\n`)
}

// D. THE DEFECT #478 EXISTS TO FIX — must still be fixed after any repair.
// A real +13.2pp lift over 76 held-out items: 15 wins / 5 losses / 56 ties.
console.log('=== D. the real +13.2pp lift #478 exists to see: 15 wins / 5 losses / 56 ties @ threshold 0 ===')
{
  const before = []
  const after = []
  for (let i = 0; i < 15; i++) {
    before.push(0)
    after.push(1)
  }
  for (let i = 0; i < 5; i++) {
    before.push(1)
    after.push(0)
  }
  for (let i = 0; i < 56; i++) {
    const v = i % 2 === 0 ? 1 : 0
    before.push(v)
    after.push(v)
  }
  const { cand, base } = arms(before, after)
  const gate = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: 0 })
  const d = gate.evaluate(cand, base)
  console.log(`  promote=${d.promote}  code=${d.rejectionCode}`)
  console.log(`  CI=[${d.evidence.pairedCI?.low}, ${d.evidence.pairedCI?.high}]`)
  console.log(`  mcnemar p=${d.evidence.mcnemar?.pValue}  medianPairedDelta=${d.evidence.medianPairedDelta}`)
  console.log(`  reason: ${d.reason}\n`)
}

// E. POWER — a repair must not turn the gate into "always refuse".
// True lift of +10pp with no losses, and a mixed +15/-5 lift.
console.log('=== E. power at a real lift (true RD = +0.10, P(win)=0.10, P(loss)=0) @ threshold 0 ===')
const drawLift = (n, r) => {
  const before = []
  const after = []
  for (let i = 0; i < n; i++) {
    if (r() < 0.1) {
      before.push(0)
      after.push(1)
    } else {
      const v = i % 2 === 0 ? 1 : 0
      before.push(v)
      after.push(v)
    }
  }
  return { before, after }
}
sweep('E', [20, 40, 76, 200], 0, drawLift, 555)

console.log(
  '=== E2. power at a real NONINFERIORITY pass: true RD = 0 (P(win)=P(loss)=0.05) @ threshold -0.05 ===',
)
const drawNoninf = (n, r) => {
  const before = []
  const after = []
  for (let i = 0; i < n; i++) {
    const u = r()
    if (u < 0.05) {
      before.push(0)
      after.push(1)
    } else if (u < 0.1) {
      before.push(1)
      after.push(0)
    } else {
      const v = i % 2 === 0 ? 1 : 0
      before.push(v)
      after.push(v)
    }
  }
  return { before, after }
}
sweep('E2', [20, 40, 76, 200], -0.05, drawNoninf, 777)

console.log('########## END ##########\n')
