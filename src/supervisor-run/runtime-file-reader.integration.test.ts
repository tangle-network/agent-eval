// Real retained Runtime files move to an archive while logical paths retain only pointers.
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { analyzeSupervisorRunSources } from './analyze'
import { readRuntimeSupervisorRun } from './runtime-reader'

it('reads archived bytes without changing source identity, absent evidence or native references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-file-reader-'))
  try {
    for (const name of ['runtime-run-r1-no-winner', 'runtime-run-r1-failed']) {
      const logical = join(root, name),
        stored = join(root, `${name}-archive`)
      await cp(join(process.cwd(), 'tests/fixtures/supervisor-run', name), logical, {
        recursive: true,
        dereference: true,
      })
      const now = () => Date.parse('2026-09-06T07:00:00.000Z')
      const before = analyzeSupervisorRunSources(await readRuntimeSupervisorRun(logical), now)
      await rename(logical, stored)
      for (const file of await readdir(stored, { recursive: true })) {
        if (!(await stat(join(stored, file))).isFile()) continue
        await mkdir(dirname(join(logical, file)), { recursive: true })
        await writeFile(join(logical, file), 'private archive pointer\n')
      }
      await expect(readRuntimeSupervisorRun(logical)).rejects.toThrow()
      const read = (path: string) => readFile(join(stored, relative(logical, path)), 'utf8')
      const after = analyzeSupervisorRunSources(
        await readRuntimeSupervisorRun(logical, { readFile: read }),
        now,
      )
      expect(after).toEqual(before)
      const terminal = name === 'runtime-run-r1-failed' ? 'failure.json' : 'spawn-journal.jsonl'
      await writeFile(join(stored, terminal), 'corrupt original record\n')
      await expect(readRuntimeSupervisorRun(logical, { readFile: read })).rejects.toThrow()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
