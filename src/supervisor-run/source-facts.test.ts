/**
 * Row accounting: a caller must always be able to tell "the run was empty" from
 * "the input was unreadable".
 *
 * The defect these tests pin: `agent-runtime`'s `FileSpawnJournal` writes
 * `{kind:'event', root, event:{...}}` envelopes, this parser read only the flat
 * dialect, and an enveloped journal therefore produced zero spawns, zero closes AND
 * zero invalid rows — a positive, false claim that nothing happened.
 */

import { describe, expect, it } from 'vitest'
import { fixtureSources } from './fixtures'
import { parseSupervisorTree, type SupervisorTreeFacts } from './source-facts'

const jsonl = (rows: readonly unknown[]): string =>
  `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`

const ROOT = 'run-1'
const CHILD = 'run-1:s0'

const flatEvents = [
  { kind: 'spawned', id: ROOT, label: 'root', seq: 0, at: '2026-07-31T16:58:28.103Z' },
  {
    kind: 'metered',
    id: ROOT,
    spend: { tokens: { input: 10, output: 20 }, usd: 0.5 },
    seq: 0,
    at: '2026-07-31T16:59:17.113Z',
  },
  {
    kind: 'spawned',
    id: CHILD,
    parent: ROOT,
    label: 'worker',
    seq: 0,
    at: '2026-07-31T16:59:17.120Z',
  },
  {
    kind: 'settled',
    id: CHILD,
    status: 'done',
    spent: { tokens: { input: 30, output: 40 }, usd: 1 },
    seq: 0,
    at: '2026-07-31T16:59:40.503Z',
  },
] as const

const enveloped = jsonl([
  { kind: 'begin', root: ROOT, at: '2026-07-31T16:58:28.095Z' },
  ...flatEvents.map((event) => ({ kind: 'event', root: ROOT, event })),
])

const unwrapped = jsonl(flatEvents)

/** Every non-empty line lands in exactly one bucket — the invariant that makes the
 *  counts trustworthy rather than merely present. `journalMeteredRows` is the bucket, not
 *  `brain.meteredCount`: the brain sums only root-attributed metered rows. */
function accountedRows(facts: SupervisorTreeFacts): number {
  const ignored = Object.values(facts.journalIgnoredRowsByKind).reduce((a, b) => a + b, 0)
  return (
    facts.spawns.length +
    facts.closes.length +
    facts.journalMeteredRows +
    ignored +
    facts.journalInvalidRows
  )
}

const parse = (journal: string): SupervisorTreeFacts =>
  parseSupervisorTree(fixtureSources({ journal }))

