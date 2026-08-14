// Collects this slice's certification evidence into one measurement file.
// Separation is re-checked here: phase C can re-grade a solved container back to
// unsolved, which the determinism rule reads as stable because every replicate agrees.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
const OUT = process.env.HOME + '/bench-cache/certify-scale-20260813/slice5'
const rows = readFileSync(OUT + '/summary.psv', 'utf8').trim().split('\n')
const head = rows[0].split('|')
const results = rows.slice(1).map(line => {
  const r = Object.fromEntries(line.split('|').map((v, i) => [head[i], v]))
  const dvPath = `${OUT}/${r.task}/determinism-verdict.json`
  const dv = existsSync(dvPath) ? JSON.parse(readFileSync(dvPath, 'utf8')) : null
  const solved = dv?.byState?.find(s => s.state === 'solved')
  const unsolved = dv?.byState?.find(s => s.state === 'unsolved')
  const separationHeldInPhaseC = !!solved && !!unsolved && solved.passes === solved.replicates && unsolved.passes === 0
  return {
    taskName: r.task,
    image: dv?.image ?? r.image,
    suiteDigest: dv?.suiteDigest ?? null,
    scriptVerdict: r.verdict,
    phaseAReward: r.unsolved_reward,
    phaseBReward: r.solved_reward,
    replicates: dv?.replicates ?? null,
    flipRate: dv?.flipRate ?? null,
    granularity: solved?.granularity ?? null,
    phaseCSolvedPasses: solved ? `${solved.passes}/${solved.replicates}` : null,
    phaseCUnsolvedPasses: unsolved ? `${unsolved.passes}/${unsolved.replicates}` : null,
    separationHeldInPhaseC,
    sliceVerdict: r.verdict === 'CERTIFIED' && !separationHeldInPhaseC ? 'SUSPECT_SEPARATION_LOST_ON_REGRADE' : r.verdict,
    determinism: dv,
  }
})
const ordered = readFileSync('.scratch/slice5/cert-order.txt', 'utf8').trim().split('\n')
const reached = new Set(results.map(r => r.taskName))
const doc = {
  version: 1,
  slice: 5,
  slices: 6,
  selection: 'assay byTask tier_b>0, minus make-doom-for-mips, sorted by name, index % 6 == 5',
  tb2Commit: JSON.parse(readFileSync('benchmarks/trace-repair/tb-images.lock.json', 'utf8')).tb2Commit,
  assignedTasks: ordered.concat(['pytorch-model-recovery']).sort(),
  hostLoadDuringRun: process.env.SLICE5_LOADAVG ?? null,
  evidenceDir: OUT,
  results,
  unreached: ordered.concat(['pytorch-model-recovery']).sort().filter(t => !reached.has(t)),
}
writeFileSync('benchmarks/trace-repair/.slices/slice-5.json', JSON.stringify(doc, null, 2) + '\n')
console.log('certified', results.filter(r => r.sliceVerdict === 'CERTIFIED').length, '| suspect', results.filter(r => r.sliceVerdict.startsWith('SUSPECT')).length, '| other', results.filter(r => r.sliceVerdict !== 'CERTIFIED' && !r.sliceVerdict.startsWith('SUSPECT')).map(r => r.taskName + '=' + r.sliceVerdict).join(','), '| unreached', doc.unreached.length)
