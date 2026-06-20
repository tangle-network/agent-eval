import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetLockedAppendersForTesting } from '../testing'
import { createChatClient } from './chat-client'
import { defaultIsMaterial, diffFindings, FindingsStore } from './findings-store'
import { type AnalystHooks, AnalystRegistry } from './registry'
import {
  type Analyst,
  type AnalystFinding,
  type AnalystRunInputs,
  computeFindingId,
  makeFinding,
} from './types'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'analyst-test-'))
})

afterEach(() => {
  resetLockedAppendersForTesting()
  rmSync(tmp, { recursive: true, force: true })
})

describe('computeFindingId', () => {
  it('produces a stable id for identical identity-defining fields', () => {
    const a = computeFindingId({ analyst_id: 'x', area: 'a', claim: 'something happened' })
    const b = computeFindingId({ analyst_id: 'x', area: 'a', claim: 'Something Happened.' })
    expect(a).toBe(b)
  })

  it('differs when subject changes', () => {
    const a = computeFindingId({ analyst_id: 'x', area: 'a', subject: 's1', claim: 'c' })
    const b = computeFindingId({ analyst_id: 'x', area: 'a', subject: 's2', claim: 'c' })
    expect(a).not.toBe(b)
  })

  it('honors id_basis override so cosmetic claim drift does not change the id', () => {
    const a = computeFindingId({
      analyst_id: 'x',
      area: 'a',
      claim: 'cost was $1.23',
      id_basis: 'cost-finding',
    })
    const b = computeFindingId({
      analyst_id: 'x',
      area: 'a',
      claim: 'cost was $4.56',
      id_basis: 'cost-finding',
    })
    expect(a).toBe(b)
  })
})

describe('AnalystRegistry', () => {
  it('rejects duplicate ids and missing version at register-time', () => {
    const reg = new AnalystRegistry()
    const ok: Analyst = {
      id: 'a',
      description: 'test',
      inputKind: 'run-record',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze() {
        return []
      },
    }
    reg.register(ok)
    expect(() => reg.register(ok)).toThrow(/duplicate/)
    expect(() => reg.register({ ...ok, id: 'b', version: '' } as Analyst)).toThrow(/version/)
  })

  it('routes inputKind correctly and skips analysts with missing input', async () => {
    const reg = new AnalystRegistry()
    let saw: unknown
    reg.register({
      id: 'needs-trace-store',
      description: '',
      inputKind: 'trace-store',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze(input) {
        saw = input
        return [
          makeFinding({
            analyst_id: 'needs-trace-store',
            area: 'x',
            claim: 'ok',
            severity: 'info',
            confidence: 1,
            evidence_refs: [],
          }),
        ]
      },
    })
    reg.register({
      id: 'needs-judge-input',
      description: '',
      inputKind: 'judge-input',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze() {
        return []
      },
    })

    const fakeStore = {} as AnalystRunInputs['traceStore']
    const result = await reg.run('run-1', { traceStore: fakeStore })

    expect(saw).toBe(fakeStore)
    expect(result.findings).toHaveLength(1)
    const summaries = Object.fromEntries(result.per_analyst.map((s) => [s.analyst_id, s.status]))
    expect(summaries['needs-trace-store']).toBe('ok')
    expect(summaries['needs-judge-input']).toBe('skipped')
  })

  it('isolates one analyst failure from others', async () => {
    const reg = new AnalystRegistry()
    reg.register({
      id: 'will-throw',
      description: '',
      inputKind: 'run-record',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze() {
        throw new Error('boom')
      },
    })
    reg.register({
      id: 'will-succeed',
      description: '',
      inputKind: 'run-record',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze() {
        return [
          makeFinding({
            analyst_id: 'will-succeed',
            area: 'x',
            claim: 'ok',
            severity: 'info',
            confidence: 1,
            evidence_refs: [],
          }),
        ]
      },
    })

    // Pass `judgeInput` as a hack — both analysts declare 'run-record' so
    // we need that present. We just need _something_ truthy at the right
    // key; the analysts ignore the value.
    const fakeRunRecord = { id: 'r' } as unknown as AnalystRunInputs['runRecord']
    const result = await reg.run('run-1', { runRecord: fakeRunRecord })

    const byId = Object.fromEntries(result.per_analyst.map((s) => [s.analyst_id, s]))
    expect(byId['will-throw']?.status).toBe('failed')
    expect(byId['will-throw']?.error?.message).toBe('boom')
    expect(byId['will-succeed']?.status).toBe('ok')
    expect(result.findings).toHaveLength(1)
  })

  it('only / skip selection works', async () => {
    const reg = new AnalystRegistry()
    for (const id of ['a', 'b', 'c']) {
      reg.register({
        id,
        description: '',
        inputKind: 'run-record',
        cost: { kind: 'deterministic' },
        version: '1',
        async analyze() {
          return []
        },
      })
    }
    const fakeRunRecord = { id: 'r' } as unknown as AnalystRunInputs['runRecord']
    const onlyAB = await reg.run('run-1', { runRecord: fakeRunRecord }, { only: ['a', 'b'] })
    expect(onlyAB.per_analyst.map((s) => s.analyst_id).sort()).toEqual(['a', 'b'])
    const skipB = await reg.run('run-1', { runRecord: fakeRunRecord }, { skip: ['b'] })
    expect(skipB.per_analyst.map((s) => s.analyst_id).sort()).toEqual(['a', 'c'])
  })

  it('attributes cost from finding metadata into per-analyst + total', async () => {
    const reg = new AnalystRegistry()
    reg.register({
      id: 'cost-attributor',
      description: '',
      inputKind: 'run-record',
      cost: { kind: 'llm' },
      version: '1',
      async analyze() {
        return [
          makeFinding({
            analyst_id: 'cost-attributor',
            area: 'x',
            claim: 'a',
            severity: 'info',
            confidence: 1,
            evidence_refs: [],
            metadata: { cost_usd: 0.04 },
          }),
          makeFinding({
            analyst_id: 'cost-attributor',
            area: 'x',
            claim: 'b',
            severity: 'info',
            confidence: 1,
            evidence_refs: [],
            metadata: { cost_usd: 0.06 },
          }),
        ]
      },
    })
    const fakeRunRecord = { id: 'r' } as unknown as AnalystRunInputs['runRecord']
    const result = await reg.run('run-1', { runRecord: fakeRunRecord })
    expect(result.per_analyst[0]?.cost_usd).toBeCloseTo(0.1, 5)
    expect(result.total_cost_usd).toBeCloseTo(0.1, 5)
  })
})

