import { describe, expect, it } from 'vitest'
import { expectAgent } from '../src/behavior-dsl'
import { ValidationError } from '../src/errors'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { createOtelTracingStore } from '../src/trace/otel-bridge'
import type { ExportableSpan, OtelExporter } from '../src/trace/otel-export'
import {
  type ContractSpan,
  checkTraceContracts,
  contractJudge,
  evaluateTraceContract,
  matchSpan,
  type TraceContract,
  traceContract,
} from '../src/trace-contracts'

// ── fixtures ──────────────────────────────────────────────────────────

let seq = 0
function tool(toolName: string, extra: Partial<ContractSpan> = {}): ContractSpan {
  seq += 1
  return {
    spanId: `sp-${seq}`,
    name: toolName,
    kind: 'tool',
    toolName,
    startedAt: seq * 10,
    status: 'ok',
    ...extra,
  }
}

function llm(name: string, extra: Partial<ContractSpan> = {}): ContractSpan {
  seq += 1
  return { spanId: `sp-${seq}`, name, kind: 'llm', startedAt: seq * 10, status: 'ok', ...extra }
}

// ── matchSpan ─────────────────────────────────────────────────────────

describe('matchSpan', () => {
  it('matches name by string, RegExp, and SerializedRegex', () => {
    const s = tool('search')
    expect(matchSpan(s, { name: 'search' })).toBe(true)
    expect(matchSpan(s, { name: /sea/ })).toBe(true)
    expect(matchSpan(s, { name: { $regex: 'SEARCH', flags: 'i' } })).toBe(true)
    expect(matchSpan(s, { name: 'other' })).toBe(false)
  })

  it('resolves tool from toolName, attributes, and tool-kind name fallback', () => {
    expect(matchSpan(tool('transfer'), { tool: 'transfer' })).toBe(true)
    expect(
      matchSpan(
        { spanId: 'x', name: 'call', kind: 'custom', attributes: { 'tool.name': 'transfer' } },
        { tool: 'transfer' },
      ),
    ).toBe(true)
    // otel-bridge ExportableSpan shape: toolName dropped, kind + name survive.
    expect(matchSpan({ spanId: 'x', name: 'transfer', kind: 'tool' }, { tool: 'transfer' })).toBe(
      true,
    )
    expect(matchSpan(llm('transfer'), { tool: 'transfer' })).toBe(false)
  })

  it('matches attr by strict equality and regex on strings', () => {
    const s = tool('transfer', { attributes: { amount: 500, currency: 'USD' } })
    expect(matchSpan(s, { attr: { amount: 500 } })).toBe(true)
    expect(matchSpan(s, { attr: { amount: 501 } })).toBe(false)
    expect(matchSpan(s, { attr: { currency: /usd/i } })).toBe(true)
    expect(matchSpan(s, { attr: { amount: /500/ } })).toBe(false)
  })

  it('ANDs all specified fields and supports custom', () => {
    const s = tool('transfer', { attributes: { amount: 500 } })
    expect(matchSpan(s, { tool: 'transfer', attr: { amount: 500 } })).toBe(true)
    expect(matchSpan(s, { tool: 'transfer', attr: { amount: 1 } })).toBe(false)
    expect(matchSpan(s, { custom: (span) => span.status === 'ok' })).toBe(true)
    expect(matchSpan(s, { tool: 'transfer', custom: () => false })).toBe(false)
  })

  it('throws on an empty predicate — it would match every span', () => {
    expect(() => matchSpan(tool('x'), {})).toThrow(ValidationError)
  })
})

// ── operators: pass + violation ───────────────────────────────────────

