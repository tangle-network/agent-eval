import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  analyzeSupervisorRunSources,
  parseSupervisorTree,
  readRuntimeSupervisorRun,
  type SupervisorRunSources,
  type SupervisorTreeFacts,
} from '../../src/supervisor-run/index'

type Row = Record<string, unknown>
const ROOT = 'group-proof-root'
const AT = '2026-10-22T00:00:00.000Z'
const BEGIN = { kind: 'begin', root: ROOT, at: AT }
const directories: string[] = []
const jsonl = (rows: readonly unknown[]): string =>
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
const envelope = (event: Row, root = ROOT): Row => ({ kind: 'event', root, event })
const group = (events: readonly unknown[], root = ROOT): Row => ({ kind: 'events', root, events })
const spawn = (id: string, parent: string | null): Row => ({
  kind: 'spawned',
  id,
  parent,
  label: id,
  role: parent === null ? 'supervisor' : 'worker',
  runtime: 'inline',
  at: AT,
})
const SPEND = {
  tokens: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, cacheBreakdownKnown: false },
  tokensKnown: false,
  usd: 0,
  usdKnown: false,
  resources: { compute: { unit: 'millisecond', amount: 7, known: false } },
}
const EVENTS = [
  spawn(ROOT, null),
  spawn(`${ROOT}:a`, ROOT),
  { kind: 'metered', id: ROOT, spend: SPEND, at: AT },
  { kind: 'waiting', id: `${ROOT}:wait`, at: AT },
  spawn(`${ROOT}:b`, ROOT),
  { kind: 'settled', id: `${ROOT}:b`, status: 'done', spent: SPEND, at: AT },
  { kind: 'settled', id: `${ROOT}:a`, status: 'done', spent: SPEND, at: AT },
]

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeRun(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-event-group-integration-'))
  directories.push(dir)
  await writeFile(join(dir, 'spawn-journal.jsonl'), text)
  return dir
}

async function directTree(dir: string, source: SupervisorRunSources): Promise<SupervisorTreeFacts> {
  return parseSupervisorTree({
    ...source,
    journal: await readFile(join(dir, 'spawn-journal.jsonl'), 'utf8'),
  })
}

// Physical rows and evidence paths differ between layouts; the retained tree and spend do not.
function semanticTree(tree: SupervisorTreeFacts): unknown {
  return {
    rootId: tree.rootId,
    spawns: tree.spawns.map(({ sourceRow: _sourceRow, ...spawn }) => spawn),
    closes: tree.closes,
    brain: tree.brain,
    resources: tree.resourceRecords?.map(({ source: _source, ...record }) => record),
    firstEventAt: tree.firstEventAt,
    lastEventAt: tree.lastEventAt,
  }
}

