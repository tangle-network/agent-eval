/**
 * Summarise a certification sweep: verdict, measured flip rate, and the units responsible.
 *
 * A refusal is only a finding about the task when the flipping unit asserts on something
 * the state does not fix — wall clock above all. This prints the flipping unit ids beside
 * whether the task's suite source contains a timing assertion, so a refusal measured on a
 * loaded machine can be told apart from one caused by the suite itself.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type OracleDeterminismEvidence,
  oracleDeterminism,
} from '../src/trace-repair/oracle-determinism'

const evidenceRoot = process.argv[2]
const verdictsPath = process.argv[3]
const tb2 = process.argv[4] ?? `${process.env.HOME}/bench-cache/terminal-bench-2`
const TIMING = /time\.time|perf_counter|monotonic|time\.process_time|\btimeit\b|speedup|elapsed/

function suiteHasTimingAssertion(task: string): boolean {
  const dir = join(tb2, task, 'tests')
  if (!existsSync(dir)) return false
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, entry)
    try {
      if (TIMING.test(readFileSync(path, 'utf8'))) return true
    } catch {
      // a directory entry, not a readable file
    }
  }
  return false
}

const rows = readFileSync(verdictsPath, 'utf8').split('\n').filter((l) => l.trim())
const counts = new Map<string, number>()

console.log(
  ['task', 'verdict', 'flip%', 'replicates', 'granularity', 'flipped_units', 'timing_assert', 'secs'].join('\t'),
)
for (const line of rows) {
  const [task, verdict, secs] = line.split('|')
  const kind = verdict.startsWith('NONDETERMINISTIC') ? 'NONDETERMINISTIC_ORACLE' : verdict.split('(')[0]
  counts.set(kind, (counts.get(kind) ?? 0) + 1)

  const path = join(evidenceRoot, task, 'determinism.json')
  let flip = '-'
  let reps = '-'
  let gran = '-'
  let units = '-'
  if (existsSync(path)) {
    const evidence = JSON.parse(readFileSync(path, 'utf8')) as OracleDeterminismEvidence
    const v = oracleDeterminism(evidence)
    flip = (v.flipRate * 100).toFixed(2)
    reps = String(v.replicates)
    gran = [...new Set(v.byState.map((s) => s.granularity))].join('+')
    const flipped = v.byState.flatMap((s) => s.flipped.map((u) => `${s.state}:${u.unit}`))
    units = flipped.length ? flipped.slice(0, 4).join(',') : 'none'
  }
  console.log(
    [task, kind, flip, reps, gran, units, suiteHasTimingAssertion(task) ? 'yes' : 'no', secs].join('\t'),
  )
}

console.log('\n--- verdict counts ---')
for (const [kind, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${kind}\t${n}`)
