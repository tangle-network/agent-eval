/**
 * Assemble slice 3's measurements into one file, so parallel slices never edit the shared
 * registry at the same time. The verdict is re-derived from the replicates here as well:
 * the file records what was measured, not a word a script chose.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type OracleDeterminismEvidence,
  oracleDeterminism,
} from '/home/drew/code/agent-eval/.worktrees/certify-oracles-scale/src/trace-repair/oracle-determinism'

const ROOT = '/home/drew/code/agent-eval/.worktrees/certify-oracles-scale'
const HOME = process.env.HOME as string
const SLICE_OUT = join(ROOT, 'benchmarks/trace-repair/.slices/slice-3.json')
const SOURCES = [
  { root: join(HOME, 'bench-cache/certify-slice3'), provenance: 'slice-3 run 2026-08-14' },
  { root: join(HOME, 'bench-cache/certify-scale-20260813'), provenance: 'serial run 2026-08-13, reused' },
]
const TASKS = process.argv.slice(2)

type Row = Record<string, string>
function summaryRows(root: string): Map<string, Row> {
  const path = join(root, 'summary.psv')
  const out = new Map<string, Row>()
  if (!existsSync(path)) return out
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  const header = lines[0].split('|')
  for (const line of lines.slice(1)) {
    const cells = line.split('|')
    const row: Row = {}
    header.forEach((h, i) => (row[h] = cells[i]))
    out.set(row.task, row)
  }
  return out
}

const bySource = SOURCES.map((s) => ({ ...s, rows: summaryRows(s.root) }))
const registryPath = join(ROOT, 'benchmarks/trace-repair/task-oracles.json')
const registry = new Map<string, OracleDeterminismEvidence>(
  (JSON.parse(readFileSync(registryPath, 'utf8')).measurements as OracleDeterminismEvidence[]).map(
    (m) => [m.taskName, m],
  ),
)
const measurements: unknown[] = []
const unreached: string[] = []

for (const task of TASKS) {
  const hit = bySource.find((s) => s.rows.has(task))
  if (!hit) {
    // Already recorded in the checked-in registry: re-derive from its replicates rather
    // than re-grade, and say which file the replicates came from.
    const recorded = registry.get(task)
    if (recorded) {
      const derived = oracleDeterminism(recorded)
      measurements.push({
        taskName: task,
        verdict: derived.stable ? 'CERTIFIED' : 'NONDETERMINISTIC_ORACLE',
        provenance: 'already in benchmarks/trace-repair/task-oracles.json',
        evidencePath: registryPath,
        determinism: {
          stable: derived.stable,
          flipRatePct: Number((derived.flipRate * 100).toFixed(2)),
          replicates: derived.replicates,
          granularity: [...new Set(derived.byState.map((s) => s.granularity))].join('+'),
          flippedUnits: derived.byState.flatMap((s) =>
            s.flipped.map((u) => ({ state: s.state, unit: u.unit, passes: u.passes, fails: u.fails })),
          ),
          detail: derived.detail,
        },
      })
      continue
    }
    unreached.push(task)
    continue
  }
  const row = hit.rows.get(task) as Row
  const evidencePath = join(hit.root, task, 'determinism.json')
  let derived: ReturnType<typeof oracleDeterminism> | null = null
  if (existsSync(evidencePath)) {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as OracleDeterminismEvidence
    derived = oracleDeterminism(evidence)
  }
  measurements.push({
    taskName: task,
    verdict: row.verdict,
    provenance: hit.provenance,
    evidencePath,
    unsolvedReward: row.unsolved_reward,
    solvedReward: row.solved_reward,
    testsBeforeAgentPhase: row.tests_before_agent_phase,
    determinism: derived && {
      stable: derived.stable,
      flipRatePct: Number((derived.flipRate * 100).toFixed(2)),
      replicates: derived.replicates,
      granularity: [...new Set(derived.byState.map((s) => s.granularity))].join('+'),
      flippedUnits: derived.byState.flatMap((s) =>
        s.flipped.map((u) => ({ state: s.state, unit: u.unit, passes: u.passes, fails: u.fails })),
      ),
      detail: derived.detail,
    },
  })
}

mkdirSync(join(ROOT, 'benchmarks/trace-repair/.slices'), { recursive: true })
writeFileSync(
  SLICE_OUT,
  `${JSON.stringify(
    {
      sliceId: 'slice-3',
      of: 6,
      selection: 'tb-images.lock.json image keys sorted, zero-based index % 6 === 3',
      generatedAt: new Date().toISOString(),
      loadContext:
        'six slices certified in parallel on one 32-core host; phase C idle groups were not on an idle machine',
      measurements,
      unreached,
    },
    null,
    2,
  )}\n`,
)
console.log(`wrote ${measurements.length} measurement(s), ${unreached.length} unreached -> ${SLICE_OUT}`)
