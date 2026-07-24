import { describe, expect, it } from 'vitest'
import {
  toJsonl,
  toRewardRows,
  toRftItems,
  toSftRows,
  toVerifiersRolloutOutput,
  toVerifiersRolloutOutputs,
} from './exporters'
import { fixtureRolloutLine } from './fixtures'

describe('SFT exporter', () => {
  it('keeps only clean trainable successes with messages', () => {
    const keep = fixtureRolloutLine()
    const holdout = fixtureRolloutLine({ task: { ...keep.task, split: 'holdout' } })
    const failed = fixtureRolloutLine({ outcome: { ...keep.outcome, reward: 0 } })
    const partial = fixtureRolloutLine({ outcome: { ...keep.outcome, reward: 0.5 } })
    const unlabeled = fixtureRolloutLine({ outcome: { ...keep.outcome, reward: null } })
    const gated = fixtureRolloutLine({ outcome: { ...keep.outcome, realness_gated: true } })
    const gap = fixtureRolloutLine({
      messages: [],
      provenance: {
        captured_at: '2026-07-23T00:00:00.000Z',
        capture: 'backfill',
        gap: 'store unavailable',
      },
    })
    const rows = toSftRows([keep, holdout, failed, partial, unlabeled, gated, gap])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.messages).toEqual(keep.messages)
    expect(rows[0]!.metadata).toEqual({
      rollout_id: keep.rollout_id,
      run_id: keep.run_id,
      candidate_id: 'gen0-cand1',
      instance_id: 'astropy__astropy-13033',
      reward: 1,
    })
  })

  it('never leaks a holdout line even at reward 1 (fail-closed filter)', () => {
    const holdout = fixtureRolloutLine({ task: { ...fixtureRolloutLine().task, split: 'holdout' } })
    expect(toSftRows([holdout])).toHaveLength(0)
  })

  it('treats the legacy train split as trainable', () => {
    const legacy = fixtureRolloutLine({ task: { ...fixtureRolloutLine().task, split: 'train' } })
    expect(toSftRows([legacy])).toHaveLength(1)
  })

  it('toJsonl emits one JSON object per line with a trailing newline', () => {
    const out = toJsonl([{ a: 1 }, { b: 2 }])
    expect(out).toBe('{"a":1}\n{"b":2}\n')
    expect(toJsonl([])).toBe('')
  })
})

describe('reward-rows exporter', () => {
  it('keeps failures as signal with their scalar reward, drops unlabeled lines', () => {
    const success = fixtureRolloutLine()
    const failure = fixtureRolloutLine({ outcome: { ...success.outcome, reward: 0 } })
    const unlabeled = fixtureRolloutLine({ outcome: { ...success.outcome, reward: null } })
    const rows = toRewardRows([success, failure, unlabeled])
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.reward)).toEqual([1, 0])
    expect(rows[0]!.prompt).toBe('Fix the misleading exception in TimeSeries.')
    expect(rows[0]!.metadata.split).toBe('search')
  })
})

describe('verifiers RolloutOutput exporter', () => {
  it('splits prompt/completion at the first assistant turn', () => {
    const line = fixtureRolloutLine()
    const out = toVerifiersRolloutOutput(line)
    expect(out.prompt.map((m) => m.role)).toEqual(['system', 'user'])
    expect(out.completion.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(out.reward).toBe(1)
    expect(out.metrics).toEqual(line.outcome.metrics)
    expect(out.tool_defs).toEqual(line.tool_defs)
    expect(out.token_usage).toEqual({
      input_tokens: 79554,
      output_tokens: 19784,
      reasoning_tokens: 1200,
      cache_read_tokens: 6784,
      cache_write_tokens: 0,
    })
    expect(out.info.task).toEqual(line.task)
    expect(out.info.policy).toEqual(line.policy)
    expect(out.info.rollout_id).toBe(line.rollout_id)
    expect(out.info.candidate_id).toBe('gen0-cand1')
    expect(out.info.experiment_id).toBe('swe-arena-gen3')
  })

  it('drops gap lines (no transcript, nothing to verify)', () => {
    const gap = fixtureRolloutLine({
      messages: [],
      provenance: {
        captured_at: '2026-07-23T00:00:00.000Z',
        capture: 'backfill',
        gap: 'store unavailable',
      },
    })
    expect(toVerifiersRolloutOutputs([gap, fixtureRolloutLine()])).toHaveLength(1)
  })
})

describe('OpenAI RFT items exporter', () => {
  it('emits prompt turns plus verdict reference fields', () => {
    const line = fixtureRolloutLine()
    const [item] = toRftItems([line])
    expect(item!.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(item!.reference).toEqual({
      reward: 1,
      reward_source: 'swe-arena-official-judge/inherited',
      verdict: { iid: 'astropy__astropy-13033', resolved: true },
      instance_id: 'astropy__astropy-13033',
      suite: 'swe-bench-verified',
      split: 'search',
      rollout_id: line.rollout_id,
    })
  })

  it('skips lines whose transcript opens with an assistant turn (no prompt to grade)', () => {
    const line = fixtureRolloutLine()
    const assistantFirst = fixtureRolloutLine({ messages: line.messages.slice(2) })
    expect(toRftItems([assistantFirst])).toHaveLength(0)
  })
})