describe('operators', () => {
  it('always: pass and violation', () => {
    const c = traceContract('all-ok')
      .always({ attr: { team: 'ops' } })
      .build()
    const pass = evaluateTraceContract(c, [
      tool('a', { attributes: { team: 'ops' } }),
      tool('b', { attributes: { team: 'ops' } }),
    ])
    expect(pass.valid).toBe(true)
    const bad = tool('b', { attributes: { team: 'eng' } })
    const fail = evaluateTraceContract(c, [tool('a', { attributes: { team: 'ops' } }), bad])
    expect(fail.valid).toBe(false)
    expect(fail.violations).toHaveLength(1)
    expect(fail.violations[0]!.spanId).toBe(bad.spanId)
  })

  it('never: pass and violation', () => {
    const c = traceContract('no-delete').never({ tool: 'delete_db' }).build()
    expect(evaluateTraceContract(c, [tool('search'), tool('read')]).valid).toBe(true)
    const bad = tool('delete_db')
    const fail = evaluateTraceContract(c, [tool('search'), bad])
    expect(fail.valid).toBe(false)
    expect(fail.violations[0]).toMatchObject({ spanId: bad.spanId })
  })

  it('eventually: pass and violation (no spanId on the violation)', () => {
    const c = traceContract('must-verify')
      .eventually({ tool: /verify/ })
      .build()
    expect(evaluateTraceContract(c, [tool('search'), tool('verify_id')]).valid).toBe(true)
    const fail = evaluateTraceContract(c, [tool('search')])
    expect(fail.valid).toBe(false)
    expect(fail.violations).toHaveLength(1)
    expect(fail.violations[0]!.spanId).toBeUndefined()
  })

  it('eventually fails on an empty trace; always/never pass vacuously', () => {
    const c = traceContract('empty')
      .always({ tool: 'x' })
      .never({ tool: 'x' })
      .eventually({ tool: 'x' })
      .build()
    const v = evaluateTraceContract(c, [])
    expect(v.score).toBeCloseTo(2 / 3)
    expect(v.valid).toBe(false)
  })

  it('precedes: approval-before-transfer passes', () => {
    const c = traceContract('guarded').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const v = evaluateTraceContract(c, [tool('approval'), tool('transfer')])
    expect(v.valid).toBe(true)
    expect(v.score).toBe(1)
  })

  it('precedes: transfer-without-approval fails', () => {
    const c = traceContract('guarded').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const bad = tool('transfer')
    const v = evaluateTraceContract(c, [tool('search'), bad])
    expect(v.valid).toBe(false)
    expect(v.violations[0]).toMatchObject({ spanId: bad.spanId })
    expect(v.violations[0]!.detail).toMatch(/no earlier/)
  })

  it('precedes: approval-AFTER-transfer fails (ordering matters)', () => {
    const c = traceContract('guarded').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const v = evaluateTraceContract(c, [tool('transfer'), tool('approval')])
    expect(v.valid).toBe(false)
  })

  it('precedes: a span matching both a and b cannot witness itself', () => {
    const c = traceContract('self').precedes({ tool: /^t/ }, { tool: 'transfer' }).build()
    // 'transfer' matches both /^t/ and itself — needs a STRICTLY earlier /^t/ match.
    expect(evaluateTraceContract(c, [tool('transfer')]).valid).toBe(false)
    expect(evaluateTraceContract(c, [tool('touch'), tool('transfer')]).valid).toBe(true)
  })

  it('precedes with multiple matches: each unguarded b-match is a violation', () => {
    const c = traceContract('multi').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const t1 = tool('transfer')
    const a1 = tool('approval')
    const t2 = tool('transfer')
    const t3 = tool('transfer')
    const v = evaluateTraceContract(c, [t1, a1, t2, t3])
    // t1 precedes the approval — violation; t2 + t3 are covered by a1.
    expect(v.valid).toBe(false)
    expect(v.violations).toHaveLength(1)
    expect(v.violations[0]!.spanId).toBe(t1.spanId)
    // Fresh spans (startedAt follows creation order): approval first covers all.
    const allCovered = evaluateTraceContract(c, [
      tool('approval'),
      tool('transfer'),
      tool('transfer'),
    ])
    expect(allCovered.valid).toBe(true)
  })

  it('neverUnless: violation without prior, pass with earlier prior, fail with later prior', () => {
    const c = traceContract('consent')
      .neverUnless({ tool: 'send_email' }, { tool: 'user_consent' })
      .build()
    expect(evaluateTraceContract(c, [tool('send_email')]).valid).toBe(false)
    expect(evaluateTraceContract(c, [tool('user_consent'), tool('send_email')]).valid).toBe(true)
    expect(evaluateTraceContract(c, [tool('send_email'), tool('user_consent')]).valid).toBe(false)
  })
})

