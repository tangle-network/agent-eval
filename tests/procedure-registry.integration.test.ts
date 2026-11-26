/**
 * The procedure registry over real search ledgers and real Claude Code
 * transcripts, through the command the package ships.
 *
 * Two searches are written with the ledger recorder. Search A starts from skill
 * text V1 and improves it to V2, then to a V3 that is pruned; search B starts
 * from V2 again, so the registry holds V2 once, with both searches on it. The
 * ledger nodes hold the text; the caller says which skill version a node is by
 * hashing it, as a product that mounts a skill into a profile would.
 *
 * Five sessions are written as transcripts:
 *
 * | Session | What it records |
 * |---|---|
 * | S1 | `tidy` at V1, a pull request opened, another merged by number, and a subagent that also runs `tidy` at V1 |
 * | S2 | `tidy` at V2, a pull request opened, and `audit`, which recorded no loaded text |
 * | S3 | `tidy` at V1 and no change |
 * | S4 | `tidy` at V1; a `gh pr create` that failed, so it produced no change |
 * | S5 | `audit` and a pull request in a repository nobody supplied an outcome for |
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openSearchLedger, replaySearchLedgerText } from '../src/campaign/search-ledger'
import { SearchRecorder, surfaceNode } from '../src/campaign/search-ledger-recording'
import type { SearchCostAccounting } from '../src/campaign/search-ledger-types'
import { hashCanonical } from '../src/ledger-core/canonical'
import {
  buildProcedureRegistry,
  type ChangeOutcome,
  type ProcedureRegistry,
  type ProcedureVersion,
  runProcedureRegistryCommand,
} from '../src/procedure-registry'
import {
  claudeCodeSkillSessions,
  type SkillSessionRead,
  type SkillSessionRecord,
} from '../src/skill-usage'
import { skillBodySha256 } from '../src/skill-usage/skill-file'

const SOURCE = { uri: 'test:procedure-registry', revision: hashCanonical('procedure-registry') }
const V1 = '# Tidy\n\nRemove dead code.'
const V2 = '# Tidy\n\nRemove dead code and duplicated logic.'
const V3 = '# Tidy\n\nRewrite everything.'
const digestOf = (text: string): string => `sha256:${skillBodySha256(text)}`

let root: string
let projects: string
let ledgerA: string
let ledgerB: string
let outcomesFile: string

interface Turn {
  tool: string
  input: Record<string, unknown>
  result?: string
  failed?: boolean
  /** The text the harness loaded for a `Skill` call. */
  loaded?: string
}

/** One transcript: a user request, then each turn as a tool call, its result and, for a skill, its loaded text. */
function transcript(
  sessionId: string,
  turns: readonly Turn[],
  subagent: { agentId: string } | null = null,
): string {
  const lines: unknown[] = []
  const owner = subagent?.agentId ?? sessionId
  let previous: string | null = null
  let tick = 0
  const at = (): string =>
    new Date(Date.parse('2026-11-10T10:00:00Z') + 60_000 * tick++).toISOString()
  const base = (type: string, uuid: string, message: unknown, extra: object = {}): unknown => {
    const line = {
      parentUuid: previous,
      isSidechain: subagent !== null,
      userType: 'external',
      cwd: '/work/app',
      sessionId,
      version: '0.0.0-fixture',
      type,
      uuid,
      timestamp: at(),
      message,
      ...(subagent === null ? {} : { agentId: subagent.agentId }),
      ...extra,
    }
    previous = uuid
    return line
  }
  lines.push(base('user', `${owner}-u0`, { role: 'user', content: 'Fixture request.' }))
  turns.forEach((turn, index) => {
    const id = `toolu_${owner}_${index}`
    lines.push(
      base('assistant', `${owner}-a${index}`, {
        id: `msg_${owner}_${index}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id, name: turn.tool, input: turn.input }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      base('user', `${owner}-r${index}`, {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: turn.result ?? 'ok',
            ...(turn.failed === true ? { is_error: true } : {}),
          },
        ],
      }),
    )
    if (turn.loaded !== undefined) {
      lines.push(
        base(
          'user',
          `${owner}-l${index}`,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Base directory for this skill: /skills/${String(turn.input.skill)}\n\n${turn.loaded}`,
              },
            ],
          },
          { isMeta: true, sourceToolUseID: id },
        ),
      )
    }
  })
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

