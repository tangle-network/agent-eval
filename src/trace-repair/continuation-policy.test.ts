import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import type {
  ContinuationEnvironment,
  ContinuationEnvironmentFactory,
  ContinuationEnvironmentRequest,
  ContinuationExecResult,
  ContinuationModel,
  ContinuationModelResponse,
} from './continuation-policy'
import {
  assertArmSymmetry,
  ContinuationPolicyViolationError,
  ContinuationSymmetryError,
  continuationPolicyDigest,
  continuationSeed,
  definePinnedContinuationPolicy,
  runContinuation,
} from './continuation-policy'
import type {
  ContinuationArm,
  ContinuationMessage,
  ContinuationRollout,
} from './continuation-records'
import { rolloutDigest, rolloutRecordedSteps, toRecordedSteps } from './continuation-records'
import {
  MINI_SWE_SYSTEM_MESSAGE,
  renderInstanceMessage,
  SUBMIT_SENTINEL,
} from './mini-swe-scaffold'

const POLICY = definePinnedContinuationPolicy({ model: 'fake/pinned-model', seed: 20260808 })

const PREFIX: ContinuationMessage[] = [
  { role: 'system', content: MINI_SWE_SYSTEM_MESSAGE },
  {
    role: 'user',
    content: renderInstanceMessage({ task: 'Fix the build.', systemInformation: 'Linux x86_64' }),
  },
  { role: 'assistant', content: 'THOUGHT: look\n\n```bash\nls /app\n```' },
  { role: 'user', content: '<returncode>0</returncode>\n<output>\nbuild.sh\n</output>' },
]

interface FakeEnvironmentOptions {
  networkMode?: string
  exec?: (command: string, callIndex: number) => ContinuationExecResult
  throwOnCommand?: string
}

interface FakeEnvironmentFactory extends ContinuationEnvironmentFactory {
  created: ContinuationEnvironmentRequest[]
  disposed: string[]
  commands: string[]
}

function fakeEnvironments(options: FakeEnvironmentOptions = {}): FakeEnvironmentFactory {
  const created: ContinuationEnvironmentRequest[] = []
  const disposed: string[] = []
  const commands: string[] = []
  return {
    id: 'fake-env',
    created,
    disposed,
    commands,
    async create(request): Promise<ContinuationEnvironment> {
      created.push(request)
      const containerRef = `container-${request.arm}-${request.rolloutIndex}`
      let callIndex = 0
      return {
        containerRef,
        async describe() {
          return { networkMode: options.networkMode ?? 'none', image: 'task:pinned' }
        },
        async exec(command) {
          commands.push(command)
          if (options.throwOnCommand && command === options.throwOnCommand) {
            throw new Error('docker exec: container is not running')
          }
          const result = options.exec?.(command, callIndex) ?? {
            output: `ran ${command}\n`,
            returncode: 0,
            timedOut: false,
          }
          callIndex += 1
          return result
        },
        async dispose() {
          disposed.push(containerRef)
        },
      }
    },
  }
}

interface FakeModelOptions {
  /** Turn content by 0-based call index. Cycles once exhausted. */
  script?: string[]
  usage?: (callIndex: number) => ContinuationModelResponse['usage']
  costUsd?: (callIndex: number) => number | null
  throwOnCall?: number
}

interface FakeModel {
  model: ContinuationModel
  calls: number
  seeds: number[]
  messageCounts: number[]
}

/**
 * Deterministic stand-in for a provider. Content derives from the seed so a
 * changed seed changes the rollout, which is what the determinism test needs.
 */
function fakeModel(options: FakeModelOptions = {}): FakeModel {
  const state: FakeModel = {
    calls: 0,
    seeds: [],
    messageCounts: [],
    model: async (request) => {
      const index = state.calls
      state.calls += 1
      state.seeds.push(request.seed)
      state.messageCounts.push(request.messages.length)
      if (options.throwOnCall === index) throw new Error('provider returned 503')
      const scripted = options.script?.[index]
      const content =
        scripted ??
        `THOUGHT: step ${index}\n\n\`\`\`bash\necho seed-${request.seed}-${index}\n\`\`\``
      return {
        content,
        servedModel: request.model,
        usage: options.usage ? options.usage(index) : { input: 100 + index, output: 20 + index },
        costUsd: options.costUsd ? options.costUsd(index) : 0.001,
        finishReason: 'stop',
      }
    },
  }
  return state
}

const SUBMIT_TURN = `THOUGHT: done\n\n\`\`\`bash\necho ${SUBMIT_SENTINEL}\n\`\`\``