describe('parseSupervisorTree journal dialects', () => {
  it('reads the runtime envelope agent-runtime writes, and records that dialect', () => {
    const facts = parse(enveloped)

    expect(facts.rootId).toBe(ROOT)
    expect(facts.spawns).toHaveLength(2)
    expect(facts.closes).toHaveLength(1)
    expect(facts.brain.meteredCount).toBe(1)
    expect(facts.journalDialect).toBe('runtime-envelope')
    // The `begin` header is understood, not folded into the tree — and it says so.
    expect(facts.journalIgnoredRowsByKind).toEqual({ begin: 1 })
    expect(facts.journalInvalidRows).toBe(0)
    expect(facts.journalRows).toBe(5)
    expect(accountedRows(facts)).toBe(facts.journalRows)
  })

  it('reads the flat dialect identically and reports it as flat', () => {
    const facts = parse(unwrapped)

    expect(facts.rootId).toBe(ROOT)
    expect(facts.spawns).toHaveLength(2)
    expect(facts.closes).toHaveLength(1)
    expect(facts.brain.meteredCount).toBe(1)
    expect(facts.journalDialect).toBe('flat')
    expect(facts.journalIgnoredRowsByKind).toEqual({})
    expect(facts.journalInvalidRows).toBe(0)
    expect(facts.journalRows).toBe(4)
    expect(accountedRows(facts)).toBe(facts.journalRows)
  })

  it('produces the same tree from either dialect', () => {
    const fromEnvelope = parse(enveloped)
    const fromFlat = parse(unwrapped)

    expect(fromEnvelope.spawns.map((s) => [s.id, s.parent, s.role])).toEqual(
      fromFlat.spawns.map((s) => [s.id, s.parent, s.role]),
    )
    expect(fromEnvelope.closes.map((c) => [c.id, c.status, c.spend.tokens.input])).toEqual(
      fromFlat.closes.map((c) => [c.id, c.status, c.spend.tokens.input]),
    )
    expect(fromEnvelope.brain.tokensIn).toBe(fromFlat.brain.tokensIn)
    expect(fromEnvelope.brain.usd).toBe(fromFlat.brain.usd)
  })

  it('reads a mixed journal fully and reports the shape disagreement', () => {
    const mixed = jsonl([
      { kind: 'begin', root: ROOT, at: '2026-07-31T16:58:28.095Z' },
      { kind: 'event', root: ROOT, event: flatEvents[0] },
      flatEvents[1],
      { kind: 'event', root: ROOT, event: flatEvents[2] },
      flatEvents[3],
    ])
    const facts = parse(mixed)

    expect(facts.rootId).toBe(ROOT)
    expect(facts.spawns).toHaveLength(2)
    expect(facts.closes).toHaveLength(1)
    expect(facts.brain.meteredCount).toBe(1)
    expect(facts.journalDialect).toBe('mixed')
    expect(facts.journalInvalidRows).toBe(0)
    expect(facts.journalRows).toBe(5)
    expect(accountedRows(facts)).toBe(facts.journalRows)
  })

  it('calls a garbage journal unreadable rather than empty', () => {
    const garbage = [
      'not json at all',
      '{"kind":"spawned","id":"truncated"',
      JSON.stringify(['an', 'array']),
      JSON.stringify({ noKindAtAll: true }),
      JSON.stringify({ kind: 'some-other-log-line', message: 'hi' }),
      JSON.stringify({ kind: 'event', root: ROOT, event: 'not an object' }),
    ].join('\n')
    const facts = parse(`${garbage}\n`)

    expect(facts.spawns).toHaveLength(0)
    expect(facts.closes).toHaveLength(0)
    expect(facts.brain.meteredCount).toBe(0)
    expect(facts.rootId).toBeNull()
    // Six rows read, none understood — the opposite claim from an empty run.
    expect(facts.journalRows).toBe(6)
    expect(facts.journalInvalidRows).toBe(6)
    expect(facts.journalMalformedJsonRows).toBe(3)
    expect(facts.journalDialect).toBe('none')
    expect(accountedRows(facts)).toBe(facts.journalRows)
  })

  it('a genuinely empty journal is distinguishable from an unreadable one', () => {
    const facts = parse('')

    expect(facts.spawns).toHaveLength(0)
    expect(facts.journalRows).toBe(0)
    expect(facts.journalInvalidRows).toBe(0)
    expect(facts.journalDialect).toBe('none')

    const unreadable = parse(`${JSON.stringify({ kind: 'nonsense' })}\n`)
    expect(unreadable.spawns).toHaveLength(0)
    expect(unreadable.journalRows).toBe(1)
    // Same zero spawns; different, and correct, story about why.
    expect(unreadable.journalInvalidRows).toBe(1)
  })

  it('counts recognized-but-unmodelled wait events by kind instead of dropping them', () => {
    const waits = jsonl([
      { kind: 'begin', root: ROOT, at: '2026-07-31T16:58:28.095Z' },
      { kind: 'event', root: ROOT, event: flatEvents[0] },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'waiting',
          id: `${ROOT}:w0`,
          parent: ROOT,
          label: 'wait',
          seq: 1,
          at: '2026-07-31T16:58:30.000Z',
        },
      },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'woken',
          id: `${ROOT}:w0`,
          by: 'fired',
          seq: 1,
          at: '2026-07-31T16:58:31.000Z',
        },
      },
    ])
    const facts = parse(waits)

    expect(facts.spawns).toHaveLength(1)
    expect(facts.journalIgnoredRowsByKind).toEqual({ begin: 1, waiting: 1, woken: 1 })
    // Understood but not modeled is not the same claim as malformed.
    expect(facts.journalInvalidRows).toBe(0)
    expect(accountedRows(facts)).toBe(facts.journalRows)
  })

  it('keeps a non-root metered row accounted without folding it into the brain', () => {
    const nested = jsonl([
      ...flatEvents,
      {
        kind: 'metered',
        id: CHILD,
        spend: { tokens: { input: 7, output: 8 }, usd: 0.1 },
        seq: 1,
        at: '2026-07-31T16:59:41.000Z',
      },
    ])
    const facts = parse(nested)

    expect(facts.journalMeteredRows).toBe(2)
    // A non-root node's metered spend reaches this tree through its settled close, so the
    // brain sums only the root's rows — the same tokens are never counted twice.
    expect(facts.brain.meteredCount).toBe(1)
    expect(facts.brain.tokensIn).toBe(10)
    expect(facts.brain.usd).toBe(0.5)
    expect(accountedRows(facts)).toBe(facts.journalRows)
  })
})

