/**
 * Capture a multishot golden-record fixture from a reference engine.
 *
 *   pnpm tsx scripts/record-multishot-golden.ts \
 *     --version v1 \
 *     --engine ./src/multishot/multishot.ts#runMultishot \
 *     --matrix-engine ./src/multishot/matrix.ts#runMultishotMatrix
 *
 * Records are FROZEN once written. The script refuses to overwrite an existing
 * version file, because a golden record that can be regenerated over itself
 * proves nothing: a regression would simply be re-recorded as the new truth. A
 * deliberate behaviour change mints a NEW version and the diff between the two
 * files is the reviewable evidence.
 *
 * Every scenario is captured TWICE and the two captures must be identical.
 * A scenario that is not reproducible cannot be a regression detector, so an
 * unstable capture fails the run instead of freezing a coin flip.
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareJson } from '../src/multishot/golden/compare'
import { isUsableDuration } from '../src/multishot/golden/harness'
import type {
  MultishotGoldenEngine,
  MultishotMatrixGoldenEngine,
} from '../src/multishot/golden/engine'
import {
  multishotMatrixGoldenScenarios,
  type MultishotMatrixGoldenScenario,
} from '../src/multishot/golden/matrix-scenarios'
import {
  readRunDir,
  recordError,
  recordResult,
  sortJudgeRequests,
  stripVolatile,
} from '../src/multishot/golden/recording'
import {
  multishotGoldenScenarios,
  type MultishotGoldenScenario,
} from '../src/multishot/golden/scenarios'
import type {
  MultishotGoldenRecord,
  MultishotGoldenRecordSet,
  MultishotMatrixGoldenRecord,
} from '../src/multishot/golden/types'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every scenario answers from its own scripted transports. A capture that
 *  reaches the network is recording something the scenario does not control, so
 *  the call fails loud instead of leaving. The matrix path has the same guard
 *  through its judge wire. */
function forbidNetwork(label: string): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    throw new Error(`record-multishot-golden: ${label} reached the network at ${String(url)}`)
  }) as unknown as typeof globalThis.fetch
  return () => {
    globalThis.fetch = previous
  }
}

function readArg(flag: string): string | undefined {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

function requireArg(flag: string): string {
  const value = readArg(flag)
  if (!value) throw new Error(`record-multishot-golden: ${flag} is required`)
  if (value.startsWith('--')) {
    throw new Error(`record-multishot-golden: ${flag} was given the flag ${value}, not a value`)
  }
  return value
}

/** The version names a file, so it may not carry a path separator or anything
 *  else that would place the record outside the records directory. */
function requireVersion(): string {
  const version = requireArg('--version')
  if (!/^[a-zA-Z0-9._-]+$/.test(version) || version === '.' || version === '..') {
    throw new Error(
      `record-multishot-golden: --version must match [a-zA-Z0-9._-]+, received ${version}`,
    )
  }
  return version
}

/** Load `<module>#<export>` relative to the repo root. The engine is never
 *  defaulted: after the loop is deleted this repository holds no conversation
 *  engine, and a script that silently picked one would record the wrong thing. */
async function loadEngine<T>(spec: string, flag: string): Promise<T> {
  const [modulePath, exportName] = spec.split('#')
  if (!modulePath || !exportName) {
    throw new Error(`record-multishot-golden: ${flag} must be <module>#<export>, received ${spec}`)
  }
  const url = pathToFileURL(resolve(repoRoot, modulePath)).href
  const loaded = (await import(url)) as Record<string, unknown>
  const engine = loaded[exportName]
  if (typeof engine !== 'function') {
    throw new Error(`record-multishot-golden: ${modulePath} exports no function ${exportName}`)
  }
  return engine as T
}

async function captureScenario(
  engine: MultishotGoldenEngine,
  scenario: MultishotGoldenScenario,
): Promise<MultishotGoldenRecord> {
  const runCase = scenario.build()
  let outcome: MultishotGoldenRecord['outcome']
  const restoreFetch = forbidNetwork(`scenario ${scenario.id}`)
  try {
    const result = await engine(runCase.options)
    if (!isUsableDuration(result.durationMs)) {
      // The checker rejects this on every live run, so freezing it would mint a
      // record the reference engine itself cannot pass.
      throw new Error(
        `record-multishot-golden: ${scenario.id} returned durationMs ${String(result.durationMs)} — the check requires a finite number >= 0`,
      )
    }
    outcome = { kind: 'result', result: recordResult(result) }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('record-multishot-golden:')) throw err
    outcome = { kind: 'error', error: recordError(err) }
  } finally {
    restoreFetch()
  }
  return {
    id: scenario.id,
    description: scenario.description,
    requests: runCase.requests,
    outcome,
  }
}

