/** Canonical capture -> durable journal -> the public training formats and their admission receipt. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { compareCodeUnits, hashCanonical, jsonDocument } from '../src/ledger-core/canonical'
import {
  buildRlDataset,
  type PreferenceTriple,
  toDpoRows,
  toGrpoRows,
  toSftRowsWithLookups,
} from '../src/rl'
import {
  admitRolloutBatch,
  assertMinted,
  type ChatMessage,
  mintRolloutRows,
  type RolloutLine,
  readRolloutJournal,
  readRolloutLedger,
  type TrainingAdmission,
  toSftRows,
} from '../src/rollout'
import { fixtureRolloutLine } from '../src/rollout/fixtures'
import type { RunRecord } from '../src/run-record'
import { InMemoryTraceStore } from '../src/trace/store'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'training-contract-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const record: RunRecord = {
  runId: 'captured',
  experimentId: 'capture',
  candidateId: 'candidate',
  scenarioId: 'task',
  seed: 1,
  splitTag: 'search',
  model: 'test-model@2026-01-01',
  promptHash: 'a'.repeat(64),
  configHash: 'b'.repeat(64),
  commitSha: 'c'.repeat(40),
  wallMs: 10,
  costUsd: null,
  costProvenance: { kind: 'uncaptured', usd: null },
  tokenUsage: { input: 10, output: 5 },
  terminalOutcome: 'succeeded',
  outcome: { searchScore: 1, raw: {}, realness: { score: 1, gated: false } },
}

it('retains copied tool conditioning, masks its assistant loss, and carries captured tool definitions', async () => {
  const capture = fixtureRolloutLine()
  const messages: ChatMessage[] = capture.messages.map((message, index) => ({
    ...message,
    ...(index < 3 ? { is_copied_context: true } : {}),
  }))
  const { rows } = await mintRolloutRows([record], new InMemoryTraceStore(), {
    messagesOf: () => messages,
    toolDefsOf: () => capture.tool_defs,
    now: () => new Date('2026-11-01T00:00:00Z'),
  })
  const identity = {
    key: record.runId,
    sourceDigest: hashCanonical(record),
    projection: 'capture/v1',
  }
  const admitted = admitRolloutBatch(directory, identity, rows)
  const read = await readRolloutLedger(admitted.receipt.path)
  expect(read[0]!.messages).toEqual(messages)
  expect(admitRolloutBatch(directory, identity, rows).disposition).toBe('existing')
  const [sft] = toSftRows(read)
  expect(sft!.messages.map((message) => message.content)).toEqual(
    messages.map((message) => message.content),
  )
  expect(sft!.messages[2]).toMatchObject({ weight: 0, tool_calls: messages[2]!.tool_calls })
  expect(sft!.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
  expect(sft!.messages[4]).toMatchObject({ weight: 1 })
  expect(sft!.messages.every((message) => message.is_copied_context === undefined)).toBe(true)
  expect(sft!.tools).toEqual(capture.tool_defs)
  const withoutTools = assertMinted({ ...read[0]!, tool_defs: [] })
  const withoutParameters = assertMinted({
    ...read[0]!,
    tool_defs: capture.tool_defs.map((tool) => ({
      ...tool,
      function: { name: tool.function.name },
    })),
  })
  const mismatched = assertMinted({
    ...read[0]!,
    tool_defs: [
      { type: 'function', function: { name: 'different', parameters: { type: 'object' } } },
    ],
  })
  expect(toSftRows([withoutTools, withoutParameters, mismatched])).toEqual([])
  expect(
    await toSftRowsWithLookups([withoutTools, withoutParameters, mismatched], {
      promptOf: () => 'unused',
      completionOf: () => 'unused',
    }),
  ).toEqual([])
  expect(() =>
    admitRolloutBatch(directory, { ...identity, projection: 'capture/v2' }, rows),
  ).toThrow(/different source or projection/)

  // The journal also retains unscreened claims and incomplete attempts. It does not mint them.
  const unapproved: RolloutLine = {
    ...rows[0]!,
    rollout_id: 'unapproved',
    outcome: { ...rows[0]!.outcome, realness_screened: false },
  }
  const raw = admitRolloutBatch(directory, { ...identity, key: 'unapproved' }, [unapproved])
  expect(await readRolloutJournal(raw.receipt.path)).toEqual([unapproved])
  await expect(readRolloutLedger(raw.receipt.path)).rejects.toThrow(/realness_screened/)
})

it('applies split and capture admission even to supplied pairs, and accounts for exclusions beside emitted rows', async () => {
  const base = fixtureRolloutLine()
  const line = (id: string, changes: Partial<RolloutLine> = {}) =>
    assertMinted({ ...base, rollout_id: id, run_id: id, ...changes })
  const good = line('good')
  const failed = line('failed', {
    outcome: { ...base.outcome, reward: 0, error: 'verification failed' },
  })
  const holdout = line('holdout', { task: { ...base.task, split: 'holdout' } })
  const dev = line('dev', { task: { ...base.task, split: 'dev' } })
  const canary = line('canary', { task: { ...base.task, split: 'canary' } })
  const lossy = line('lossy', {
    provenance: { ...base.provenance, lossy_projection: true, gap: 'second attempt unavailable' },
  })
  const truncated = line('truncated', { outcome: { ...base.outcome, is_truncated: true } })
  const error = line('error', {
    outcome: { ...base.outcome, error: 'claimed success despite executor error' },
  })
  const lines = [good, failed, holdout, dev, canary, lossy, truncated, error]
  const pair = (rejectedRunId: string): PreferenceTriple => ({
    scenarioId: base.task.instance_id,
    chosenRunId: 'good',
    rejectedRunId,
    chosenVariantId: 'A',
    rejectedVariantId: 'B',
    marginScore: 1,
    meta: {
      chosenPromptHash: 'p',
      rejectedPromptHash: 'p',
      chosenConfigHash: 'c',
      rejectedConfigHash: 'c',
      chosenModel: 'm',
      rejectedModel: 'm',
    },
  })
  const lookups = { promptOf: () => 'same task', completionOf: (id: string) => `completion ${id}` }
  const decisions: TrainingAdmission[] = []
  const triples = lines.slice(1).map((item) => pair(item.rollout_id))
  expect(
    await toDpoRows(triples, lookups, {
      lines,
      onAdmission: (decision) => decisions.push(decision),
    }),
  ).toHaveLength(1)
  expect(
    new Set(
      decisions.filter((decision) => decision.reason !== null).map((decision) => decision.reason),
    ),
  ).toEqual(new Set(['split', 'lossy-capture', 'truncated', 'execution-error']))
  expect((await toGrpoRows(lines, { ...lookups, onAdmission: () => {} }))[0]!.runIds).toEqual([
    'good',
    'failed',
  ])
  expect(
    await toDpoRows([pair('holdout')], lookups, { lines, allowHeldOutTrainingData: true }),
  ).toHaveLength(1)

  const bundle = await buildRlDataset(
    lines,
    lookups,
    {
      name: 'contract',
      version: '1',
      domain: 'capture',
      license: 'MIT',
      createdAtIso: '2026-11-01T00:00:00Z',
      reward: { kind: 'deterministic', source: 'verification', description: 'captured verdict' },
      intendedUse: 'training',
      outOfScope: 'held-out evaluation',
      limitations: 'fixture corpus',
      formats: ['sft', 'grpo', 'dpo'],
    },
    { triples, lookups },
  )
  await expect(
    buildRlDataset([good, { ...good, outcome: failed.outcome }], lookups, bundle.manifest),
  ).rejects.toThrow(/duplicate rollout_id/)
  expect(bundle.manifest.rowCounts).toEqual({ sft: 1, grpo: 1, dpo: 1 })
  expect(bundle.manifest.sourceSha256).toBe(
    hashCanonical(lines.map((line) => hashCanonical(jsonDocument(line))).sort(compareCodeUnits)),
  )
  expect(bundle.manifest.admission?.grpo).toMatchObject({
    considered: 8,
    eligible: 2,
    excluded: 6,
    reasons: { split: 3, 'lossy-capture': 1 },
  })
  const audit = bundle.files['admission.jsonl']!.trim()
    .split('\n')
    .map((row) => JSON.parse(row))
  expect(audit.filter((decision) => decision.format === 'sft')).toHaveLength(8)
  expect(
    audit.some((decision) => decision.rollout_id === 'holdout' && decision.reason === 'split'),
  ).toBe(true)
})
