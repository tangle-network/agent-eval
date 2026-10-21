import { describe, expect, it } from 'vitest'
import { toSftRows } from '../exporters'
import { fixtureRolloutLine, malformedRolloutLine } from '../fixtures'
import type { RolloutLine } from '../schema'
import { validateRolloutLine } from '../schema'
import {
  fromHarborTrajectory,
  type HarborTrajectory,
  toHarborTrajectory,
} from './harbor'

const CAPTURED_AT = '2026-07-23T00:00:00.000Z'
const now = () => new Date(CAPTURED_AT)

/** A supervisor with two workers — the multi-agent shape ATIF embeds and we flatten. */
function episode(): RolloutLine[] {
  const base = fixtureRolloutLine()
  const supervisor = fixtureRolloutLine({
    rollout_id: 'sup-1',
    parent_rollout_id: null,
    role: 'supervisor',
    messages: [
      { role: 'system', content: 'You supervise two coding workers.' },
      { role: 'user', content: 'Fix astropy__astropy-13033.' },
      { role: 'assistant', content: 'Delegating to workers.' },
    ],
  })
  const workerA = fixtureRolloutLine({ rollout_id: 'w-a', parent_rollout_id: 'sup-1' })
  const workerB = fixtureRolloutLine({
    rollout_id: 'w-b',
    parent_rollout_id: 'sup-1',
    messages: base.messages.slice(0, 2),
    outcome: { ...base.outcome, reward: 0 },
  })
  return [supervisor, workerA, workerB]
}





/**
 * RFC 0001 MUST rule 2, checked over the whole tree: every `source_call_id` in
 * an `ObservationResult` matches a `tool_call_id` in THAT step's `tool_calls`.
 * Returns the offending `trajectory#step:call` triples.
 */
function ruleTwoViolations(trajectory: HarborTrajectory): string[] {
  const bad: string[] = []
  for (const step of trajectory.steps) {
    const declared = new Set((step.tool_calls ?? []).map((call) => call.tool_call_id))
    for (const result of step.observation?.results ?? []) {
      if (result.source_call_id !== undefined && !declared.has(result.source_call_id)) {
        bad.push(`${trajectory.trajectory_id}#${step.step_id}:${result.source_call_id}`)
      }
    }
  }
  for (const child of trajectory.subagent_trajectories ?? []) {
    bad.push(...ruleTwoViolations(child))
  }
  return bad
}







describe('ATIF MUST rule 2 — observations link by id, not by adjacency', () => {
  it('holds on the fixture and on the multi-agent episode', () => {
    expect(ruleTwoViolations(toHarborTrajectory([fixtureRolloutLine()]))).toEqual([])
    expect(ruleTwoViolations(toHarborTrajectory(episode()))).toEqual([])
  })

  it('does not hang a result on an assistant turn that declared no tool calls', () => {
    const line = fixtureRolloutLine({
      messages: [
        { role: 'assistant', content: 'no calls here' },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    expect(trajectory.steps[0]!.observation).toBeUndefined()
    expect(trajectory.steps).toHaveLength(2)
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })

  it('does not hang a result on an assistant turn that declared a DIFFERENT call', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c2', content: 'answers a call this step never made' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    expect(trajectory.steps[0]!.observation).toBeUndefined()
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })

  it('links to the declaring step, not the preceding one, and keeps message order', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'assistant', content: 'still thinking' },
        { role: 'tool', tool_call_id: 'c1', content: 'late answer to c1' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    // The intervening turn means the result cannot legally ride step 2, so it
    // becomes its own carrier rather than being mis-attributed.
    expect(trajectory.steps.map((s) => s.source)).toEqual(['agent', 'agent', 'system'])
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })

  it('folds several results onto the one step that declared all of them', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c2', content: 'second first' },
        { role: 'tool', tool_call_id: 'c1', content: 'first second' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    expect(trajectory.steps).toHaveLength(1)
    expect(trajectory.steps[0]!.observation!.results.map((r) => r.source_call_id)).toEqual([
      'c2',
      'c1',
    ])
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })
})

describe('ATIF is_copied_context — RFC 0001 rule 7', () => {
  const withCopied = fixtureRolloutLine({
    messages: [
      { role: 'system', content: 'You are a coding worker.' },
      { role: 'user', content: 'context pasted from the supervisor', is_copied_context: true },
      { role: 'assistant', content: 'my own work' },
    ],
  })

  it('travels on the native ATIF step field, both directions', () => {
    const trajectory = toHarborTrajectory([withCopied])
    expect(trajectory.steps.map((s) => s.is_copied_context)).toEqual([undefined, true, undefined])
    const [back] = fromHarborTrajectory(trajectory, { now })
    expect(back!.messages).toEqual(withCopied.messages)
  })

  it('survives on a tool result carried by an observation', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'pasted', is_copied_context: true },
      ],
    })
    const [back] = fromHarborTrajectory(toHarborTrajectory([line]), { now })
    expect(back!.messages).toEqual(line.messages)
  })

  it('is excluded from the SFT export — the MUST the RFC actually states', () => {
    const [row] = toSftRows([withCopied])
    expect(row!.messages.map((m) => m.content)).toEqual(['You are a coding worker.', 'my own work'])
    expect(row!.messages.some((m) => m.is_copied_context === true)).toBe(false)
  })

  it('drops a line whose transcript is nothing but copied context', () => {
    const allCopied = fixtureRolloutLine({
      messages: [{ role: 'user', content: 'all borrowed', is_copied_context: true }],
    })
    expect(toSftRows([allCopied])).toEqual([])
  })
})





describe('schema back-compatibility for the ATIF-lifted optional fields', () => {
  it('validates a line that predates them', () => {
    expect(validateRolloutLine(fixtureRolloutLine())).toEqual([])
  })

  it('validates a line that carries them', () => {
    const line = fixtureRolloutLine({
      steps: [
        {
          kind: 'llm',
          name: 'chat',
          llm_call_count: 0,
          prompt_token_ids: [7],
          completion_token_ids: [8],
          logprobs: [-0.5],
        },
      ],
      cost: { ...fixtureRolloutLine().cost, llm_call_count: 2 },
    })
    expect(validateRolloutLine(line)).toEqual([])
  })

  it('rejects malformed values for them', () => {
    const bad = malformedRolloutLine({
      steps: [
        {
          kind: 'llm',
          name: 'chat',
          llm_call_count: 1.5,
          prompt_token_ids: [1.5],
          logprobs: ['x'],
        } as never,
      ],
      cost: { ...malformedRolloutLine().cost, llm_call_count: 'two' as never },
    })
    expect(validateRolloutLine(bad)).toEqual([
      'steps[0].llm_call_count: expected integer when present',
      'steps[0].prompt_token_ids: expected integer[] when present',
      'steps[0].logprobs: expected number[] when present',
      'cost.llm_call_count: expected integer|null when present',
    ])
  })

  it('validates and rejects the copied-context flag', () => {
    expect(
      validateRolloutLine(
        fixtureRolloutLine({
          messages: [{ role: 'user', content: 'pasted', is_copied_context: true }],
        }),
      ),
    ).toEqual([])
    expect(
      validateRolloutLine(
        malformedRolloutLine({
          messages: [{ role: 'user', content: 'pasted', is_copied_context: 'yes' as never }],
        }),
      ),
    ).toEqual(['messages[0].is_copied_context: must be boolean when present'])
  })
})


