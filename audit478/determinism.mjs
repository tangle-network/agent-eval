/** 500 evaluations of ONE identical input, counting distinct verdicts.
 *  #457 was closed partly on "233 promotions and 267 refusals across 500
 *  evaluations because unseeded bootstrap randomness". */
const distPath = process.env.DIST ?? new URL('../dist/index.js', import.meta.url).href
const { HeldOutGate } = await import(distPath)

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

console.log(`\n=== DETERMINISM: 500 evaluations of one identical input ===`)
console.log(`    build: ${distPath}`)

// Several inputs, all on the bootstrap path (non-binary, n >= 20), chosen to
// sit near the threshold where resampling noise would flip a verdict.
const cases = [
  { label: 'near-threshold mixed deltas, n=24', n: 24, seed: 7, hi: 0.02, lo: -0.014 },
  { label: 'near-threshold mixed deltas, n=40', n: 40, seed: 11, hi: 0.03, lo: -0.026 },
  { label: 'near-threshold mixed deltas, n=64', n: 64, seed: 13, hi: 0.05, lo: -0.045 },
]
for (const c of cases) {
  const r = rng(c.seed)
  const before = []
  const after = []
  for (let i = 0; i < c.n; i++) {
    before.push(1)
    after.push(1 + (r() < 0.5 ? c.hi : c.lo))
  }
  const { cand, base } = arms(before, after)
  const verdicts = new Map()
  const cis = new Set()
  for (let i = 0; i < 500; i++) {
    const d = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: 0 }).evaluate(
      cand,
      base,
    )
    const k = `${d.promote ? 'PROMOTE' : 'REFUSE'}|${d.rejectionCode}`
    verdicts.set(k, (verdicts.get(k) ?? 0) + 1)
    cis.add(`${d.evidence.pairedCI?.low},${d.evidence.pairedCI?.high}`)
  }
  console.log(`\n  ${c.label}`)
  console.log(`    distinct verdicts = ${verdicts.size}`)
  for (const [k, v] of verdicts) console.log(`      ${k} : ${v}/500`)
  console.log(`    distinct CIs      = ${cis.size}`)
}
console.log('')
