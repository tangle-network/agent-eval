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
import type { RunRecord } from '../src/run-record'

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

function rec(args: {
  runId: string
  scenarioId: string
  score: number
  candidateId?: string
}): RunRecord {
  return {
    runId: args.runId,
    experimentId: 'e',
    candidateId: args.candidateId ?? 'A',
    seed: 0,
    model: 'm@1',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1,
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    outcome: { holdoutScore: args.score, raw: {} },
    splitTag: 'holdout',
    scenarioId: args.scenarioId,
  }
}

describe('toDpoRows', () => {
  it('produces TRL-compatible {prompt, chosen, rejected} rows', async () => {
    const promptOf = (id: string) => `prompt for ${id}`
    const completionOf = (id: string) => `completion for ${id}`
    const rows = await toDpoRows([baseTriple], { promptOf, completionOf })
    expect(rows[0]).toMatchObject({
      prompt: 'prompt for run-A',
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
    const rows = await toDpoRows([baseTriple], {
      promptOf: async (id) => `[async] ${id}`,
      completionOf: async (id) => `[async-c] ${id}`,
    })
    expect(rows[0]?.prompt).toBe('[async] run-A')
    expect(rows[0]?.chosen).toBe('[async-c] run-A')
  })
})

describe('toGrpoRows', () => {
  it('groups runs by scenarioId and produces one row per scenario', async () => {
    const runs = [
      rec({ runId: 'a-1', scenarioId: 's1', score: 0.7, candidateId: 'A' }),
      rec({ runId: 'b-1', scenarioId: 's1', score: 0.5, candidateId: 'B' }),
      rec({ runId: 'a-2', scenarioId: 's2', score: 0.9, candidateId: 'A' }),
    ]
    const rows = await toGrpoRows(runs, {
      promptOf: (id) => `prompt-${id}`,
      completionOf: (id) => `completion-${id}`,
    })
    expect(rows).toHaveLength(2)
    const s1 = rows.find((r) => r.meta?.scenarioId === 's1')!
    expect(s1.completions).toHaveLength(2)
    expect(s1.rewards).toEqual([0.7, 0.5])
  })

  it('honors a custom rewardOf callback', async () => {
    const runs = [rec({ runId: 'a', scenarioId: 's', score: 0.5 })]
    runs[0]!.outcome.raw.bonus = 0.3
    const rows = await toGrpoRows(runs, {
      promptOf: () => 'p',
      completionOf: () => 'c',
      rewardOf: (r) => r.outcome.raw.bonus ?? 0,
    })
    expect(rows[0]?.rewards).toEqual([0.3])
  })
})

describe('toSftRows', () => {
  it('produces conversational messages format with system + user + assistant', async () => {
    const runs = [rec({ runId: 'a', scenarioId: 's', score: 0.9 })]
    const rows = await toSftRows(runs, {
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

  it('include callback filters runs (rejection-sampling SFT)', async () => {
    const runs = [
      rec({ runId: 'good', scenarioId: 's', score: 0.95 }),
      rec({ runId: 'bad', scenarioId: 's', score: 0.2 }),
    ]
    const rows = await toSftRows(runs, {
      promptOf: () => 'p',
      completionOf: () => 'c',
      include: (r) => (r.outcome.holdoutScore ?? 0) >= 0.5,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.meta?.runId).toBe('good')
  })

  it('omits system message when systemOf returns null', async () => {
    const runs = [rec({ runId: 'a', scenarioId: 's', score: 0.5 })]
    const rows = await toSftRows(runs, {
      promptOf: () => 'p',
      completionOf: () => 'c',
      systemOf: () => null,
    })
    expect(rows[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('toPrmRows', () => {
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
    const rows = await toPrmRows(triples, {
      promptOf: (id) => `p:${id}`,
      stepTextOf: (rid, sid) => `step:${rid}/${sid}`,
      prefixOf: () => ['span-0', 'span-1'],
    })
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
    const rows = await toPrmRows(triples, {
      promptOf: () => 'p',
      stepTextOf: () => 's',
    })
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
    const jsonl = stepRewardsToJsonl(stepRewards)
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

  it('toGrpoJsonl, toSftJsonl, toPrmJsonl, toDpoJsonl all return empty string on empty input', () => {
    expect(toGrpoJsonl([])).toBe('')
    expect(toSftJsonl([])).toBe('')
    expect(toPrmJsonl([])).toBe('')
    expect(toDpoJsonl([])).toBe('')
  })
})
