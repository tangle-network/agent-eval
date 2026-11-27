import { execFileSync } from 'node:child_process'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  benchmarkJudge,
  benchmarkScenarios,
  createHarborBenchmarkAdapter,
  deterministicSplit,
  gradeHarborPatch,
} from '../src/benchmarks/index'

const present = (program: string, args: string[]) => {
  try {
    execFileSync(program, args, { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}
const harborAndDocker = present('harbor', ['--version']) && present('docker', ['info'])

const roots: string[] = []
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

const PASSING_PATCH = `diff --git a/greeting.txt b/greeting.txt
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-hello
+world
`

/** A local Harbor dataset: `greet` checks a patched file; `broken` crashes before any reward. */
async function dataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'eval-harbor-patch-'))
  roots.push(root)
  const tests = {
    greet: `#!/bin/bash\nprintf '\\033[31mgreeting:\\033[0m %s\\n' "$(cat /app/greeting.txt)"\nif grep -qx world /app/greeting.txt; then echo 1; else echo 0; fi > /logs/verifier/reward.txt\n`,
    broken: '#!/bin/bash\necho "verifier crashed"\nexit 3\n',
  }
  for (const [name, test] of Object.entries(tests)) {
    const task = join(root, 'tasks', name)
    await mkdir(join(task, 'environment'), { recursive: true })
    await mkdir(join(task, 'tests'))
    await writeFile(
      join(task, 'task.toml'),
      'version = "1.0"\n[agent]\ntimeout_sec = 60\n[verifier]\ntimeout_sec = 60\n',
    )
    await writeFile(join(task, 'instruction.md'), 'Make greeting.txt say world.\n')
    await writeFile(
      join(task, 'environment/Dockerfile'),
      "FROM alpine:3.20\nRUN apk add --no-cache bash git\nWORKDIR /app\nRUN printf 'hello\\n' > greeting.txt\n",
    )
    await writeFile(join(task, 'tests/test.sh'), test)
    await chmod(join(task, 'tests/test.sh'), 0o755)
  }
  return root
}

it('commits only selected Harbor task assets, independently of checkout path, and refuses changed imported assets', async () => {
  const root = await dataset()
  const adapter = (datasetDir: string) =>
    createHarborBenchmarkAdapter<{ patch: string }>({
      id: 'selected-assets',
      datasetDir,
      tasks: ['greet'],
      source: { name: 'synthetic-patch', revision: 'unchanged' },
      grade: gradeHarborPatch(),
    })
  const selected = adapter(root)
  const [original] = await selected.loadAll()
  expect(original!.payload.assetIdentity).toMatchObject({
    version: 1,
    digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    components: {
      environment: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      tests: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      verifier: null,
    },
  })
  const copy = await mkdtemp(join(tmpdir(), 'eval-harbor-assets-copy-'))
  roots.push(copy)
  await cp(root, copy, { recursive: true })
  expect((await adapter(copy).loadAll())[0]!.payload.assetIdentity).toEqual(
    original!.payload.assetIdentity,
  )
  // This task is not admitted: even malformed configuration cannot affect the selected identity.
  await writeFile(join(root, 'tasks/broken/task.toml'), 'not valid TOML {')
  expect((await selected.loadAll())[0]!.payload.assetIdentity).toEqual(
    original!.payload.assetIdentity,
  )
  await writeFile(join(root, 'tasks/greet/tests/private-data.txt'), 'independent grading data')
  const [changed] = await selected.loadAll()
  expect(changed!.payload.assetIdentity!.digest).not.toBe(original!.payload.assetIdentity!.digest)
  expect(changed!.payload.assetIdentity!.components.environment).toBe(
    original!.payload.assetIdentity!.components.environment,
  )
  expect(JSON.stringify(changed!.payload.assetIdentity)).not.toContain('independent grading data')
  await expect(selected.evaluate(original!, { patch: PASSING_PATCH })).rejects.toThrow(
    /assets changed since import/,
  )
  await chmod(join(root, 'tasks/greet/environment/Dockerfile'), 0o755)
  const [modeChanged] = await selected.loadAll()
  expect(modeChanged!.payload.assetIdentity!.components.environment).not.toBe(
    changed!.payload.assetIdentity!.components.environment,
  )
  await symlink(join(root, 'tasks/broken/task.toml'), join(root, 'tasks/greet/tests/foreign'))
  await expect(selected.loadAll()).rejects.toThrow(/link escapes its declared directory/)
})

