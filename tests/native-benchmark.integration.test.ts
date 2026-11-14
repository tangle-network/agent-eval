import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { BenchmarkDatasetItem } from '../src/benchmarks'
import {
  type BenchmarkDefinition,
  type BenchmarkEvaluation,
  benchmarkDefinitionDigest,
  createHarborBenchmarkAdapter,
  createNativeBenchmarkAdapter,
  defineBenchmark,
  defineBenchmarkResult,
  gradeHarborTrial,
  runBenchmarkAdapter,
} from '../src/benchmarks'
import type { StrategyChecker } from '../src/verification-strategy'

const execute = promisify(execFile)
const roots: string[] = []
const temporary = async () => {
  const path = await mkdtemp(join(tmpdir(), 'native-benchmark-'))
  roots.push(path)
  return path
}
afterAll(() => Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))))

type Payload = { expected: number[] }
type Item = BenchmarkDatasetItem<Payload>
type Evaluation = BenchmarkEvaluation & { passed: boolean }
const checkerIdentity = {
  name: 'local-numerical-file-checker',
  version: '1',
  pins: { implementation: 'native-benchmark-checker.mjs@1' },
}
const definitionFor = (ids: string[]): BenchmarkDefinition =>
  defineBenchmark({
    schemaVersion: 1,
    id: 'integration/numerical-files',
    source: {
      name: 'original integration fixture',
      revision: 'fixture-v1',
      contamination: 'unknown',
    },
    taskIds: ids,
    metric: {
      name: 'absolute-error',
      unit: 'scalar',
      direction: 'lower',
      aggregation: 'mean absolute error',
      normalization: 'max(0, 1-error/10); pass iff error=0',
    },
    verification: {
      strategy: 'test',
      checker: checkerIdentity,
      assumptions: ['fixture covers only the listed vectors'],
    },
  })