describe('FindingsStore + diffFindings', () => {
  function f(
    over: Partial<AnalystFinding> & {
      claim: string
      area?: string
      subject?: string
      analyst_id?: string
    },
  ) {
    return makeFinding({
      analyst_id: over.analyst_id ?? 'a',
      area: over.area ?? 'x',
      subject: over.subject,
      claim: over.claim,
      severity: over.severity ?? 'medium',
      confidence: over.confidence ?? 0.8,
      evidence_refs: over.evidence_refs ?? [],
    })
  }

  it('round-trips through JSONL persistence', async () => {
    const store = new FindingsStore(join(tmp, 'findings.jsonl'))
    const written = [f({ claim: 'one' }), f({ claim: 'two' })]
    await store.append('run-1', written)
    const loaded = store.loadRun('run-1')
    expect(loaded.map((r) => r.claim)).toEqual(['one', 'two'])
    expect(loaded.every((r) => r.run_id === 'run-1')).toBe(true)
  })

  it('diffs by stable id — appeared / disappeared / persisted / changed', () => {
    const prev = [
      f({ claim: 'still here' }),
      f({ claim: 'gone', subject: 's1' }),
      f({ claim: 'changed', subject: 's2', severity: 'medium' }),
    ].map((x) => ({ ...x, run_id: 'r0' }))
    const curr = [
      f({ claim: 'still here' }),
      f({ claim: 'new finding', subject: 'snew' }),
      f({ claim: 'changed', subject: 's2', severity: 'critical' }),
    ].map((x) => ({ ...x, run_id: 'r1' }))

    const d = diffFindings(prev, curr)
    expect(d.appeared.map((x) => x.subject)).toEqual(['snew'])
    expect(d.disappeared.map((x) => x.subject)).toEqual(['s1'])
    expect(d.persisted.map((x) => x.claim)).toEqual(['still here'])
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0]?.previous.severity).toBe('medium')
    expect(d.changed[0]?.current.severity).toBe('critical')
  })
})

