/** Power of the repaired binary path: true RD = 0, judged against a -0.05
 *  noninferiority margin. Sets the defensible bar for the calibration test
 *  rather than guessing one. */
const { HeldOutGate } = await import(new URL('../dist/index.js', import.meta.url).href)
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

console.log('\n=== POWER: true RD = 0 (P(win)=P(loss)=p), margin -0.05, threshold cleared? ===')
console.log('   discordant rate p |     n | promote% (this is POWER, want high)')
for (const p of [0.05, 0.02, 0.01]) {
  for (const n of [76, 200, 400, 800, 1600]) {
    const r = rng(2024 + n + Math.round(p * 1000))
    let promoted = 0
    for (let rep = 0; rep < REPS; rep++) {
      const before = []
      const after = []
      for (let i = 0; i < n; i++) {
        const u = r()
        if (u < p) {
          before.push(0)
          after.push(1)
        } else if (u < 2 * p) {
          before.push(1)
          after.push(0)
        } else {
          const v = i % 2 === 0 ? 1 : 0
          before.push(v)
          after.push(v)
        }
      }
      const { cand, base } = arms(before, after)
      const d = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: -0.05 }).evaluate(
        cand,
        base,
      )
      if (d.promote) promoted++
    }
    console.log(
      `   ${String(p).padStart(17)} | ${String(n).padStart(5)} | ${((promoted / REPS) * 100).toFixed(2).padStart(7)}%`,
    )
  }
}

console.log('\n=== POWER: true lift +10pp (P(win)=0.10, P(loss)=0), threshold 0 ===')
for (const n of [20, 40, 76, 200]) {
  const r = rng(999 + n)
  let promoted = 0
  for (let rep = 0; rep < REPS; rep++) {
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
    const { cand, base } = arms(before, after)
    const d = new HeldOutGate({ baselineKey: 'baseline' }).evaluate(cand, base)
    if (d.promote) promoted++
  }
  console.log(`   n=${String(n).padStart(4)} | ${((promoted / REPS) * 100).toFixed(2).padStart(7)}%`)
}
console.log('')