// ── ordering ──────────────────────────────────────────────────────────

describe('span ordering', () => {
  it('orders by startedAt regardless of array order', () => {
    const c = traceContract('order').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const approval = tool('approval', { startedAt: 5 })
    const transfer = tool('transfer', { startedAt: 99 })
    // Array order is transfer-first; timestamps say approval-first.
    expect(evaluateTraceContract(c, [transfer, approval]).valid).toBe(true)
  })

  it('falls back to array order when no span has a timestamp', () => {
    const c = traceContract('order').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const approval = { spanId: 'a', name: 'approval', kind: 'tool' }
    const transfer = { spanId: 't', name: 'transfer', kind: 'tool' }
    expect(evaluateTraceContract(c, [approval, transfer]).valid).toBe(true)
    expect(evaluateTraceContract(c, [transfer, approval]).valid).toBe(false)
  })

  it('throws when timestamps are mixed — never guess an ordering', () => {
    const c = traceContract('order').eventually({ tool: 'transfer' }).build()
    const timed = tool('approval', { startedAt: 1 })
    const untimed = { spanId: 'u', name: 'transfer', kind: 'tool' }
    expect(() => evaluateTraceContract(c, [timed, untimed])).toThrow(/mixed timestamps/)
  })
})

// ── verdict math ──────────────────────────────────────────────────────

describe('verdict math', () => {
  it('score is the fraction of passing rules, scores keyed 0|1 by label', () => {
    const c = traceContract('math')
      .eventually({ tool: 'approval' }, 'has-approval')
      .never({ tool: 'delete_db' }, 'no-delete')
      .precedes({ tool: 'approval' }, { tool: 'transfer' }, 'approval-first')
      .eventually({ tool: 'audit_log' }, 'has-audit')
      .build()
    const v = evaluateTraceContract(c, [tool('approval'), tool('transfer')])
    expect(v.scores).toEqual({
      'has-approval': 1,
      'no-delete': 1,
      'approval-first': 1,
      'has-audit': 0,
    })
    expect(v.score).toBeCloseTo(0.75)
    expect(v.valid).toBe(false)
    expect(v.notes).toBe('3/4 rules passed')
  })

  it('checkTraceContracts aggregates allValid and rejects an empty list', () => {
    const ok = traceContract('ok').eventually({ tool: 'approval' }).build()
    const bad = traceContract('bad').never({ tool: 'approval' }).build()
    const spans = [tool('approval')]
    const both = checkTraceContracts(spans, [ok, bad])
    expect(both.allValid).toBe(false)
    expect(both.verdicts.map((v) => v.valid)).toEqual([true, false])
    expect(checkTraceContracts(spans, [ok]).allValid).toBe(true)
    expect(() => checkTraceContracts(spans, [])).toThrow(/vacuously pass/)
  })
})

// ── builder validation ────────────────────────────────────────────────

describe('builder', () => {
  it('build() throws on zero rules', () => {
    expect(() => traceContract('empty').build()).toThrow(/no rules/)
  })

  it('rejects empty predicates at build time', () => {
    expect(() => traceContract('c').always({})).toThrow(/empty predicate/)
  })

  it('auto-dedupes duplicate default labels', () => {
    const c = traceContract('dupe').never({ tool: 'x' }).never({ tool: 'x' }).build()
    expect(c.rules.map((r) => r.label)).toEqual(['never(tool=x)', 'never(tool=x) #2'])
  })

  it('evaluateTraceContract rejects hand-built contracts with duplicate labels', () => {
    const c: TraceContract = {
      name: 'dupe',
      rules: [
        { kind: 'never', label: 'same', p: { tool: 'x' } },
        { kind: 'never', label: 'same', p: { tool: 'y' } },
      ],
    }
    expect(() => evaluateTraceContract(c, [])).toThrow(/duplicate label/)
  })
})