function submitExec(command: string): ContinuationExecResult {
  if (command === `echo ${SUBMIT_SENTINEL}`) {
    return { output: `${SUBMIT_SENTINEL}\n`, returncode: 0, timedOut: false }
  }
  return { output: `ran ${command}\n`, returncode: 0, timedOut: false }
}

function fixedClock(): () => number {
  let now = 1_760_000_000_000
  return () => {
    now += 10
    return now
  }
}

describe('definePinnedContinuationPolicy', () => {
  it('freezes the defaults the campaign does not choose', () => {
    expect(POLICY.stepBudget).toBe(20)
    expect(POLICY.networkMode).toBe('none')
    expect(POLICY.temperature).toBe(0)
    expect(POLICY.commandTimeoutSeconds).toBe(30)
    expect(POLICY.scaffold).toBe('mini-swe-agent')
    expect(Object.isFrozen(POLICY)).toBe(true)
  })

  it('rejects a policy that cannot produce comparable rollouts', () => {
    expect(() => definePinnedContinuationPolicy({ model: '  ', seed: 1 })).toThrow(ValidationError)
    expect(() => definePinnedContinuationPolicy({ model: 'm', seed: 1.5 })).toThrow(ValidationError)
    expect(() => definePinnedContinuationPolicy({ model: 'm', seed: 1, stepBudget: 0 })).toThrow(
      ValidationError,
    )
    expect(() => definePinnedContinuationPolicy({ model: 'm', seed: 1, temperature: -1 })).toThrow(
      ValidationError,
    )
  })
})

