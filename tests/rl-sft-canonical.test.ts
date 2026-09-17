import { describe, expect, it } from 'vitest'
import { buildRlDataset, type RlDatasetConfig } from '../src/rl/dataset'
import { type SftLookups, toGrpoRows, toSftRows } from '../src/rl/exporters'
import { toSftRows as canonicalSftRows } from '../src/rollout/exporters'
import { fixtureRolloutLine } from '../src/rollout/fixtures'
import type { ChatMessage, MintedRolloutLine, RolloutSplit } from '../src/rollout/schema'

// The `/rl` SFT exporter is an adapter over `rollout/exporters.toSftRows`: a
// captured transcript ships as captured, tool turns included, and the text
// lookups only recover gap lines. A regression here either destroys captured
// tool conversations at packaging time or manufactures an imitation target
// from lookups for a line the canonical policy refused.

const config: RlDatasetConfig = {
  name: 'captured-tool-conversations',
  version: '1',
  domain: 'test',
  license: 'MIT',
  reward: { kind: 'deterministic', source: 'fixture', description: 'Test fixture only' },
  intendedUse: 'Regression testing',
  outOfScope: 'Training a real model',
  limitations: 'Synthetic fixture, not execution evidence',
  createdAtIso: '2026-09-17T00:00:00.000Z',
  formats: ['sft'],
}

/** Lookups that fail the test if a captured line ever consults them. */
const noLookups: SftLookups = {
  promptOf: () => {
    throw new Error('prompt lookup must not run')
  },
  completionOf: () => {
    throw new Error('completion lookup must not run')
  },
  systemOf: () => {
    throw new Error('system lookup must not run')
  },
}

const textLookups: SftLookups = {
  promptOf: async () => 'Legacy prompt',
  completionOf: async () => 'Legacy completion',
  systemOf: () => 'Legacy system',
}

const recoveredMessages: ChatMessage[] = [
  { role: 'system', content: 'Legacy system' },
  { role: 'user', content: 'Legacy prompt' },
  { role: 'assistant', content: 'Legacy completion' },
]

function withOutcome(overrides: Partial<MintedRolloutLine['outcome']>): MintedRolloutLine {
  const base = fixtureRolloutLine()
  return fixtureRolloutLine({ outcome: { ...base.outcome, ...overrides } })
}

function gapLine(): MintedRolloutLine {
  const base = fixtureRolloutLine()
  return fixtureRolloutLine({
    messages: [],
    provenance: { ...base.provenance, gap: 'Legacy corpus did not retain a transcript' },
  })
}

function splitLine(split: RolloutSplit): MintedRolloutLine {
  const base = fixtureRolloutLine()
  return fixtureRolloutLine({ task: { ...base.task, split } })
}

