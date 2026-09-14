import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DeploymentOutcome,
  FileSystemOutcomeStore,
  InMemoryOutcomeStore,
  OutcomeStoreError,
} from '../src/meta-eval/outcome-store'

const observation = (runId = 'run'): DeploymentOutcome => ({
  runId,
  capturedAt: 1,
  metrics: { success: 0 },
  labels: { cohort: 'test' },
})

describe('outcome evidence storage', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-eval-outcome-store-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it.each(['memory', 'filesystem'] as const)(
    'protects %s records from input and read-result mutation',
    async (kind) => {
      const store =
        kind === 'memory' ? new InMemoryOutcomeStore() : new FileSystemOutcomeStore({ dir })
      const input = observation()
      await store.append(input)
      input.metrics.success = 1
      input.labels!.cohort = 'changed'
      const first = await store.forRun('run')
      expect(first[0]).toEqual(observation())
      first[0]!.metrics.success = 100
      first[0]!.labels!.cohort = 'changed-again'
      expect(await store.list()).toEqual([observation()])
    },
  )

  it.each(['memory', 'filesystem'] as const)(
    'refuses non-finite %s observations instead of serializing them as null',
    async (kind) => {
      const store =
        kind === 'memory' ? new InMemoryOutcomeStore() : new FileSystemOutcomeStore({ dir })
      await expect(
        store.append({ ...observation(), metrics: { success: Number.NaN } }),
      ).rejects.toThrow()
      expect(await store.list()).toEqual([])
      await store.append(observation())
      expect((await store.list())[0]?.metrics.success).toBe(0)
    },
  )

  it('treats a missing directory as empty and observes subsequent writes from another instance', async () => {
    const missing = join(dir, 'new-store')
    const reader = new FileSystemOutcomeStore({ dir: missing })
    expect(await reader.list()).toEqual([])
    const writer = new FileSystemOutcomeStore({ dir: missing })
    await writer.append(observation('first'))
    expect((await reader.list()).map((row) => row.runId)).toEqual(['first'])
    await writer.append(observation('second'))
    expect((await reader.list()).map((row) => row.runId)).toEqual(['first', 'second'])
  })

  it('reports the corrupt file and line instead of returning partial or empty evidence', async () => {
    const file = join(dir, 'outcomes.ndjson')
    await writeFile(file, `${JSON.stringify(observation())}\n{broken\n`)
    const store = new FileSystemOutcomeStore({ dir })
    await expect(store.list()).rejects.toMatchObject({
      name: 'OutcomeStoreError',
      operation: 'decode',
      path: file,
      line: 2,
    })
    await expect(store.forRun('unrelated')).rejects.toBeInstanceOf(OutcomeStoreError)
    await writeFile(file, `${JSON.stringify(observation())}\n`)
    expect(await store.list()).toEqual([observation()])
  })

  it.each([
    { runId: 'run', capturedAt: 1, metrics: { success: null } },
    { runId: 'run', capturedAt: 1, metrics: null },
    { runId: '', capturedAt: 1, metrics: { success: 0 } },
    { runId: 'run', capturedAt: 'yesterday', metrics: { success: 0 } },
  ])('refuses a decoded record outside the outcome contract: %j', async (invalid) => {
    const file = join(dir, 'outcomes.ndjson')
    await writeFile(file, `${JSON.stringify(invalid)}\n`)
    await expect(new FileSystemOutcomeStore({ dir }).list()).rejects.toMatchObject({
      operation: 'decode',
      path: file,
      line: 1,
    })
  })

  it('surfaces an unreadable store path as a read error', async () => {
    const file = join(dir, 'file-not-directory')
    await writeFile(file, 'existing data')
    await expect(new FileSystemOutcomeStore({ dir: file }).list()).rejects.toMatchObject({
      operation: 'read',
      path: file,
    })
  })

  it('surfaces an unreadable evidence file instead of calling it an empty store', async () => {
    const file = join(dir, 'outcomes.ndjson')
    await mkdir(file)
    await expect(new FileSystemOutcomeStore({ dir }).list()).rejects.toMatchObject({
      operation: 'read',
      path: file,
    })
  })

  it('retains write failure diagnostics and accepts a repaired path on the next operation', async () => {
    const file = join(dir, 'outcomes.ndjson')
    await mkdir(file)
    const store = new FileSystemOutcomeStore({ dir })
    await expect(store.append(observation())).rejects.toMatchObject({
      name: 'OutcomeStoreError',
      operation: 'write',
      path: file,
      cause: expect.any(Error),
    })
    await rm(file, { recursive: true })
    await store.append(observation())
    expect(await store.list()).toEqual([observation()])
  })

  it('serializes concurrent writes and keeps every rotation even within one millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234)
    const store = new FileSystemOutcomeStore({ dir, maxBytes: 1 })
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append(observation(`run-${i}`))))
    const rows = await store.list()
    expect(rows).toHaveLength(20)
    expect(new Set(rows.map((row) => row.runId)).size).toBe(20)
    expect(await readdir(dir)).toHaveLength(20)
    expect(await readFile(join(dir, 'outcomes.ndjson'), 'utf8')).toContain('run-19')
  })
})
