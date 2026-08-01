import { readFileSync, existsSync } from 'node:fs'

const SUB = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'
const sets = {
  'split3-37': ['/dev/shm/ctb-split3-labels.json', '/dev/shm/ctb-split3-traces'],
  'dev-32': [
    '/home/drew/code/agent-eval/benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json',
    '/dev/shm/ctb-traces',
  ],
  'holdout1-32': ['/dev/shm/ctb-holdout-labels.json', '/dev/shm/ctb-holdout-traces'],
  'holdout2-32': [
    '/home/drew/bench-cache/ctb-20260801/ctb-holdout2-labels.json',
    '/home/drew/bench-cache/ctb-20260801/ctb-holdout2-traces',
  ],
}
const gold = (r) =>
  [...new Set((r.incorrect_stages ?? []).flatMap((s) => s.incorrect_step_ids ?? []))].sort(
    (a, b) => a - b,
  )

for (const [name, [labelsPath, traceDir]] of Object.entries(sets)) {
  if (!existsSync(traceDir)) {
    console.log(`${name}: trace directory missing (${traceDir})`)
    continue
  }
  const rows = JSON.parse(readFileSync(labelsPath, 'utf8')).filter((r) => gold(r).length > 0)
  let goldSteps = 0
  let blind = 0
  let allBlindCases = 0
  let spans = 0
  let duplicateSpans = 0
  for (const row of rows) {
    const path = `${traceDir}/${row.traj_id}.otlp.jsonl`
    if (!existsSync(path)) {
      console.log(`${name}: no trace for ${row.traj_id}`)
      continue
    }
    const content = new Map()
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const attributes = JSON.parse(line).attributes ?? {}
      if (attributes['trajectory.role'] !== 'assistant' || attributes.step === undefined) continue
      content.set(Number(attributes.step), String(attributes.content ?? ''))
    }
    const occurrences = new Map()
    for (const text of content.values()) occurrences.set(text, (occurrences.get(text) ?? 0) + 1)
    spans += content.size
    duplicateSpans += [...occurrences.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0)
    const steps = gold(row)
    let caseBlind = 0
    for (const step of steps) {
      const text = content.get(step) ?? ''
      const beyond = text
        .split('\n')
        .filter((l) => !l.includes(SUB))
        .join('\n')
        .trim()
      goldSteps += 1
      if ((occurrences.get(text) ?? 0) > 1 || beyond === '') {
        blind += 1
        caseBlind += 1
      }
    }
    if (caseBlind === steps.length) allBlindCases += 1
  }
  console.log(
    `${name.padEnd(12)} cases ${String(rows.length).padStart(3)} | gold ${String(goldSteps).padStart(4)} ` +
      `input-blind ${String(blind).padStart(4)} (${((blind / goldSteps) * 100).toFixed(1)}%) | ` +
      `all-gold-blind cases ${allBlindCases}/${rows.length} | duplicate assistant spans ${duplicateSpans}/${spans}`,
  )
}