async function captureMatrixScenario(
  engine: MultishotMatrixGoldenEngine,
  scenario: MultishotMatrixGoldenScenario,
): Promise<MultishotMatrixGoldenRecord> {
  const runDir = mkdtempSync(join(tmpdir(), 'multishot-golden-'))
  try {
    const runCase = scenario.build(runDir)
    const restore = runCase.installJudgeWire()
    let matrix: Awaited<ReturnType<MultishotMatrixGoldenEngine>>
    try {
      matrix = await engine(runCase.options)
    } finally {
      restore()
    }
    return {
      id: scenario.id,
      description: scenario.description,
      requests: runCase.requests,
      judgeRequests: sortJudgeRequests(runCase.judgeRequests),
      matrix: stripVolatile(matrix.matrix),
      files: readRunDir(runDir),
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true })
  }
}

function requireStable(first: unknown, second: unknown, label: string): void {
  const drift = compareJson(first, second, label)
  if (drift.length > 0) {
    throw new Error(
      [
        `record-multishot-golden: ${label} is not reproducible — two captures disagree:`,
        ...drift.map((line) => `  - ${line}`),
      ].join('\n'),
    )
  }
}

async function main(): Promise<void> {
  const version = requireVersion()
  const engineSpec = requireArg('--engine')
  const matrixEngineSpec = requireArg('--matrix-engine')
  const outArg = readArg('--out')
  if (outArg !== undefined && (outArg === '' || outArg.startsWith('--'))) {
    throw new Error(`record-multishot-golden: --out was given ${outArg || 'an empty value'}`)
  }
  const outDir = resolve(repoRoot, outArg ?? 'src/multishot/golden/records')
  const outFile = join(outDir, `${version}.json`)

  if (existsSync(outFile)) {
    throw new Error(
      `record-multishot-golden: ${outFile} already exists. Golden records are frozen — mint a new version instead of rewriting a released one.`,
    )
  }

  const engine = await loadEngine<MultishotGoldenEngine>(engineSpec, '--engine')
  const matrixEngine = await loadEngine<MultishotMatrixGoldenEngine>(
    matrixEngineSpec,
    '--matrix-engine',
  )

  const scenarios: MultishotGoldenRecord[] = []
  for (const scenario of multishotGoldenScenarios()) {
    const first = await captureScenario(engine, scenario)
    const second = await captureScenario(engine, scenario)
    requireStable(first, second, `scenario ${scenario.id}`)
    scenarios.push(first)
    process.stdout.write(`recorded ${scenario.id}\n`)
  }

  const matrixScenarios: MultishotMatrixGoldenRecord[] = []
  for (const scenario of multishotMatrixGoldenScenarios()) {
    const first = await captureMatrixScenario(matrixEngine, scenario)
    const second = await captureMatrixScenario(matrixEngine, scenario)
    requireStable(first, second, `matrix scenario ${scenario.id}`)
    matrixScenarios.push(first)
    process.stdout.write(`recorded matrix ${scenario.id}\n`)
  }

  const packageVersion = (
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  ).version

  const set: MultishotGoldenRecordSet = {
    version,
    recordedFrom: `${engineSpec} + ${matrixEngineSpec}`,
    recordedFromPackageVersion: packageVersion,
    recordedAt: new Date().toISOString(),
    scenarios,
    matrixScenarios,
  }

  mkdirSync(outDir, { recursive: true })
  // The whole capture run sits between the existsSync check above and this
  // write, so the check alone cannot hold the freeze. The record is written to a
  // sibling first — a crash there leaves a `.partial` nobody mistakes for a
  // released record — and then linked into place. `linkSync` fails with EEXIST
  // rather than overwriting, so a second recorder that started meanwhile cannot
  // replace a frozen record.
  // Per-process temp path: two recorders on the same version must not write
  // through one file on their way to the exclusive link below.
  const tempFile = `${outFile}.${process.pid}.partial`
  writeFileSync(tempFile, `${JSON.stringify(set, null, 2)}\n`)
  try {
    linkSync(tempFile, outFile)
  } catch (err) {
    throw new Error(
      `record-multishot-golden: could not claim ${outFile} — another recorder may hold it: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    rmSync(tempFile, { force: true })
  }
  process.stdout.write(
    `wrote ${outFile} — ${scenarios.length} shot scenarios, ${matrixScenarios.length} matrix scenarios\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
