import { describe, expect, it } from 'vitest'
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
    expect(v.violations[0]!.detail).toMatch(/required predecessor tool=approval never occurred/)
  })

  it('precedes: fails when the required successor never occurs (no vacuous pass)', () => {
    const c = traceContract('guarded').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const v = evaluateTraceContract(c, [tool('approval'), tool('search')])
    expect(v.valid).toBe(false)
    expect(v.status).toBe('fail')
    expect(v.violations[0]!.detail).toMatch(/required successor tool=transfer never occurred/)
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
    // The conditional guard: a run that never sends passes.
    expect(evaluateTraceContract(c, [tool('search')]).valid).toBe(true)
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

  it('fails an ordering rule when timestamps are missing — array position is not time', () => {
    const c = traceContract('order').precedes({ tool: 'approval' }, { tool: 'transfer' }).build()
    const approval = { spanId: 'a', name: 'approval', kind: 'tool' }
    const transfer = { spanId: 't', name: 'transfer', kind: 'tool' }
    const v = evaluateTraceContract(c, [approval, transfer])
    expect(v.status).toBe('fail')
    expect(v.violations[0]!.detail).toMatch(/span t has no startedAt/)
    const guardOnly = { ...approval, startedAt: 1 }
    const fromGuard = evaluateTraceContract(c, [
      { spanId: 'a', name: 'approval', kind: 'tool' },
      { ...transfer, startedAt: 5 },
    ])
    expect(fromGuard.violations[0]!.detail).toMatch(/span a has no startedAt/)
    expect(evaluateTraceContract(c, [guardOnly, { ...transfer, startedAt: 5 }]).valid).toBe(true)
  })

  it('mixed timestamps fail only the ordering rules that need the missing one', () => {
    const c = traceContract('order')
      .eventually({ tool: 'transfer' }, 'has-transfer')
      .precedes({ tool: 'approval' }, { tool: 'transfer' }, 'approval-first')
      .build()
    const timed = tool('approval', { startedAt: 1 })
    const untimed = { spanId: 'u', name: 'transfer', kind: 'tool' }
    const v = evaluateTraceContract(c, [timed, untimed])
    expect(v.scores).toEqual({ 'has-transfer': 1, 'approval-first': 0 })
  })

  it('finish-before-start needs the predecessor to END before the successor starts', () => {
    const c = traceContract('fbs')
      .precedes({ tool: 'retrieve' }, { tool: 'answer' }, 'retrieve-then-answer', {
        order: 'finish-before-start',
      })
      .build()
    const overlapping = [
      tool('retrieve', { startedAt: 0, endedAt: 50 }),
      tool('answer', { startedAt: 10, endedAt: 60 }),
    ]
    // start-order would pass: retrieve started first. finish-before-start does not.
    expect(evaluateTraceContract(c, overlapping).valid).toBe(false)
    expect(
      evaluateTraceContract(c, [
        tool('retrieve', { startedAt: 0, endedAt: 10 }),
        tool('answer', { startedAt: 10, endedAt: 60 }),
      ]).valid,
    ).toBe(true)
    const noEnd = evaluateTraceContract(c, [
      tool('retrieve', { startedAt: 0 }),
      tool('answer', { startedAt: 10 }),
    ])
    expect(noEnd.violations[0]!.detail).toMatch(/has no endedAt/)
  })

  it('all-occurrences needs EVERY predecessor to end before each successor starts', () => {
    const c = traceContract('all')
      .precedes({ tool: 'lint' }, { tool: 'publish' }, 'lint-all-then-publish', {
        order: 'all-occurrences',
      })
      .build()
    const lateLint = [
      tool('lint', { startedAt: 0, endedAt: 5 }),
      tool('publish', { startedAt: 10, endedAt: 20 }),
      tool('lint', { startedAt: 12, endedAt: 15 }),
    ]
    const v = evaluateTraceContract(c, lateLint)
    expect(v.valid).toBe(false)
    expect(v.violations[0]!.detail).toMatch(/ends after span/)
    expect(evaluateTraceContract(c, lateLint.slice(0, 2)).valid).toBe(true)
  })

  it('rejects an unknown order mode', () => {
    expect(() =>
      traceContract('x').precedes({ tool: 'a' }, { tool: 'b' }, undefined, {
        order: 'first-occurrence' as never,
      }),
    ).toThrow(/order must be one of/)
  })
})

// ── statuses and the rule log ─────────────────────────────────────────