function nativeChecker(): StrategyChecker<{ item: Item; artifact: string }, Evaluation> {
  return {
    strategy: 'test',
    identity: structuredClone(checkerIdentity),
    determinism: 'deterministic',
    async check({ item, artifact }) {
      try {
        const { stdout } = await execute(process.execPath, [
          resolve('tests/fixtures/native-benchmark-checker.mjs'),
          artifact,
          JSON.stringify(item.payload.expected),
        ])
        return { succeeded: true, value: JSON.parse(stdout) as Evaluation }
      } catch (error) {
        return { succeeded: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
const digestFile = async (file: string) =>
  `sha256:${createHash('sha256')
    .update(await readFile(file))
    .digest('hex')}`

describe('native benchmark through real file/process/campaign boundaries', () => {
  it('retains native values, artifact binding and certification; excludes missing grading and binds resumptions', async () => {
    const root = await temporary()
    const ids = ['exact', 'partial', 'zero', 'invalid']
    const definition = definitionFor(ids)
    const items: Item[] = ids.map((id) => ({ id, payload: { expected: [2, 3, 5] }, split: 'dev' }))
    await Promise.all([
      writeFile(join(root, 'exact.json'), '[2,3,5]'),
      writeFile(join(root, 'partial.json'), '[2,4,5]'),
      writeFile(join(root, 'zero.json'), '[1002,3,5]'),
      writeFile(join(root, 'invalid.json'), 'not json'),
    ])
    const makeAdapter = (implementationRef = 'file-adapter@1') =>
      createNativeBenchmarkAdapter({
        definition,
        implementationRef,
        load: async () => items,
        checker: nativeChecker(),
        artifactDigest: digestFile,
      })
    const adapter = makeAdapter()
    const input = {
      adapter,
      dispatchRef: 'numerical-producer@1',
      runDir: join(root, 'run'),
      respond: ({ item }: { item: Item }) => join(root, `${item.id}.json`),
    }
    const run = await runBenchmarkAdapter(input)
    expect(run.report).toMatchObject({
      totalCells: 4,
      cellsMeasured: 3,
      cellsUnmeasured: 1,
      cellsFailed: 1,
      scoreAggregation: 'mean-normalized-score',
      nativeAggregation: 'not-computed',
    })
    expect(run.report.score.n).toBe(3)
    expect(run.report.score.mean).toBeCloseTo(1.9 / 3)
    expect(run.report.dimensions.absoluteError?.max).toBe(1000)
    expect(run.report.splits.dev?.passRate).toBe(1 / 3)
    const partial = run.campaign.cells.find((cell) => cell.scenarioId.endsWith(':partial'))!
    const score = Object.values(partial.judgeScores)[0]!
    expect(score).toMatchObject({
      composite: 0.9,
      dimensions: { absoluteError: 1, passed: 0 },
      certification: { strategy: 'test', checker: checkerIdentity },
      evidence: {
        benchmarkResult: {
          evaluation: {
            raw: {
              measurement: { absoluteError: 1 },
              binding: { artifactDigest: await digestFile(join(root, 'partial.json')) },
            },
          },
        },
      },
    })
    expect(Object.keys(score.evidence!).sort()).toEqual([
      'benchmarkId',
      'benchmarkResult',
      'evaluationRef',
    ])
    const persisted = JSON.parse(await readFile(join(root, 'run', 'benchmark-report.json'), 'utf8'))
    expect(persisted.definitionDigest).toBe(benchmarkDefinitionDigest(definition))
    expect(
      defineBenchmarkResult(score.evidence!.benchmarkResult, definition).evaluation.certification,
    ).toEqual(score.certification)
    const savedCells = (await readdir(join(root, 'run'), { recursive: true })).filter((path) =>
      path.endsWith('/result.json'),
    )
    const saved = await Promise.all(
      savedCells.map(async (path) => JSON.parse(await readFile(join(root, 'run', path), 'utf8'))),
    )
    const savedPartial = saved.find((cell) => cell.scenarioId?.endsWith(':partial'))
    const savedScore = Object.values(savedPartial.judgeScores)[0] as typeof score
    expect(defineBenchmarkResult(savedScore.evidence!.benchmarkResult, definition)).toEqual(
      score.evidence!.benchmarkResult,
    )

    const admitted = (await adapter.loadAll()).find((item) => item.id === 'partial')!
    const receipt = await adapter.evaluateResult(admitted, join(root, 'partial.json'))
    expect(defineBenchmarkResult(JSON.parse(JSON.stringify(receipt)), definition)).toEqual(receipt)
    const forged = structuredClone(receipt)
    forged.evaluation.score = 1
    expect(() => defineBenchmarkResult(forged, definition)).toThrow(/evidence digest/)
    const wrongArtifact = structuredClone(receipt)
    wrongArtifact.artifactDigest = `sha256:${'0'.repeat(64)}`
    expect(() => defineBenchmarkResult(wrongArtifact, definition)).toThrow(/evidence digest/)

    const same = await runBenchmarkAdapter(input)
    expect(same.report.cellsCached).toBe(3)
    const changedSolver = await runBenchmarkAdapter({
      ...input,
      dispatchRef: 'numerical-producer@2',
    })
    expect(changedSolver.report.manifestHash).not.toBe(run.report.manifestHash)
    expect(changedSolver.report.cellsCached).toBe(0)
    const changedGrader = await runBenchmarkAdapter({
      ...input,
      adapter: makeAdapter('file-adapter@2'),
    })
    expect(changedGrader.report.manifestHash).not.toBe(run.report.manifestHash)
    expect(changedGrader.report.cellsCached).toBe(0)
    await expect(runBenchmarkAdapter({ ...input, dispatchRef: undefined })).rejects.toThrow(
      /dispatchRef/,
    )
  })

  it('freezes admitted source/splits and refuses an impostor task before checking', async () => {
    const root = await temporary()
    const file = join(root, 'exact.json')
    await writeFile(file, '[2,3,5]')
    const definition = definitionFor(['a'])
    const mutable: Item[] = [{ id: 'a', payload: { expected: [2, 3, 5] }, split: 'dev' }]
    const adapter = createNativeBenchmarkAdapter({
      definition,
      implementationRef: 'fixture@1',
      load: async () => mutable,
      checker: nativeChecker(),
      artifactDigest: digestFile,
    })
    const [item] = await adapter.loadAll()
    delete mutable[0]!.split
    mutable[0]!.payload.expected[0] = 99
    expect((await adapter.loadAll())[0]).toEqual(item)
    expect(() => {
      adapter.definition.metric.normalization = 'different'
    }).toThrow()
    expect(() => {
      item!.payload.expected[0] = 99
    }).toThrow()
    await expect(
      adapter.evaluate({ ...item!, source: { revision: 'different' } }, file),
    ).rejects.toThrow(/admitted task/)
    expect((await adapter.evaluate(item!, file)).passed).toBe(true)
    const noSplit = createNativeBenchmarkAdapter({
      definition,
      implementationRef: 'fixture@1',
      load: async () => mutable,
      checker: nativeChecker(),
      artifactDigest: digestFile,
    })
    await expect(noSplit.loadAll()).rejects.toThrow(/explicit valid split/)
  })

  it('refuses contradictory certifications after a real checker measurement', async () => {
    const root = await temporary()
    const file = join(root, 'exact.json')
    await writeFile(file, '[2,3,5]')
    const original = nativeChecker()
    const checker: typeof original = {
      ...original,
      async check(input) {
        const outcome = await original.check(input)
        if (outcome.succeeded)
          outcome.value.certification = {
            strategy: 'proof-kernel',
            checker: { name: 'unexecuted-kernel', version: '1' },
            assumptions: [],
            evidenceDigest: 'invented',
          }
        return outcome
      },
    }
    const adapter = createNativeBenchmarkAdapter({
      definition: definitionFor(['a']),
      implementationRef: 'fixture@1',
      load: async () => [{ id: 'a', payload: { expected: [2, 3, 5] }, split: 'dev' }],
      checker,
      artifactDigest: digestFile,
    })
    await expect(adapter.evaluate((await adapter.loadAll())[0]!, file)).rejects.toThrow(
      /certification checker/,
    )
  })
})

describe('Harbor import through pinned upstream task files', () => {
  const datasetDir = resolve('tests/fixtures/science-harbor')
  const source = {
    name: 'terminal-bench-science',
    revision: 'f81afac4f11048e77a15dfc8fb1dbfb897fea0ce',
    version: '0.1.0',
  }
  const adapter = (options: { datasetDir?: string; tasks?: string[] } = {}) =>
    createHarborBenchmarkAdapter({
      id: 'terminal-bench-science@0.1.0',
      datasetDir,
      source,
      ...options,
      grade: async () => ({ succeeded: false, error: 'import-only test; no verifier launched' }),
    })
  it('discovers nested tasks with stable paths and preserves native verifier isolation and metadata', async () => {
    const items = await adapter().loadAll()
    expect(items.map((item) => item.id)).toEqual([
      'earth-sciences/atmospheric-sciences/sparse-network-assimilation',
      'mathematical-sciences/applied-mathematics/ode-law-discovery',
    ])
    const task = items[1]!
    expect(task.payload.dir).toBe('ode-law-discovery')
    expect(task.payload.relativePath).toBe(task.id)
    expect(task.tags).toContain('mathematical-sciences')
    expect(task.tags).toContain('applied-mathematics')
    expect(task.payload.config).toMatchObject({
      verifier: { environment_mode: 'separate', environment: { network_mode: 'no-network' } },
    })
    expect(task.payload.artifactMappings?.[0]).toEqual({ source: '/results/equations.json' })
    expect((await adapter({ tasks: [task.id] }).loadAll())[0]).toEqual(task)
    await expect(adapter().evaluate(task, '')).rejects.toThrow(/no verifier launched/)
  })
  it('keeps same-named leaves distinct, preserves artifact destinations, and refuses path escape', async () => {
    const root = await temporary()
    for (const domain of ['physics', 'biology']) {
      const task = join(root, 'tasks', domain, 'analysis')
      await mkdir(task, { recursive: true })
      await writeFile(
        join(task, 'task.toml'),
        'artifacts = [{source="/out/a", destination="/in/a", service="worker", exclude=["*.tmp"]}]\n',
      )
      await writeFile(join(task, 'instruction.md'), 'Analyze the produced result.')
    }
    const items = await adapter({ datasetDir: root }).loadAll()
    expect(items.map((item) => item.id)).toEqual(['biology/analysis', 'physics/analysis'])
    expect(items[0]!.payload.artifactMappings![0]).toEqual({
      source: '/out/a',
      destination: '/in/a',
      service: 'worker',
      exclude: ['*.tmp'],
    })
    await symlink(dirname(root), join(root, 'tasks', 'outside'))
    await expect(adapter({ datasetDir: root, tasks: ['outside'] }).loadAll()).rejects.toThrow(
      /escapes/,
    )
    await expect(adapter({ datasetDir: root, tasks: ['../elsewhere'] }).loadAll()).rejects.toThrow(
      /relative path/,
    )
    await expect(
      adapter({ datasetDir: root, tasks: ['biology/analysis', 'biology/analysis'] }).loadAll(),
    ).rejects.toThrow(/duplicate/)
  })

  it('retains a missing-executable refusal and original source identity without changing the source', async () => {
    const root = await temporary()
    const trial = join(root, 'source')
    const output = join(root, 'output')
    await mkdir(join(trial, 'artifacts'), { recursive: true })
    await mkdir(output)
    const task = (await adapter().loadAll())[0]!
    // Deliberately incomplete input for the refusal path. This is not a native Harbor run.
    const original = JSON.stringify({
      id: 'refusal-fixture',
      task_name: task.payload.name,
      task_checksum: 'original-task-checksum',
      config: { api_key: 'refusal-test-secret' },
    })
    await writeFile(join(trial, 'result.json'), original)
    await writeFile(join(trial, 'artifacts/manifest.json'), '[]')
    const grade = gradeHarborTrial({
      trialsDir: output,
      harborBin: join(root, 'missing-harbor'),
      rewardKey: 'reward',
      env: { TEST_SECRET: 'refusal-test-secret' },
    })
    const mismatch = await grade(task, { trialDir: trial, sourceTaskChecksum: 'wrong' })
    expect(mismatch).toMatchObject({
      succeeded: false,
      error: expect.stringMatching(/identity mismatch/),
    })
    expect(await readdir(output)).toEqual([])
    const missing = await grade(task, {
      trialDir: trial,
      sourceTrialId: 'refusal-fixture',
      sourceTaskChecksum: 'original-task-checksum',
    })
    expect(missing).toMatchObject({
      succeeded: false,
      error: expect.stringMatching(/missing-harbor.*ENOENT.*no readable regrade result/s),
    })
    const receiptFiles = await readdir(output)
    expect(receiptFiles).toHaveLength(1)
    const attemptText = await readFile(join(output, receiptFiles[0]!), 'utf8')
    expect(attemptText).not.toContain('refusal-test-secret')
    const attempt = JSON.parse(attemptText)
    expect(attempt).toMatchObject({
      status: 'unmeasured',
      original: { result: { task_checksum: 'original-task-checksum' } },
      verifierTask: { source: { revision: source.revision } },
      commandError: expect.stringContaining('missing-harbor'),
    })
    expect(await readFile(join(trial, 'result.json'), 'utf8')).toBe(original)
    expect(await readdir(trial)).toEqual(['artifacts', 'result.json'])
    const unsafeOutput = gradeHarborTrial({ trialsDir: trial, rewardKey: 'reward' })
    expect(await unsafeOutput(task, { trialDir: trial })).toMatchObject({
      succeeded: false,
      error: expect.stringMatching(/outside/),
    })
  })
})
