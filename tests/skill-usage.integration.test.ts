/**
 * Skill usage over recorded sessions, through the real transcript reader.
 *
 * `fixtures/skill-usage/projects` is a small Claude Code projects directory
 * written for this test: every prompt, path and id in it is invented. It holds
 * two top-level sessions and one subagent on one project, and an older session
 * on another:
 *
 * | Session | What it records |
 * |---|---|
 * | A | an agent invokes `tidy` twice (one version), a tool error after it, a response split over two records, a request snapshot that quotes the first call |
 * | A's subagent | the harness preloads `helper-contract`, the agent invokes `tidy`, a model with no rate, a tool call with no result |
 * | B | a copy of A's first call, a command the CLI answers itself, a typed `tidy` command at a newer version, a bundled skill, a refused skill, a subagent's record |
 * | C | one older `tidy` call and a line that is not JSON |
 *
 * `{{SKILL_ROOT}}` in the transcripts becomes a real folder holding the current
 * `tidy` skill file, so the report reads it; `helper-contract` has no file.
 */

import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionInput } from '@tangle-network/harness-sessions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildSkillUsageReport,
  claudeCodeSkillSessions,
  readSkillFile,
  renderSkillUsageTable,
  type SkillSessionRead,
  type SkillUsageReport,
  type SkillUsageRow,
  skillSessionFromHarnessSession,
} from '../src/skill-usage'
import { runSkillUsageCommand } from '../src/skill-usage/command'

const FIXTURE = join(import.meta.dirname, 'fixtures/skill-usage')
const SESSION_C = '-work-notes/cccccccc-0000-4000-8000-000000000003.jsonl'
const WINDOW_OPENS = '2026-03-01T00:00:00.000Z'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const TIDY_V1 = sha256('# Tidy\n\nRemove dead code, then run the checks.')
const TIDY_V2 = sha256('# Tidy\n\nRemove dead code and duplicated logic, then run the checks.')
const HELPER = sha256('# Helper contract\n\nCall the helper with one task at a time.')

let root: string
let projects: string
let skills: string

