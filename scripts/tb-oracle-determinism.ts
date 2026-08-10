/**
 * Apply the oracle-determinism rule to measured replicates.
 *
 * `certify-task-oracle.sh` runs the replicates and writes the evidence; this
 * reads it and decides. The rule lives in one place — `oracleDeterminism` in
 * the substrate — so the verdict a certification run prints and the verdict a
 * campaign enforces cannot drift apart.
 *
 *   node --import tsx scripts/tb-oracle-determinism.ts EVIDENCE.json [--out VERDICT.json]
 *
 * Prints one line of shell-readable fields, then a human summary on stderr.
 * Exit 0 when the task's grader answered about the state, 3 when it did not,
 * 2 when the evidence could not be read.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import {
  type OracleDeterminismEvidence,
  oracleDeterminism,
} from '../src/trace-repair/oracle-determinism'

function fail(message: string): never {
  process.stderr.write(`tb-oracle-determinism: ${message}\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
const evidencePath = args.find((arg) => !arg.startsWith('--'))
if (!evidencePath) fail('name an evidence JSON file')
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? args[outIndex + 1] : null

let evidence: OracleDeterminismEvidence
try {
  evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as OracleDeterminismEvidence
} catch (error) {
  fail(`cannot read ${evidencePath}: ${(error as Error).message}`)
}

let verdict: ReturnType<typeof oracleDeterminism>
try {
  verdict = oracleDeterminism(evidence)
} catch (error) {
  fail((error as Error).message)
}

if (outPath) writeFileSync(outPath, `${JSON.stringify(verdict, null, 2)}\n`)

// Basis points keep the shell in integer arithmetic.
process.stdout.write(
  `flip_bp=${Math.round(verdict.flipRate * 10000)} replicates=${verdict.replicates} ` +
    `state=${verdict.stable ? 'stable' : 'unstable'}\n`,
)
process.stderr.write(`${verdict.taskName}: ${verdict.detail}\n`)
for (const state of verdict.byState) {
  for (const unit of state.flipped) {
    process.stderr.write(
      `  ${state.state} ${unit.unit}: ${unit.passes} pass / ${unit.fails} fail ` +
        `(flip ${(unit.flipRate * 100).toFixed(1)} %)\n`,
    )
  }
}
process.exit(verdict.stable ? 0 : 3)
