import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnalystRegistry } from './registry'
import { FindingsStore, diffFindings } from './findings-store'
import {
  computeFindingId,
  makeFinding,
  type Analyst,
  type AnalystFinding,
  type AnalystRunInputs,
} from './types'
import { createChatClient } from './chat-client'
import { resetLockedAppendersForTesting } from '../locked-jsonl-appender'

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
    const a = computeFindingId({ analyst_id: 'x', area: 'a', claim: 'cost was $1.23', id_basis: 'cost-finding' })
    const b = computeFindingId({ analyst_id: 'x', area: 'a', claim: 'cost was $4.56', id_basis: 'cost-finding' })
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
    expect(() =>
      reg.register({ ...ok, id: 'b', version: '' } as Analyst),
    ).toThrow(/version/)
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
        return [makeFinding({ analyst_id: 'needs-trace-store', area: 'x', claim: 'ok', severity: 'info', confidence: 1, evidence_refs: [] })]
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
  function f(over: Partial<AnalystFinding> & { claim: string; area?: string; subject?: string; analyst_id?: string }) {
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
    const prev = [f({ claim: 'still here' }), f({ claim: 'gone', subject: 's1' }), f({ claim: 'changed', subject: 's2', severity: 'medium' })].map((x) => ({ ...x, run_id: 'r0' }))
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
        return { text: 'ok', model: req.model ?? '', usage: { promptTokens: 0, completionTokens: 0 } } as never
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