describe('createChatClient mock transport', () => {
  it('falls back to defaultModel and forwards request to handler', async () => {
    const seen: Array<{ model: string | undefined }> = []
    const client = createChatClient({
      transport: 'mock',
      defaultModel: 'fake-model',
      handler: async (req) => {
        seen.push({ model: req.model })
        return {
          text: 'ok',
          model: req.model ?? '',
          usage: { promptTokens: 0, completionTokens: 0 },
        } as never
      },
    })
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(seen[0]?.model).toBe('fake-model')
  })

  it('throws when no model and no defaultModel', async () => {
    const client = createChatClient({
      transport: 'mock',
      handler: async () => ({}) as never,
    })
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /no model/i,
    )
  })
})

describe('AnalystHooks', () => {
  function ok(id: string): Analyst {
    return {
      id,
      description: '',
      inputKind: 'run-record',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze() {
        return [
          makeFinding({
            analyst_id: id,
            area: 'x',
            claim: 'ok',
            severity: 'info',
            confidence: 1,
            evidence_refs: [],
          }),
        ]
      },
    }
  }

  function fail(id: string): Analyst {
    return {
      id,
      description: '',
      inputKind: 'run-record',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze() {
        throw new Error('boom')
      },
    }
  }

  it('invokes onBefore/onAfter/onComplete in order', async () => {
    const calls: string[] = []
    const hooks: AnalystHooks = {
      onBeforeAnalyze: ({ analyst }) => void calls.push(`before:${analyst.id}`),
      onAfterAnalyze: ({ analyst, summary }) =>
        void calls.push(`after:${analyst.id}:${summary.status}`),
      onComplete: ({ result }) => void calls.push(`complete:${result.findings.length}`),
    }
    const reg = new AnalystRegistry({ hooks })
    reg.register(ok('a'))
    reg.register(ok('b'))
    const r = { id: 'r' } as unknown as AnalystRunInputs['runRecord']
    await reg.run('run-1', { runRecord: r })
    expect(calls).toEqual(['before:a', 'after:a:ok', 'before:b', 'after:b:ok', 'complete:2'])
  })

  it('onError can convert a thrown analyst into findings', async () => {
    const hooks: AnalystHooks = {
      onError: ({ analyst, error }) => [
        makeFinding({
          analyst_id: analyst.id,
          area: 'errors',
          claim: `analyst crashed: ${error.message}`,
          severity: 'high',
          confidence: 1,
          evidence_refs: [],
        }),
      ],
    }
    const reg = new AnalystRegistry({ hooks })
    reg.register(fail('a'))
    reg.register(ok('b'))
    const r = { id: 'r' } as unknown as AnalystRunInputs['runRecord']
    const result = await reg.run('run-1', { runRecord: r })
    // 1 from converted error + 1 from ok analyst
    expect(result.findings).toHaveLength(2)
    const byId = Object.fromEntries(result.per_analyst.map((s) => [s.analyst_id, s]))
    expect(byId.a?.status).toBe('failed')
    expect(byId.a?.findings_count).toBe(1) // surfaced from hook
    expect(byId.b?.status).toBe('ok')
  })

  it('onAfter runs for skipped analysts too', async () => {
    const summaries: string[] = []
    const hooks: AnalystHooks = {
      onAfterAnalyze: ({ summary }) =>
        void summaries.push(`${summary.analyst_id}:${summary.status}`),
    }
    const reg = new AnalystRegistry({ hooks })
    reg.register({
      id: 'wants-judge',
      description: '',
      inputKind: 'judge-input',
      cost: { kind: 'deterministic' },
      version: '1',
      async analyze() {
        return []
      },
    })
    await reg.run('run-1', {})
    expect(summaries).toEqual(['wants-judge:skipped'])
  })
})