// ── serializability ───────────────────────────────────────────────────

describe('serializability', () => {
  it('JSON roundtrip preserves evaluation, including RegExp matchers', () => {
    const c = traceContract('wire')
      .never({ tool: /delete/i })
      .precedes({ tool: 'approval', attr: { team: /ops/ } }, { tool: 'transfer' })
      .build()
    const revived = JSON.parse(JSON.stringify(c)) as TraceContract
    const spans = [tool('approval', { attributes: { team: 'ops-eu' } }), tool('transfer')]
    const before = evaluateTraceContract(c, spans)
    const after = evaluateTraceContract(revived, spans)
    expect(after).toEqual(before)
    expect(after.valid).toBe(true)
    const failing = evaluateTraceContract(revived, [tool('DELETE_db'), tool('transfer')])
    expect(failing.valid).toBe(false)
  })

  it('custom predicates fail loud after deserialization instead of weakening', () => {
    const c = traceContract('custom')
      .never({ custom: (s) => s.status === 'error' })
      .build()
    expect(evaluateTraceContract(c, [tool('a')]).valid).toBe(true)
    const revived = JSON.parse(JSON.stringify(c)) as TraceContract
    expect(() => evaluateTraceContract(revived, [tool('a')])).toThrow(/custom predicate/)
  })
})

// ── OTLP-flattened spans (otel-bridge ExportableSpan shape) ───────────

describe('dual-use: otel-bridge flattened spans', () => {
  async function flattenedRun(
    build: (e: TraceEmitter) => Promise<void>,
  ): Promise<ExportableSpan[]> {
    const captured: ExportableSpan[] = []
    const exporter: OtelExporter = {
      exportSpan: (s) => {
        captured.push(s)
      },
      flush: async () => {},
      shutdown: async () => {},
    }
    const store = createOtelTracingStore(new InMemoryTraceStore(), exporter, 'run-1')
    let t = 0
    let n = 0
    const e = new TraceEmitter(store, { runId: 'run-1', now: () => ++t, id: () => `id-${++n}` })
    await e.startRun({ scenarioId: 's' })
    await build(e)
    await e.endRun({ pass: true })
    return captured
  }

  const contract = traceContract('payment-safety')
    .precedes({ tool: 'approval' }, { tool: 'transfer' })
    .never({ tool: 'delete_db' })
    .eventually({ tool: 'transfer' })
    .build()

  it('the same contract passes over spans captured through the real flattening', async () => {
    const spans = await flattenedRun(async (e) => {
      const a = await e.tool({ name: 'approval', toolName: 'approval', args: {} })
      await a.end()
      const tr = await e.tool({ name: 'transfer', toolName: 'transfer', args: { amount: 5 } })
      await tr.end()
    })
    expect(spans.length).toBe(2)
    // The flattening drops `toolName` — matching survives via kind+name.
    expect(spans[0]).not.toHaveProperty('toolName')
    expect(spans[0]!.kind).toBe('tool')
    const v = evaluateTraceContract(contract, spans)
    expect(v.valid).toBe(true)
  })

  it('and fails over a flattened trace that transfers without approval', async () => {
    const spans = await flattenedRun(async (e) => {
      const tr = await e.tool({ name: 'transfer', toolName: 'transfer', args: { amount: 5 } })
      await tr.end()
    })
    const v = evaluateTraceContract(contract, spans)
    expect(v.valid).toBe(false)
    expect(v.scores['eventually(tool=transfer)']).toBe(1)
  })

  it('attr predicates read flattened attributes', async () => {
    const spans = await flattenedRun(async (e) => {
      const tr = await e.tool({
        name: 'transfer',
        toolName: 'transfer',
        args: {},
        attributes: { region: 'eu-west' },
      })
      await tr.end()
    })
    const c = traceContract('region')
      .always({ attr: { region: /^eu-/ } })
      .build()
    expect(evaluateTraceContract(c, spans).valid).toBe(true)
  })
})

