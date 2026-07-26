import { describe, expect, it } from 'vitest'
import {
  stepRewardsToJsonl,
  toDpoJsonl,
  toDpoRows,
  toGrpoJsonl,
  toGrpoRows,
  toPrmJsonl,
  toPrmRows,
  toSftJsonl,
  toSftRows,
} from '../src/rl/exporters'
import type { PreferenceTriple } from '../src/rl/preferences'
import type { PrmTrainingTriple, StepReward } from '../src/rl/process-reward'
import { fixtureRolloutLine } from '../src/rollout/fixtures'
import { assertMinted, type MintedRolloutLine, type RolloutSplit } from '../src/rollout/schema'

const baseTriple: PreferenceTriple = {
  scenarioId: 's1',
  chosenRunId: 'run-A',
  rejectedRunId: 'run-B',
  chosenVariantId: 'A',
  rejectedVariantId: 'B',
  marginScore: 0.2,
  scores: { chosen: 0.8, rejected: 0.6 },
  meta: {
    chosenPromptHash: 'p-A',
    rejectedPromptHash: 'p-B',
    chosenConfigHash: 'c-A',
    rejectedConfigHash: 'c-B',
    chosenModel: 'm',
    rejectedModel: 'm',
  },
}

const BASE = fixtureRolloutLine()

function line(args: {
  runId: string
  scenarioId: string
  score?: number
  candidateId?: string
  promptHash?: string
  split?: RolloutSplit
  completed?: boolean
}): MintedRolloutLine {
  const score = args.score ?? null
  return fixtureRolloutLine({
    rollout_id: args.runId,
    run_id: args.runId,
    candidate_id: args.candidateId ?? 'A',
    task: {
      ...BASE.task,
      instance_id: args.scenarioId,
      split: args.split ?? 'search',
      seed: 0,
    },
    policy: {
      ...BASE.policy,
      model: 'm@1',
      prompt_hash: args.promptHash ?? 'p'.repeat(64),
      config_hash: 'c'.repeat(64),
    },
    outcome: {
      ...BASE.outcome,
      reward: score,
      reward_source: score === null ? 'test/unscored' : 'test/reward',
      is_completed: args.completed ?? true,
      error: args.completed === false ? 'run failed' : null,
    },
  })
}

/**
 * Minted lines for the runs a line-less artifact names — the gate context every
 * such exporter now requires. A triple carries run ids and a bare number; these
 * are what let the exporter see whether either run faked its success.
 */
const linesFor = (...runIds: string[]): MintedRolloutLine[] =>
  runIds.map((run_id) =>
    fixtureRolloutLine({
      run_id,
      rollout_id: `rollout-${run_id}`,
      steps: [{ kind: 'tool', name: 'compile', status: 'ok' }],
    }),
  )

/** The same line, flagged by the authenticity gate. */
const gatedLinesFor = (...runIds: string[]): MintedRolloutLine[] =>
  linesFor(...runIds).map((line) =>
    assertMinted({ ...line, outcome: { ...line.outcome, reward: 0, realness_gated: true } }),
  )