const skill = (name: string, loaded?: string): Turn => ({
  tool: 'Skill',
  input: { skill: name },
  ...(loaded === undefined ? {} : { loaded }),
})
const bash = (command: string, result: string, failed = false): Turn => ({
  tool: 'Bash',
  input: { command },
  result,
  failed,
})

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** The skill text each ledger node holds, by search and node: what a product that mounts a skill into a profile knows. */
const nodeText = new Map<string, string>()

async function writeSearch(
  path: string,
  searchId: string,
  skillTexts: readonly string[],
  tokens: 'known' | 'unknown',
  cost: SearchCostAccounting = { status: 'known', usd: 0.25, source: 'provider' },
): Promise<void> {
  const tasks = ['t0', 't1'].map((taskId) => ({
    taskId,
    unitId: taskId,
    source: { uri: `test://${taskId}`, revision: SOURCE.revision },
  }))
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({ path, searchId }),
      now: () => (clock += 1000),
    },
    {
      subject: 'test/skill',
      process: { name: 'procedure-registry-test', executionRef: SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction: 'maximize',
        judge: SOURCE,
        claim: {
          population: { id: 'procedure-registry', description: 'two synthetic units' },
          samplingFrame: 'both units',
          independentUnit: 'id',
          generalization: 'new-units',
          use: 'comparison',
          minimumEffect: 0.2,
        },
      },
      splits: { train: tasks, selection: [], test: [], heldOutUnits: false },
      policy: { expansion: 'incumbent', allocation: 'uniform', seed: 1 },
      budget: {
        maxUsd: null,
        maxCells: null,
        maxNodes: 4,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: { provider: 'test', alias: 'test', unknown: 'no model' },
        agent: SOURCE,
        benchmark: { uri: 'test://tasks', revision: SOURCE.revision },
      },
    },
  )
  let parent: string | null = null
  for (const [index, text] of skillTexts.entries()) {
    const { nodeId } = await recorder.registerNode(surfaceNode(recorder, text))
    nodeText.set(`${searchId}:${nodeId}`, text)
    await recorder.recordEdge({
      childNodeId: nodeId,
      parents: parent === null ? [] : [parent],
      operator: parent === null ? 'seed' : 'improve',
      attribution: 'explicit',
      proposer:
        parent === null
          ? null
          : { kind: 'optimizer', name: 'test-proposer', operationId: null, source: SOURCE },
      proposalKey: `gen-${index}`,
      rationale: parent === null ? { unknown: 'the starting text' } : 'tighter wording',
      diffs: parent === null ? [] : [{ unknown: 'not recorded' }],
    })
    for (const task of tasks) {
      const cellId = await recorder.allocateCell({
        nodeId,
        taskId: task.taskId,
        split: 'train',
        rep: 0,
        stage: parent === null ? 'root' : 'train',
      })
      await recorder.settleCell({
        cellId,
        outcome: { status: 'passed', score: 0.5 + 0.1 * index, metrics: {} },
        accounting: {
          tokens:
            tokens === 'known'
              ? { status: 'known', inputTokens: 1000, outputTokens: 200, cachedTokens: 300 }
              : { status: 'unknown', reason: 'the lane reports no tokens' },
          cost,
        },
        wallMs: tokens === 'known' ? 4000 : null,
        identity: {
          model: { provider: 'test', alias: 'test', unknown: 'no model' },
          agent: SOURCE,
          benchmark: { uri: 'test://tasks', revision: SOURCE.revision },
        },
      })
    }
    // V2 beat V1 and advances; V3 is worse and is pruned.
    if (index === 1) {
      await recorder.decideNode({
        nodeId,
        decision: { status: 'advanced', rung: 1 },
        rule: 'test-rule',
        reason: 'beat its parent',
      })
    } else if (index === 2) {
      await recorder.decideNode({
        nodeId,
        decision: { status: 'pruned' },
        rule: 'test-rule',
        reason: 'worse than its parent',
      })
    }
    parent = nodeId
  }
}