describe('rl/toSftRows over captured transcripts', () => {
  it('ships a captured tool conversation to the SFT JSONL line byte-for-byte', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a coding worker.' },
      { role: 'user', content: 'Fix the misleading exception in TimeSeries.' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'Read the module before editing it.',
        tool_calls: [
          {
            id: 'call_read',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"astropy/timeseries/core.py"}' },
          },
          {
            id: 'call_edit',
            type: 'function',
            function: { name: 'edit', arguments: '{"filePath":"core.py","patch":"@@ -1 +1 @@"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read', name: 'read', content: 'class BaseTimeSeries:' },
      { role: 'tool', tool_call_id: 'call_edit', name: 'edit', content: null },
      { role: 'assistant', content: `Patched. ${'x'.repeat(8192)}` },
    ]
    const line = fixtureRolloutLine({ messages })
    const before = JSON.stringify(line)

    const bundle = await buildRlDataset([line], noLookups, config)
    const jsonl = bundle.files['train.sft.jsonl']!

    // The published line carries the captured transcript verbatim: the same
    // bytes `JSON.stringify` produces for the line's own `messages`.
    const expectedMessages = JSON.stringify(messages)
    expect(jsonl.startsWith(`{"messages":${expectedMessages},"meta":`)).toBe(true)
    expect(jsonl.endsWith('\n')).toBe(true)
    const row = JSON.parse(jsonl)
    expect(JSON.stringify(row.messages)).toBe(expectedMessages)
    expect(row.messages).toEqual(canonicalSftRows([line])[0]!.messages)
    expect(row.meta).toEqual({
      runId: line.run_id,
      rolloutId: line.rollout_id,
      candidateId: line.candidate_id,
      scenarioId: line.task.instance_id,
      score: line.outcome.reward,
      model: line.policy.model,
      transcriptSource: 'captured',
      captureGap: null,
      realness_gated: false,
      realness_screened: null,
    })
    expect(bundle.manifest.rowCounts.sft).toBe(1)
    expect(JSON.stringify(line)).toBe(before)
  })

  it('preserves distinct invocation transcripts sharing one run id', async () => {
    const first = fixtureRolloutLine({ rollout_id: 'worker-one', run_id: 'episode' })
    const second = fixtureRolloutLine({
      rollout_id: 'worker-two',
      run_id: 'episode',
      messages: [
        { role: 'user', content: 'Second task' },
        { role: 'assistant', content: 'Second answer' },
      ],
    })
    const rows = await toSftRows([first, second], noLookups)
    expect(rows.map((row) => row.meta?.rolloutId)).toEqual(['worker-one', 'worker-two'])
    expect(rows.map((row) => row.messages)).toEqual([first.messages, second.messages])
  })

  it('removes copied context without replacing the captured conversation', async () => {
    const base = fixtureRolloutLine()
    const line = fixtureRolloutLine({
      messages: [
        { role: 'assistant', content: 'Another invocation wrote this', is_copied_context: true },
        ...base.messages,
      ],
    })
    const rows = await toSftRows([line], noLookups)
    expect(rows[0]!.messages).toEqual(base.messages)
    expect(line.messages).toHaveLength(base.messages.length + 1)
  })

  it('refuses an empty dataset when every captured turn is copied context', async () => {
    const line = fixtureRolloutLine({
      messages: [{ role: 'assistant', content: 'Not this invocation', is_copied_context: true }],
    })
    expect(await toSftRows([line], textLookups)).toEqual([])
    await expect(buildRlDataset([line], textLookups, config)).rejects.toThrow(/no trainable rows/)
  })

  it('recovers a gap line from the text lookups and labels the recovery', async () => {
    const gap = gapLine()
    expect((await toSftRows([gap], textLookups))[0]!.messages).toEqual(recoveredMessages)

    const bundle = await buildRlDataset([gap], textLookups, config)
    const recovered = JSON.parse(bundle.files['train.sft.jsonl']!)
    expect(recovered.messages).toEqual(recoveredMessages)
    expect(recovered.meta.transcriptSource).toBe('lookups')
    expect(recovered.meta.captureGap).toBe(gap.provenance.gap)
    expect(recovered.meta.realness_screened).toBeNull()
    expect(gap.messages).toEqual([])
  })

  it('rejects missing or malformed recovered text rather than publishing a target', async () => {
    for (const override of [
      { promptOf: () => '' },
      { completionOf: () => '  ' },
      { promptOf: () => undefined as unknown as string },
      { completionOf: () => undefined as unknown as string },
      { systemOf: () => 1 as unknown as string },
    ]) {
      await expect(
        buildRlDataset([gapLine()], { ...textLookups, ...override }, config),
      ).rejects.toThrow(/invalid text lookups/)
    }
  })

  it('preserves unknown screening as unknown and retains screened verdicts', async () => {
    const unknown = fixtureRolloutLine()
    const screened = withOutcome({ realness_screened: true })
    const rows = await toSftRows([unknown, screened], noLookups)
    expect(rows.map((row) => row.meta?.realness_screened)).toEqual([null, true])
    expect(rows.map((row) => row.meta?.realness_gated)).toEqual([false, false])
  })

  it('shares canonical eligibility for unsuccessful and held-out lines', async () => {
    const ineligible = [
      withOutcome({ reward: null }),
      withOutcome({ reward: 0 }),
      withOutcome({ is_completed: false }),
      withOutcome({ is_truncated: true }),
      withOutcome({ error: 'execution failed' }),
      withOutcome({ reward: 0, realness_gated: true }),
      splitLine('dev'),
      splitLine('canary'),
      splitLine('holdout'),
    ]
    expect(canonicalSftRows(ineligible)).toEqual([])
    expect(await toSftRows(ineligible, noLookups)).toEqual([])
    // Ineligible gap lines never reach the lookups either.
    const gap = gapLine()
    const ineligibleGap = fixtureRolloutLine({ ...gap, task: { ...gap.task, split: 'dev' } })
    expect(await toSftRows([ineligibleGap], noLookups)).toEqual([])
  })

  it('shares explicit split selection without relaxing the default', async () => {
    const lines = [splitLine('search'), splitLine('holdout'), splitLine('dev')]
    for (const options of [
      {},
      { allowHeldOutTrainingData: true },
      { splitFilter: ['holdout'] as RolloutSplit[] },
      { splitFilter: ['dev'] as RolloutSplit[] },
      { splitFilter: [] as RolloutSplit[] },
    ]) {
      const rows = await toSftRows(lines, { ...noLookups, ...options })
      expect(rows.map((row) => row.messages)).toEqual(
        canonicalSftRows(lines, options).map((row) => row.messages),
      )
      expect(rows).toHaveLength(
        options.splitFilter?.length ?? (options.allowHeldOutTrainingData ? 2 : 1),
      )
    }
  })

  it('retains GRPO explicit split behavior after sharing the selector', async () => {
    const base = splitLine('dev')
    const lines = [base, { ...base, rollout_id: 'other', run_id: 'other' }]
    expect(await toGrpoRows(lines, textLookups)).toEqual([])
    const rows = await toGrpoRows(lines, { ...textLookups, splitFilter: ['dev'] })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.rewards).toEqual([1, 1])
  })

  it('honors the extra filter and exclusive threshold before text recovery', async () => {
    expect(await toSftRows([gapLine()], { ...noLookups, include: () => false })).toEqual([])
    const line = withOutcome({ reward: 0.5 })
    expect(await toSftRows([line], { ...noLookups, minimumQualityExclusive: 0.5 })).toEqual([])
    expect(await toSftRows([line], { ...noLookups, minimumQualityExclusive: 0.49 })).toHaveLength(1)
    for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        toSftRows([line], { ...noLookups, minimumQualityExclusive: threshold }),
      ).rejects.toThrow(/must be finite/)
    }
  })

  it('rejects poisoned rewards before filtering or looking up text', async () => {
    const base = fixtureRolloutLine()
    for (const outcome of [
      { ...base.outcome, realness_gated: true },
      { ...base.outcome, realness_screened: false },
      { ...base.outcome, reward: Number.POSITIVE_INFINITY },
      { ...base.outcome, reward: Number.NaN },
      { ...base.outcome, reward: '1' as unknown as number },
    ]) {
      const forged = { ...base, outcome }
      await expect(toSftRows([forged], noLookups)).rejects.toThrow()
    }
    await expect(
      toSftRows([{ ...base, outcome: { ...base.outcome, realness_gated: true } }], {
        ...noLookups,
        include: () => false,
      }),
    ).rejects.toThrow()
  })
})