describe('toDpoRows', () => {
  it('produces TRL-compatible {prompt, chosen, rejected} rows', async () => {
    const promptOf = () => 'shared prompt'
    const completionOf = (id: string) => `completion for ${id}`
    const rows = await toDpoRows(
      [baseTriple],
      { promptOf, completionOf },
      {
        lines: linesFor('run-A', 'run-B'),
      },
    )
    expect(rows[0]).toMatchObject({
      prompt: 'shared prompt',
      chosen: 'completion for run-A',
      rejected: 'completion for run-B',
      margin: 0.2,
    })
    expect(rows[0]?.meta?.scenarioId).toBe('s1')
  })

  it('toDpoJsonl emits one line per row terminated by newline', () => {
    const jsonl = toDpoJsonl([
      { prompt: 'p', chosen: 'c', rejected: 'r' },
      { prompt: 'p2', chosen: 'c2', rejected: 'r2' },
    ])
    expect(jsonl).toBe(
      '{"prompt":"p","chosen":"c","rejected":"r"}\n{"prompt":"p2","chosen":"c2","rejected":"r2"}\n',
    )
  })

  it('handles async lookups (Promise-returning callbacks)', async () => {
    const rows = await toDpoRows(
      [baseTriple],
      {
        promptOf: async () => '[async] prompt',
        completionOf: async (id) => `[async-c] ${id}`,
      },
      { lines: linesFor('run-A', 'run-B') },
    )
    expect(rows[0]?.prompt).toBe('[async] prompt')
    expect(rows[0]?.chosen).toBe('[async-c] run-A')
  })

  const dpoLookups = {
    promptOf: (id: string) => `prompt for ${id}`,
    completionOf: (id: string) => `completion for ${id}`,
  }

  it('rejects a preference whose runs resolve to different prompts', async () => {
    await expect(
      toDpoRows([baseTriple], dpoLookups, { lines: linesFor('run-A', 'run-B') }),
    ).rejects.toThrow(/resolves to different prompts/)
  })

  it('drops a pair whose CHOSEN side is realness-gated — DPO would learn to prefer it', async () => {
    const lines = [...gatedLinesFor('run-A'), ...linesFor('run-B')]
    expect(await toDpoRows([baseTriple], dpoLookups, { lines })).toEqual([])
  })

  it('drops a pair whose REJECTED side is realness-gated — a gamed trajectory ships on neither side', async () => {
    const lines = [...linesFor('run-A'), ...gatedLinesFor('run-B')]
    expect(await toDpoRows([baseTriple], dpoLookups, { lines })).toEqual([])
  })

  it('refuses a triple naming a run with no supplied line (gate status unknown)', async () => {
    await expect(toDpoRows([baseTriple], dpoLookups, { lines: linesFor('run-A') })).rejects.toThrow(
      /no rollout line supplied for run run-B/,
    )
  })

  it('refuses to export without a line context — it cannot see the gate there', async () => {
    const untyped = toDpoRows as unknown as (
      triples: PreferenceTriple[],
      lookups: typeof dpoLookups,
    ) => Promise<unknown>
    await expect(untyped([baseTriple], dpoLookups)).rejects.toThrow(/a DpoLineContext is required/)
  })
})

describe('toGrpoRows', () => {
  it('groups scored search lines by scenario', async () => {
    const lines = [
      line({ runId: 'a-1', scenarioId: 's1', score: 0.7, candidateId: 'A' }),
      line({ runId: 'b-1', scenarioId: 's1', score: 0.5, candidateId: 'B' }),
      line({ runId: 'a-2', scenarioId: 's2', score: 0.9, candidateId: 'A' }),
    ]
    const rows = await toGrpoRows(lines, {
      promptOf: (id) => (id.endsWith('-1') ? 'prompt-s1' : 'prompt-s2'),
      completionOf: (id) => `completion-${id}`,
    })
    expect(rows).toHaveLength(1)
    const s1 = rows.find((r) => r.meta?.scenarioId === 's1')!
    expect(s1.completions).toHaveLength(2)
    expect(s1.rewards).toEqual([0.7, 0.5])
  })

  it('skips groups with fewer than two scored completions', async () => {
    const scored = line({ runId: 'scored', scenarioId: 's', score: 0.8 })
    const unscored = line({ runId: 'unscored', scenarioId: 's' })

    const rows = await toGrpoRows([scored, unscored], {
      promptOf: () => 'p',
      completionOf: () => 'c',
    })

    expect(rows).toEqual([])
  })

  it('rejects one scenario resolving to different prompt text', async () => {
    const lines = [
      line({ runId: 'a', scenarioId: 's', score: 0.8 }),
      line({ runId: 'b', scenarioId: 's', score: 0.7 }),
    ]

    await expect(
      toGrpoRows(lines, {
        promptOf: (id) => `prompt-${id}`,
        completionOf: (id) => `completion-${id}`,
      }),
    ).rejects.toThrow(/resolves to different prompt text/)
  })

  it('requires explicit consent before using held-out lines', async () => {
    const lines = [
      line({ runId: 'a', scenarioId: 's', score: 0.8, split: 'holdout' }),
      line({ runId: 'b', scenarioId: 's', score: 0.7, split: 'holdout' }),
    ]
    const lookups = {
      promptOf: () => 'prompt',
      completionOf: (id: string) => `completion-${id}`,
    }

    expect(await toGrpoRows(lines, lookups)).toEqual([])
    expect(await toGrpoRows(lines, { ...lookups, allowHeldOutTrainingData: true })).toHaveLength(1)
  })
})

