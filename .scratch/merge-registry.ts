/**
 * Merge measured determinism evidence into the checked-in task-oracle registry.
 *
 * Only two outcomes may enter the file. The admission gate reads the registry and checks
 * determinism alone, so evidence from a task whose phase A or phase B failed would admit a
 * task whose suite cannot separate a solved state from an unsolved one. Those stay absent,
 * which reads as `task-oracle-uncertified` and stops a row.
 *
 *   CERTIFIED               -> stable replicates, admitted
 *   NONDETERMINISTIC_ORACLE -> unstable replicates, refused with a measured flip rate
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type OracleDeterminismEvidence,
  type TaskOracleRegistryDocument,
  oracleDeterminism,
  parseTaskOracleRegistry,
} from '../src/trace-repair/oracle-determinism'

const REGISTRY = 'benchmarks/trace-repair/task-oracles.json'
const evidenceRoot = process.argv[2]
const verdictsPath = process.argv[3]
if (!evidenceRoot || !verdictsPath) {
  process.stderr.write('usage: merge-registry.ts EVIDENCE_ROOT VERDICTS_PSV\n')
  process.exit(2)
}

const admissible = new Set<string>()
const rejected: Array<{ task: string; verdict: string }> = []
for (const line of readFileSync(verdictsPath, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const [task, verdict] = line.split('|')
  if (verdict === 'CERTIFIED' || verdict.startsWith('NONDETERMINISTIC_ORACLE')) admissible.add(task)
  else rejected.push({ task, verdict })
}

const document = JSON.parse(readFileSync(REGISTRY, 'utf8')) as TaskOracleRegistryDocument
const measurements: OracleDeterminismEvidence[] = [...document.measurements]
const known = new Set(measurements.map((m) => m.taskName))

let added = 0
for (const task of [...admissible].sort()) {
  const path = join(evidenceRoot, task, 'determinism.json')
  if (!existsSync(path)) {
    process.stderr.write(`no determinism evidence for ${task} at ${path}\n`)
    process.exit(1)
  }
  const evidence = JSON.parse(readFileSync(path, 'utf8')) as OracleDeterminismEvidence
  if (evidence.taskName !== task) {
    process.stderr.write(`evidence at ${path} names ${evidence.taskName}, expected ${task}\n`)
    process.exit(1)
  }
  // Re-derive here too: the file must never carry replicates the rule cannot read.
  oracleDeterminism(evidence)
  if (known.has(task)) {
    process.stderr.write(`${task} already certified in the registry; leaving it as recorded\n`)
    continue
  }
  measurements.push(evidence)
  added += 1
}

measurements.sort((a, b) => a.taskName.localeCompare(b.taskName))
const next: TaskOracleRegistryDocument = { version: 1, measurements }
writeFileSync(REGISTRY, `${JSON.stringify(next, null, 2)}\n`)

const registry = parseTaskOracleRegistry(JSON.parse(readFileSync(REGISTRY, 'utf8')))
let stable = 0
for (const [, verdict] of registry) if (verdict.stable) stable += 1
process.stdout.write(
  `added ${added}; registry holds ${registry.size} task(s), ${stable} stable, ` +
    `${registry.size - stable} refused; ${rejected.length} outcome(s) deliberately omitted\n`,
)
for (const row of rejected) process.stdout.write(`  omitted ${row.task}: ${row.verdict}\n`)
