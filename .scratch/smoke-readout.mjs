import { readFileSync, writeFileSync } from 'node:fs'

const restoredPath = '/home/drew/bench-cache/ctb-20260801/split3-restored/smoke-run/observations.jsonl'
const baselinePath = '/dev/shm/cert-g-s3/observations.jsonl'
const labelsPath = '/dev/shm/ctb-split3-labels.json'

const read = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const restored = read(restoredPath).filter((r) => r.observation.runnerId === 'dspy-rlm')
const completed = new Set(restored.map((r) => r.observation.caseId))
console.log(`restored dspy observations: ${restored.length}, cases: ${completed.size}`)
const baseline = read(baselinePath).filter(
  (r) => r.observation.runnerId === 'dspy-rlm' && completed.has(r.observation.caseId),
)
// Keep only repetitions the restored arm has completed, so the comparison is paired.
const restoredKeys = new Set(
  restored.map((r) => `${r.observation.caseId}#${r.observation.repetition}`),
)
const pairedBaseline = baseline.filter((r) =>
  restoredKeys.has(`${r.observation.caseId}#${r.observation.repetition}`),
)
console.log(`paired baseline observations: ${pairedBaseline.length}`)

const labels = JSON.parse(readFileSync(labelsPath, 'utf8')).filter((row) =>
  completed.has(`codetrace:${row.traj_id}`),
)
writeFileSync('/dev/shm/ae-r2-tn/.scratch/smoke-completed-labels.json', `${JSON.stringify(labels, null, 2)}\n`)
writeFileSync(
  '/dev/shm/ae-r2-tn/.scratch/smoke-restored-obs.jsonl',
  `${restored.map((r) => JSON.stringify(r)).join('\n')}\n`,
)
writeFileSync(
  '/dev/shm/ae-r2-tn/.scratch/smoke-baseline-obs.jsonl',
  `${pairedBaseline.map((r) => JSON.stringify(r)).join('\n')}\n`,
)

const cost = restored.reduce((sum, r) => sum + (r.observation.usage?.cost?.usd ?? 0), 0)
console.log(`restored arm model cost so far: $${cost.toFixed(4)}`)