const outcomes: ChangeOutcome[] = [
  // Merged, red on its first gate run, and fixed within the week.
  {
    ref: 'acme/widgets#7',
    merged: true,
    gateGreenFirstTry: false,
    hotfixed: true,
    hotfixWindowDays: 7,
  },
  // Merged, and the week passed with no fix; the gate result is not known.
  {
    ref: 'acme/gadgets#8',
    merged: true,
    gateGreenFirstTry: null,
    hotfixed: false,
    hotfixWindowDays: 7,
  },
  // Judged over 14 days: its "no fix" is not the 7-day claim, so it reads as unknown.
  {
    ref: 'acme/widgets#9',
    merged: true,
    gateGreenFirstTry: true,
    hotfixed: false,
    hotfixWindowDays: 14,
  },
]

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'procedure-registry-'))
  projects = join(root, 'projects')
  const app = join(projects, '-work-app')
  write(
    join(app, 's1.jsonl'),
    transcript('s1', [
      skill('tidy', V1),
      bash('gh pr create --title t', 'https://github.com/acme/widgets/pull/7\n'),
      bash('gh-drew pr merge 8 -R acme/gadgets --merge', 'merged'),
    ]),
  )
  write(
    join(app, 's1', 'subagents', 'agent-ab12.jsonl'),
    transcript('s1', [skill('tidy', V1)], { agentId: 'ab12' }),
  )
  write(
    join(app, 's2.jsonl'),
    transcript('s2', [
      skill('tidy', V2),
      skill('audit'),
      bash('gh pr create', 'https://github.com/acme/widgets/pull/9\n'),
    ]),
  )
  write(
    join(app, 's3.jsonl'),
    transcript('s3', [skill('tidy', V1), bash('gh pr merge 5', 'merged')]),
  )
  write(
    join(app, 's4.jsonl'),
    transcript('s4', [skill('tidy', V1), bash('gh pr create', 'could not create', true)]),
  )
  write(
    join(app, 's5.jsonl'),
    transcript('s5', [
      skill('audit'),
      bash('gh pr create', 'https://github.com/acme/other/pull/3\n'),
    ]),
  )
  ledgerA = join(root, 'a', 'search-ledger.jsonl')
  ledgerB = join(root, 'b', 'search-ledger.jsonl')
  mkdirSync(join(root, 'a'), { recursive: true })
  mkdirSync(join(root, 'b'), { recursive: true })
  await writeSearch(ledgerA, 'search-a', [V1, V2, V3], 'known')
  await writeSearch(ledgerB, 'search-b', [V2], 'unknown')
  outcomesFile = join(root, 'changes.json')
  writeFileSync(outcomesFile, JSON.stringify(outcomes))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const NOW = Date.parse('2026-11-20T00:00:00Z')

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runProcedureRegistryCommand(args, {
    stdout: (text) => {
      out += text
    },
    stderr: (text) => {
      err += text
    },
    now: () => NOW,
  })
  return { code, out, err }
}

function version(registry: ProcedureRegistry, key: string): ProcedureVersion {
  const found = registry.versions.find((candidate) => candidate.key === key)
  if (found === undefined) throw new Error(`no version ${key}`)
  return found
}