describe('Runtime event groups through public file-reader and analyzer APIs', () => {
  it('preserves root, children, spend, member order and physical resource provenance', async () => {
    const legacyDir = await writeRun(jsonl([BEGIN, ...EVENTS.map((event) => envelope(event))]))
    const groupedDir = await writeRun(
      `\n${jsonl([
        BEGIN,
        group(EVENTS.slice(0, 4)),
        envelope(EVENTS[4]!),
        group(EVENTS.slice(5)),
      ])}\n`,
    )
    const flatDir = await writeRun(jsonl(EVENTS))
    const legacy = await readRuntimeSupervisorRun(legacyDir)
    const grouped = await readRuntimeSupervisorRun(groupedDir)
    const groupedTree = await directTree(groupedDir, grouped)
    const legacyTree = await directTree(legacyDir, legacy)
    const flatTree = await directTree(flatDir, legacy)

    expect(semanticTree(groupedTree)).toEqual(semanticTree(legacyTree))
    expect(semanticTree(groupedTree)).toEqual(semanticTree(flatTree))
    expect(semanticTree(parseSupervisorTree(grouped))).toEqual(semanticTree(groupedTree))
    expect(grouped.workers?.map((worker) => worker.workerId)).toEqual([`${ROOT}:a`, `${ROOT}:b`])
    expect(groupedTree.spawns.map((row) => [row.id, row.sourceRow])).toEqual([
      [ROOT, 1],
      [`${ROOT}:a`, 1],
      [`${ROOT}:b`, 2],
    ])
    expect(groupedTree.closes.map((row) => row.id)).toEqual([`${ROOT}:b`, `${ROOT}:a`])
    expect(groupedTree).toMatchObject({
      journalRows: 4,
      journalInvalidRows: 0,
      journalMalformedJsonRows: 0,
      journalMeteredRows: 1,
      journalDialect: 'runtime-envelope',
      journalIgnoredRowsByKind: { begin: 1, waiting: 1 },
      brain: { meteredCount: 1, tokensKnownCount: 0, tokensUnknownCount: 1, usdUnknownCount: 1 },
    })
    expect(legacyTree.journalRows).toBe(EVENTS.length + 1)
    expect(flatTree.journalRows).toBe(EVENTS.length)
    expect(flatTree.journalDialect).toBe('flat')
    expect(groupedTree.resourceRecords?.map((record) => record.source)).toEqual([
      'journal.rows[1].events[2].spend.resources',
      'journal.rows[3].events[0].spent.resources',
      'journal.rows[3].events[1].spent.resources',
    ])
    expect(groupedTree.closes[0]?.spend).toMatchObject({
      tokensKnown: false,
      usdKnown: false,
      tokens: { breakdownKnown: false },
      resources: [{ name: 'compute', unit: 'millisecond', amount: 7, known: false }],
    })
    const normalizedEvents = (grouped.journal ?? '')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event: Row }).event)
    expect(normalizedEvents.map((event) => event.kind)).toEqual(EVENTS.map((event) => event.kind))
    expect(normalizedEvents[2]?.spend).toEqual(SPEND)
    expect(normalizedEvents[5]?.spent).toEqual(SPEND)
  })

  it.each(['runtime-run-winner', 'runtime-run-mixed-usd', 'runtime-named-resources'])(
    'replays retained %s with grouped writes and unchanged measured outcomes',
    async (fixture) => {
      const fixtureDir = join(process.cwd(), 'tests/fixtures/supervisor-run', fixture)
      const original = await readRuntimeSupervisorRun(fixtureDir)
      const raw = await readFile(join(fixtureDir, 'spawn-journal.jsonl'), 'utf8')
      const rows = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Row)
      const begin = rows[0]!
      const events = rows.slice(1).map((row) => row.event as Row)
      const transformed = jsonl([
        begin,
        group(events.slice(0, 2), begin.root as string),
        group([], begin.root as string),
        group(events.slice(2), begin.root as string),
      ])
      const dir = await writeRun(transformed)
      await writeFile(
        join(dir, 'result.json'),
        await readFile(join(fixtureDir, 'result.json'), 'utf8'),
      )
      const source = await readRuntimeSupervisorRun(dir)
      expect(source.instanceId).toBe(original.instanceId)
      expect(source.workers?.map((worker) => worker.workerId)).toEqual(
        original.workers?.map((worker) => worker.workerId),
      )
      expect(semanticTree(parseSupervisorTree(source))).toEqual(
        semanticTree(parseSupervisorTree(original)),
      )
      const direct = await directTree(dir, source)
      expect(direct).toMatchObject({
        journalRows: 4,
        journalInvalidRows: 0,
        journalIgnoredRowsByKind: { begin: 1, events: 1 },
      })
      expect(direct.brain).toEqual(parseSupervisorTree(source).brain)
      expect(direct.closes).toEqual(parseSupervisorTree(source).closes)
      const report = analyzeSupervisorRunSources(source)
      const baseline = analyzeSupervisorRunSources(original)
      expect(report.economics.brain).toEqual(baseline.economics.brain)
      expect(report.economics.workers).toEqual(baseline.economics.workers)
      expect(report.economics.totalUsd).toEqual(baseline.economics.totalUsd)
      expect(report.outcome).toEqual(baseline.outcome)
    },
  )

  const invalidGroups = [
    { label: 'null member', row: group([EVENTS[0], null]) },
    { label: 'array member', row: group([EVENTS[0], []]) },
    { label: 'missing kind member', row: group([EVENTS[0], {}]) },
    { label: 'empty kind member', row: group([EVENTS[0], { kind: '' }]) },
    { label: 'non-string kind member', row: group([EVENTS[0], { kind: 12 }]) },
    { label: 'several malformed members', row: group([EVENTS[0], null, [], {}]) },
    { label: 'missing events', row: { kind: 'events', root: ROOT } },
    { label: 'null events', row: { kind: 'events', root: ROOT, events: null } },
    { label: 'object events', row: { kind: 'events', root: ROOT, events: {} } },
    { label: 'missing root', row: { kind: 'events', events: [EVENTS[0]] } },
    { label: 'empty root', row: group([EVENTS[0]], '') },
    { label: 'non-string root', row: { kind: 'events', root: 1, events: [EVENTS[0]] } },
  ]

  it.each(invalidGroups)(
    'rejects $label atomically as one physical invalid row',
    async ({ row }) => {
      const dir = await writeRun(jsonl([BEGIN, envelope(EVENTS[0]!)]))
      const base = await readRuntimeSupervisorRun(dir)
      await writeFile(join(dir, 'spawn-journal.jsonl'), jsonl([BEGIN, row]))
      const direct = await directTree(dir, base)
      expect(direct).toMatchObject({
        rootId: null,
        spawns: [],
        closes: [],
        journalRows: 2,
        journalInvalidRows: 1,
        journalMalformedJsonRows: 0,
        journalMeteredRows: 0,
      })
      expect(direct.resourceRecords).toEqual([])
      await expect(readRuntimeSupervisorRun(dir)).rejects.toThrow(
        /spawn-journal\.jsonl:2: invalid Runtime spawn journal/,
      )
    },
  )

  it('does not consume any prefix when a later member corrupts spawn, spend and close', async () => {
    const dir = await writeRun(jsonl([BEGIN, envelope(EVENTS[0]!)]))
    const base = await readRuntimeSupervisorRun(dir)
    await writeFile(join(dir, 'spawn-journal.jsonl'), jsonl([BEGIN, group([...EVENTS, null])]))
    const direct = await directTree(dir, base)
    expect(direct).toMatchObject({
      rootId: null,
      spawns: [],
      closes: [],
      journalInvalidRows: 1,
      journalMeteredRows: 0,
      brain: { meteredCount: 0 },
    })
    expect(direct.resourceRecords).toEqual([])
    await expect(readRuntimeSupervisorRun(dir)).rejects.toThrow(/invalid Runtime spawn journal/)
  })

  it('never recovers a valid event prefix from torn JSON and retains parsed-object sourceRow', async () => {
    const dir = await writeRun(jsonl([BEGIN, envelope(EVENTS[0]!)]))
    const base = await readRuntimeSupervisorRun(dir)
    const torn = JSON.stringify(group(EVENTS)).slice(0, -2)
    await writeFile(join(dir, 'spawn-journal.jsonl'), `${jsonl([BEGIN])}${torn}\n`)
    const corrupt = await directTree(dir, base)
    expect(corrupt).toMatchObject({
      spawns: [],
      closes: [],
      journalRows: 2,
      journalInvalidRows: 1,
      journalMalformedJsonRows: 1,
      journalMeteredRows: 0,
    })
    await expect(readRuntimeSupervisorRun(dir)).rejects.toThrow(/line is not JSON/)
    await writeFile(join(dir, 'spawn-journal.jsonl'), `${torn}\n\n${jsonl([BEGIN, group(EVENTS)])}`)
    const recovered = await directTree(dir, base)
    expect(recovered.journalRows).toBe(3)
    expect(recovered.journalInvalidRows).toBe(1)
    expect(recovered.spawns.map((row) => row.sourceRow)).toEqual([1, 1, 1])
    expect(recovered.resourceRecords?.[0]?.source).toBe('journal.rows[1].events[2].spend.resources')
  })

  it('accepts an empty group after begin, counts it once, and keeps unknown event kinds', async () => {
    const dir = await writeRun(
      jsonl([BEGIN, group([]), group([{ kind: 'future-runtime-event', id: ROOT }, EVENTS[0]!])]),
    )
    const source = await readRuntimeSupervisorRun(dir)
    const direct = await directTree(dir, source)
    expect(direct).toMatchObject({
      rootId: ROOT,
      journalRows: 3,
      journalInvalidRows: 0,
      journalIgnoredRowsByKind: { begin: 1, events: 1, 'future-runtime-event': 1 },
    })
    expect(direct.spawns).toHaveLength(1)
    expect(parseSupervisorTree(source).spawns).toHaveLength(1)
  })

  it.each([{ events: [] }, { events: [EVENTS[0]!] }])(
    'requires begin before a group containing $events',
    async ({ events }) => {
      const dir = await writeRun(jsonl([group(events), BEGIN]))
      await expect(readRuntimeSupervisorRun(dir)).rejects.toThrow(/precedes begin/)
    },
  )

  it('normalizes nested grouped trees exactly like legacy envelopes in source order', async () => {
    const nested = `${ROOT}/driver`
    const child = `${ROOT}:driver`
    const leaf = `${child}:leaf`
    const topEvents = [
      spawn(ROOT, null),
      { ...spawn(child, ROOT), role: 'supervisor', ownedTreeRoot: nested },
    ]
    const nestedEvents = [
      { ...spawn(child, null), role: 'supervisor' },
      spawn(leaf, child),
      { kind: 'metered', id: child, spend: SPEND, at: AT },
      { kind: 'settled', id: leaf, status: 'done', spent: SPEND, at: AT },
    ]
    const close = { kind: 'settled', id: child, status: 'done', spent: SPEND, at: AT }
    const legacyDir = await writeRun(
      jsonl([
        BEGIN,
        ...topEvents.map((event) => envelope(event)),
        { ...BEGIN, root: nested },
        ...nestedEvents.map((event) => envelope(event, nested)),
        envelope(close),
      ]),
    )
    const groupedDir = await writeRun(
      jsonl([
        BEGIN,
        group(topEvents),
        { ...BEGIN, root: nested },
        group(nestedEvents, nested),
        group([close]),
      ]),
    )
    const legacy = await readRuntimeSupervisorRun(legacyDir)
    const grouped = await readRuntimeSupervisorRun(groupedDir)
    expect(semanticTree(parseSupervisorTree(grouped))).toEqual(
      semanticTree(parseSupervisorTree(legacy)),
    )
    expect(
      parseSupervisorTree(grouped).spawns.map((row) => [row.id, row.parent, row.role]),
    ).toEqual([
      [ROOT, null, 'supervisor'],
      [child, ROOT, 'supervisor'],
      [leaf, child, 'worker'],
    ])
    expect(grouped.workers?.map((worker) => worker.workerId)).toEqual([child, leaf])
    expect(parseSupervisorTree(grouped).closes.map((row) => row.id)).toEqual([leaf, child])
    expect(parseSupervisorTree(grouped).brain.meteredCount).toBe(0)
    expect(parseSupervisorTree(grouped).journalMeteredRows).toBe(1)
  })
})