describe('continuationSeed', () => {
  it('gives the same seed to every arm of the same paired rollout', () => {
    const arms: ContinuationArm[] = ['intervention', 'no-fix-control', 'no-op-control']
    const seeds = arms.map(() => continuationSeed(POLICY.seed, 'row-1', 2))
    expect(new Set(seeds).size).toBe(1)
  })

  it('separates rows and rollout indices', () => {
    expect(continuationSeed(POLICY.seed, 'row-1', 0)).not.toBe(
      continuationSeed(POLICY.seed, 'row-2', 0),
    )
    expect(continuationSeed(POLICY.seed, 'row-1', 0)).not.toBe(
      continuationSeed(POLICY.seed, 'row-1', 1),
    )
    expect(continuationSeed(1, 'row-1', 0)).not.toBe(continuationSeed(2, 'row-1', 0))
  })

  it('returns a non-negative integer a provider can accept', () => {
    for (const row of ['a', 'row-1', 'break-filter-js-from-html:7']) {
      const seed = continuationSeed(POLICY.seed, row, 0)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('runContinuation determinism', () => {
  it('reproduces the same rollout under a fixed seed', async () => {
    const run = async () =>
      runContinuation({
        policy: POLICY,
        arm: 'intervention',
        rowId: 'row-1',
        prefix: PREFIX,
        rollouts: 2,
        model: fakeModel({ script: [undefined as unknown as string, SUBMIT_TURN] }).model,
        environments: fakeEnvironments({ exec: submitExec }),
        clock: fixedClock(),
      })
    const first = await run()
    const second = await run()
    expect(first.map(rolloutDigest)).toEqual(second.map(rolloutDigest))
    expect(first[0]?.exitStatus).toBe('submitted')
  })

  it('changes the rollout when the policy seed changes', async () => {
    const base = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-1',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel().model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    const reseeded = await runContinuation({
      policy: definePinnedContinuationPolicy({ model: POLICY.model, seed: POLICY.seed + 1 }),
      arm: 'intervention',
      rowId: 'row-1',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel().model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    expect(rolloutDigest(base[0]!)).not.toBe(rolloutDigest(reseeded[0]!))
  })

  it('hands every call in a rollout the rollout seed', async () => {
    const model = fakeModel()
    const rollouts = await runContinuation({
      policy: POLICY,
      arm: 'no-fix-control',
      rowId: 'row-9',
      prefix: PREFIX,
      rollouts: 2,
      model: model.model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    expect(new Set(model.seeds)).toEqual(
      new Set([
        continuationSeed(POLICY.seed, 'row-9', 0),
        continuationSeed(POLICY.seed, 'row-9', 1),
      ]),
    )
    expect(rollouts.map((rollout) => rollout.seed)).toEqual([
      continuationSeed(POLICY.seed, 'row-9', 0),
      continuationSeed(POLICY.seed, 'row-9', 1),
    ])
  })
})

describe('runContinuation budget', () => {
  it('stops at the step budget when the agent never submits', async () => {
    const model = fakeModel()
    const environments = fakeEnvironments()
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'no-op-control',
      rowId: 'row-2',
      prefix: PREFIX,
      rollouts: 1,
      model: model.model,
      environments,
      clock: fixedClock(),
    })
    expect(rollout?.exitStatus).toBe('step-budget-exhausted')
    expect(rollout?.steps).toHaveLength(POLICY.stepBudget)
    expect(model.calls).toBe(POLICY.stepBudget)
    expect(environments.commands).toHaveLength(POLICY.stepBudget)
    expect(rollout?.submission).toBeNull()
  })

  it('honours a shorter budget without touching any other setting', async () => {
    const policy = definePinnedContinuationPolicy({ model: POLICY.model, seed: 7, stepBudget: 3 })
    const model = fakeModel()
    const [rollout] = await runContinuation({
      policy,
      arm: 'intervention',
      rowId: 'row-3',
      prefix: PREFIX,
      rollouts: 1,
      model: model.model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    expect(rollout?.steps).toHaveLength(3)
    expect(model.calls).toBe(3)
  })

  it('ends the rollout after consecutive unparseable turns', async () => {
    const model = fakeModel({ script: ['no action here', 'still none', 'and none again'] })
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-4',
      prefix: PREFIX,
      rollouts: 1,
      model: model.model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    expect(rollout?.exitStatus).toBe('repeated-format-error')
    expect(rollout?.steps).toHaveLength(3)
    expect(rollout?.steps.every((step) => step.action === null && step.execution === null)).toBe(
      true,
    )
    expect(rollout?.steps[0]?.observation).toContain('found 0 actions')
  })

  it('resets the format-error count after a clean step', async () => {
    const model = fakeModel({
      script: [
        'no action',
        'no action',
        'THOUGHT: ok\n\n```bash\nls\n```',
        'no action',
        'no action',
      ],
    })
    const [rollout] = await runContinuation({
      policy: definePinnedContinuationPolicy({ model: POLICY.model, seed: 3, stepBudget: 5 }),
      arm: 'intervention',
      rowId: 'row-5',
      prefix: PREFIX,
      rollouts: 1,
      model: model.model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    expect(rollout?.exitStatus).toBe('step-budget-exhausted')
    expect(rollout?.steps).toHaveLength(5)
  })
})

describe('runContinuation network enforcement', () => {
  it('refuses a container that still has a network', async () => {
    const model = fakeModel()
    const environments = fakeEnvironments({ networkMode: 'bridge' })
    await expect(
      runContinuation({
        policy: POLICY,
        arm: 'intervention',
        rowId: 'row-6',
        prefix: PREFIX,
        rollouts: 1,
        model: model.model,
        environments,
        clock: fixedClock(),
      }),
    ).rejects.toThrow(ContinuationPolicyViolationError)
    expect(model.calls).toBe(0)
    expect(environments.commands).toHaveLength(0)
    expect(environments.disposed).toEqual(['container-intervention-0'])
  })

  it('records the network mode it verified', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-7',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({ script: [SUBMIT_TURN] }).model,
      environments: fakeEnvironments({ exec: submitExec }),
      clock: fixedClock(),
    })
    expect(rollout?.environment).toEqual({ networkMode: 'none', image: 'task:pinned' })
  })
})

describe('runContinuation usage capture', () => {
  it('sums usage and cost when every call reports them', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-8',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({
        script: ['THOUGHT: a\n\n```bash\nls\n```', SUBMIT_TURN],
        usage: (index) => ({ input: 100, output: 10, reasoning: index, cached: 5 }),
        costUsd: () => 0.25,
      }).model,
      environments: fakeEnvironments({ exec: submitExec }),
      clock: fixedClock(),
    })
    expect(rollout?.usage).toEqual({
      calls: 2,
      callsWithUsage: 2,
      captured: true,
      input: 200,
      output: 20,
      reasoning: 1,
      cached: 10,
    })
    expect(rollout?.costProvenance).toEqual({ kind: 'observed', usd: 0.5 })
  })

  it('marks the rollout uncaptured when a call reports no usage', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-9',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({
        script: ['THOUGHT: a\n\n```bash\nls\n```', SUBMIT_TURN],
        usage: (index) => (index === 0 ? { input: 100, output: 10 } : null),
        costUsd: () => 0.25,
      }).model,
      environments: fakeEnvironments({ exec: submitExec }),
      clock: fixedClock(),
    })
    expect(rollout?.usage.calls).toBe(2)
    expect(rollout?.usage.callsWithUsage).toBe(1)
    expect(rollout?.usage.captured).toBe(false)
    expect(rollout?.usage.input).toBe(100)
    expect(rollout?.steps[1]?.model.usage).toBeNull()
  })

  it('reports an unknown cost rather than a partial sum', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-10',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({
        script: ['THOUGHT: a\n\n```bash\nls\n```', SUBMIT_TURN],
        costUsd: (index) => (index === 0 ? 0.25 : null),
      }).model,
      environments: fakeEnvironments({ exec: submitExec }),
      clock: fixedClock(),
    })
    expect(rollout?.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
  })

  it('keeps latency and served model per call', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-11',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({ script: [SUBMIT_TURN] }).model,
      environments: fakeEnvironments({ exec: submitExec }),
      clock: fixedClock(),
    })
    const call = rollout?.steps[0]?.model
    expect(call?.servedModel).toBe(POLICY.model)
    expect(call?.latencyMs).toBeGreaterThan(0)
    expect(call?.finishReason).toBe('stop')
    expect(rollout?.wallMs).toBeGreaterThan(0)
  })
})

