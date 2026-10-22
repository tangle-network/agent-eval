import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureRolloutLine, malformedRolloutLine } from './fixtures'


import { assertRolloutLine, validateRolloutLine } from './schema'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rollout-ledger-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('validateRolloutLine', () => {
  it('accepts the fixture line', () => {
    expect(validateRolloutLine(fixtureRolloutLine())).toEqual([])
  })

  it('rejects obsolete split and omitted required fields', () => {
    const obsolete = fixtureRolloutLine() as unknown as Record<string, unknown>
    ;(obsolete.task as Record<string, unknown>).split = 'train'
    delete obsolete.experiment_id
    delete obsolete.candidate_id
    delete (obsolete.outcome as Record<string, unknown>).realness_gated
    const errors = validateRolloutLine(obsolete)
    expect(errors.some((error) => error.startsWith('task.split:'))).toBe(true)
    expect(errors).toContain('experiment_id: expected string|null')
    expect(errors).toContain('candidate_id: expected string|null')
    expect(errors).toContain('outcome.realness_gated: expected boolean')
  })

  it('rejects a wrong schema tag, bad role, and bad split with dotted paths', () => {
    const bad = malformedRolloutLine() as unknown as Record<string, unknown>
    bad.schema = 'tangle.rollout.v0'
    bad.role = 'manager'
    ;(bad.task as Record<string, unknown>).split = 'test'
    const errors = validateRolloutLine(bad)
    expect(errors).toContain('schema: expected "tangle.rollout.v1"')
    expect(errors.some((e) => e.startsWith('role:'))).toBe(true)
    expect(errors.some((e) => e.startsWith('task.split:'))).toBe(true)
  })

  it('rejects non-integer generation and non-boolean realness_gated', () => {
    const bad = malformedRolloutLine() as unknown as Record<string, unknown>
    bad.generation = 1.5
    ;(bad.outcome as Record<string, unknown>).realness_gated = 'yes'
    const errors = validateRolloutLine(bad)
    expect(errors.some((e) => e.startsWith('generation:'))).toBe(true)
    expect(errors.some((e) => e.startsWith('outcome.realness_gated:'))).toBe(true)
  })

  it('requires a gap note on empty-messages lines', () => {
    const gapless = malformedRolloutLine({ messages: [] })
    expect(validateRolloutLine(gapless)).toContain(
      'provenance.gap: required when messages is empty',
    )
    const labeled = fixtureRolloutLine({
      messages: [],
      provenance: {
        captured_at: '2026-07-23T00:00:00.000Z',
        capture: 'backfill',
        gap: 'store unavailable',
      },
    })
    expect(validateRolloutLine(labeled)).toEqual([])
  })

  it('rejects a positive reward on a realness-gated line (the anti-Goodhart invariant)', () => {
    const forged = malformedRolloutLine({
      outcome: { ...malformedRolloutLine().outcome, reward: 0.95, realness_gated: true },
    })
    const errors = validateRolloutLine(forged)
    expect(errors.some((e) => e.startsWith('outcome.reward: 0.95'))).toBe(true)
    expect(() => assertRolloutLine(forged, 'forged')).toThrow(/may not carry a positive reward/)
    // reward 0 with the same flag is the CORRECT encoding of a gamed run.
    expect(
      validateRolloutLine(
        malformedRolloutLine({
          outcome: { ...malformedRolloutLine().outcome, reward: 0, realness_gated: true },
        }),
      ),
    ).toEqual([])
  })

  it('requires tool_call_id on role:"tool" messages and rejects malformed tool_calls', () => {
    const line = malformedRolloutLine() as unknown as { messages: Array<Record<string, unknown>> }
    delete line.messages[3]!.tool_call_id
    line.messages[2]!.tool_calls = [{ id: 'x' }]
    const errors = validateRolloutLine(line)
    expect(errors.some((e) => e.includes('messages[3].tool_call_id'))).toBe(true)
    expect(errors.some((e) => e.includes('messages[2].tool_calls[0]'))).toBe(true)
  })
})