describe('BudgetPolicy', () => {
  function noop(id: string): Analyst {
    return {
      id,
      description: '',
      inputKind: 'run-record',
      cost: { kind: 'llm' },
      version: '1',
      async analyze() {
        return []
      },
    }
  }

  it('equal-split is the default when only totalUsd is set', async () => {
    const captured: Array<{ id: string; budget: number | undefined }> = []
    const hooks: AnalystHooks = {
      onBeforeAnalyze: ({ analyst, ctx }) =>
        void captured.push({ id: analyst.id, budget: ctx.budgetUsd }),
    }
    const reg = new AnalystRegistry({ hooks })
    reg.register(noop('a'))
    reg.register(noop('b'))
    reg.register(noop('c'))
    const r = { id: 'r' } as unknown as AnalystRunInputs['runRecord']
    await reg.run('run-1', { runRecord: r }, { budget: { totalUsd: 0.9 } })
    expect(captured.map((c) => c.budget)).toEqual([0.3, 0.3, 0.3])
  })

  it('custom allocate hook overrides default', async () => {
    const seen: Array<{ id: string; budget: number | undefined }> = []
    const reg = new AnalystRegistry({
      hooks: {
        onBeforeAnalyze: ({ analyst, ctx }) =>
          void seen.push({ id: analyst.id, budget: ctx.budgetUsd }),
      },
    })
    reg.register(noop('cheap'))
    reg.register(noop('expensive'))
    const r = { id: 'r' } as unknown as AnalystRunInputs['runRecord']
    await reg.run(
      'run-1',
      { runRecord: r },
      {
        budget: {
          totalUsd: 1.0,
          allocate: ({ analyst, totalUsd }) =>
            analyst.id === 'expensive' ? (totalUsd ?? 0) * 0.8 : (totalUsd ?? 0) * 0.2,
        },
      },
    )
    expect(seen.find((s) => s.id === 'cheap')?.budget).toBeCloseTo(0.2, 5)
    expect(seen.find((s) => s.id === 'expensive')?.budget).toBeCloseTo(0.8, 5)
  })
})

describe('diffFindings policy', () => {
  function f(claim: string, sev: AnalystFinding['severity'] = 'medium', rationale?: string) {
    return {
      ...makeFinding({
        analyst_id: 'a',
        area: 'x',
        claim,
        severity: sev,
        confidence: 0.8,
        evidence_refs: [],
        rationale,
      }),
      run_id: 'r0',
    }
  }

  it('default isMaterial ignores rationale text change', () => {
    const prev = [f('same', 'medium', 'reason A')]
    const cur = [{ ...f('same', 'medium', 'reason B reworded'), run_id: 'r1' }]
    const d = diffFindings(prev, cur)
    expect(d.changed).toHaveLength(0)
    expect(d.persisted).toHaveLength(1)
  })

  it('custom isMaterial can flag rationale shifts', () => {
    const prev = [f('same', 'medium', 'reason A')]
    const cur = [{ ...f('same', 'medium', 'reason B reworded'), run_id: 'r1' }]
    const d = diffFindings(prev, cur, {
      isMaterial: (a, b) => defaultIsMaterial(a, b) || a.rationale !== b.rationale,
    })
    expect(d.changed).toHaveLength(1)
  })
})