/**
 * The exact bytes `agent-runtime`'s `FileSpawnJournal` wrote for a real recursive run
 * (`discovery-lab/runs/proof-recursive-child-20260731g/spawn-journal.jsonl`, 2026-07-31).
 * Pinned here because the regression must be held against real writer output, not only
 * against a fixture written by the same hand that wrote the parser.
 *
 * Before the fix this input produced `{spawns: 0, closes: 0, journalInvalidRows: 0,
 * rootId: null}` — a false claim that the run was empty.
 */
const REAL_RUNTIME_JOURNAL = [
  '{"kind":"begin","root":"proof-recursive-child-20260731g","at":"2026-07-31T16:58:28.095Z"}',
  '{"kind":"event","root":"proof-recursive-child-20260731g","event":{"kind":"spawned","id":"proof-recursive-child-20260731g","label":"root","budget":{"maxIterations":12,"maxTokens":400000,"maxUsd":2,"deadlineMs":900000},"runtime":"inline","seq":0,"at":"2026-07-31T16:58:28.103Z"}}',
  '{"kind":"event","root":"proof-recursive-child-20260731g","event":{"kind":"metered","id":"proof-recursive-child-20260731g","spend":{"iterations":0,"tokens":{"input":3265,"output":3818},"usd":0.010358599999999999,"ms":0},"seq":0,"at":"2026-07-31T16:59:17.113Z"}}',
  '{"kind":"event","root":"proof-recursive-child-20260731g","event":{"kind":"spawned","id":"proof-recursive-child-20260731g:s0","parent":"proof-recursive-child-20260731g","label":"worker","budget":{"maxIterations":6,"maxTokens":8000},"runtime":"pi","seq":0,"at":"2026-07-31T16:59:17.120Z"}}',
  '{"kind":"event","root":"proof-recursive-child-20260731g","event":{"kind":"metered","id":"proof-recursive-child-20260731g","spend":{"iterations":0,"tokens":{"input":4013,"output":32},"usd":0.0024782,"ms":0},"seq":1,"at":"2026-07-31T16:59:22.679Z"}}',
  '{"kind":"event","root":"proof-recursive-child-20260731g","event":{"kind":"settled","id":"proof-recursive-child-20260731g:s0","status":"down","spent":{"iterations":2,"tokens":{"input":31211,"output":990},"usd":0,"usdKnown":false,"ms":0},"infra":false,"seq":0,"at":"2026-07-31T16:59:40.503Z"}}',
  '{"kind":"event","root":"proof-recursive-child-20260731g","event":{"kind":"metered","id":"proof-recursive-child-20260731g","spend":{"iterations":0,"tokens":{"input":4106,"output":39},"usd":0.0025494,"ms":0},"seq":2,"at":"2026-07-31T16:59:43.384Z"}}',
].join('\n')

describe('parseSupervisorTree on a journal agent-runtime actually wrote', () => {
  it('recovers the tree that a hand-unwrapped copy of the same file yields', () => {
    const facts = parse(`${REAL_RUNTIME_JOURNAL}\n`)

    expect(facts.journalDialect).toBe('runtime-envelope')
    expect(facts.rootId).toBe('proof-recursive-child-20260731g')
    expect(facts.spawns.map((s) => s.id)).toEqual([
      'proof-recursive-child-20260731g',
      'proof-recursive-child-20260731g:s0',
    ])
    expect(facts.workerSpawns.map((s) => s.id)).toEqual(['proof-recursive-child-20260731g:s0'])
    expect(facts.closes.map((c) => [c.id, c.status])).toEqual([
      ['proof-recursive-child-20260731g:s0', 'down'],
    ])
    expect(facts.brain.meteredCount).toBe(3)
    expect(facts.brain.tokensIn).toBe(11384)
    expect(facts.brain.tokensOut).toBe(3889)
    expect(facts.journalRows).toBe(7)
    expect(facts.journalInvalidRows).toBe(0)
    expect(facts.journalIgnoredRowsByKind).toEqual({ begin: 1 })
    expect(accountedRows(facts)).toBe(facts.journalRows)

    // Same file with the envelopes stripped by hand: the tree must be identical.
    const unwrapped = REAL_RUNTIME_JOURNAL.split('\n')
      .map((line) => JSON.parse(line) as { kind: string; event?: unknown })
      .filter((record) => record.kind === 'event')
      .map((record) => JSON.stringify(record.event))
      .join('\n')
    const hand = parse(`${unwrapped}\n`)

    expect(hand.journalDialect).toBe('flat')
    expect(hand.rootId).toBe(facts.rootId)
    expect(hand.spawns.map((s) => s.id)).toEqual(facts.spawns.map((s) => s.id))
    expect(hand.closes.map((c) => c.id)).toEqual(facts.closes.map((c) => c.id))
    expect(hand.brain).toEqual(facts.brain)
  })
})
