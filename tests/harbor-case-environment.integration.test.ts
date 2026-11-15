import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
    try {
      expect(image).toMatch(/^harbor-case\/prepared:[0-9a-f]{16}-[0-9a-f]{6}-\d+-[0-9a-f]{4}$/)
      expect(docker('buildx', 'du', '--format', 'json')).toContain(MARK)

      expect(await adapter.evaluate(task!, { patch: PATCH })).toMatchObject({ score: 1 })
      expect(await adapter.evaluate(task!, { patch: '' })).toMatchObject({ score: 0 })
      // Both grades ran on the prepared image: Harbor built no image of its own. Other owners'
      // harbor-case/prepared tags may share the host.
      const named = docker('images', '--format', '{{.Repository}}').split('\n')
      expect(
        named.filter((name) => name.includes('prepared') && name !== 'harbor-case/prepared'),
      ).toEqual([])
    } finally {
      await releaseCaseEnvironment(task!)
    }
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
    const nextImage = await next
    expect(nextImage).not.toBe(image)
    await releaseCaseEnvironment(second)
    const tags = docker('images', '--format', '{{.Repository}}:{{.Tag}}')
    expect(tags).not.toContain(image)
    expect(tags).not.toContain(nextImage)
    expect(docker('buildx', 'du', '--format', 'json')).not.toContain(MARK)
  }, 300_000)

  // The 2026-11-14 factory v4 runs: two improve passes graded the same cases on one host, and the
  // pass that finished a case first removed the image the other's judge then failed to pull.
  it.each([2, 4])(
    'grades the same case in %i concurrent passes, each releasing only its own image',
    async (count) => {
      const root = await dataset()
      const coord = await mkdtemp(join(tmpdir(), 'eval-harbor-case-passes-'))
      roots.push(coord)
      const script = join(import.meta.dirname, 'fixtures/harbor-case-pass.ts')
      const passes = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          promisify(execFile)(
            process.execPath,
            ['--import', 'tsx', script, root, coord, `${i}`, `${count}`],
            { timeout: 900_000, maxBuffer: 1 << 26 },
          ),
        ),
      )
      const results = passes.map(
        ({ stdout }) =>
          JSON.parse(stdout.trim().split('\n').at(-1)!) as {
            image: string
            scores: (number | string)[]
          },
      )
      expect(results.map((result) => result.scores)).toEqual(
        Array.from({ length: count }, () => [1, 0]),
      )
      expect(new Set(results.map((result) => result.image)).size).toBe(count)
      const tags = docker('images', '--format', '{{.Repository}}:{{.Tag}}')
      for (const { image } of results) expect(tags).not.toContain(image)
      expect(docker('buildx', 'du', '--format', 'json')).not.toContain(MARK)
    },
    1_800_000,
  )

  it("removes a dead pass's image on the next release of its case", async () => {
    const root = await dataset()
    const coord = await mkdtemp(join(tmpdir(), 'eval-harbor-case-passes-'))
    roots.push(coord)
    const script = join(import.meta.dirname, 'fixtures/harbor-case-pass.ts')
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', script, root, coord, '0', 'crash'],
      { timeout: 600_000, maxBuffer: 1 << 26 },
    )
    const { image: orphan } = JSON.parse(stdout.trim().split('\n').at(-1)!) as { image: string }
    expect(docker('images', '--format', '{{.Repository}}:{{.Tag}}')).toContain(orphan)
    const [task] = await createHarborBenchmarkAdapter({
      id: 'case-env',
      datasetDir: root,
      source: { name: 'synthetic-case-env', revision: 'local' },
      grade: gradeHarborPatch(),
    }).loadAll()
    const image = await prepareCaseEnvironment(task!)
    await releaseCaseEnvironment(task!)
    const tags = docker('images', '--format', '{{.Repository}}:{{.Tag}}')
    expect(tags).not.toContain(orphan)
    expect(tags).not.toContain(image)
  }, 600_000)

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