describe.skipIf(!harborAndDocker)('gradeHarborPatch through real Harbor and Docker', () => {
  it('scores a passing patch 1, an empty patch a measured 0, and refuses a run with no reward', async () => {
    const root = await dataset()
    const jobsDir = join(root, 'jobs')
    const adapter = createHarborBenchmarkAdapter<{ patch: string }>({
      id: 'local-patch',
      datasetDir: root,
      source: { name: 'synthetic-patch', revision: 'local' },
      grade: gradeHarborPatch({ jobsDir, maxDetailChars: 200, timeoutMs: 600_000 }),
    })
    const [broken, greet] = await adapter.loadAll()
    expect([broken!.id, greet!.id]).toEqual(['broken', 'greet'])

    const passing = await adapter.evaluate(greet!, { patch: PASSING_PATCH })
    expect(passing).toMatchObject({ score: 1, passed: true })
    expect(passing.notes).toContain('greeting: world')
    expect(passing.notes).not.toContain('\u001b')
    expect(JSON.stringify(passing.notes).length).toBeLessThanOrEqual(200)

    const scenarios = await benchmarkScenarios(adapter)
    expect(scenarios.map((scenario) => scenario.item.id).sort()).toEqual(['broken', 'greet'])
    const scenario = scenarios.find((entry) => entry.item.id === 'greet')!
    const empty = await benchmarkJudge(adapter).score({
      artifact: { patch: '' },
      scenario,
      signal: new AbortController().signal,
    })
    expect(empty).toMatchObject({ composite: 0, dimensions: { score: 0, passed: 0 } })
    expect(empty.notes).toContain('greeting: hello')

    // A patch that does not apply is no score, never the base tree's 0, and is not retried.
    const corrupt = PASSING_PATCH.replace('+world\n', '')
    await expect(adapter.evaluate(greet!, { patch: corrupt })).rejects.toThrow(
      /did not score this artifact: solve.sh exited \d+: .*(corrupt patch|patch failed)/s,
    )
    expect((await readdir(jobsDir)).filter((job) => job.startsWith('greet-'))).toHaveLength(3)

    await expect(adapter.evaluate(broken!, { patch: PASSING_PATCH })).rejects.toThrow(
      /did not score this artifact: attempt 1: .*; attempt 3: No reward file/,
    )
    expect((await readdir(jobsDir)).filter((job) => job.startsWith('broken-'))).toHaveLength(3)
    const verifier = join(root, 'tasks/greet/tests/test.sh')
    await writeFile(
      verifier,
      (await readFile(verifier, 'utf8')).replace('grep -qx world', 'grep -qx another-answer'),
    )
    await expect(adapter.evaluate(greet!, { patch: PASSING_PATCH })).rejects.toThrow(
      /assets changed since import/,
    )
    const current = (await adapter.loadAll()).find((item) => item.id === 'greet')!
    expect(await adapter.evaluate(current, { patch: PASSING_PATCH })).toMatchObject({
      score: 0,
      passed: false,
    })
  }, 900_000)
})

describe('deterministicSplit cut points', () => {
  it('keeps the default split and refuses cuts outside 0 < a < b < 1', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `item-${index}`)
    expect(ids.map((id) => deterministicSplit(id, undefined, [0.6, 0.8]))).toEqual(
      ids.map((id) => deterministicSplit(id)),
    )
    expect(new Set(ids.map((id) => deterministicSplit(id, 'seed', [0.01, 0.02])))).toContain(
      'holdout',
    )
    for (const cuts of [
      [0, 0.5],
      [0.5, 0.5],
      [0.4, 1],
      [0.8, 0.6],
    ] as const) {
      expect(() => deterministicSplit('item', undefined, cuts)).toThrow(RangeError)
    }
  })
})