describe('runContinuation failure handling', () => {
  it('records a provider failure instead of returning a shorter clean rollout', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-12',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({ script: ['THOUGHT: a\n\n```bash\nls\n```'], throwOnCall: 1 }).model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    expect(rollout?.exitStatus).toBe('model-error')
    expect(rollout?.terminalError).toBe('provider returned 503')
    expect(rollout?.steps).toHaveLength(1)
  })

  it('records an environment failure against the action that hit it', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-13',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({ script: ['THOUGHT: a\n\n```bash\nbroken\n```'] }).model,
      environments: fakeEnvironments({ throwOnCommand: 'broken' }),
      clock: fixedClock(),
    })
    expect(rollout?.exitStatus).toBe('environment-error')
    expect(rollout?.steps[0]?.action).toBe('broken')
    expect(rollout?.steps[0]?.observation).toBeNull()
    expect(rollout?.steps[0]?.execution).toBeNull()
    expect(rollout?.steps[0]?.error).toContain('container is not running')
  })

  it('feeds a timed-out command back as the timeout observation and keeps going', async () => {
    const model = fakeModel({
      script: ['THOUGHT: a\n\n```bash\nsleep 600\n```', SUBMIT_TURN],
    })
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-14',
      prefix: PREFIX,
      rollouts: 1,
      model: model.model,
      environments: fakeEnvironments({
        exec: (command) =>
          command === 'sleep 600'
            ? { output: '', returncode: -9, timedOut: true }
            : submitExec(command),
      }),
      clock: fixedClock(),
    })
    expect(rollout?.steps[0]?.execution?.timedOut).toBe(true)
    expect(rollout?.steps[0]?.observation).toContain('timed out and has been killed')
    expect(rollout?.exitStatus).toBe('submitted')
  })

  it('does not submit on a sentinel that exited non-zero', async () => {
    const [rollout] = await runContinuation({
      policy: definePinnedContinuationPolicy({ model: POLICY.model, seed: 4, stepBudget: 1 }),
      arm: 'intervention',
      rowId: 'row-15',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({ script: [SUBMIT_TURN] }).model,
      environments: fakeEnvironments({
        exec: () => ({ output: `${SUBMIT_SENTINEL}\n`, returncode: 1, timedOut: false }),
      }),
      clock: fixedClock(),
    })
    expect(rollout?.exitStatus).toBe('step-budget-exhausted')
    expect(rollout?.submission).toBeNull()
  })

  it('rejects a prefix that leaves an action unanswered', async () => {
    await expect(
      runContinuation({
        policy: POLICY,
        arm: 'intervention',
        rowId: 'row-16',
        prefix: PREFIX.slice(0, 3),
        rollouts: 1,
        model: fakeModel().model,
        environments: fakeEnvironments(),
        clock: fixedClock(),
      }),
    ).rejects.toThrow(ValidationError)
  })
})

describe('runContinuation isolation', () => {
  it('gives every rollout its own environment and disposes each one', async () => {
    const environments = fakeEnvironments({ exec: submitExec })
    const rollouts = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-17',
      prefix: PREFIX,
      rollouts: 3,
      model: fakeModel({ script: [SUBMIT_TURN, SUBMIT_TURN, SUBMIT_TURN] }).model,
      environments,
      clock: fixedClock(),
    })
    expect(environments.created.map((request) => request.rolloutIndex)).toEqual([0, 1, 2])
    expect(environments.disposed).toEqual([
      'container-intervention-0',
      'container-intervention-1',
      'container-intervention-2',
    ])
    expect(rollouts.map((rollout) => rollout.containerRef)).toEqual(environments.disposed)
    expect(new Set(rollouts.map((rollout) => rollout.rolloutId)).size).toBe(3)
  })

  it('starts every rollout from the inherited prefix, not the previous rollout', async () => {
    const model = fakeModel()
    await runContinuation({
      policy: definePinnedContinuationPolicy({ model: POLICY.model, seed: 5, stepBudget: 2 }),
      arm: 'intervention',
      rowId: 'row-18',
      prefix: PREFIX,
      rollouts: 2,
      model: model.model,
      environments: fakeEnvironments(),
      clock: fixedClock(),
    })
    expect(model.messageCounts).toEqual([4, 6, 4, 6])
  })
})