describe('rule statuses', () => {
  it('a rule whose predicate throws is an error, and the verdict is never valid', () => {
    const c = traceContract('boom')
      .eventually({ tool: 'search' }, 'searched')
      .never(
        {
          custom: () => {
            throw new Error('predicate exploded')
          },
        },
        'exploding',
      )
      .build()
    const v = evaluateTraceContract(c, [tool('search')])
    expect(v.status).toBe('error')
    expect(v.valid).toBe(false)
    expect(v.ruleExecutions).toEqual([
      { rule: 'searched', status: 'pass', violations: 0 },
      { rule: 'exploding', status: 'error', violations: 0, error: 'predicate exploded' },
    ])
    expect(v.errors).toEqual(['exploding: predicate exploded'])
    // An errored rule is absent from scores, never recorded as 0.
    expect(v.scores).toEqual({ searched: 1 })
    expect(checkTraceContracts([tool('search')], [c]).status).toBe('error')
  })

  it('the rule log lists every rule with its outcome', () => {
    const c = traceContract('log')
      .eventually({ tool: 'a' }, 'has-a')
      .never({ tool: 'b' }, 'no-b')
      .build()
    const v = evaluateTraceContract(c, [tool('a'), tool('b')])
    expect(v.ruleExecutions).toEqual([
      { rule: 'has-a', status: 'pass', violations: 0 },
      { rule: 'no-b', status: 'fail', violations: 1 },
    ])
  })
})

// ── counting, tokens, run, arguments ──────────────────────────────────

describe('atMost and tokensAtMost', () => {
  it('atMost counts matching calls', () => {
    const c = traceContract('budget').atMost({ tool: 'retrieve_policy' }, 1, 'one-retrieve').build()
    expect(evaluateTraceContract(c, [tool('retrieve_policy')]).valid).toBe(true)
    const v = evaluateTraceContract(c, [tool('retrieve_policy'), tool('retrieve_policy')])
    expect(v.valid).toBe(false)
    expect(v.violations[0]!.detail).toMatch(
      /2 span\(s\) match tool=retrieve_policy, over the limit of 1/,
    )
  })

  it('tokensAtMost sums typed fields and gen_ai attributes; an unknown count fails', () => {
    const c = traceContract('tokens').tokensAtMost({ kind: 'LLM' }, 100, 'token-budget').build()
    const typed = llm('turn-1', { inputTokens: 30, outputTokens: 20 })
    const attrs = llm('turn-2', {
      attributes: { 'gen_ai.usage.input_tokens': 25, 'gen_ai.usage.output_tokens': 25 },
    })
    expect(evaluateTraceContract(c, [typed, attrs]).valid).toBe(true)
    const over = evaluateTraceContract(c, [
      typed,
      attrs,
      llm('turn-3', { inputTokens: 1, outputTokens: 0 }),
    ])
    expect(over.violations[0]!.detail).toMatch(/101 tokens/)
    const unknown = evaluateTraceContract(c, [typed, llm('turn-3', { inputTokens: 5 })])
    expect(unknown.valid).toBe(false)
    expect(unknown.violations[0]!.detail).toMatch(/total is unknown/)
  })
})

describe('run rule', () => {
  it('reads an explicit run record', () => {
    const c = traceContract('run')
      .run({ requireCompleted: true, allowedStatuses: ['completed'], maxDurationMs: 100 })
      .build()
    const spans = [tool('a')]
    expect(
      evaluateTraceContract(c, spans, { run: { status: 'completed', startedAt: 0, endedAt: 50 } })
        .valid,
    ).toBe(true)
    const failed = evaluateTraceContract(c, spans, {
      run: { status: 'failed', startedAt: 0, endedAt: 500 },
    })
    expect(failed.violations.map((v) => v.detail)).toEqual([
      'run status failed is not one of completed',
      'run took 500 ms, over 100 ms',
    ])
    const running = evaluateTraceContract(c, spans, { run: { status: 'running', startedAt: 0 } })
    expect(running.violations[0]!.detail).toMatch(/did not reach a terminal status/)
  })

  it('derives the run from a single root span, and fails when there is no unique root', () => {
    const c = traceContract('run')
      .run({ allowedStatuses: ['completed'] })
      .build()
    const root = {
      spanId: 'r',
      name: 'agent',
      kind: 'agent',
      startedAt: 0,
      endedAt: 9,
      status: 'ok',
    }
    const child = tool('search', { parentSpanId: 'r' })
    expect(evaluateTraceContract(c, [root, child]).valid).toBe(true)
    const erroredRoot = evaluateTraceContract(c, [{ ...root, status: 'error' }, child])
    expect(erroredRoot.violations[0]!.detail).toBe('run status failed is not one of completed')
    const twoRoots = evaluateTraceContract(c, [tool('a'), tool('b')])
    expect(twoRoots.valid).toBe(false)
    expect(twoRoots.violations[0]!.detail).toMatch(/2 root spans and no run record/)
  })

  it('rejects typos in run statuses instead of widening the allowed set', () => {
    expect(() => traceContract('run').run({ allowedStatuses: ['succes' as never] })).toThrow(
      /unknown run status "succes"/,
    )
  })
})

