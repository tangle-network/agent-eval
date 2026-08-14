import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = '/home/drew/code/agent-eval/.worktrees/certify-oracles-scale'
const out = process.env.HOME + '/bench-cache/certify-slice4'
const tasks = readFileSync(join(root, '.scratch/slice4/tasks.txt'), 'utf8').trim().split('\n')

const summaryPath = join(out, 'summary.psv')
const summary = new Map()
if (existsSync(summaryPath)) {
  const lines = readFileSync(summaryPath, 'utf8').trim().split('\n')
  const header = lines[0].split('|')
  for (const line of lines.slice(1)) {
    const cells = line.split('|')
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]))
    summary.set(row[header[0]], row)
  }
}

const results = []
for (const task of tasks) {
  const dir = join(out, task)
  const entry = { taskName: task }
  const verdictPath = join(dir, 'determinism-verdict.json')
  const detPath = join(dir, 'determinism.json')
  const row = summary.get(task)
  if (row) entry.summaryRow = row
  if (existsSync(verdictPath)) entry.determinismVerdict = JSON.parse(readFileSync(verdictPath, 'utf8'))
  if (existsSync(detPath)) entry.measurement = JSON.parse(readFileSync(detPath, 'utf8'))
  const runLog = join(out, `${task}.run.log`)
  if (existsSync(runLog)) {
    const verdicts = readFileSync(runLog, 'utf8').split('\n').filter((l) => l.startsWith('VERDICT='))
    entry.certifyVerdict = verdicts.length ? verdicts[verdicts.length - 1].slice('VERDICT='.length) : 'NO_VERDICT_EMITTED'
  } else {
    entry.certifyVerdict = 'NOT_REACHED'
  }
  results.push(entry)
}

const slicesDir = join(root, 'benchmarks/trace-repair/.slices')
mkdirSync(slicesDir, { recursive: true })
const doc = {
  version: 1,
  slice: 'slice-4-of-6',
  selection: 'assay byTask tier_b>0, excluding make-doom-for-mips and tasks already in task-oracles.json, sorted by name, index % 6 === 4',
  evidenceDir: out,
  writtenAt: new Date().toISOString(),
  tasks: results,
}
writeFileSync(join(slicesDir, 'slice-4.json'), JSON.stringify(doc, null, 2) + '\n')
console.log(results.map((r) => `${r.taskName}\t${r.certifyVerdict}`).join('\n'))