describe('procedure registry over ledgers and transcripts', () => {
  let registry: ProcedureRegistry

  beforeAll(async () => {
    const sinceMs = NOW - 30 * 86_400_000
    const searches = [
      replaySearchLedgerText(readFileSync(ledgerA, 'utf8'), 'search-a', ledgerA),
      replaySearchLedgerText(readFileSync(ledgerB, 'utf8'), 'search-b', ledgerB),
    ]
    registry = await buildProcedureRegistry(
      { searches, sessions: claudeCodeSkillSessions(projects, { sinceMs }), outcomes },
      {
        sinceMs,
        procedureOfNode: (node, search) => {
          const text = nodeText.get(`${search.searchId}:${node.nodeId}`)
          return text === undefined ? null : { digest: digestOf(text), name: 'tidy', kind: 'skill' }
        },
      },
    )
  })

  it('keys each version by digest, one entry across searches and sessions', () => {
    expect(registry.versions.map((entry) => entry.key).sort()).toEqual(
      [digestOf(V1), digestOf(V2), digestOf(V3), 'unversioned:audit'].sort(),
    )
    const second = version(registry, digestOf(V2))
    // Search A's V2 node and search B's root are one version.
    expect(second.searches.map((entry) => entry.searchId).sort()).toEqual(['search-a', 'search-b'])
    expect(second.cells.count).toBe(4)
    expect(second.sessions.invocations).toBe(1)
    expect(second.names).toEqual(['tidy'])
    expect(registry.searches).toEqual({ read: 2, closed: 0 })
  })

  it('records lineage with the operator that made each version', () => {
    const second = version(registry, digestOf(V2))
    expect(second.parents).toEqual([digestOf(V1)])
    const improve = second.edges.find((edge) => edge.operator === 'improve')
    expect(improve).toMatchObject({
      searchId: 'search-a',
      attribution: 'explicit',
      proposer: { kind: 'optimizer', name: 'test-proposer' },
      reproposal: false,
    })
    expect(improve?.parents.map((parent) => parent.digest)).toEqual([digestOf(V1)])
    expect(
      second.edges.some((edge) => edge.operator === 'seed' && edge.searchId === 'search-b'),
    ).toBe(true)
    expect(version(registry, digestOf(V3)).parents).toEqual([digestOf(V2)])
    expect(version(registry, digestOf(V1)).parents).toEqual([])
  })

  it('sums tokens, cost and wall time over the executions that reported them, and counts the rest apart', () => {
    const first = version(registry, digestOf(V1))
    expect(first.cells).toMatchObject({ count: 2, passed: 2 })
    expect(first.cells.tokens).toEqual({ sum: 3000, measured: 2, unmeasured: 0 })
    expect(first.cells.usd).toEqual({ sum: 0.5, measured: 2, unmeasured: 0 })
    expect(first.cells.wallMs).toEqual({ sum: 8000, measured: 2, unmeasured: 0 })
    // Search B's cells reported no tokens and no wall time: unknown, never zero.
    const second = version(registry, digestOf(V2))
    expect(second.cells.tokens).toEqual({ sum: 3000, measured: 2, unmeasured: 2 })
    expect(second.cells.usd).toEqual({ sum: 1, measured: 4, unmeasured: 0 })
    expect(second.cells.wallMs).toEqual({ sum: 8000, measured: 2, unmeasured: 2 })
    const invocation = first.executions.find(
      (execution) => execution.source === 'session' && execution.sessionId === 's1',
    )
    // Two model calls of 100 input and 10 output tokens follow the invocation in S1.
    expect(invocation).toMatchObject({ skill: 'tidy', invoker: 'agent', tokens: 220 })
  })

  it('records every decision taken on a version, the latest marked current', () => {
    expect(version(registry, digestOf(V2)).decisions).toEqual([
      {
        searchId: 'search-a',
        nodeId: expect.any(String),
        source: 'node-decided',
        status: 'advanced',
        rung: 1,
        rule: 'test-rule',
        reason: 'beat its parent',
        current: true,
      },
    ])
    expect(version(registry, digestOf(V3)).decisions.map((entry) => entry.status)).toEqual([
      'pruned',
    ])
    expect(version(registry, digestOf(V1)).decisions).toEqual([])
  })

  it('joins each invocation to the changes of its session and of the session that spawned it', () => {
    const first = version(registry, digestOf(V1))
    // S1 and its subagent joined; S3 named a merge with no repository, S4's pull request failed.
    expect(first.sessions.changes).toMatchObject({
      invocations: 4,
      joined: 2,
      none: 2,
      notRecorded: 0,
      distinctChanges: 2,
      withOutcome: 2,
    })
    const subagent = first.executions.filter(
      (execution) => execution.source === 'session' && execution.sessionId === 'ab12',
    )
    expect(subagent).toHaveLength(1)
    expect(subagent[0]).toMatchObject({
      changes: { status: 'joined', refs: ['acme/gadgets#8', 'acme/widgets#7'] },
    })
    expect(registry.changeJoin).toMatchObject({
      hotfixWindowDays: 7,
      invocations: 7,
      joined: 5,
      none: 2,
      notRecorded: 0,
      withOutcome: 4,
      distinctChanges: 4,
      outcomesSupplied: 3,
      outcomesInWrongWindow: 1,
    })
    expect(registry.changeJoin.joinedShare).toBeCloseTo(5 / 7, 10)
    expect(registry.changeJoin.withOutcomeShare).toBeCloseTo(4 / 7, 10)
  })

  it('keeps a missing outcome and an unknown field apart from false', () => {
    const first = version(registry, digestOf(V1)).sessions.changes
    expect(first.merged).toEqual({ yes: 2, no: 0, unknown: 0 })
    // #7 was red on its first gate run; #8's gate result is not known.
    expect(first.gateGreenFirstTry).toEqual({ yes: 0, no: 1, unknown: 1 })
    expect(first.hotfixed).toEqual({ yes: 1, no: 1, unknown: 0 })
    // #9's outcome was judged over 14 days, so its hot-fix reading is unknown rather than false.
    expect(version(registry, digestOf(V2)).sessions.changes).toMatchObject({
      merged: { yes: 1, no: 0, unknown: 0 },
      gateGreenFirstTry: { yes: 1, no: 0, unknown: 0 },
      hotfixed: { yes: 0, no: 0, unknown: 1 },
    })
    // The session with a change nobody supplied an outcome for joins it and reads every field as unknown.
    const audit = version(registry, 'unversioned:audit')
    expect(audit.digest).toBeNull()
    expect(audit.sessions.changes).toMatchObject({
      invocations: 2,
      joined: 2,
      distinctChanges: 2,
      withOutcome: 1,
      merged: { yes: 1, no: 0, unknown: 1 },
    })
  })

  it('prints the join share the program reads', async () => {
    const result = await run(
      projects,
      '--ledger',
      ledgerA,
      '--outcomes',
      outcomesFile,
      '--format',
      'table',
    )
    expect(result.code).toBe(0)
    expect(result.out).toContain('joined to a change: 5 of 7 invocations (71.4%)')
    expect(result.out).toContain('hot-fix window 7 days')
  })

  it('has no invocations to join outside the window', async () => {
    const result = await run(projects, '--since', '1d', '--format', 'json')
    expect(result.code).toBe(0)
    const empty = JSON.parse(result.out) as ProcedureRegistry
    expect(empty.invocations).toBe(0)
    expect(empty.changeJoin.joinedShare).toBeNull()
  })

  it('refuses an outcomes file that cannot be read as the contract', async () => {
    const bad = join(root, 'bad.json')
    writeFileSync(bad, JSON.stringify([{ ref: 'a/b#1', merged: 'yes', hotfixWindowDays: 7 }]))
    const result = await run(projects, '--outcomes', bad)
    expect(result.code).toBe(2)
    expect(result.err).toContain('merged must be true, false or null')
  })
})

