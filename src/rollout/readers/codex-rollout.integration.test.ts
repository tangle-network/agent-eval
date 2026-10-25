/** Real saved Codex bytes → public reader → canonical ledger → interchange. No inference. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { redactForShare, shareAllowed } from '../../traces'
import {
  type CodexRollout,
  fromHarborTrajectory,
  parseCodexRollout,
  ROLLOUT_SCHEMA,
  type RolloutLine,
  readCodexRollout,
  readRolloutLedger,
  toHarborTrajectory,
  toSftRows,
  writeRolloutLedger,
} from '../index'

const SESSION_ID = '01a108e5-81d9-71b0-9cec-e5d33586604f'
const FIXTURE = join(
  import.meta.dirname,
  '../../../tests/fixtures/harness-sessions/codex-rollout',
  `rollout-2026-10-04T21-50-21-${SESSION_ID}.jsonl`,
)
const FIXTURE_HASH = '87f6c65737d3adf99a3740368714f36957d3057d15db039f043b7bc13251f8b9'
const CALL_IDS = ['call_a3eee50923b340cda61b5372', 'call_1711bf9c2fa246ff82c95b0d']
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-rollout-intake-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// This caller labels the retained slice as incomplete/unjudged. The reader does
// not manufacture a RunRecord, task ownership, reward, or training permission.
function unlabeledLine(source: CodexRollout): RolloutLine {
  return {
    schema: ROLLOUT_SCHEMA,
    rollout_id: `codex:${source.nativeSessionId}`,
    parent_rollout_id: null,
    run_id: 'retained-offline-trace-proof',
    experiment_id: null,
    candidate_id: null,
    generation: null,
    candidate_index: null,
    role: 'agent',
    task: {
      suite: 'offline-trace-proof',
      instance_id: SESSION_ID,
      split: 'holdout',
      seed: null,
      rep: 0,
    },
    policy: {
      harness: 'codex',
      harness_version: null,
      model: source.model,
      provider: null,
      profile_commit: null,
      sampling: null,
    },
    messages: source.messages,
    tool_defs: [],
    outcome: {
      reward: null,
      reward_source: null,
      verdict: null,
      metrics: {},
      is_completed: false,
      is_truncated: true,
      error: null,
      realness_gated: false,
      realness_screened: false,
    },
    cost: {
      usd: null,
      tokens_in: source.usage?.input ?? null,
      tokens_out: source.usage?.output ?? null,
      tokens_reasoning: source.usage?.reasoning ?? null,
      cache_read: source.usage?.cacheRead ?? null,
      cache_write: source.usage?.cacheWrite ?? null,
      wall_s: null,
    },
    artifacts: { transcript_ref: FIXTURE, patch_path: null, run_dir: null },
    provenance: {
      captured_at: '2026-10-04T21:50:21.953Z',
      capture: 'backfill',
      gap: 'Saved proof slice omits initial context; no task verdict or training eligibility established.',
    },
  }
}

describe('Codex retained rollout intake through the public rollout boundary', () => {
  it('preserves real tool calls, cumulative usage, provenance and unlabeled export semantics', async () => {
    const raw = await readFile(FIXTURE, 'utf8')
    const source = await readCodexRollout(FIXTURE)
    expect(createHash('sha256').update(raw).digest('hex')).toBe(FIXTURE_HASH)
    expect(parseCodexRollout(raw, { label: FIXTURE, nativeSessionId: SESSION_ID })).toEqual(source)
    expect(source).toMatchObject({
      nativeSessionId: SESSION_ID,
      parentNativeSessionId: null,
      startedAt: '2026-10-04T21:50:21.356Z',
      endedAt: '2026-10-04T21:50:21.953Z',
      requestedModel: 'gpt-5.5',
      model: null,
      modelSource: 'turn-context',
      usage: { input: 300, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      ending: { status: 'completed', error: null },
      integrity: {
        sourceFiles: [{ path: FIXTURE, sha256: `sha256:${FIXTURE_HASH}`, bytes: 7866 }],
        unparsedRecords: 0,
        truncated: false,
        gaps: [],
      },
    })
    expect(source.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    const calls = source.messages.flatMap((message) => message.tool_calls ?? [])
    expect(calls.map((call) => call.id)).toEqual(CALL_IDS)
    expect(calls.map((call) => call.function.name)).toEqual(['exec_command', 'exec_command'])
    expect(calls[1]!.function.arguments).toBe(
      '{"cmd":"echo TRACEPROOF-WORKER-CODEX-SECOND-TOOL && wc -c traceproof-worker-codex.txt"}',
    )
    expect(
      source.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.tool_call_id),
    ).toEqual(CALL_IDS)
    expect(source.messages[2]!.content).toContain('TRACEPROOF-WORKER-CODEX-TOOL-OUTPUT')
    expect(source.messages[4]!.content).toContain('34 traceproof-worker-codex.txt')

    const redacted = redactForShare(source.messages, { profile: 'default' })
    expect(shareAllowed(redacted.verdict)).toBe(true)
    expect(redacted.report.redactionCount).toBe(0)
    const ledgerPath = join(dir, 'rollouts.jsonl')
    await writeRolloutLedger(ledgerPath, [unlabeledLine({ ...source, messages: redacted.value })])
    const rows = await readRolloutLedger(ledgerPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.messages).toEqual(source.messages)
    expect(rows[0]!.cost).toMatchObject({
      usd: null,
      tokens_in: 300,
      tokens_out: 60,
      cache_read: 0,
    })
    expect(toSftRows(rows)).toEqual([])
    const exported = JSON.parse(JSON.stringify(toHarborTrajectory(rows)))
    const imported = fromHarborTrajectory(exported, { now: () => new Date('2026-10-04T21:50:22Z') })
    expect(imported).toHaveLength(1)
    expect(imported[0]!.messages).toEqual(source.messages)
    expect(imported[0]!.cost).toEqual(rows[0]!.cost)
    expect(imported[0]!.task.split).toBe('holdout')
    expect(imported[0]!.outcome.reward).toBeNull()
    expect(imported[0]!.provenance.gap).toContain('no task verdict')
    expect(
      createHash('sha256')
        .update(await readFile(FIXTURE))
        .digest('hex'),
    ).toBe(FIXTURE_HASH)
  })

  it('keeps corruption evidence and rejects malformed middle records in strict mode', async () => {
    const lines = (await readFile(FIXTURE, 'utf8')).trimEnd().split('\n')
    const path = join(dir, `rollout-${SESSION_ID}.jsonl`)
    await writeFile(path, [...lines.slice(0, 3), '{bad json', ...lines.slice(3)].join('\n') + '\n')
    const recovered = await readCodexRollout(path)
    expect(recovered.usage).toEqual({
      input: 300,
      output: 60,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(recovered.integrity.unparsedRecords).toBe(1)
    expect(recovered.integrity.gaps).toContain(`${path}: line 4 is not a JSON record`)
    await expect(readCodexRollout(path, { corruption: 'strict' })).rejects.toMatchObject({
      name: 'SessionParseError',
    })
    expect(() =>
      parseCodexRollout(
        [...lines.slice(0, 3), '{bad json', ...lines.slice(3)].join('\n'),
        { label: path, nativeSessionId: SESSION_ID },
        { corruption: 'strict' },
      ),
    ).toThrow('malformed JSON')
  })

  it('redacts caller-designated sensitive text before ledger export while keeping native tool linkage', async () => {
    const secret = 'codex-fixture-only-sensitive-value'
    const raw = (await readFile(FIXTURE, 'utf8')).replaceAll(
      'TRACEPROOF-WORKER-CODEX-TOOL-OUTPUT',
      `TRACEPROOF-WORKER-CODEX-TOOL-OUTPUT ${secret}`,
    )
    const path = join(dir, `sensitive-${SESSION_ID}.jsonl`)
    await writeFile(path, raw)
    const source = await readCodexRollout(path)
    const redacted = redactForShare(source.messages, { knownSecrets: [secret] })
    expect(shareAllowed(redacted.verdict)).toBe(true)
    expect(redacted.report.redactionCount).toBeGreaterThan(0)
    const ledgerPath = join(dir, 'redacted-rollouts.jsonl')
    await writeRolloutLedger(ledgerPath, [unlabeledLine({ ...source, messages: redacted.value })])
    expect(await readFile(ledgerPath, 'utf8')).not.toContain(secret)
    const rows = await readRolloutLedger(ledgerPath)
    expect(
      rows[0]!.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.id),
    ).toEqual(CALL_IDS)
    expect(await readFile(path, 'utf8')).toBe(raw)
    expect(toSftRows(rows)).toEqual([])
  })

  it('does not invent usage or tool results for an incomplete capture, and marks a torn tail', async () => {
    const lines = (await readFile(FIXTURE, 'utf8')).trimEnd().split('\n')
    const pendingPath = join(dir, `pending-${SESSION_ID}.jsonl`)
    await writeFile(pendingPath, lines.slice(0, 6).join('\n') + '\n')
    const pending = await readCodexRollout(pendingPath)
    expect(pending.ending.status).toBe('open')
    expect(pending.usage).toBeNull()
    expect(
      pending.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.id),
    ).toEqual([CALL_IDS[0]])
    expect(pending.messages.some((message) => message.role === 'tool')).toBe(false)
    const tornPath = join(dir, `torn-${SESSION_ID}.jsonl`)
    await writeFile(tornPath, lines.join('\n') + '\n{')
    const torn = await readCodexRollout(tornPath)
    expect(torn.integrity.truncated).toBe(true)
    expect(torn.integrity.gaps).toContain(
      `${tornPath}: last record was still being written when the copy was taken`,
    )
    expect(torn.usage?.input).toBe(300)
    expect(torn.usage?.cacheRead).toBe(0)
    expect(torn.integrity.unparsedRecords).toBe(0)
  })
})
