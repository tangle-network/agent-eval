/** Two questions the main audit leaves open.
 *
 *  1. Is the residual bounded-asymmetric mean-null rate a DEFECT or the
 *     nonparametric FLOOR? A sample that contains no drop at all carries no
 *     evidence that a drop is possible, so no method without an assumption
 *     about the score range can refuse it. Compare the measured promotion rate
 *     against P(no drop in n) = (1-p)^n. At-or-below that line = floor, not bug.
 *
 *  2. Is the score interval anti-conservative at a NEGATIVE threshold at small
 *     n, where no exact veto applies? Sweep the margin, not just -0.05.
 */
const distPath = process.env.DIST ?? new URL('../dist/index.js', import.meta.url).href
const { HeldOutGate } = await import(distPath)

const REPS = Number(process.env.REPS ?? 4000)

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

console.log(`\n### build: ${distPath}   reps=${REPS}\n`)

console.log('=== 1. bounded asymmetric mean-null vs the no-counterevidence floor ===')
console.log('    P(drop)=0.02, drop magnitude 1.0, gains jittered; true mean = 0; threshold 0')
console.log('   n | promote% | P(no drop)=0.98^n | promote% - floor')
for (const n of [6, 8, 10, 12, 16, 20, 26, 40]) {
  const r = rng(8080 + n)
  const P_DROP = 0.02
  const GAIN = P_DROP / (1 - P_DROP)
  let promoted = 0
  let noDrop = 0
  for (let rep = 0; rep < REPS; rep++) {
    const before = []
    const after = []
    let sawDrop = false
    for (let i = 0; i < n; i++) {
      before.push(1)
      if (r() < P_DROP) {
        after.push(0)
        sawDrop = true
      } else after.push(1 + GAIN * (0.5 + r()))
    }
    if (!sawDrop) noDrop++
    const { cand, base } = arms(before, after)
    const d = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: 0 }).evaluate(
      cand,
      base,
    )
    if (d.promote) promoted++
  }
  const pct = (promoted / REPS) * 100
  const floor = 0.98 ** n * 100
  console.log(
    `  ${String(n).padStart(2)} | ${pct.toFixed(2).padStart(7)}% | ${floor.toFixed(2).padStart(16)}% | ${(pct - floor).toFixed(2).padStart(7)}  (empirical no-drop samples: ${((noDrop / REPS) * 100).toFixed(2)}%)`,
  )
}

console.log('\n=== 2. binary noninferiority: margin sweep at the boundary (true RD = margin) ===')
console.log('    nominal 5%; a cell above 5% is anti-conservative')
const margins = [-0.02, -0.05, -0.1, -0.2, -0.3]
process.stdout.write('     n |')
for (const m of margins) process.stdout.write(`  margin=${String(m).padStart(5)} |`)
process.stdout.write('\n')
for (const n of [6, 10, 20, 40, 76, 200, 500]) {
  process.stdout.write(`  ${String(n).padStart(4)} |`)
  for (const margin of margins) {
    const pLoss = -margin
    const r = rng(4321 + n + Math.round(margin * -1000))
    let promoted = 0
    for (let rep = 0; rep < REPS; rep++) {
      const before = []
      const after = []
      for (let i = 0; i < n; i++) {
        if (r() < pLoss) {
          before.push(1)
          after.push(0)
        } else {
          const v = i % 2 === 0 ? 1 : 0
          before.push(v)
          after.push(v)
        }
      }
      const { cand, base } = arms(before, after)
      const d = new HeldOutGate({
        baselineKey: 'baseline',
        pairedDeltaThreshold: margin,
      }).evaluate(cand, base)
      if (d.promote) promoted++
    }
    const pct = ((promoted / REPS) * 100).toFixed(2)
    process.stdout.write(`${(pct + '%').padStart(15)} |`)
  }
  process.stdout.write('\n')
}
console.log('')
