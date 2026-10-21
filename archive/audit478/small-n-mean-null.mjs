/** Supplementary: the bounded asymmetric mean-null BELOW n=20, where
 *  `pairedDeltaTest` stops deciding on the bootstrap interval and decides on an
 *  exact one-sided SIGN test instead. The sign test is about the median; the
 *  gate's estimand is the mean. Under a bounded asymmetric law those disagree,
 *  so this is the cell that says whether a zero-width fail-closed rule is
 *  needed at small n as well as at n >= 20.
 *
 *  DIST=/dev/shm/ae478-dist-before/index.js node audit478/small-n-mean-null.mjs
 */
const distPath = process.env.DIST ?? new URL('../dist/index.js', import.meta.url).href
const { HeldOutGate } = await import(distPath)

const REPS = Number(process.env.REPS ?? 4000)
const P_DROP = 0.02
const GAIN = P_DROP / (1 - P_DROP)

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

console.log(`\n=== small-n bounded asymmetric mean-null, true mean = 0, threshold 0, nominal 5% ===`)
console.log(`    build: ${distPath}`)
console.log(`    reps=${REPS} per cell`)
for (const jitter of [false, true]) {
  console.log(`\n  --- gains ${jitter ? 'JITTERED (CI has width)' : 'IDENTICAL (CI zero-width)'} ---`)
  for (const n of [6, 8, 10, 12, 16, 20, 26]) {
    const r = rng(31337 + n + (jitter ? 5000 : 0))
    let promoted = 0
    const codes = new Map()
    for (let rep = 0; rep < REPS; rep++) {
      const before = []
      const after = []
      for (let i = 0; i < n; i++) {
        before.push(1)
        if (r() < P_DROP) after.push(0)
        else after.push(1 + (jitter ? GAIN * (0.5 + r()) : GAIN))
      }
      const { cand, base } = arms(before, after)
      const gate = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: 0 })
      const d = gate.evaluate(cand, base)
      if (d.promote) promoted++
      const key = d.rejectionCode ?? 'PROMOTED'
      codes.set(key, (codes.get(key) ?? 0) + 1)
    }
    const breakdown = [...codes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(
      `  n=${String(n).padStart(2)}  promote=${((promoted / REPS) * 100).toFixed(2).padStart(6)}%  ${breakdown}`,
    )
  }
}
console.log('')
