import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  FileSystemTraceStore,
  InMemoryTraceStore,
  TraceEmitter,
} from '../src/trace'
import type { Run, Span } from '../src/trace'

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    runId: id,
    scenarioId: 'scenario-a',
    startedAt: 1_000_000,
    status: 'running',
    ...overrides,
  }
}

describe('InMemoryTraceStore', () => {
  it('appends and retrieves runs', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun(makeRun('r1'))
    expect((await store.getRun('r1'))?.scenarioId).toBe('scenario-a')
  })

  it('updates runs — regression: lost updates mask failed completions', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun(makeRun('r1'))
    await store.updateRun('r1', { status: 'completed', outcome: { pass: true, score: 0.9 } })
    const loaded = await store.getRun('r1')
    expect(loaded?.status).toBe('completed')
    expect(loaded?.outcome?.score).toBe(0.9)
  })

  it('rejects duplicate runs + updates on missing', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun(makeRun('r1'))
    await expect(store.appendRun(makeRun('r1'))).rejects.toThrow(/already exists/)
    await expect(store.updateRun('missing', {})).rejects.toThrow(/not found/)
  })

  it('filters spans by kind + toolName', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun(makeRun('r1'))
    const spans: Span[] = [
      { spanId: 's1', runId: 'r1', kind: 'tool', toolName: 'search', args: {}, name: 'search', startedAt: 0 },
      { spanId: 's2', runId: 'r1', kind: 'tool', toolName: 'write_file', args: {}, name: 'write_file', startedAt: 0 },
      { spanId: 's3', runId: 'r1', kind: 'llm', model: 'claude', messages: [], name: 'llm', startedAt: 0 },
    ]
    for (const s of spans) await store.appendSpan(s)
    expect(await store.spans({ runId: 'r1', kind: 'tool' })).toHaveLength(2)
    expect(await store.spans({ runId: 'r1', toolName: 'search' })).toHaveLength(1)
    expect(await store.spans({ runId: 'r1', kind: 'llm' })).toHaveLength(1)
  })

  it('spans filter by toolName rejects non-tool spans — regression: non-tool kinds would leak through', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun(makeRun('r1'))
    await store.appendSpan({ runId: 'r1', spanId: 's1', kind: 'llm', model: 'm', messages: [], name: 'llm', startedAt: 0 })
    expect(await store.spans({ runId: 'r1', toolName: 'search' })).toHaveLength(0)
  })
})

describe('FileSystemTraceStore', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
    dirs.length = 0
  })

  async function makeDir(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-eval-test-'))
    dirs.push(d)
    return d
  }

  it('round-trips a run through NDJSON', async () => {
    const dir = await makeDir()
    const store = new FileSystemTraceStore({ dir })
    await store.appendRun(makeRun('r1', { tags: { persona: 'senior-dev' } }))
    await store.appendSpan({ runId: 'r1', spanId: 's1', kind: 'llm', model: 'claude', messages: [], name: 'call', startedAt: 1 })

    const fresh = new FileSystemTraceStore({ dir })
    expect((await fresh.getRun('r1'))?.scenarioId).toBe('scenario-a')
    expect(await fresh.spans({ runId: 'r1' })).toHaveLength(1)
  })

  it('rolls over large files — regression: single huge file hurts append latency', async () => {
    const dir = await makeDir()
    const store = new FileSystemTraceStore({ dir, maxBytes: 200 })
    for (let i = 0; i < 30; i++) await store.appendRun(makeRun(`r${i}`))
    const entries = await fs.readdir(dir)
    const runsFiles = entries.filter((e) => e.startsWith('runs.'))
    expect(runsFiles.length).toBeGreaterThan(1)
  })
})

describe('TraceEmitter', () => {
  it('auto-parents spans via stack', async () => {
    const store = new InMemoryTraceStore()
    let t = 1000
    const emitter = new TraceEmitter(store, { now: () => t++ })
    await emitter.startRun({ scenarioId: 'x' })
    const outer = await emitter.span({ kind: 'agent', name: 'outer' })
    const inner = await emitter.span({ kind: 'tool', name: 'inner', toolName: 'search', args: {} })
    expect(inner.span.parentSpanId).toBe(outer.span.spanId)
    await inner.end()
    await outer.end()
    const inInner = (await store.spans({ name: 'inner' }))[0]
    expect(inInner?.endedAt).toBeDefined()
    expect(inInner?.status).toBe('ok')
  })

  it('within() ends span on success and fails on throw — regression: thrown errors used to leak spans as still-running', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    await expect(
      emitter.within({ kind: 'custom', name: 'boom' }, async () => { throw new Error('kaboom') }),
    ).rejects.toThrow(/kaboom/)
    const failed = (await store.spans()).find((s) => s.name === 'boom')
    expect(failed?.status).toBe('error')
    expect(failed?.error).toBe('kaboom')
  })

  it('recordBudget emits a breach event when breached=true', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    await emitter.recordBudget({ dimension: 'tokens', limit: 100, consumed: 101, remaining: -1, breached: true })
    const events = await store.events({ kind: 'budget_breach' })
    expect(events).toHaveLength(1)
    expect(events[0].payload.dimension).toBe('tokens')
  })

  it('endRun marks failed when outcome.pass === false', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    await emitter.endRun({ pass: false, failureClass: 'tool_selection_error' })
    const r = await store.getRun(emitter.runId)
    expect(r?.status).toBe('failed')
    expect(r?.outcome?.failureClass).toBe('tool_selection_error')
  })

  it('startRun accepts input without scenarioId — defaults to layer / tags.kind / "runtime"', async () => {
    // Runtime / operator / meta-eval runs don't have a curated scenario corpus
    // to anchor to. Caller used to have to invent placeholder strings; now the
    // emitter substitutes a sensible default while the persisted Run shape
    // keeps scenarioId required for downstream filters + aggregations.
    const store = new InMemoryTraceStore()

    // Bare default: no layer, no tags → 'runtime'
    {
      const e = new TraceEmitter(store)
      const run = await e.startRun({})
      expect(run.scenarioId).toBe('runtime')
      const persisted = await store.getRun(e.runId)
      expect(persisted?.scenarioId).toBe('runtime')
    }

    // Layer wins over the bare default.
    {
      const e = new TraceEmitter(store)
      const run = await e.startRun({ layer: 'meta' })
      expect(run.scenarioId).toBe('meta')
    }

    // tags.kind wins over the bare default when no layer.
    {
      const e = new TraceEmitter(store)
      const run = await e.startRun({ tags: { kind: 'inbound_email' } })
      expect(run.scenarioId).toBe('inbound_email')
    }

    // Caller-provided scenarioId still wins — no behavior regression.
    {
      const e = new TraceEmitter(store)
      const run = await e.startRun({ scenarioId: 'explicit', layer: 'meta', tags: { kind: 'x' } })
      expect(run.scenarioId).toBe('explicit')
    }
  })
})