describe('toSftRows', () => {
  it('produces conversational messages format with system + user + assistant', async () => {
    const lines = [line({ runId: 'a', scenarioId: 's', score: 0.9 })]
    const rows = await toSftRows(lines, {
      promptOf: (id) => `user-prompt-${id}`,
      completionOf: (id) => `assistant-${id}`,
      systemOf: () => 'You are helpful.',
    })
    expect(rows[0]?.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'user-prompt-a' },
      { role: 'assistant', content: 'assistant-a' },
    ])
  })

  it('include callback filters lines', async () => {
    const lines = [
      line({ runId: 'good', scenarioId: 's', score: 0.95 }),
      line({ runId: 'bad', scenarioId: 's', score: 0.2 }),
    ]
    const rows = await toSftRows(lines, {
      promptOf: () => 'p',
      completionOf: () => 'c',
      include: (rollout) => (rollout.outcome.reward ?? 0) >= 0.5,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.meta?.runId).toBe('good')
  })

  it('omits system message when systemOf returns null', async () => {
    const lines = [line({ runId: 'a', scenarioId: 's', score: 0.5 })]
    const rows = await toSftRows(lines, {
      promptOf: () => 'p',
      completionOf: () => 'c',
      systemOf: () => null,
    })
    expect(rows[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('defaults to positive, completed search lines', async () => {
    const search = line({ runId: 'search', scenarioId: 's', score: 0.8 })
    const dev = line({ runId: 'dev', scenarioId: 's', score: 0.7, split: 'dev' })
    const zero = line({ runId: 'zero', scenarioId: 's', score: 0 })
    const unscored = line({ runId: 'unscored', scenarioId: 's' })
    const failed = line({
      runId: 'failed',
      scenarioId: 's',
      score: 1,
      completed: false,
    })
    const holdout = line({
      runId: 'holdout',
      scenarioId: 's',
      score: 1,
      split: 'holdout',
    })
    const base = {
      promptOf: () => 'p',
      completionOf: () => 'c',
    }

    const rows = await toSftRows([search, dev, zero, unscored, failed, holdout], base)
    expect(rows.map((row) => row.meta?.runId)).toEqual(['search'])
  })

  it('requires explicit consent before using held-out lines', async () => {
    const holdout = line({
      runId: 'holdout',
      scenarioId: 's',
      score: 1,
      split: 'holdout',
    })
    const base = {
      promptOf: () => 'p',
      completionOf: () => 'c',
    }

    expect(await toSftRows([holdout], base)).toEqual([])
    const rows = await toSftRows([holdout], {
      ...base,
      allowHeldOutTrainingData: true,
    })
    expect(rows.map((row) => row.meta?.runId)).toEqual(['holdout'])
  })
})

describe('toPrmRows', () => {
  // `toPrmRows` requires the minted lines for every run its triples name: a
  // triple carries a bare `chosenReward` number, so without them the exporter
  // cannot see the realness gate or tell a complete trajectory from a capped
  // one. These are ungated, fully-captured lines — the case that exports.
  const prmLines = (...runIds: string[]): MintedRolloutLine[] =>
    runIds.map((run_id) =>
      fixtureRolloutLine({
        run_id,
        rollout_id: `rollout-${run_id}`,
        steps: [{ kind: 'tool', name: 'compile', status: 'ok' }],
      }),
    )

  it('produces PRM training rows with prefix + chosen/rejected', async () => {
    const triples: PrmTrainingTriple[] = [
      {
        prefixRunId: 'prefix-run',
        prefixStepIndex: 1,
        chosenSpanId: 'chosen-step',
        chosenReward: 0.9,
        rejectedSpanId: 'rejected-step',
        rejectedReward: 0.3,
        rejectedRunId: 'other-run',
        marginScore: 0.6,
      },
    ]
    const rows = await toPrmRows(
      triples,
      {
        promptOf: (id) => `p:${id}`,
        stepTextOf: (rid, sid) => `step:${rid}/${sid}`,
        prefixOf: () => ['span-0', 'span-1'],
      },
      { lines: prmLines('prefix-run', 'other-run') },
    )
    expect(rows[0]?.prompt).toBe('p:prefix-run')
    expect(rows[0]?.prefixStepText).toEqual(['step:prefix-run/span-0', 'step:prefix-run/span-1'])
    expect(rows[0]?.chosenStep).toBe('step:prefix-run/chosen-step')
    expect(rows[0]?.rejectedStep).toBe('step:other-run/rejected-step')
    expect(rows[0]?.marginScore).toBe(0.6)
  })

  it('omits prefix steps when prefixOf is not supplied', async () => {
    const triples: PrmTrainingTriple[] = [
      {
        prefixRunId: 'r',
        prefixStepIndex: 0,
        chosenSpanId: 'c',
        chosenReward: 1,
        rejectedSpanId: 'rj',
        rejectedReward: 0,
        rejectedRunId: 'r',
        marginScore: 1,
      },
    ]
    const rows = await toPrmRows(
      triples,
      {
        promptOf: () => 'p',
        stepTextOf: () => 's',
      },
      { lines: prmLines('r') },
    )
    expect(rows[0]?.prefixSpanIds).toEqual([])
    expect(rows[0]?.prefixStepText).toEqual([])
  })
})

describe('stepRewardsToJsonl + JSONL helpers', () => {
  it('serializes step rewards as JSONL', () => {
    const stepRewards: StepReward[] = [
      {
        spanId: 'sp',
        runId: 'r',
        stepIndex: 0,
        kind: 'tool',
        name: 'compile',
        reward: 0.8,
        determinism: 'deterministic',
        weight: 1,
      },
    ]
    const jsonl = stepRewardsToJsonl(stepRewards, { lines: linesFor('r') })
    expect(jsonl.trim().split('\n')).toHaveLength(1)
    const parsed = JSON.parse(jsonl.trim())
    expect(parsed).toMatchObject({
      spanId: 'sp',
      runId: 'r',
      stepIndex: 0,
      reward: 0.8,
      determinism: 'deterministic',
    })
  })

  it('drops the steps of a realness-gated run — the per-step rewards are the reward in pieces', () => {
    const stepRewards: StepReward[] = [
      {
        spanId: 'sp',
        runId: 'r',
        stepIndex: 0,
        kind: 'tool',
        name: 'compile',
        reward: 0.8,
        determinism: 'deterministic',
        weight: 1,
      },
    ]
    expect(stepRewardsToJsonl(stepRewards, { lines: gatedLinesFor('r') })).toBe('')
  })

  it('refuses to serialize step rewards without a line context', () => {
    const untyped = stepRewardsToJsonl as unknown as (rewards: StepReward[]) => string
    expect(() => untyped([])).toThrow(/a RolloutLineContext is required/)
  })

  it('toGrpoJsonl, toSftJsonl, toPrmJsonl, toDpoJsonl all return empty string on empty input', () => {
    expect(toGrpoJsonl([])).toBe('')
    expect(toSftJsonl([])).toBe('')
    expect(toPrmJsonl([])).toBe('')
    expect(toDpoJsonl([])).toBe('')
  })
})
