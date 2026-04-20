import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { MemoryTraceStore, FileSystemTraceStore, type LlmTrace } from '../src/trace-store'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

function trace(partial: Partial<LlmTrace> = {}): LlmTrace {
  return {
    id: `trc_${Math.random().toString(36).slice(2, 10)}`,
    runId: 'run_1',
    role: 'judge',
    model: 'claude-sonnet-4-6',
    prompt: 'test prompt',
    output: 'test output',
    timestamp: new Date().toISOString(),
    ...partial,
  }
}

describe('MemoryTraceStore', () => {
  let store: MemoryTraceStore
  beforeEach(() => { store = new MemoryTraceStore() })

  it('records + queries by runId', async () => {
    await store.record(trace({ runId: 'run_a' }))
    await store.record(trace({ runId: 'run_b' }))
    const found = await store.query({ runId: 'run_a' })
    expect(found).toHaveLength(1)
    expect(found[0].runId).toBe('run_a')
  })

  it('filters by role + scenarioId — regression: missing filter returns wrong slice to reports', async () => {
    await store.record(trace({ role: 'judge', scenarioId: 's1' }))
    await store.record(trace({ role: 'driver', scenarioId: 's1' }))
    await store.record(trace({ role: 'judge', scenarioId: 's2' }))
    const judgesOfS1 = await store.query({ role: 'judge', scenarioId: 's1' })
    expect(judgesOfS1).toHaveLength(1)
  })

  it('limit caps the result — regression: unbounded query OOMs on long runs', async () => {
    for (let i = 0; i < 100; i++) await store.record(trace())
    const capped = await store.query({ limit: 10 })
    expect(capped).toHaveLength(10)
  })

  it('sinceMs filter excludes earlier traces', async () => {
    await store.record(trace({ timestamp: '2026-01-01T00:00:00Z' }))
    await store.record(trace({ timestamp: '2026-06-01T00:00:00Z' }))
    const recent = await store.query({ sinceMs: Date.parse('2026-03-01T00:00:00Z') })
    expect(recent).toHaveLength(1)
  })

  it('count is total without filter, filtered otherwise', async () => {
    await store.record(trace({ runId: 'r1' }))
    await store.record(trace({ runId: 'r2' }))
    await store.record(trace({ runId: 'r1' }))
    expect(await store.count()).toBe(3)
    expect(await store.count({ runId: 'r1' })).toBe(2)
  })
})

describe('FileSystemTraceStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'agent-eval-trace-'))
  })
  afterAll(async () => {
    // best-effort cleanup of all test dirs
    const all = await import('node:fs/promises').then((fs) => fs.readdir(tmpdir()))
    for (const entry of all) {
      if (entry.startsWith('agent-eval-trace-')) {
        await rm(path.join(tmpdir(), entry), { recursive: true, force: true })
      }
    }
  })

  it('records + round-trips through NDJSON segments', async () => {
    const store = new FileSystemTraceStore({ dir })
    await store.record(trace({ runId: 'r1' }))
    await store.record(trace({ runId: 'r2' }))
    const all = await store.query({})
    expect(all).toHaveLength(2)
    const r1 = await store.query({ runId: 'r1' })
    expect(r1).toHaveLength(1)
  })

  it('skips malformed NDJSON lines — regression: one bad line must not kill the whole query', async () => {
    const store = new FileSystemTraceStore({ dir })
    await store.record(trace({ runId: 'good' }))
    const { appendFile } = await import('node:fs/promises')
    await appendFile(path.join(dir, 'traces-000.ndjson'), '{broken json\n')
    await store.record(trace({ runId: 'also_good' }))
    const out = await store.query({})
    expect(out).toHaveLength(2)
  })

  it('rolls over past rolloverBytes — regression: unbounded single-file growth kills grep performance', async () => {
    const store = new FileSystemTraceStore({ dir, rolloverBytes: 200 })
    for (let i = 0; i < 5; i++) await store.record(trace({ prompt: 'x'.repeat(80) }))
    const { readdir } = await import('node:fs/promises')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
    expect(files.length).toBeGreaterThanOrEqual(2)
  })
})