describe('what the join does not know', () => {
  const record = (
    sessionId: string,
    changes: SkillSessionRecord['changes'],
    parentSessionId: string | null = null,
  ): SkillSessionRead => ({
    succeeded: true,
    source: sessionId,
    value: {
      harness: 'test',
      sessionId,
      parentSessionId,
      endedAt: null,
      events: [
        {
          kind: 'skill',
          callId: `call-${sessionId}`,
          skill: 'tidy',
          invoker: 'agent',
          at: '2026-11-10T10:00:00.000Z',
          version: { bodySha256: skillBodySha256(V1), source: 'session' },
          skillFile: null,
          failed: false,
        },
      ],
      ...(changes === undefined ? {} : { changes }),
      gaps: [],
    },
  })

  it('separates a reader that records no changes from a session that produced none', async () => {
    const built = await buildProcedureRegistry({
      sessions: [
        record('unread', undefined),
        record('looked', []),
        record('shipped', [{ ref: 'acme/widgets#1', callId: 'c', at: null }]),
        record('child', undefined, 'shipped'),
      ],
    })
    expect(built.changeJoin).toMatchObject({
      invocations: 4,
      joined: 2,
      none: 1,
      notRecorded: 1,
      withOutcome: 0,
      distinctChanges: 1,
    })
    expect(built.changeJoin.joinedShare).toBeCloseTo(0.5, 10)
  })

  it('refuses two different outcomes for one change', async () => {
    await expect(
      buildProcedureRegistry({
        outcomes: [
          {
            ref: 'a/b#1',
            merged: true,
            gateGreenFirstTry: null,
            hotfixed: false,
            hotfixWindowDays: 7,
          },
          {
            ref: 'a/b#1',
            merged: false,
            gateGreenFirstTry: null,
            hotfixed: false,
            hotfixWindowDays: 7,
          },
        ],
      }),
    ).rejects.toThrow(/two different outcomes/)
  })
})

