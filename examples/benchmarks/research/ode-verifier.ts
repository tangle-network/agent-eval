/** Bind the unchanged public ODE checker. This example never starts an agent or Harbor. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  createHarborBenchmarkAdapter,
  createNativeBenchmarkAdapter,
  defineBenchmark,
  runBenchmarkAdapter,
  type HarborTaskPayload,
} from '../../../src/benchmarks/index'
import { hashCanonical } from '../../../src/ledger-core/canonical'

const execute = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const artifactFiles = ['equations.json', 'predictions.csv', 'report.md'] as const
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

export async function odeArtifactDigest(directory: string): Promise<string> {
  const files = await Promise.all(artifactFiles.map(async (path) => ({
    path, sha256: sha256(await readFile(join(directory, path))),
  })))
  return hashCanonical(files)
}

export async function createOdeVerifierAdapter(options: {
  datasetDir: string
  nativeOutputDir: string
  python: string
  pythonPath?: string
}) {
  const sourceText = await readFile(join(here, 'sources.json'), 'utf8')
  const pins = JSON.parse(sourceText)
  const taskId: string = pins.ode.relativeTask
  const source = {...pins.recipes['terminal-bench-science'].source, contamination: 'unknown' as const}
  const checkerIdentity = {
    name: 'TBS-ODE-unmodified-pytest-direct', version: source.revision,
    pins: {
      wrapperSha256: sha256(await readFile(join(here, 'ode-control.py'))),
      sourcePinsDigest: hashCanonical({source, taskId, files: pins.ode.files}),
      numpy: '1.26.4', scipy: '1.13.0', pandas: '2.2.2', sympy: '1.13.1', pytest: '8.4.1',
    },
  }
  const definition = defineBenchmark({
    schemaVersion: 1, id: 'tbs-v0.1.0/ode-direct-verifier-calibration', source,
    taskIds: [taskId],
    metric: {name: 'all-eight-checks-pass', unit: 'binary', direction: 'higher', range: [0, 1],
      aggregation: 'Per-artifact conjunction of all eight upstream checks; no suite aggregate.',
      normalization: '1 exactly when every upstream test passed; 0 for completed assertion rejection.'},
    verification: {strategy: 'test', checker: checkerIdentity,
      assumptions: [
        'Direct execution of pinned public checker; not a Harbor sandbox or containment qualification.',
        'Both controls use public author references; no agent rollout or discovery is claimed.',
        'CPU dependency versions are checked; hardware, OS and Python may differ from the upstream container.',
        'Validity extends only to the eight upstream checks and this selected task.',
      ]},
  })
  const loader = createHarborBenchmarkAdapter<never>({
    id: definition.id, datasetDir: options.datasetDir, source, tasks: [taskId],
    assignSplit: () => 'dev',
    grade: async () => { throw new Error('This object is a loader; use the bound native checker.') },
  })
  let call = 0
  return createNativeBenchmarkAdapter<HarborTaskPayload, string>({
    definition,
    implementationRef: hashCanonical({
      adapterSha256: sha256(await readFile(fileURLToPath(import.meta.url))), checkerIdentity,
    }),
    load: () => loader.loadAll(),
    artifactDigest: odeArtifactDigest,
    family: 'scientific-discovery', taskKind: 'numerical-artifact',
    checker: {
      strategy: 'test', identity: checkerIdentity, determinism: 'deterministic',
      async check({item, artifact}) {
        const output = join(resolve(options.nativeOutputDir), `grade-${String(++call).padStart(2, '0')}`)
        const command = [join(here, 'ode-control.py'), 'grade', '--task', item.payload.taskDir,
          '--artifact', resolve(artifact), '--output', output]
        try {
          const {stdout} = await execute(options.python, command, {
            timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
            env: {...process.env, ...(options.pythonPath ? {PYTHONPATH: options.pythonPath} : {})},
          })
          const result = JSON.parse(stdout)
          if (result.tests_total !== 8 || typeof result.passed !== 'boolean' ||
              result.scope !== 'direct-public-upstream-verifier-calibration') {
            return {succeeded: false, error: 'Native checker returned an incomplete measurement.'}
          }
          return {succeeded: true, value: {
            score: result.passed ? 1 : 0, passed: result.passed,
            raw: {native: result, nativeOutputDir: output, command: [options.python, ...command]},
            notes: 'Verifier calibration only; author-reference controls, no agent solve or Harbor sandbox.',
          }}
        } catch (error) {
          return {succeeded: false, error: error instanceof Error ? error.message : String(error)}
        }
      },
    },
  })
}

async function main() {
  const [datasetDir, controlsDir, outputDir] = process.argv.slice(2)
  if (!datasetDir || !controlsDir || !outputDir) {
    throw new Error('Usage: tsx ode-verifier.ts DATASET_DIR CONTROLS_DIR NEW_OUTPUT_DIR')
  }
  await mkdir(outputDir, {recursive: false})
  const adapter = await createOdeVerifierAdapter({
    datasetDir, nativeOutputDir: join(outputDir, 'native'),
    python: process.env.PYTHON ?? 'python3', pythonPath: process.env.PYTHONPATH,
  })
  const items = await adapter.loadAll()
  const item = items[0]!
  await writeFile(join(outputDir, 'definition.json'), `${JSON.stringify(adapter.definition, null, 2)}\n`)
  const controls = []
  for (const name of ['author-reference', 'corrupted-vector-field']) {
    const artifact = resolve(controlsDir, name)
    const result = await adapter.evaluateResult(item, artifact)
    const run = await runBenchmarkAdapter({
      adapter, respond: () => artifact,
      dispatchRef: hashCanonical({control: name, artifactDigest: await odeArtifactDigest(artifact)}),
      splits: ['dev'], runDir: join(outputDir, name), reps: 1, resumable: false,
      expectUsage: 'off', maxConcurrency: 1,
    })
    if (run.report.cellsMeasured !== 1 || run.report.cellsUnmeasured !== 0 ||
        run.report.score.mean !== result.evaluation.score) {
      throw new Error(`${name}: campaign did not retain the native measured outcome`)
    }
    await writeFile(join(outputDir, `${name}.result.json`), `${JSON.stringify(result, null, 2)}\n`)
    controls.push({name, result, report: run.report})
  }
  if (!controls[0]!.result.evaluation.passed || controls[1]!.result.evaluation.passed) {
    throw new Error('The real verifier did not establish good-pass/bad-reject.')
  }
  const receipt = {
    purpose: 'Public upstream checker and AgentEval native-result/campaign integration calibration',
    agentExecuted: false, harborEnvironmentExecuted: false, officialBenchmarkScore: false,
    costScope: 'No model calls; reported API spend excludes CPU and preparation cost.',
    sourceRevision: adapter.definition.source.revision,
    command: [process.execPath, ...process.argv.slice(1)], controls,
  }
  await writeFile(join(outputDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify(controls.map(({name, result, report}) => ({
    name, score: result.evaluation.score, passed: result.evaluation.passed,
    artifactDigest: result.artifactDigest, cellsMeasured: report.cellsMeasured,
    nativeAggregation: report.nativeAggregation,
  })), null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