function copyTranscripts(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    if (entry.isDirectory()) copyTranscripts(source, join(to, entry.name))
    else {
      writeFileSync(
        join(to, entry.name),
        readFileSync(source, 'utf8').replaceAll('{{SKILL_ROOT}}', skills),
      )
    }
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-usage-'))
  projects = join(root, 'projects')
  skills = join(root, 'skills')
  copyTranscripts(join(FIXTURE, 'projects'), projects)
  mkdirSync(join(skills, 'tidy'), { recursive: true })
  writeFileSync(join(skills, 'tidy', 'SKILL.md'), readFileSync(join(FIXTURE, 'skills/tidy.md')))
  // A transcript that cannot be read: the link's target does not exist.
  symlinkSync(join(root, 'missing.jsonl'), join(projects, '-work-app', 'dangling.jsonl'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function row(report: SkillUsageReport, skill: string, bodySha256: string | null): SkillUsageRow {
  const found = report.rows.find(
    (candidate) =>
      candidate.skill === skill && (candidate.version?.bodySha256 ?? null) === bodySha256,
  )
  if (found === undefined) throw new Error(`no row for ${skill} at ${bodySha256}`)
  return found
}

describe('skill usage from Claude Code transcripts', () => {
  it('counts each invocation once, by who started it, one row per skill and version', async () => {
    const report = await buildSkillUsageReport(claudeCodeSkillSessions(projects), { readSkillFile })

    expect(report.since).toBeNull()
    // Two calls in A, a preload and a call in its subagent, three in B, one in C. B's copy of
    // A's first call and the request snapshot that quotes it add nothing; the `/model` command
    // and the subagent's record inside B are not invocations of B.
    expect(report.invocations).toEqual({
      total: 8,
      agent: 6,
      user: 1,
      harness: 1,
      duplicates: 1,
      beforeWindow: 0,
      undated: 0,
    })
    expect(report.skills).toBe(4)
    expect(report.sessions).toMatchObject({ read: 4, subagent: 1, withInvocation: 4 })
    expect(report.rows.map((entry) => [entry.skill, entry.version?.bodySha256 ?? null])).toEqual([
      ['tidy', TIDY_V1],
      ['bundled-helper', null],
      ['ghost', null],
      ['helper-contract', HELPER],
      ['tidy', TIDY_V2],
    ])

    const first = row(report, 'tidy', TIDY_V1)
    expect(first.invocations).toEqual({ total: 4, agent: 4, user: 0, harness: 0 })
    expect(first.sessions).toBe(3)
    expect(first.subagentSessions).toBe(1)
    expect(first.subagentShare).toBe(0.25)
    expect(first.firstAt).toBe('2026-02-01T08:00:10.000Z')
    expect(first.lastAt).toBe('2026-03-10T10:04:10.000Z')
    expect(first.version).toEqual({ bodySha256: TIDY_V1, source: 'session' })

    // The typed command ran a newer text of the same skill: its own row.
    const second = row(report, 'tidy', TIDY_V2)
    expect(second.invocations).toEqual({ total: 1, agent: 0, user: 1, harness: 0 })
    expect(second.subagentShare).toBe(0)

    const preload = row(report, 'helper-contract', HELPER)
    expect(preload.invocations).toEqual({ total: 1, agent: 0, user: 0, harness: 1 })
    expect(preload.subagentShare).toBe(1)

    expect(row(report, 'ghost', null).failedInvocations).toBe(1)
    expect(row(report, 'bundled-helper', null).failedInvocations).toBe(0)
  })

  it('reports what sessions did after the first invocation, and prices only what has a rate', async () => {
    const report = await buildSkillUsageReport(claudeCodeSkillSessions(projects))

    // A: a failed Bash, an Edit and an Agent call, three responses. Subagent: a Grep and a Bash
    // with no result, two responses from a model with no rate. C: one response.
    const tidy = row(report, 'tidy', TIDY_V1).afterFirstInvocation
    expect(tidy).toMatchObject({
      toolCalls: 5,
      toolErrors: 1,
      toolCallsUnsettled: 1,
      modelCalls: 6,
      modelCallsWithoutUsage: 0,
      tokens: { input: 1350, output: 270, cached: 13300, cacheWrite: 100, total: 15020 },
      wallMs: 640_000,
      sessionsWithWallTime: 3,
      pricedModelCalls: 4,
      unpricedModelCalls: 2,
    })
    // The ledger's rate for the priced model is $3 and $15 per million; it charges cached and
    // cache-write tokens as input. A: (1200 + 12000 + 100) in, 240 out. C: 20 in, 4 out.
    expect(tidy.costUsd).toBeCloseTo(0.0435 + 0.00012, 10)
    expect(tidy.perSessionMedian).toMatchObject({
      toolCalls: 2,
      toolErrors: 0,
      tokens: 1456,
      wallMs: 50_000,
    })
    expect(tidy.perSessionMedian.costUsd).toBeCloseTo((0.0435 + 0.00012) / 2, 10)

    // Every response after the preload came from a model with no rate: unknown, not free.
    const preload = row(report, 'helper-contract', HELPER).afterFirstInvocation
    expect(preload).toMatchObject({
      toolCalls: 2,
      toolCallsUnsettled: 1,
      modelCalls: 3,
      tokens: { input: 180, output: 36, cached: 1800, cacheWrite: 0, total: 2016 },
      wallMs: 60_000,
      costUsd: null,
      pricedModelCalls: 0,
      unpricedModelCalls: 3,
    })
    expect(preload.perSessionMedian.costUsd).toBeNull()

    // The typed command: one Read, then four responses, the last without usage.
    expect(row(report, 'tidy', TIDY_V2).afterFirstInvocation).toMatchObject({
      toolCalls: 1,
      toolErrors: 0,
      modelCalls: 4,
      modelCallsWithoutUsage: 1,
      tokens: { input: 3300, output: 630, cached: 0, cacheWrite: 0, total: 3930 },
      wallMs: 240_000,
    })

    // Only a response without usage followed the refused call: no token reading, no price.
    const ghost = row(report, 'ghost', null).afterFirstInvocation
    expect(ghost).toMatchObject({ modelCalls: 1, modelCallsWithoutUsage: 1, costUsd: null })
    expect(ghost.perSessionMedian.tokens).toBeNull()

    expect(report.models).toEqual([
      { model: 'claude-sonnet-4-20250514', modelCalls: 12, priced: true },
      { model: 'fixture-model-without-rate', modelCalls: 3, priced: false },
    ])

    // Rates the caller supplies price the model the ledger does not know, cache reads included.
    const priced = await buildSkillUsageReport(claudeCodeSkillSessions(projects), {
      pricing: (model) =>
        model === 'fixture-model-without-rate'
          ? { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 }
          : undefined,
    })
    const pricedPreload = row(priced, 'helper-contract', HELPER).afterFirstInvocation
    expect(pricedPreload.costUsd).toBeCloseTo(180e-6 + 1800e-7 + 36 * 2e-6, 12)
    expect(pricedPreload.unpricedModelCalls).toBe(0)
    expect(priced.models[1]).toMatchObject({ priced: true })
  })

  it('keeps what could not be read apart from zero', async () => {
    const report = await buildSkillUsageReport(claudeCodeSkillSessions(projects), { readSkillFile })

    // The dangling transcript is a failed read with its reason, not a session without skills.
    expect(report.sessions.unreadable).toBe(1)
    expect(report.unreadable).toHaveLength(1)
    expect(report.unreadable[0]?.source).toBe(join(projects, '-work-app', 'dangling.jsonl'))
    expect(report.unreadable[0]?.error).toContain('ENOENT')
    // B skipped a subagent's record and C holds a line that is not JSON.
    expect(report.sessions.withGaps).toBeGreaterThanOrEqual(2)

    // The skill file today is the newer text: the old row's version came from the session.
    const tidyFile = join(skills, 'tidy', 'SKILL.md')
    const fileSha256 = sha256(readFileSync(tidyFile, 'utf8'))
    expect(row(report, 'tidy', TIDY_V1).skillFile).toEqual({
      path: tidyFile,
      state: 'changed',
      fileSha256,
    })
    expect(row(report, 'tidy', TIDY_V2).skillFile).toEqual({
      path: tidyFile,
      state: 'current',
      fileSha256,
    })
    // A skill whose file is gone still has the version the session recorded.
    expect(row(report, 'helper-contract', HELPER).skillFile).toEqual({
      path: join(skills, 'helper-contract', 'SKILL.md'),
      state: 'unreadable',
      error: 'ENOENT',
    })
    // A bundled skill and a refused one record no text: no version, and no file to read.
    for (const skill of ['bundled-helper', 'ghost']) {
      expect(row(report, skill, null).version).toBeNull()
      expect(row(report, skill, null).skillFile).toBeNull()
    }

    const table = renderSkillUsageTable(report)
    expect(table).toMatch(/^bundled-helper\s+not recorded\s+1\s+1\/0\/0/m)
    expect(table).toMatch(/^ghost\s+not recorded.*no reading.*not priced$/m)
    expect(table).toMatch(/^helper-contract\s+\w{12}\s+1\s+0\/0\/1.*not priced$/m)
    expect(table).toContain('1 unreadable')

    // Without a file reader the file is named and marked unread.
    const unread = await buildSkillUsageReport(claudeCodeSkillSessions(projects))
    expect(row(unread, 'tidy', TIDY_V1).skillFile).toEqual({ path: tidyFile, state: 'not-read' })
  })

  it('counts only invocations inside the window', async () => {
    const sinceMs = Date.parse(WINDOW_OPENS)
    const report = await buildSkillUsageReport(claudeCodeSkillSessions(projects), { sinceMs })

    expect(report.since).toBe(WINDOW_OPENS)
    expect(report.invocations).toMatchObject({ total: 7, beforeWindow: 1, duplicates: 1 })
    const tidy = row(report, 'tidy', TIDY_V1)
    expect(tidy.invocations.total).toBe(3)
    expect(tidy.sessions).toBe(2)
    expect(tidy.subagentShare).toBeCloseTo(1 / 3, 12)
    expect(tidy.firstAt).toBe('2026-03-10T10:01:00.000Z')
  })
})

describe('agent-eval skill-usage', () => {
  it('prints the JSON report and the table from one command over a directory', async () => {
    // A transcript last written before the window is not opened at all.
    const old = new Date('2026-02-02T00:00:00.000Z')
    utimesSync(join(projects, SESSION_C), old, old)
    const rates = join(root, 'rates.json')
    writeFileSync(
      rates,
      JSON.stringify({
        'fixture-model-without-rate': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      }),
    )

    let stdout = ''
    let stderr = ''
    const io = {
      stdout: (text: string) => {
        stdout += text
      },
      stderr: (text: string) => {
        stderr += text
      },
    }
    const code = await runSkillUsageCommand(
      [projects, '--since', WINDOW_OPENS, '--pricing', rates],
      io,
    )

    expect(code).toBe(0)
    const report = JSON.parse(stdout) as SkillUsageReport
    expect(report.since).toBe(WINDOW_OPENS)
    expect(report.sessions).toMatchObject({ read: 3, unreadable: 1, subagent: 1 })
    expect(report.invocations).toMatchObject({ total: 7, agent: 5, user: 1, harness: 1 })
    expect(report.invocations.beforeWindow).toBe(0)
    expect(row(report, 'tidy', TIDY_V1).skillFile?.state).toBe('changed')
    // 180 fresh and 1800 cached tokens at the input rate, 36 out.
    expect(row(report, 'helper-contract', HELPER).afterFirstInvocation.costUsd).toBeCloseTo(
      1980e-6 + 72e-6,
      12,
    )
    expect(stderr).toContain(`window: since ${WINDOW_OPENS}`)
    expect(stderr).toContain('invocations: 7 across 4 skills: 5 agent, 1 user, 1 harness')
    expect(stderr).toMatch(/^tidy\s+\w{12}\s+3\s+3\/0\/0\s+2\s+33%/m)

    stdout = ''
    stderr = ''
    expect(await runSkillUsageCommand([projects, '--format', 'table', '--limit', '1'], io)).toBe(0)
    expect(stdout).toContain('... 4 more rows')
    expect(stderr).toBe('')
  })

  it('refuses a bad invocation and names a directory it cannot read', async () => {
    const run = async (argv: string[]): Promise<{ code: number; stderr: string }> => {
      let stderr = ''
      const code = await runSkillUsageCommand(argv, {
        stdout: () => {},
        stderr: (text) => {
          stderr += text
        },
      })
      return { code, stderr }
    }

    expect(await run([])).toMatchObject({ code: 2 })
    expect((await run([projects, '--since', 'soon'])).stderr).toContain('--since expects')
    expect((await run([projects, '--window', '7d'])).stderr).toContain('unknown flag "--window"')
    const missing = await run([join(root, 'no-such-directory')])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('cannot read')
  })
})

describe('skill usage from any session source', () => {
  it('reads records a caller supplies, and a failed read stays a failed read', async () => {
    const source: SkillSessionRead[] = [
      {
        succeeded: true,
        source: 'caller-store:1',
        value: {
          harness: 'caller-harness',
          sessionId: 'caller-1',
          parentSessionId: null,
          endedAt: '2026-04-01T00:10:00.000Z',
          events: [
            {
              kind: 'skill',
              callId: 'call-1',
              skill: 'tidy',
              invoker: 'agent',
              at: '2026-04-01T00:00:00.000Z',
              version: null,
              // The record names no text, so the version is the skill file as it is now.
              skillFile: join(skills, 'tidy', 'SKILL.md'),
              failed: false,
            },
            { kind: 'tool', id: 'tool-1', name: 'shell', at: null, failed: true },
            { kind: 'model', id: 'model-1', at: null, model: null, usage: null },
          ],
          gaps: [],
        },
      },
      { succeeded: false, source: 'caller-store:2', error: 'store offline' },
    ]

    const report = await buildSkillUsageReport(source, { readSkillFile })

    expect(report.sessions).toMatchObject({ read: 1, unreadable: 1 })
    expect(report.unreadable).toEqual([{ source: 'caller-store:2', error: 'store offline' }])
    const tidy = row(report, 'tidy', TIDY_V2)
    expect(tidy.version).toEqual({ bodySha256: TIDY_V2, source: 'file' })
    expect(tidy.skillFile?.state).toBe('current')
    expect(tidy.afterFirstInvocation).toMatchObject({
      toolCalls: 1,
      toolErrors: 1,
      modelCalls: 1,
      modelCallsWithoutUsage: 1,
      wallMs: 600_000,
      costUsd: null,
    })
    expect(report.models).toEqual([{ model: null, modelCalls: 1, priced: false }])
  })

  it('reads a Codex session, which records tool and model calls and marks no skill', async () => {
    const text = readFileSync(
      join(
        import.meta.dirname,
        'fixtures/harness-sessions/codex-rollout/rollout-2026-10-04T21-50-21-01a108e5-81d9-71b0-9cec-e5d33586604f.jsonl',
      ),
      'utf8',
    )
    const session = readSessionInput('codex', { text }, { nativeSessionId: 'fixture-codex' })

    const record = skillSessionFromHarnessSession(session)
    expect(record.harness).toBe('codex')
    expect(record.events.map((event) => event.kind)).toEqual([
      'model',
      'tool',
      'model',
      'tool',
      'model',
    ])
    const report = await buildSkillUsageReport([
      { succeeded: true, source: 'codex', value: record },
    ])
    expect(report.sessions).toMatchObject({ read: 1, withInvocation: 0 })
    expect(report.invocations.total).toBe(0)
    expect(report.rows).toEqual([])

    // A caller that knows how its harness marks a skill supplies the marker.
    const marked = skillSessionFromHarnessSession(session, {
      skillOfToolCall: (call) => (call.id === session.toolCalls[0]?.id ? 'caller-marked' : null),
    })
    const markedReport = await buildSkillUsageReport([
      { succeeded: true, source: 'codex', value: marked },
    ])
    expect(markedReport.rows).toHaveLength(1)
    expect(markedReport.rows[0]).toMatchObject({
      skill: 'caller-marked',
      version: null,
      invocations: { total: 1, agent: 1 },
      afterFirstInvocation: { toolCalls: 1, modelCalls: 2 },
    })
  })
})
