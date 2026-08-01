import { readFileSync } from 'node:fs'

const sets = {
  'split3-37': '/dev/shm/ctb-split3-labels.json',
  'dev-32': '/home/drew/code/agent-eval/benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json',
  'holdout1-32': '/dev/shm/ctb-holdout-labels.json',
  'holdout2-32': '/home/drew/bench-cache/ctb-20260801/ctb-holdout2-labels.json',
}
const gold = (r) =>
  [...new Set((r.incorrect_stages ?? []).flatMap((s) => s.incorrect_step_ids ?? []))].sort(
    (a, b) => a - b,
  )
const f1 = (recall, precision) =>
  recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision)

for (const [name, path] of Object.entries(sets)) {
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  const positive = rows.filter((r) => gold(r).length > 0)
  const expected = positive.reduce((sum, r) => sum + gold(r).length, 0)
  const line = []
  for (const shift of [0, 1, 2]) {
    let matched = 0
    let predicted = 0
    for (const r of positive) {
      const step = r.step_count - shift
      predicted += 1
      if (gold(r).includes(step)) matched += 1
    }
    const recall = matched / expected
    const precision = matched / predicted
    line.push(`n-${shift}: R ${recall.toFixed(3)} P ${precision.toFixed(3)} F1 ${f1(recall, precision).toFixed(3)}`)
  }
  // last-2 window
  let matched = 0
  let predicted = 0
  for (const r of positive) {
    const window = new Set([r.step_count, r.step_count - 1])
    predicted += window.size
    for (const step of window) if (gold(r).includes(step)) matched += 1
  }
  const recall = matched / expected
  const precision = matched / predicted
  line.push(`last2: R ${recall.toFixed(3)} P ${precision.toFixed(3)} F1 ${f1(recall, precision).toFixed(3)}`)
  console.log(
    `${name.padEnd(12)} positive-cases ${String(positive.length).padStart(3)} gold ${String(expected).padStart(4)} | ${line.join(' | ')}`,
  )
}