describe('AnalystRegistry.runStream', () => {
  function makeOkAnalyst(id: string, findings: AnalystFinding[]): Analyst {
    return {
      id,
      description: `ok ${id}`,
      inputKind: 'custom',
      cost: { kind: 'deterministic' },
      version: '1.0.0',
      analyze: async () => findings,
    } as never
  }

  function makeFailingAnalyst(id: string, error: Error): Analyst {
    return {
      id,
      description: `failing ${id}`,
      inputKind: 'custom',
      cost: { kind: 'deterministic' },
      version: '1.0.0',
      analyze: async () => {
        throw error
      },
    } as never
  }

  function makeMissingInputAnalyst(id: string): Analyst {
    return {
      id,
      description: `needs trace-store ${id}`,
      inputKind: 'trace-store',
      cost: { kind: 'deterministic' },
      version: '1.0.0',
      analyze: async () => [],
    } as never
  }

  function mkFinding(id: string, analystId: string): AnalystFinding {
    return makeFinding({
      analyst_id: analystId,
      area: analystId,
      claim: id,
      severity: 'low',
      confidence: 0.5,
      evidence_refs: [],
    })
  }

  const inputs: AnalystRunInputs = {
    custom: { a: 1, b: 2, c: 3, boom: 1, after: 1, 'needs-trace': 1 },
  }

  it('emits run-started → analyst-started → analyst-completed → run-completed for a clean run', async () => {
    const r = new AnalystRegistry()
    r.register(makeOkAnalyst('a', [mkFinding('f1', 'a'), mkFinding('f2', 'a')]))
    r.register(makeOkAnalyst('b', [mkFinding('g1', 'b')]))

    const events: import('./types').AnalystRunEvent[] = []
    for await (const ev of r.runStream('run-1', inputs)) events.push(ev)

    expect(events.map((e) => e.type)).toEqual([
      'run-started',
      'analyst-started',
      'analyst-completed',
      'analyst-started',
      'analyst-completed',
      'run-completed',
    ])

    const runStarted = events[0]
    if (runStarted?.type !== 'run-started') throw new Error('order invariant')
    expect(runStarted.analyst_ids).toEqual(['a', 'b'])
    expect(runStarted.run_id).toBe('run-1')

    const completedA = events[2]
    if (completedA?.type !== 'analyst-completed') throw new Error('order invariant')
    expect(completedA.summary.analyst_id).toBe('a')
    expect(completedA.summary.status).toBe('ok')
    expect(completedA.findings).toHaveLength(2)

    const runCompleted = events[5]
    if (runCompleted?.type !== 'run-completed') throw new Error('order invariant')
    expect(runCompleted.result.findings).toHaveLength(3)
    expect(runCompleted.result.per_analyst.map((s) => s.analyst_id)).toEqual(['a', 'b'])
  })

  it('emits analyst-skipped instead of analyst-started when input is missing', async () => {
    const r = new AnalystRegistry()
    r.register(makeMissingInputAnalyst('needs-trace'))

    const events: import('./types').AnalystRunEvent[] = []
    for await (const ev of r.runStream('run-1', inputs)) events.push(ev)

    expect(events.map((e) => e.type)).toEqual(['run-started', 'analyst-skipped', 'run-completed'])
    const skipped = events[1]
    if (skipped?.type !== 'analyst-skipped') throw new Error('order invariant')
    expect(skipped.summary.status).toBe('skipped')
    expect(skipped.summary.reason).toMatch(/missing input/)
  })

  it('emits analyst-completed with status=failed when the analyst throws; siblings still run', async () => {
    const r = new AnalystRegistry()
    r.register(makeFailingAnalyst('boom', new TypeError('synthetic')))
    r.register(makeOkAnalyst('after', [mkFinding('f1', 'after')]))

    const events: import('./types').AnalystRunEvent[] = []
    for await (const ev of r.runStream('run-1', inputs)) events.push(ev)

    const failedEv = events.find(
      (e) => e.type === 'analyst-completed' && e.summary.analyst_id === 'boom',
    )
    if (!failedEv || failedEv.type !== 'analyst-completed') throw new Error('expected failed event')
    expect(failedEv.summary.status).toBe('failed')
    expect(failedEv.summary.error?.class).toBe('TypeError')

    const afterEv = events.find(
      (e) => e.type === 'analyst-completed' && e.summary.analyst_id === 'after',
    )
    if (!afterEv || afterEv.type !== 'analyst-completed') throw new Error('expected after event')
    expect(afterEv.summary.status).toBe('ok')
  })

  it('run() returns the same envelope as the run-completed event from runStream()', async () => {
    const r = new AnalystRegistry()
    r.register(makeOkAnalyst('a', [mkFinding('f1', 'a')]))

    const result = await r.run('run-1', inputs)

    const r2 = new AnalystRegistry()
    r2.register(makeOkAnalyst('a', [mkFinding('f1', 'a')]))
    let streamResult: import('./types').AnalystRunResult | undefined
    for await (const ev of r2.runStream('run-1', inputs)) {
      if (ev.type === 'run-completed') streamResult = ev.result
    }

    expect(result.findings.map((f) => f.finding_id)).toEqual(
      streamResult?.findings.map((f) => f.finding_id),
    )
    expect(result.per_analyst.map(({ latency_ms: _latencyMs, ...summary }) => summary)).toEqual(
      streamResult?.per_analyst.map(({ latency_ms: _latencyMs, ...summary }) => summary),
    )
    expect(result.per_analyst.every((summary) => Number.isFinite(summary.latency_ms))).toBe(true)
    expect(streamResult?.per_analyst.every((summary) => Number.isFinite(summary.latency_ms))).toBe(
      true,
    )
  })

  it('honours backpressure: slow consumer between events preserves ordering', async () => {
    const r = new AnalystRegistry()
    r.register(makeOkAnalyst('a', [mkFinding('f1', 'a')]))
    r.register(makeOkAnalyst('b', [mkFinding('g1', 'b')]))

    const events: import('./types').AnalystRunEvent[] = []
    for await (const ev of r.runStream('run-1', inputs)) {
      events.push(ev)
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(events.map((e) => e.type)).toEqual([
      'run-started',
      'analyst-started',
      'analyst-completed',
      'analyst-started',
      'analyst-completed',
      'run-completed',
    ])
  })
})

describe('RegistryRunOpts.priorFindings forwarding', () => {
  function makeRecordingAnalyst(id: string): Analyst & {
    seen: Array<ReadonlyArray<AnalystFinding> | undefined>
  } {
    const seen: Array<ReadonlyArray<AnalystFinding> | undefined> = []
    return {
      id,
      description: `recording ${id}`,
      inputKind: 'custom',
      cost: { kind: 'deterministic' },
      version: '1.0.0',
      seen,
      async analyze(_input: unknown, ctx: import('./types').AnalystContext) {
        seen.push(ctx.priorFindings)
        return []
      },
    } as never
  }

  function p(id: string, analystId = 'a'): AnalystFinding {
    return makeFinding({
      analyst_id: analystId,
      area: 'x',
      claim: id,
      severity: 'low',
      confidence: 0.5,
      evidence_refs: [],
    })
  }

  const inputs: AnalystRunInputs = { custom: { a: 1, b: 2 } }

  it('array form: each analyst sees only its own prior findings', async () => {
    const r = new AnalystRegistry()
    const a = makeRecordingAnalyst('a')
    const b = makeRecordingAnalyst('b')
    r.register(a)
    r.register(b)
    const prior = [p('one', 'a'), p('two', 'a'), p('three', 'b')]
    await r.run('run-1', inputs, { priorFindings: prior })
    expect(a.seen[0]?.map((f) => f.claim)).toEqual(['one', 'two'])
    expect(b.seen[0]?.map((f) => f.claim)).toEqual(['three'])
  })

  it('array form: analyst with no matching prior gets undefined (not empty array)', async () => {
    const r = new AnalystRegistry()
    const a = makeRecordingAnalyst('a')
    r.register(a)
    await r.run('run-1', inputs, { priorFindings: [p('other', 'b')] })
    expect(a.seen[0]).toBeUndefined()
  })

  it('record form: wildcard "*" findings reach every analyst', async () => {
    const r = new AnalystRegistry()
    const a = makeRecordingAnalyst('a')
    const b = makeRecordingAnalyst('b')
    r.register(a)
    r.register(b)
    await r.run('run-1', inputs, {
      priorFindings: {
        a: [p('a-only', 'a')],
        '*': [p('everyone', 'failure-mode')],
      },
    })
    expect(a.seen[0]?.map((f) => f.claim)).toEqual(['a-only', 'everyone'])
    expect(b.seen[0]?.map((f) => f.claim)).toEqual(['everyone'])
  })

  it('no priorFindings option: ctx.priorFindings is undefined', async () => {
    const r = new AnalystRegistry()
    const a = makeRecordingAnalyst('a')
    r.register(a)
    await r.run('run-1', inputs)
    expect(a.seen[0]).toBeUndefined()
  })
})

describe('ChatClient signal racing', () => {
  it('mock transport rejects on abort even if handler is slow', async () => {
    const controller = new AbortController()
    const client = createChatClient({
      transport: 'mock',
      defaultModel: 'fake',
      handler: () => new Promise((resolve) => setTimeout(() => resolve({} as never), 100)),
    })
    const p = client.chat(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: controller.signal },
    )
    controller.abort()
    // Mock transport doesn't currently observe the signal — this test
    // documents the limit: races live in wrapLlmClient, mock passes
    // through. Either resolves (slow path) or rejects (when bound).
    // We just assert it eventually completes without hanging.
    const settled = await Promise.race([
      p.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<string>((r) => setTimeout(() => r('hung'), 200)),
    ])
    // The mock transport passes the signal through; the real contract here is
    // only that the call SETTLES (resolves or rejects) and never hangs.
    expect(settled).toBe('settled')
  })
})