// ── behavior-dsl integration ──────────────────────────────────────────

describe('expectAgent(...).toSatisfyContract', () => {
  async function recordedRun(
    build: (e: TraceEmitter) => Promise<void>,
  ): Promise<{ store: InMemoryTraceStore; runId: string }> {
    const store = new InMemoryTraceStore()
    let t = 0
    let n = 0
    const e = new TraceEmitter(store, { now: () => ++t, id: () => `id-${++n}` })
    await e.startRun({ scenarioId: 's' })
    await build(e)
    await e.endRun({ pass: true })
    return { store, runId: e.runId }
  }

  const contract = traceContract('guarded-transfer')
    .precedes({ tool: 'approval' }, { tool: 'transfer' })
    .build()

  it('passes over a stored run that approves before transferring', async () => {
    const { store, runId } = await recordedRun(async (e) => {
      const a = await e.tool({ name: 'approval', toolName: 'approval', args: {} })
      await a.end()
      const tr = await e.tool({ name: 'transfer', toolName: 'transfer', args: {} })
      await tr.end()
    })
    const r = await expectAgent(store, runId).toSatisfyContract(contract).check()
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('guarded-transfer')
  })

  it('fails with the violating spanId as evidence', async () => {
    const { store, runId } = await recordedRun(async (e) => {
      const tr = await e.tool({ name: 'transfer', toolName: 'transfer', args: {} })
      await tr.end()
    })
    const r = await expectAgent(store, runId).toSatisfyContract(contract).check()
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no earlier/)
    expect(r.evidence).toBeDefined()
  })
})

// ── campaign judge adapter ────────────────────────────────────────────

describe('contractJudge', () => {
  interface Artifact {
    spans: ContractSpan[]
  }
  const scenario = { id: 'sc-1', kind: 'payment' }
  const safety = traceContract('safety').never({ tool: 'delete_db' }).build()
  const protocol = traceContract('protocol')
    .precedes({ tool: 'approval' }, { tool: 'transfer' })
    .eventually({ tool: 'transfer' })
    .build()

  it('scores one dimension per contract with mean composite', async () => {
    const judge = contractJudge<Artifact>([safety, protocol], {
      spans: ({ artifact }) => artifact.spans,
    })
    expect(judge.name).toBe('trace-contracts')
    expect(judge.dimensions.map((d) => d.key)).toEqual(['safety', 'protocol'])
    const score = await judge.score({
      artifact: { spans: [tool('transfer')] },
      scenario,
      signal: new AbortController().signal,
    })
    // safety passes (1); protocol: transfer unguarded (0) but eventually hits (1) → 0.5.
    expect(score.dimensions).toEqual({ safety: 1, protocol: 0.5 })
    expect(score.composite).toBeCloseTo(0.75)
    expect(score.notes).toMatch(/no earlier/)
    const clean = await judge.score({
      artifact: { spans: [tool('approval'), tool('transfer')] },
      scenario,
      signal: new AbortController().signal,
    })
    expect(clean.composite).toBe(1)
    expect(clean.notes).toBe('all trace contracts satisfied')
  })

  it('fails loud on misuse: empty contracts, duplicate names, non-array spans', () => {
    expect(() => contractJudge([], { spans: () => [] })).toThrow(/at least one/)
    expect(() => contractJudge([safety, safety], { spans: () => [] })).toThrow(/duplicate/)
    const judge = contractJudge<Artifact>([safety], {
      spans: () => undefined as unknown as ContractSpan[],
    })
    expect(() =>
      judge.score({
        artifact: { spans: [] },
        scenario,
        signal: new AbortController().signal,
      }),
    ).toThrow(/span array/)
  })
})
