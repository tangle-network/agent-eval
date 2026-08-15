import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/errors'
import {
  type ContinuationEnvironment,
  type ContinuationModelRequest,
  continuationSeed,
  definePinnedContinuationPolicy,
  runContinuation,
} from '../../src/trace-repair/continuation-policy'

const POLICY = definePinnedContinuationPolicy({ model: 'test-model', seed: 20260810 })

const PREFIX = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'task' },
] as const

function fakeEnvironments() {
  const environment: ContinuationEnvironment = {
    containerRef: 'fake',
    describe: async () => ({ networkMode: 'none' as const }),
    exec: async () => ({ output: '', returncode: 0, timedOut: false }),
    dispose: async () => undefined,
  }
  return { id: 'fake', create: async () => environment }
}

/** A model that fails on call one, so a rollout records exactly one seed. */
function seedCapturingModel(seen: number[]) {
  return async (request: ContinuationModelRequest): Promise<never> => {
    seen.push(request.seed)
    throw new Error('stop after capture')
  }
}

describe('runContinuation rolloutBase', () => {
  it('derives the seed and the record index from the global rollout index', async () => {
    const seen: number[] = []
    const rollouts = await runContinuation({
      policy: POLICY,
      arm: 'no-fix-control',
      rowId: 'row-a',
      prefix: [...PREFIX],
      rollouts: 1,
      rolloutBase: 5,
      model: seedCapturingModel(seen),
      environments: fakeEnvironments(),
    })
    expect(rollouts).toHaveLength(1)
    expect(rollouts[0]?.index).toBe(5)
    expect(rollouts[0]?.seed).toBe(continuationSeed(POLICY.seed, 'row-a', 5))
    expect(seen).toEqual([continuationSeed(POLICY.seed, 'row-a', 5)])
    expect(rollouts[0]?.seed).not.toBe(continuationSeed(POLICY.seed, 'row-a', 0))
  })

  it('defaults the base to 0 and advances it across rollouts in one call', async () => {
    const seen: number[] = []
    const rollouts = await runContinuation({
      policy: POLICY,
      arm: 'no-fix-control',
      rowId: 'row-a',
      prefix: [...PREFIX],
      rollouts: 2,
      model: seedCapturingModel(seen),
      environments: fakeEnvironments(),
    })
    expect(rollouts.map((r) => r.index)).toEqual([0, 1])
    expect(seen).toEqual([
      continuationSeed(POLICY.seed, 'row-a', 0),
      continuationSeed(POLICY.seed, 'row-a', 1),
    ])
  })

  it('refuses a negative or fractional base', async () => {
    for (const rolloutBase of [-1, 0.5]) {
      await expect(
        runContinuation({
          policy: POLICY,
          arm: 'no-fix-control',
          rowId: 'row-a',
          prefix: [...PREFIX],
          rollouts: 1,
          rolloutBase,
          model: seedCapturingModel([]),
          environments: fakeEnvironments(),
        }),
      ).rejects.toThrow(ValidationError)
    }
  })
})