describe('the ledger records what a cell cost in tokens and time', () => {
  it('carries a cell its tokens and wall time, and says when an attempt reported neither', () => {
    const cellsOf = (path: string, searchId: string) =>
      replaySearchLedgerText(readFileSync(path, 'utf8'), searchId, path).cells()
    const known = cellsOf(ledgerA, 'search-a')[0]
    expect(known).toMatchObject({
      tokens: { inputTokens: 1000, outputTokens: 200, cachedTokens: 300 },
      tokensKnown: true,
      wallMs: 4000,
      wallKnown: true,
    })
    expect(cellsOf(ledgerB, 'search-b')[0]).toMatchObject({
      tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      tokensKnown: false,
      wallKnown: false,
    })
  })
})

describe('a subscription seat is a known cost basis with no dollar figure', () => {
  const costs: Record<string, SearchCostAccounting> = {
    seat: { status: 'known', usd: 0, source: 'subscription' },
    free: { status: 'known', usd: 0, source: 'free' },
    unread: { status: 'unknown', knownLowerBoundUsd: 0, reason: 'no charge was read' },
  }

  it('keeps a seat apart from a measured zero and from an unknown charge, in the ledger and the registry', async () => {
    const searches = []
    for (const [name, cost] of Object.entries(costs)) {
      const path = join(root, `cost-${name}`, 'search-ledger.jsonl')
      mkdirSync(join(root, `cost-${name}`), { recursive: true })
      await writeSearch(path, `search-${name}`, [`# ${name}\n\nbody`], 'known', cost)
      searches.push(replaySearchLedgerText(readFileSync(path, 'utf8'), `search-${name}`, path))
    }
    const registry = await buildProcedureRegistry(
      { searches, sessions: [], outcomes: [] },
      {
        sinceMs: 0,
        procedureOfNode: (node, search) => {
          const text = nodeText.get(`${search.searchId}:${node.nodeId}`)
          return text === undefined
            ? null
            : { digest: digestOf(text), name: search.searchId, kind: 'skill' }
        },
      },
    )
    const cells = (name: string) => version(registry, digestOf(`# ${name}\n\nbody`)).cells
    expect(cells('seat')).toMatchObject({
      count: 2,
      subscription: 2,
      usd: { measured: 0, unmeasured: 0 },
    })
    expect(cells('free')).toMatchObject({
      count: 2,
      subscription: 0,
      usd: { sum: 0, measured: 2, unmeasured: 0 },
    })
    expect(cells('unread')).toMatchObject({
      count: 2,
      subscription: 0,
      usd: { measured: 0, unmeasured: 2 },
    })
    const executions = (name: string) =>
      searches
        .find((search) => search.searchId === `search-${name}`)!
        .cells()
        .map((cell) => cell.subscriptionAttempts)
    expect(executions('seat')).toEqual([1, 1])
    expect(executions('free')).toEqual([0, 0])
  })

  it('refuses a seat that carries a dollar figure', async () => {
    const path = join(root, 'cost-bad', 'search-ledger.jsonl')
    mkdirSync(join(root, 'cost-bad'), { recursive: true })
    await expect(
      writeSearch(path, 'search-bad', ['# bad\n\nbody'], 'known', {
        status: 'known',
        usd: 1.5,
        source: 'subscription',
      }),
    ).rejects.toThrow(/subscription cost source must have usd 0/)
  })
})