describe('argument rule', () => {
  const refund = (args: unknown, extra: Partial<ContractSpan> = {}) =>
    tool('refund', { args, ...extra })

  it('checks a JSON Pointer inside typed args and JSON-string attributes', () => {
    const c = traceContract('args')
      .argument(
        { tool: 'refund' },
        { pointer: '/order/currency', check: { op: 'equals', value: 'USD' } },
      )
      .build()
    expect(evaluateTraceContract(c, [refund({ order: { currency: 'USD' } })]).valid).toBe(true)
    const fromAttr = tool('refund', {
      attributes: { 'input.value': JSON.stringify({ order: { currency: 'EUR' } }) },
    })
    const v = evaluateTraceContract(c, [fromAttr])
    expect(v.valid).toBe(false)
    // The detail names the type, never the customer value.
    expect(v.violations[0]!.detail).toMatch(/\/order\/currency \(a string\) does not equal/)
    expect(v.violations[0]!.detail).not.toMatch(/EUR/)
  })

  it('fails closed when argument evidence is missing or the call never happened', () => {
    const c = traceContract('args')
      .argument({ tool: 'refund' }, { pointer: '/amount', check: { op: 'type', type: 'number' } })
      .build()
    expect(
      evaluateTraceContract(c, [refund(undefined, { argsCaptured: false })]).violations[0]!.detail,
    ).toMatch(/not captured/)
    expect(evaluateTraceContract(c, [tool('refund')]).violations[0]!.detail).toMatch(
      /no argument evidence/,
    )
    expect(evaluateTraceContract(c, [tool('search')]).violations[0]!.detail).toMatch(
      /no span matches/,
    )
    expect(evaluateTraceContract(c, [refund({})]).violations[0]!.detail).toMatch(
      /\/amount is absent/,
    )
  })

  it('occurrence any passes when one call satisfies the check; all needs every call', () => {
    const spans = [refund({ amount: 'ten' }), refund({ amount: 10 })]
    const check = { pointer: '/amount', check: { op: 'type', type: 'number' } } as const
    expect(
      evaluateTraceContract(
        traceContract('x')
          .argument({ tool: 'refund' }, { ...check, occurrence: 'any' })
          .build(),
        spans,
      ).valid,
    ).toBe(true)
    expect(
      evaluateTraceContract(traceContract('x').argument({ tool: 'refund' }, check).build(), spans)
        .valid,
    ).toBe(false)
    expect(
      evaluateTraceContract(
        traceContract('x')
          .argument({ tool: 'refund' }, { ...check, occurrence: 'last' })
          .build(),
        spans,
      ).valid,
    ).toBe(true)
  })

  it('rejects a malformed pointer', () => {
    expect(() =>
      traceContract('x').argument(
        { tool: 'refund' },
        { pointer: 'amount', check: { op: 'exists' } },
      ),
    ).toThrow(/JSON Pointer/)
  })
})

// ── predicates: kind, model, oneOf, not ───────────────────────────────

describe('predicate fields', () => {
  it('kind reads eval kinds and OTLP-declared kinds alike', () => {
    expect(matchSpan(tool('x'), { kind: 'TOOL' })).toBe(true)
    expect(
      matchSpan({ name: 'x', attributes: { 'openinference.span.kind': 'TOOL' } }, { kind: 'TOOL' }),
    ).toBe(true)
    expect(matchSpan(llm('x'), { kind: 'TOOL' })).toBe(false)
  })

  it('an LLM span never satisfies a tool endpoint of the same name', () => {
    const c = traceContract('kinds').eventually({ kind: 'TOOL', name: 'generate_answer' }).build()
    expect(evaluateTraceContract(c, [llm('generate_answer')]).valid).toBe(false)
  })

  it('model, oneOf, and not compose into an allow-list', () => {
    const offList = { kind: 'LLM', not: { model: { oneOf: ['model-a', 'model-b'] } } } as const
    const c = traceContract('models').never(offList, 'allowed-models').build()
    expect(evaluateTraceContract(c, [llm('t', { model: 'model-a' })]).valid).toBe(true)
    expect(evaluateTraceContract(c, [llm('t', { model: 'model-z' })]).valid).toBe(false)
    // An LLM span with no recorded model is not on the list.
    expect(evaluateTraceContract(c, [llm('t')]).valid).toBe(false)
  })
})

// ── scope and alternatives ────────────────────────────────────────────

