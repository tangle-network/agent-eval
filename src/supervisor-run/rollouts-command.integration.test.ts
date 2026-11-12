/**
 * `agent-eval supervisor-run rollouts` end to end: a run directory laid out
 * as Runtime writes it, real harness-session fixtures
 * (Claude Code, OpenCode, a Kimi HOME), and beelink-gate receipts, into one
 * ledger read back through the public journal reader.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionInput } from '@tangle-network/harness-sessions'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashCanonical, jsonDocument } from '../ledger-core/canonical'
import { assertMintedLines, trainingAdmission } from '../rollout'
import { toHarborTrajectories } from '../rollout/interchange/harbor'
import { readRolloutJournal } from '../rollout/ledger'
import { runSupervisorRunCommand } from './report-command'
import {
  type RuntimeRunRolloutOptions,
  type RunVerdict,
  runtimeRunRolloutLines,
} from './runtime-rollouts'

const FIXTURES = join(import.meta.dirname, '../../tests/fixtures/harness-sessions')
const RUN = 'spec-build-20261025a'
const ROOT = RUN
const WORKER = `${RUN}:s0`
const TASK = `sha256:${'a'.repeat(64)}`
const ANSWER = `sha256:${'b'.repeat(64)}`
const STEER = `sha256:${'c'.repeat(64)}`
const STEERED = `sha256:${'d'.repeat(64)}`
const RETURNED = `sha256:${'e'.repeat(64)}`

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollouts-command-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

async function runtimeRun(end?: { unansweredAt: string }): Promise<string> {
  const runDir = join(dir, 'runs', RUN)
  await mkdir(join(runDir, 'blobs'), { recursive: true })
  const at = (m: number) => `2026-10-25T0${m}:00:00.000Z`
  await writeFile(
    join(runDir, 'spawn-journal.jsonl'),
    jsonl([
      { kind: 'begin', root: ROOT, at: at(1) },
      {
        kind: 'events',
        root: ROOT,
        events: [{ kind: 'spawned', id: ROOT, label: 'root', runtime: 'cli', seq: 0, at: at(1) }],
      },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'root-segment',
          id: ROOT,
          to: { provider: 'zai-coding-plan', model: 'glm-5.3', harness: 'opencode' },
          seq: 0,
          at: at(1),
        },
      },
      {
        kind: 'events',
        root: ROOT,
        events: [
          {
            kind: 'spawned',
            id: WORKER,
            parent: ROOT,
            label: 'builder',
            runtime: 'driver',
            identity: { taskDigest: TASK },
            seq: 1,
            at: at(2),
          },
        ],
      },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'materialized',
          id: WORKER,
          receipt: {
            status: 'known',
            model: { status: 'known', id: 'opencode/deepseek/deepseek-v4' },
          },
          seq: 0,
          at: at(2),
        },
      },
      {
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'settled',
          id: WORKER,
          status: 'done',
          outRef: RETURNED,
          verdict: { valid: true, score: 1 },
          seq: 5,
          at: at(3),
        },
      },
      ...[
        { kind: 'execution-input', taskRef: TASK },
        { kind: 'execution-result', outRef: ANSWER },
        { kind: 'execution-input', taskRef: STEER },
        { kind: 'execution-result', outRef: STEERED },
      ].map((event, seq) => ({
        kind: 'event',
        root: ROOT,
        event: { ...event, id: WORKER, seq: seq + 1, at: at(2) },
      })),
      ...(end === undefined
        ? []
        : [
            {
              kind: 'event',
              root: ROOT,
              event: {
                kind: 'execution-input',
                id: ROOT,
                taskRef: STEER,
                seq: 9,
                at: end.unansweredAt,
              },
            },
          ]),
    ]),
  )
  await writeFile(
    join(runDir, 'blobs', `${TASK.replace(':', '-')}.json`),
    JSON.stringify('Build csvstat to the spec.'),
  )
  await writeFile(
    join(runDir, 'blobs', `${ANSWER.replace(':', '-')}.json`),
    JSON.stringify({
      content: 'csvstat builds; 6 of 6 cases pass.',
      events: [
        {
          type: 'message.part.updated',
          data: { part: { id: 'p1', messageID: 'm1', type: 'text', text: 'Running the cases.' } },
        },
        {
          type: 'message.part.updated',
          data: {
            part: {
              id: 'p2',
              messageID: 'm1',
              type: 'tool',
              callID: 'c1',
              tool: 'bash',
              state: { status: 'running', input: { command: 'pnpm test' } },
            },
          },
        },
        {
          type: 'message.part.updated',
          data: {
            part: {
              id: 'p2',
              messageID: 'm1',
              type: 'tool',
              callID: 'c1',
              tool: 'bash',
              state: { status: 'completed', input: { command: 'pnpm test' }, output: '6 passed' },
            },
          },
        },
        {
          type: 'message.part.updated',
          data: {
            part: {
              id: 'p3',
              messageID: 'm2',
              type: 'text',
              text: 'csvstat builds; 6 of 6 cases pass.',
            },
          },
        },
      ],
    }),
  )
  const blob = (ref: string, value: unknown) =>
    writeFile(join(runDir, 'blobs', `${ref.replace(':', '-')}.json`), JSON.stringify(value))
  await blob(STEER, 'Recheck the last case.')
  await blob(STEERED, { content: 'Still 6 of 6.', events: [] })
  await blob(RETURNED, { cases: 6, passed: 6 })
  return runDir
}

async function kimiHome(): Promise<string> {
  const home = join(dir, 'home')
  const session = join(home, '.kimi', 'sessions', 'f'.repeat(32), 'kimi-session-1')
  await mkdir(session, { recursive: true })
  await copyFile(join(FIXTURES, 'kimi', 'parent', 'wire.jsonl'), join(session, 'wire.jsonl'))
  return home
}

async function gateReceipts(): Promise<string> {
  const path = join(dir, 'receipts.jsonl')
  const receipt = (exit: number, sha: string, command = 'pnpm test') => ({
    at: '2026-10-25T23:53:59Z',
    repo: 'github.com/tangle-network/agent-eval',
    sha,
    command,
    exit,
    gate_id: `beelink1-${sha.slice(0, 8)}`,
    timed_out: false,
    watchdog: false,
    ran_s: 53,
  })
  await writeFile(
    path,
    jsonl([
      receipt(0, '1'.repeat(40)),
      receipt(1, '2'.repeat(40)),
      receipt(75, '3'.repeat(40)),
      receipt(
        0,
        '4'.repeat(40),
        `export KEY=${['sk-', 'ant-oat01-', 'ZyXwVu9876543210abcd'].join('')}`,
      ),
    ]),
  )
  return path
}

describe('supervisor-run rollouts', () => {
  const verdict = (fields: Partial<RunVerdict> = {}): RunVerdict => ({
    reward: 1,
    screened: false,
    source: 'suite/check',
    ...fields,
  })

  it('trains on a screened reward, gates a contradicted one, and refuses an unscreened one', async () => {
    const run = await runtimeRun()
    const root = async (fields: Partial<RunVerdict>) => {
      const { lines } = await runtimeRunRolloutLines(run, { verdict: verdict(fields) })
      return lines.find((line) => line.rollout_id === ROOT)!
    }
    const screened = await root({ screened: true })
    expect(screened.outcome).toMatchObject({
      reward: 1,
      realness_gated: false,
      realness_screened: true,
      reward_source: 'suite/check',
    })
    expect(() => assertMintedLines([screened])).not.toThrow()
    const gated = await root({ screened: true, gated: true })
    expect(gated.outcome).toMatchObject({
      reward: 0,
      realness_gated: true,
      realness_screened: true,
    })
    const unscreened = await root({})
    expect(unscreened.outcome.realness_screened).toBe(false)
    expect(() => assertMintedLines([unscreened])).toThrow(/realness_screened/)
  })

  it('completes a run stopped on its success, not one cut before it', async () => {
    const outcomeWhen = async (stoppedAt: string, unansweredAt: string) => {
      const run = await runtimeRun({ unansweredAt })
      const { lines } = await runtimeRunRolloutLines(run, {
        verdict: verdict({ screened: true, stoppedAt }),
      })
      await rm(run, { recursive: true })
      return lines.find((line) => line.rollout_id === ROOT)!.outcome
    }
    const earlier = '2026-10-25T04:00:00.000Z'
    const later = '2026-10-25T05:00:00.000Z'
    expect(await outcomeWhen(earlier, later)).toMatchObject({ is_completed: true, error: null })
    expect(await outcomeWhen(later, earlier)).toMatchObject({ is_completed: false })
  })

  it('keeps structured conditioning and exposes an earlier execution without a result', async () => {
    const runDir = await runtimeRun()
    const input = {
      instruction: 'Build csvstat.',
      context: { repository: 'pinned-source', requirements: ['csv quoting'] },
      prior: ['keep this evidence'],
    }
    await writeFile(join(runDir, 'blobs', `${TASK.replace(':', '-')}.json`), JSON.stringify(input))
    const path = join(runDir, 'spawn-journal.jsonl')
    const rows = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row))
    rows.push(
      ...[
        { kind: 'execution-input', taskRef: TASK },
        { kind: 'execution-input', taskRef: STEER },
        { kind: 'execution-result', outRef: STEERED },
      ].map((event, seq) => ({
        kind: 'event',
        root: ROOT,
        event: { ...event, id: WORKER, seq: 10 + seq, at: '2026-10-25T04:00:00Z' },
      })),
    )
    await writeFile(path, jsonl(rows))
    const { lines } = await runtimeRunRolloutLines(runDir, {
      split: 'holdout',
      instanceId: 'case-1',
    })
    const worker = lines.find((line) => line.rollout_id === WORKER)!
    expect(JSON.parse(worker.messages[0]!.content!)).toEqual(input)
    expect(worker.provenance.lossy_projection).toBe(true)
    expect(worker.provenance.gap).toContain('execution 2: execution result unavailable')
    expect(
      lines.every((line) => line.task.split === 'holdout' && line.task.instance_id === 'case-1'),
    ).toBe(true)
  })

  it('joins verified native capture by execution attempt and retains a later unavailable capture', async () => {
    const runDir = await runtimeRun()
    const path = join(runDir, 'spawn-journal.jsonl')
    const rows = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row))
      .filter((row) => !(row.event?.id === WORKER && row.event.kind.startsWith('execution-')))
    const put = async (value: unknown) => {
      const ref = hashCanonical(jsonDocument(value))
      await writeFile(join(runDir, 'blobs', `${ref.replace(':', '-')}.json`), JSON.stringify(value))
      return ref
    }
    const nativeText = await readFile(join(FIXTURES, 'claude-code.jsonl'), 'utf8')
    const session = readSessionInput(
      'claude-code',
      { text: nativeText },
      {},
      { corruption: 'strict' },
    )
    const native = {
      schemaVersion: 1,
      harness: 'claude-code',
      files: [
        {
          path: `${session.nativeSessionId}.jsonl`,
          bytes: Buffer.byteLength(nativeText),
          content: nativeText,
        },
      ],
      skipped: [],
    }
    const transcriptRef = await put(native)
    const appendAttempt = async (
      attemptId: string,
      available: boolean,
      overrides: { rootId?: string; transcriptRef?: string; resultRef?: string | null } = {},
    ) => {
      const wrapper = {
        kind: 'harness-transcript',
        schemaVersion: 1,
        node: {
          rootId: overrides.rootId ?? ROOT,
          nodeId: WORKER,
          parentId: ROOT,
          depth: 1,
          attemptId,
        },
        taskRef: TASK,
        outRef: overrides.resultRef === null ? undefined : (overrides.resultRef ?? ANSWER),
        harnessTranscript: available
          ? {
              status: 'available',
              transcriptRef: overrides.transcriptRef ?? transcriptRef,
              harness: 'claude-code',
              coverageComplete: true,
              fileCount: 1,
              totalBytes: Buffer.byteLength(nativeText),
              skippedCount: 0,
            }
          : { status: 'unavailable', reason: 'capture interrupted' },
      }
      const evidenceRef = await put(wrapper)
      rows.push(
        ...[
          { kind: 'execution-bound', binding: { attemptId } },
          { kind: 'execution-input', taskRef: TASK },
          { kind: 'execution-result', outRef: ANSWER },
          { kind: 'execution-evidence', outRef: evidenceRef },
        ].map((event, seq) => ({
          kind: 'event',
          root: ROOT,
          event: { ...event, id: WORKER, seq, at: '2026-10-25T04:00:00Z' },
        })),
      )
      await writeFile(path, jsonl(rows))
    }
    // A real native parser at the injected verifier boundary; no synthesized conversation.
    const readNativeTranscript: RuntimeRunRolloutOptions['readNativeTranscript'] = async (
      request,
    ) => {
      const receipt = request.receipt as { status: string; transcriptRef?: string; reason?: string }
      if (receipt.status !== 'available')
        return { succeeded: false, error: receipt.reason ?? 'unavailable' }
      const artifact = JSON.parse(
        await readFile(
          join(runDir, 'blobs', `${receipt.transcriptRef!.replace(':', '-')}.json`),
          'utf8',
        ),
      )
      if (hashCanonical(artifact) !== receipt.transcriptRef)
        return { succeeded: false, error: 'digest mismatch' }
      return {
        succeeded: true,
        value: {
          sessions: [
            readSessionInput(
              artifact.harness,
              { text: artifact.files[0].content },
              {},
              { corruption: 'strict' },
            ),
          ],
        },
      }
    }
    await appendAttempt('attempt-1', true)
    const first = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
      (line) => line.rollout_id === WORKER,
    )!
    expect(first.provenance.lossy_projection).toBeUndefined()
    expect(first.provenance.native_captures).toMatchObject([
      { attempt_id: 'attempt-1', verified: true, native_session_ids: [session.nativeSessionId] },
    ])
    expect(
      first.messages.some((message) =>
        message.content?.includes('TRACEPROOF-WORKER-REAP-FINAL-ANSWER'),
      ),
    ).toBe(true)
    for (const [index, value] of [null, 'readable generic evidence', ['audit']].entries()) {
      const ref = await put(value)
      rows.push({
        kind: 'event',
        root: ROOT,
        event: {
          kind: 'execution-evidence',
          id: WORKER,
          outRef: ref,
          seq: 5 + index,
          at: '2026-10-25T04:01:00Z',
        },
      })
    }
    const auditValue = { kind: 'capture-audit', detail: 'known non-native evidence' }
    const auditRef = await put(auditValue)
    const auditPath = join(runDir, 'blobs', `${auditRef.replace(':', '-')}.json`)
    rows.push({
      kind: 'event',
      root: ROOT,
      event: {
        kind: 'execution-evidence',
        id: WORKER,
        outRef: auditRef,
        seq: 8,
        at: '2026-10-25T04:01:00Z',
      },
    })
    await writeFile(path, jsonl(rows))
    const mixed = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
      (line) => line.rollout_id === WORKER,
    )!
    expect(mixed.provenance.lossy_projection).toBeUndefined()
    expect(mixed.provenance.native_captures).toHaveLength(1)
    for (const raw of [null, 'not JSON', JSON.stringify({ kind: 'changed-evidence' })]) {
      if (raw === null) await rm(auditPath)
      else await writeFile(auditPath, raw)
      const unreadable = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
        (line) => line.rollout_id === WORKER,
      )!
      expect(unreadable.messages).toEqual(first.messages)
      expect(unreadable.provenance.lossy_projection).toBe(true)
      expect(unreadable.provenance.native_captures?.at(-1)).toMatchObject({
        evidence_ref: auditRef,
        verified: false,
        gap: 'execution evidence blob unavailable, malformed or failed content verification',
      })
      expect(
        trainingAdmission(
          { ...unreadable, outcome: { ...unreadable.outcome, reward: null } },
          'imitation',
        ).reason,
      ).toBe('lossy-capture')
    }
    await writeFile(auditPath, JSON.stringify(auditValue))
    const completeRows = [...rows]
    await appendAttempt('forged-root', true, { rootId: 'another-run-root' })
    const forged = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
      (line) => line.rollout_id === WORKER,
    )!
    expect(forged.provenance.lossy_projection).toBe(true)
    expect(forged.provenance.gap).toContain('spawn root')
    rows.splice(0, rows.length, ...completeRows)

    for (const resultRef of [null, STEERED]) {
      await appendAttempt('unbound-result', true, { resultRef })
      const unbound = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
        (line) => line.rollout_id === WORKER,
      )!
      expect(unbound.provenance.lossy_projection).toBe(true)
      expect(unbound.provenance.gap).toContain('result does not match execution output')
      expect(unbound.provenance.native_captures?.at(-1)?.verified).toBe(false)
      rows.splice(0, rows.length, ...completeRows)
    }

    const shorter = `${nativeText
      .split('\n')
      .filter((raw) => {
        if (!raw.trim()) return false
        const row = JSON.parse(raw)
        if (!row.message) return true
        if (row.type === 'user' && typeof row.message.content === 'string') return true
        return (
          row.type === 'assistant' &&
          JSON.stringify(row.message.content).includes('TRACEPROOF-WORKER-REAP-FINAL-ANSWER')
        )
      })
      .join('\n')}\n`
    const shortenedRef = await put({
      ...native,
      files: [{ ...native.files[0], bytes: Buffer.byteLength(shorter), content: shorter }],
    })
    await appendAttempt('shorter-snapshot', true, { transcriptRef: shortenedRef })
    const shortened = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
      (line) => line.rollout_id === WORKER,
    )!
    expect(shortened.provenance.lossy_projection).toBe(true)
    expect(shortened.provenance.gap).toContain('cumulative snapshot conflicts')
    expect(shortened.messages).toEqual(first.messages)
    expect(shortened.provenance.native_captures?.map((capture) => capture.transcript_ref)).toEqual([
      transcriptRef,
      shortenedRef,
    ])
    rows.splice(0, rows.length, ...completeRows)
    await appendAttempt('attempt-2', false)
    const second = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
      (line) => line.rollout_id === WORKER,
    )!
    expect(second.provenance.lossy_projection).toBe(true)
    expect(second.provenance.native_captures?.map((capture) => capture.verified)).toEqual([
      true,
      false,
    ])
    expect(second.provenance.gap).toContain('capture interrupted')
    expect(
      trainingAdmission(
        {
          ...second,
          outcome: { ...second.outcome, reward: null },
          provenance: { ...second.provenance, lossy_projection: undefined },
        },
        'imitation',
      ).reason,
    ).toBe('lossy-capture')
    expect(
      second.messages.some((message) =>
        message.content?.includes('TRACEPROOF-WORKER-REAP-FINAL-ANSWER'),
      ),
    ).toBe(true)
    // A later verified receipt for this exact invocation repairs only its unavailable capture.
    const failedRef = second.provenance.native_captures![1]!.evidence_ref
    const failedWrapper = JSON.parse(
      await readFile(join(runDir, 'blobs', `${failedRef.replace(':', '-')}.json`), 'utf8'),
    )
    const repairedRef = await put({
      ...failedWrapper,
      harnessTranscript: {
        status: 'available',
        transcriptRef,
        harness: 'claude-code',
        coverageComplete: true,
        fileCount: 1,
        totalBytes: Buffer.byteLength(nativeText),
        skippedCount: 0,
      },
    })
    rows.push({
      kind: 'event',
      root: ROOT,
      event: {
        kind: 'execution-evidence',
        id: WORKER,
        outRef: repairedRef,
        seq: 5,
        at: '2026-10-25T04:01:00Z',
      },
    })
    await writeFile(path, jsonl(rows))
    const repaired = (await runtimeRunRolloutLines(runDir, { readNativeTranscript })).lines.find(
      (line) => line.rollout_id === WORKER,
    )!
    expect(repaired.provenance.lossy_projection).toBeUndefined()
    expect(repaired.provenance.native_captures![1]).toMatchObject({
      verified: false,
      gap: 'capture interrupted',
      resolved_by: repairedRef,
    })
    expect(
      trainingAdmission(
        { ...repaired, outcome: { ...repaired.outcome, reward: null } },
        'imitation',
      ).reason,
    ).toBe('unscored')
  })

  it('exports a real episode as a Harbor trajectory with its tool calls', async () => {
    const { lines } = await runtimeRunRolloutLines(await runtimeRun())
    const steps = toHarborTrajectories(lines)
      .flatMap((t) => [t, ...(t.subagent_trajectories ?? [])])
      .flatMap((t) => t.steps)
    expect(steps.flatMap((s) => s.tool_calls ?? []).map((c) => c.function_name)).toEqual(['bash'])
  })

  it('imports screened Runtime, harness and gate evidence and refuses private injected context', async () => {
    const out = join(dir, 'ledger.jsonl')
    const otlp = join(dir, 'spans.otlp.jsonl')
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runSupervisorRunCommand(
      [
        'rollouts',
        await runtimeRun(),
        '--sessions',
        `claude-code:${join(FIXTURES, 'claude-code.jsonl')}`,
        '--sessions',
        join(FIXTURES, 'opencode.db'),
        '--sessions',
        `kimi-code:${await kimiHome()}`,
        '--gate-receipts',
        await gateReceipts(),
        '--otlp',
        otlp,
        '--out',
        out,
      ],
      { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    )
    expect(stderr.join('')).toBe('')
    expect(code).toBe(0)
    const summary = JSON.parse(stdout.join(''))
    expect(summary.dropped['api-key']).toBe(1)
    expect(summary.dropped.email).toBe(1)
    expect(
      summary.sources.find((source: { kind: string }) => source.kind === 'sessions:claude-code'),
    ).toMatchObject({ read: 1, written: 0, errors: [] })
    expect(summary.sources[0]).toMatchObject({ kind: 'run-dir', read: 2, written: 2 })

    const lines = await readRolloutJournal(out)
    expect(summary.written).toBe(lines.length)
    const byId = new Map(lines.map((line) => [line.rollout_id, line]))

    const root = byId.get(ROOT)!
    expect(root.task.suite).toBe(`runtime/${RUN}`)
    expect(root.policy).toMatchObject({
      harness: 'opencode',
      provider: 'zai-coding-plan',
      model: 'glm-5.3',
      license_class: 'open-weight-api',
    })

    const worker = byId.get(WORKER)!
    expect(worker.role).toBe('worker')
    expect(worker.parent_rollout_id).toBe(ROOT)
    expect(worker.policy).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4',
      license_class: 'open-weight-api',
    })
    expect(worker.messages).toMatchObject([
      { role: 'user', content: 'Build csvstat to the spec.' },
      {
        role: 'assistant',
        content: 'Running the cases.',
        tool_calls: [{ function: { name: 'bash' } }],
      },
      { role: 'tool', name: 'bash', content: '6 passed' },
      { role: 'assistant', content: 'csvstat builds; 6 of 6 cases pass.' },
      { role: 'user', content: 'Recheck the last case.' },
      { role: 'assistant', content: 'Still 6 of 6.' },
    ])
    expect(worker.provenance.lossy_projection).toBe(true)
    expect(worker.provenance.gap).toContain(
      'execution 1: no attempt-bound native transcript evidence',
    )
    const spans = (await readFile(otlp, 'utf8')).trim().split('\n')
    expect(spans.some((span) => JSON.parse(span).name.includes('bash'))).toBe(true)
    expect(worker.outcome.reward).toBe(1)

    const sessions = lines.filter((line) => line.task.suite.startsWith('harness/'))
    const harnesses = new Set(sessions.map((line) => line.policy.harness))
    expect(harnesses).toEqual(new Set(['opencode', 'kimi-code']))
    for (const line of sessions) {
      expect(line.messages.length).toBeGreaterThan(0)
      expect(line.outcome.reward).toBeNull()
    }
    expect(sessions.find((l) => l.policy.harness === 'kimi-code')!.policy.license_class).toBe(
      'open-weight-api',
    )

    const gates = lines.filter((line) => line.policy.harness === 'beelink-gate')
    expect(gates.map((line) => [line.task.instance_id, line.outcome.reward])).toEqual([
      ['1'.repeat(40), 1],
      ['2'.repeat(40), 0],
    ])
    expect(await readFile(out, 'utf8')).not.toContain('sk-ant')
  })
})