describe('arm symmetry', () => {
  it('runs all three arms under one policy digest and one seed per pair', async () => {
    const arms: ContinuationArm[] = ['intervention', 'no-fix-control', 'no-op-control']
    const rollouts: ContinuationRollout[] = []
    for (const arm of arms) {
      rollouts.push(
        ...(await runContinuation({
          policy: POLICY,
          arm,
          rowId: 'row-19',
          prefix: PREFIX,
          rollouts: 3,
          model: fakeModel().model,
          environments: fakeEnvironments(),
          clock: fixedClock(),
        })),
      )
    }
    expect(new Set(rollouts.map((rollout) => rollout.policyDigest)).size).toBe(1)
    expect(() => assertArmSymmetry(rollouts)).not.toThrow()
  })

  it('catches arms that ran different policies', async () => {
    const shared = { rowId: 'row-20', prefix: PREFIX, rollouts: 1, clock: fixedClock() }
    const intervention = await runContinuation({
      ...shared,
      policy: POLICY,
      arm: 'intervention',
      model: fakeModel().model,
      environments: fakeEnvironments(),
    })
    const control = await runContinuation({
      ...shared,
      policy: definePinnedContinuationPolicy({
        model: POLICY.model,
        seed: POLICY.seed,
        maxTokens: 8192,
      }),
      arm: 'no-fix-control',
      model: fakeModel().model,
      environments: fakeEnvironments(),
    })
    expect(() => assertArmSymmetry([...intervention, ...control])).toThrow(
      ContinuationSymmetryError,
    )
  })

  it('changes the digest when a scaffold template changes', () => {
    const digest = continuationPolicyDigest(POLICY)
    expect(digest).toBe(
      continuationPolicyDigest(
        definePinnedContinuationPolicy({ model: POLICY.model, seed: POLICY.seed }),
      ),
    )
    expect(digest).not.toBe(
      continuationPolicyDigest(
        definePinnedContinuationPolicy({ model: POLICY.model, seed: POLICY.seed, stepBudget: 21 }),
      ),
    )
  })
})

describe('records', () => {
  it('projects the continuation into corpus steps a replay layer reads', async () => {
    const [rollout] = await runContinuation({
      policy: POLICY,
      arm: 'intervention',
      rowId: 'row-21',
      prefix: PREFIX,
      rollouts: 1,
      model: fakeModel({ script: ['THOUGHT: a\n\n```bash\nls /app\n```', SUBMIT_TURN] }).model,
      environments: fakeEnvironments({ exec: submitExec }),
      clock: fixedClock(),
    })
    const steps = rolloutRecordedSteps(rollout!)
    expect(steps[0]).toEqual({
      src: 'agent',
      msg: 'THOUGHT: a\n\n```bash\nls /app\n```',
      tools: [{ fn: 'bash_command', cmd: 'ls /app' }],
      obs: '<returncode>0</returncode>\n<output>\nran ls /app\n</output>',
    })
    expect(steps[1]?.obs).toBeNull()
    expect(steps[1]?.tools).toEqual([{ fn: 'bash_command', cmd: `echo ${SUBMIT_SENTINEL}` }])
  })

  it('projects a full message list the way the corpus stores one', () => {
    const steps = toRecordedSteps(PREFIX)
    expect(steps.map((step) => step.src)).toEqual(['system', 'user', 'agent'])
    expect(steps[2]).toEqual({
      src: 'agent',
      msg: 'THOUGHT: look\n\n```bash\nls /app\n```',
      tools: [{ fn: 'bash_command', cmd: 'ls /app' }],
      obs: '<returncode>0</returncode>\n<output>\nbuild.sh\n</output>',
    })
  })

  it('leaves tools null on a turn that produced no action', () => {
    const steps = toRecordedSteps([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'no action here' },
      { role: 'user', content: 'Please always provide EXACTLY ONE action' },
    ])
    expect(steps[2]?.tools).toBeNull()
    expect(steps[2]?.obs).toBe('Please always provide EXACTLY ONE action')
  })
})