describe('scope', () => {
  const root = {
    spanId: 'root',
    name: 'supervisor',
    kind: 'agent',
    startedAt: 0,
    endedAt: 100,
    status: 'ok',
  }
  const researcher = {
    spanId: 'sub',
    parentSpanId: 'root',
    name: 'researcher',
    kind: 'agent',
    startedAt: 1,
    endedAt: 50,
    status: 'ok',
  }
  const inside = tool('search', { parentSpanId: 'sub' })
  const outside = tool('delete_db', { parentSpanId: 'root' })

  it('evaluates only the selected subtree, with its root as the run', () => {
    const c = traceContract('researcher')
      .scope({ kind: 'AGENT', name: 'researcher' })
      .never({ tool: 'delete_db' })
      .eventually({ tool: 'search' })
      .run({ maxDurationMs: 60 })
      .build()
    const v = evaluateTraceContract(c, [root, researcher, inside, outside])
    expect(v.valid).toBe(true)
  })

  it('an ambiguous or empty scope is an error for every rule', () => {
    const c = traceContract('scoped').scope({ kind: 'AGENT' }).never({ tool: 'delete_db' }).build()
    const v = evaluateTraceContract(c, [root, researcher, inside])
    expect(v.status).toBe('error')
    expect(v.errors[0]).toMatch(/matched 2 spans; exactly one is required/)
    const none = evaluateTraceContract(c, [inside])
    expect(none.status).toBe('error')
  })
})

describe('alternatives', () => {
  const c = traceContract('answer-path')
    .never({ tool: 'search_docs' }, 'no-search-docs')
    .alternative('retrieved', (b) => b.eventually({ tool: 'retrieve_policy' }, 'retrieved'))
    .alternative('cache-hit', (b) => b.eventually({ tool: 'policy_cache' }, 'cache-hit'))
    .build()

  it('passes when the base rules and at least one alternative pass', () => {
    expect(evaluateTraceContract(c, [tool('retrieve_policy')]).valid).toBe(true)
    expect(evaluateTraceContract(c, [tool('policy_cache')]).valid).toBe(true)
  })

  it('fails with every alternative’s violations when none passes', () => {
    const v = evaluateTraceContract(c, [tool('answer')])
    expect(v.valid).toBe(false)
    expect(v.scores).toEqual({ 'no-search-docs': 1, anyOf: 0 })
    expect(v.violations.map((x) => x.rule)).toEqual(['retrieved/retrieved', 'cache-hit/cache-hit'])
    expect(v.ruleExecutions.map((x) => [x.alternative, x.rule, x.status])).toEqual([
      [undefined, 'no-search-docs', 'pass'],
      ['retrieved', 'retrieved', 'fail'],
      ['cache-hit', 'cache-hit', 'fail'],
    ])
  })

  it('fails when a base rule fails even if an alternative passes', () => {
    expect(evaluateTraceContract(c, [tool('retrieve_policy'), tool('search_docs')]).valid).toBe(
      false,
    )
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
    expect(score.notes).toMatch(/never occurred/)
    const clean = await judge.score({
      artifact: { spans: [tool('approval'), tool('transfer')] },
      scenario,
      signal: new AbortController().signal,
    })
    expect(clean.composite).toBe(1)
    expect(clean.notes).toBe('all trace contracts satisfied')
  })

  it('throws instead of scoring when a contract cannot be evaluated', () => {
    const scoped = traceContract('scoped').scope({ name: 'missing' }).never({ tool: 'x' }).build()
    const judge = contractJudge<Artifact>([scoped], { spans: ({ artifact }) => artifact.spans })
    expect(() =>
      judge.score({
        artifact: { spans: [tool('a')] },
        scenario,
        signal: new AbortController().signal,
      }),
    ).toThrow(/could not be evaluated/)
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

describe('contract verdict certification', () => {
  it('every verdict is certified as an invariant check with the trace-contracts checker identity', () => {
    const c = traceContract('safety').never({ tool: 'rm' }).build()
    const v = evaluateTraceContract(c, [tool('ls'), tool('cat')])
    expect(v.certification?.strategy).toBe('invariant')
    expect(v.certification?.checker.name).toBe('agent-eval:trace-contracts')
    expect(v.certification?.checker.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(v.certification?.assumptions).toEqual([])
    expect(v.certification?.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names custom predicates as assumptions the certificate rests on', () => {
    const c = traceContract('ordering')
      .eventually(
        {
          custom: function hasErrorAttr(span) {
            return span.status === 'error'
          },
        },
        'saw-error',
      )
      .build()
    const untimed = [
      { spanId: 'a', name: 'x', status: 'error' },
      { spanId: 'b', name: 'y' },
    ] satisfies ContractSpan[]
    const v = evaluateTraceContract(c, untimed)
    expect(v.certification?.assumptions).toEqual([
      "rule 'saw-error' rests on a custom predicate function",
    ])
  })
})
