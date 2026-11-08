import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  createHarborBenchmarkAdapter,
  gradeHarborPatch,
  prepareCaseEnvironment,
  releaseCaseEnvironment,
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
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' })

const roots: string[] = []
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

// A marker unique to this run, so the cache assertions see only this run's build records.
const MARK = `case-env-${randomUUID().slice(0, 8)}`

/** A one-task Harbor dataset whose environment has two build steps. */
async function dataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'eval-harbor-case-env-'))
  roots.push(root)
  const task = join(root, 'tasks', 'prepared')
  await mkdir(join(task, 'environment'), { recursive: true })
  await mkdir(join(task, 'tests'))
  await writeFile(
    join(task, 'task.toml'),
    'version = "1.0"\n[agent]\ntimeout_sec = 60\n[verifier]\ntimeout_sec = 60\n',
  )
  await writeFile(join(task, 'instruction.md'), 'Make greeting.txt say world.\n')
  await writeFile(
    join(task, 'environment/Dockerfile'),
    `FROM alpine:3.20\nRUN apk add --no-cache bash git # ${MARK}\nWORKDIR /app\nRUN printf 'hello\\n' > greeting.txt\n`,
  )
  await writeFile(
    join(task, 'tests/test.sh'),
    '#!/bin/bash\nif grep -qx world /app/greeting.txt; then echo 1; else echo 0; fi > /logs/verifier/reward.txt\n',
  )
  await chmod(join(task, 'tests/test.sh'), 0o755)
  return root
}

const PATCH = `diff --git a/greeting.txt b/greeting.txt
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-hello
+world
`

describe.skipIf(!harborAndDocker)('a Harbor case environment on a real docker host', () => {
  it('is built once for its grades, and released with its build cache', async () => {
    const root = await dataset()
    const adapter = createHarborBenchmarkAdapter<{ patch: string }>({
      id: 'case-env',
      datasetDir: root,
      source: { name: 'synthetic-case-env', revision: 'local' },
      grade: gradeHarborPatch({ jobsDir: join(root, 'jobs'), timeoutMs: 600_000 }),
    })
    const [task] = await adapter.loadAll()
    const image = await prepareCaseEnvironment(task!)
    expect(image).toMatch(/^harbor-case\/prepared:[0-9a-f]{16}$/)
    expect(docker('buildx', 'du', '--format', 'json')).toContain(MARK)

    expect(await adapter.evaluate(task!, { patch: PATCH })).toMatchObject({ score: 1 })
    expect(await adapter.evaluate(task!, { patch: '' })).toMatchObject({ score: 0 })
    // Both grades ran on the prepared image: Harbor built no image of its own.
    const named = docker('images', '--format', '{{.Repository}}').split('\n')
    expect(named.filter((name) => name.includes('prepared'))).toEqual(['harbor-case/prepared'])

    await releaseCaseEnvironment(task!)
    expect(docker('images', '--format', '{{.Repository}}:{{.Tag}}')).not.toContain(image)
    expect(docker('buildx', 'du', '--format', 'json')).not.toContain(MARK)
  }, 900_000)

  it('keeps at most maxLive case images alive, admitting the next case on a release', async () => {
    const load = async () => {
      const datasetDir = await dataset()
      const source = { name: 'synthetic-case-env', revision: 'local' }
      const adapter = createHarborBenchmarkAdapter({
        id: 'case-env',
        datasetDir,
        source,
        grade: gradeHarborPatch(),
      })
      return (await adapter.loadAll())[0]!
    }
    const [first, second] = [await load(), await load()]
    const image = await prepareCaseEnvironment(first, { maxLive: 1 })
    let admitted = false
    const next = prepareCaseEnvironment(second, { maxLive: 1 }).then((tag) => {
      admitted = true
      return tag
    })
    // A live case never waits on its own slot; the second waits for one.
    expect(await prepareCaseEnvironment(first, { maxLive: 1 })).toBe(image)
    expect(admitted).toBe(false)
    await releaseCaseEnvironment(first)
    expect(await next).toBe(image)
    await releaseCaseEnvironment(second)
    expect(docker('images', '--format', '{{.Repository}}:{{.Tag}}')).not.toContain(image)
    expect(docker('buildx', 'du', '--format', 'json')).not.toContain(MARK)
  }, 300_000)

  it('pauses, never fails, while the docker host is below its free-space floor', async () => {
    const root = await dataset()
    const [task] = await createHarborBenchmarkAdapter({
      id: 'case-env',
      datasetDir: root,
      source: { name: 'synthetic-case-env', revision: 'local' },
      grade: gradeHarborPatch(),
    }).loadAll()
    const lines: string[] = []
    const preparing = prepareCaseEnvironment(task!, {
      freeFloorBytes: Number.MAX_SAFE_INTEGER,
      recheckMs: 200,
      log: (line) => lines.push(line),
      signal: AbortSignal.timeout(3_000),
    })
    // It keeps waiting until the caller gives up; it never builds below the floor.
    await expect(preparing).rejects.toThrow(/aborted|timeout/i)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]).toMatch(
      /^PAUSE host-owned: the local docker host has [\d.]+ GiB free, below the [\d.]+ GiB floor; prepared builds after 0.2 s$/,
    )
    expect(docker('buildx', 'du', '--format', 'json')).not.toContain(MARK)
  }, 60_000)
})
