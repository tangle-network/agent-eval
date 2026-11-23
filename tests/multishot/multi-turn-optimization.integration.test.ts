// Multi-turn conversations as an optimization target, through the public
// entries: a simulated user and an agent converse through `multishotRollout`,
// `selfImprove` and `compareOptimizationMethods` search and gate the agent
// side (the comparison through its gate hook), and `repeatReliability` reports success in all of k seeded repeats.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CampaignCellResult,
  compareOptimizationMethods,
  gepaOptimizationMethod,
  inMemoryCampaignStorage,
  type OptimizationMethod,
  repeatReliability,
  runCampaign,
  type SurfaceProposer,
} from '../../src/campaign'
import { selfImprove } from '../../src/contract'
import {
  AdversarialScenarioInHeldOutError,
  assertSameSimulatedUser,
  type ConversationArtifact,
  conversationGate,
  conversationJudge,
  describeConversation,
  multishotRollout,
  SimulatedUserMismatchError,
} from '../../src/multishot/index'
import { passAtK, passHatK } from '../../src/statistics'
import {
  AGENT_MODEL,
  agentTransport,
  appendDirective,
  BASELINE_SURFACE,
  DIRECTIVE,
  isPushback,
  OTHER_USER_MODEL,
  type RefundScenario,
  refundOutcome,
  refundScenario,
  USER_MODEL,
  userTransport,
} from './conversation-world'

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'multi-turn-optimization-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

function rollout(userModel = USER_MODEL) {
  return multishotRollout<RefundScenario>({
    agent: { model: AGENT_MODEL, transport: agentTransport },
    user: {
      model: userModel,
      transport: userTransport,
      rigor: 'demanding',
      agentDescription: 'the refund desk',
      pushback: isPushback,
    },
    maxTurns: 5,
    outcome: refundOutcome,
  })
}

const directiveProposer: SurfaceProposer = {
  kind: 'test:confirm-order-directive',
  async propose({ currentSurface, populationSize }) {
    return Array.from({ length: populationSize }, () => ({
      surface: appendDirective(currentSurface),
      label: 'confirm-order-id',
      rationale: 'The agent never asks which order the refund is for.',
    }))
  },
}

const TRAIN = Array.from({ length: 6 }, (_, i) => refundScenario(i, 'train-'))
const HELD_OUT = Array.from({ length: 6 }, (_, i) => refundScenario(i + 40, 'held-'))

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  while (current !== undefined && current !== null && chain.length < 10) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

function cellsById(cells: ReadonlyArray<CampaignCellResult<ConversationArtifact>>) {
  return new Map(cells.map((cell) => [cell.cellId, cell.artifact]))
}

describe('a multi-turn conversation as the selfImprove dispatch', () => {
  it('searches the agent side over rollouts and gates the selected surface on held-out personas', async () => {
    const conversation = rollout()
    const result = await selfImprove<RefundScenario, ConversationArtifact>({
      agent: conversation.agent,
      dispatchRef: conversation.dispatchRef,
      scenarios: [...TRAIN, ...HELD_OUT],
      judge: conversationJudge(),
      gate: conversationGate(),
      describeArtifact: describeConversation,
      baselineSurface: BASELINE_SURFACE,
      proposer: directiveProposer,
      budget: { generations: 1, populationSize: 1, holdoutScenarios: HELD_OUT },
      runDir,
    })

    expect(result.mode).toBe('proposer')
    if (result.mode !== 'proposer') throw new Error('unreachable')
    expect(result.gateDecision).toBe('ship')
    expect(result.winner.surface).not.toBe(BASELINE_SURFACE)
    expect(String(result.winner.surface)).toContain(DIRECTIVE)
    expect(Object.keys(result.winner.perScenario).sort()).toEqual(
      HELD_OUT.map((scenario) => scenario.id).sort(),
    )

    const baseline = result.raw.baselineOnHoldout.cells.map((cell) => cell.artifact)
    const winner = result.raw.winnerOnHoldout.cells.map((cell) => cell.artifact)
    expect(baseline.map((artifact) => artifact.ending.kind)).toEqual(Array(6).fill('gave-up'))
    expect(baseline.map((artifact) => artifact.outcome.passed)).toEqual(Array(6).fill(false))
    expect(baseline[0]!.pushback).toEqual({ determined: true, firstTurn: 0 })
    expect(winner.map((artifact) => artifact.ending.kind)).toEqual(Array(6).fill('signed-off'))
    expect(winner.map((artifact) => artifact.outcome.passed)).toEqual(Array(6).fill(true))
    expect(winner[0]!.agentTurns).toBe(2)
    // The simulated user's closing marker is protocol, not something the agent said or saw.
    expect(winner[0]!.transcript.at(-1)).toEqual({ role: 'user', content: 'great, thanks.' })

    // The simulated user is a function of the scenario alone: both arms met the same user.
    for (const cell of result.raw.winnerOnHoldout.cells) {
      const scenario = HELD_OUT.find((candidate) => candidate.id === cell.scenarioId)!
      expect(cell.artifact.simulatedUser).toEqual(conversation.simulatedUser(scenario))
    }
    expect(() =>
      assertSameSimulatedUser(
        cellsById(result.raw.baselineOnHoldout.cells),
        cellsById(result.raw.winnerOnHoldout.cells),
      ),
    ).not.toThrow()

    // Every leg went through the cell's cost meter, the agent leg on the agent channel.
    expect(result.cost.byChannel.map((channel) => channel.channel).sort()).toEqual(
      expect.arrayContaining(['agent', 'driver']),
    )
    expect(result.raw.winnerOnHoldout.cells[0]!.resolvedModels).toEqual([AGENT_MODEL])
  })
})

describe('equivalent conditions', () => {
  it('refuses a comparison whose arms met different simulated users', async () => {
    const first = rollout()
    const second = rollout(OTHER_USER_MODEL)
    expect(second.dispatchRef).not.toBe(first.dispatchRef)

    const error = await selfImprove<RefundScenario, ConversationArtifact>({
      // A caller-built dispatch that changes the simulated user with the
      // surface. The conversation gate refuses the comparison it produces.
      agent: (surface, scenario, ctx) =>
        (String(surface) === BASELINE_SURFACE ? first : second).agent(surface, scenario, ctx),
      scenarios: [...TRAIN, ...HELD_OUT],
      judge: conversationJudge(),
      gate: conversationGate(),
      baselineSurface: BASELINE_SURFACE,
      proposer: directiveProposer,
      budget: { generations: 1, populationSize: 1, holdoutScenarios: HELD_OUT },
      runDir,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    const refusal = errorChain(error).find(
      (candidate) => candidate instanceof SimulatedUserMismatchError,
    ) as SimulatedUserMismatchError | undefined
    expect(refusal).toBeDefined()
    expect(refusal!.name).toBe('SimulatedUserMismatchError')
    expect(refusal!.mismatches).toHaveLength(HELD_OUT.length)
    expect(refusal!.mismatches[0]).toMatchObject({ reason: 'simulated-user' })
  })

  it('refuses paired cells that ran on different seeds or carry no simulated-user identity', async () => {
    const conversation = rollout()
    const campaign = await runCampaign<RefundScenario, ConversationArtifact>({
      scenarios: HELD_OUT.slice(0, 2),
      dispatch: (scenario, ctx) => conversation.agent(BASELINE_SURFACE, scenario, ctx),
      judges: [conversationJudge()],
      runDir,
      storage: inMemoryCampaignStorage(),
    })
    const baseline = cellsById(campaign.cells)
    const reseeded = new Map(
      [...baseline].map(([cellId, artifact]) => [cellId, { ...artifact, seed: artifact.seed + 1 }]),
    )
    expect(() => assertSameSimulatedUser(baseline, reseeded)).toThrow(SimulatedUserMismatchError)
    try {
      assertSameSimulatedUser(baseline, reseeded)
    } catch (thrown) {
      expect((thrown as SimulatedUserMismatchError).mismatches[0]).toMatchObject({ reason: 'seed' })
    }

    const anonymous = new Map(
      [...baseline].map(([cellId, artifact]) => {
        const { simulatedUser: _dropped, ...rest } = artifact
        return [cellId, rest as unknown as ConversationArtifact]
      }),
    )
    expect(() => assertSameSimulatedUser(baseline, anonymous)).toThrow(
      /carries no simulated-user identity/,
    )
  })
})

describe('the conversation gate in a method comparison', () => {
  const appendDirectiveMethod: OptimizationMethod<RefundScenario, ConversationArtifact> = {
    name: 'append-directive',
    optimize: async (input) => ({
      winnerSurface: appendDirective(input.baselineSurface),
      cost: {
        totalCostUsd: 0,
        costProvenance: { kind: 'observed', usd: 0 },
        accountingComplete: true,
        incompleteReasons: [],
      },
    }),
  }
  const comparison = {
    methods: [appendDirectiveMethod],
    baselineSurface: BASELINE_SURFACE,
    trainScenarios: TRAIN.slice(0, 2),
    selectionScenarios: TRAIN.slice(2, 4),
    testScenarios: HELD_OUT,
    judges: [conversationJudge<RefundScenario>()],
    gate: conversationGate<RefundScenario>(),
    resamples: 40,
  }

  it('checks that each winner met the same simulated user as the baseline', async () => {
    const conversation = rollout()
    const compared = await compareOptimizationMethods<RefundScenario, ConversationArtifact>({
      ...comparison,
      dispatchWithSurface: conversation.agent,
      dispatchRef: conversation.dispatchRef,
      runDir: join(runDir, 'same-user'),
    })
    expect(compared.best.gate?.decision).toBe('ship')
    expect(compared.best.gate?.contributingGates[0]).toEqual({
      name: 'simulated-user-identity',
      status: 'pass',
      detail: { pairedConversations: HELD_OUT.length },
    })

    const other = rollout(OTHER_USER_MODEL)
    await expect(
      compareOptimizationMethods<RefundScenario, ConversationArtifact>({
        ...comparison,
        dispatchWithSurface: (surface, scenario, ctx) =>
          (String(surface) === BASELINE_SURFACE ? conversation : other).agent(
            surface,
            scenario,
            ctx,
          ),
        runDir: join(runDir, 'other-user'),
      }),
    ).rejects.toBeInstanceOf(SimulatedUserMismatchError)
  })

  it('refuses an adversarial-user scenario in the test split before any cell runs', async () => {
    const conversation = rollout()
    const emitted: RefundScenario = {
      ...refundScenario(60, 'emitted-'),
      userPlan: 'PLAN:INDIRECT',
      origin: {
        kind: 'adversarial-user',
        sourceScenarioId: 'user-held-0',
        planDigest: `sha256:${'c'.repeat(64)}`,
      },
    }
    let dispatched = 0
    await expect(
      compareOptimizationMethods<RefundScenario, ConversationArtifact>({
        ...comparison,
        testScenarios: [...HELD_OUT, emitted],
        dispatchWithSurface: (surface, scenario, ctx) => {
          dispatched += 1
          return conversation.agent(surface, scenario, ctx)
        },
        runDir: join(runDir, 'adversarial-test'),
      }),
    ).rejects.toBeInstanceOf(AdversarialScenarioInHeldOutError)
    expect(dispatched).toBe(0)
  })
})

describe('evidence for reflection', () => {
  it('shows the native proposer and GEPA the same conversation evidence object', async () => {
    const conversation = rollout()
    const nativeSeen: Array<{ scenarioId: string; emitted?: string }> = []
    const recordingProposer: SurfaceProposer = {
      kind: 'test:recording',
      async propose(ctx) {
        nativeSeen.push(...(ctx.baselineOutcome?.scenarios ?? []))
        return []
      },
    }
    await selfImprove<RefundScenario, ConversationArtifact>({
      agent: conversation.agent,
      dispatchRef: conversation.dispatchRef,
      scenarios: TRAIN.slice(0, 2),
      judge: conversationJudge(),
      describeArtifact: describeConversation,
      baselineSurface: BASELINE_SURFACE,
      proposer: recordingProposer,
      budget: { generations: 1, populationSize: 1, holdout: 'deferred' },
      runDir: join(runDir, 'native'),
    })
    const native = nativeSeen.find((row) => row.scenarioId === TRAIN[0]!.id)
    expect(native?.emitted).toBeDefined()

    const observedPath = join(runDir, 'gepa-observed.json')
    const gepa = gepaOptimizationMethod<RefundScenario, ConversationArtifact>({
      recipe: {
        kind: 'engine',
        run: { engine: 'best_of_n', maxEvaluations: 1, maxProposerCostUsd: 1 },
      },
      objective: 'Resolve the refund in as few turns as the customer needs.',
      evaluationId: 'multi-turn-evidence',
      describeScenario: (scenario) => ({ persona: scenario.persona.id }),
      runner: recordingGepaRunner(observedPath),
    })
    await compareOptimizationMethods<RefundScenario, ConversationArtifact>({
      methods: [gepa],
      baselineSurface: BASELINE_SURFACE,
      trainScenarios: [TRAIN[0]!],
      selectionScenarios: [TRAIN[1]!],
      testScenarios: HELD_OUT.slice(0, 2),
      dispatchWithSurface: conversation.agent,
      dispatchRef: conversation.dispatchRef,
      judges: [conversationJudge()],
      describeArtifact: describeConversation,
      runDir: join(runDir, 'gepa'),
      resamples: 40,
    })
    const scored = JSON.parse(readFileSync(observedPath, 'utf8')) as {
      info: { artifact?: unknown }
    }

    const nativeEvidence = JSON.parse(native!.emitted!) as Record<string, unknown>
    expect(scored.info.artifact).toEqual(nativeEvidence)
    expect(nativeEvidence).toMatchObject({
      outcome: { passed: false, detail: 'no refund confirmation names the order' },
      ending: { kind: 'gave-up', turn: 2 },
      agentTurns: 3,
      firstPushbackTurn: 0,
    })
    const transcript = String(nativeEvidence.transcript)
    expect(transcript.startsWith('user: Hi')).toBe(true)
    expect(transcript.endsWith('user: forget it.')).toBe(true)
    expect(JSON.stringify(nativeEvidence).length).toBeLessThanOrEqual(2000)
  })

  it('keeps the head and the tail of a long conversation within the evidence bound', async () => {
    const conversation = multishotRollout<RefundScenario>({
      agent: {
        model: AGENT_MODEL,
        transport: async (req) => ({
          message: { content: `Let me look into that. ${'Checking the ledger. '.repeat(40)}` },
          usage: { prompt_tokens: 50, completion_tokens: 200 },
          model: req.model,
        }),
      },
      user: { model: USER_MODEL, transport: userTransport, agentDescription: 'the refund desk' },
      maxTurns: 8,
      outcome: refundOutcome,
    })
    const campaign = await runCampaign<RefundScenario, ConversationArtifact>({
      scenarios: [TRAIN[0]!],
      dispatch: (scenario, ctx) => conversation.agent(BASELINE_SURFACE, scenario, ctx),
      runDir,
      storage: inMemoryCampaignStorage(),
    })
    const evidence = describeConversation(campaign.cells[0]!.artifact)
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(2000)
    expect(evidence.transcript.startsWith('user: Hi')).toBe(true)
    expect(evidence.transcript).toMatch(/characters omitted/)
    expect(evidence.transcript.endsWith('user: forget it.')).toBe(true)
    expect(evidence.firstPushbackTurn).toBe('undetermined')
  })
})

describe('reliability across seeded repeats', () => {
  it('reports success in all k of k repeats beside mean success, per independent unit', async () => {
    const conversation = rollout()
    const flaky = refundScenario(1, 'flaky-', true)
    const steady = refundScenario(2, 'steady-')
    const campaign = await runCampaign<RefundScenario, ConversationArtifact>({
      scenarios: [flaky, steady],
      dispatch: (scenario, ctx) =>
        conversation.agent(appendDirective(BASELINE_SURFACE), scenario, ctx),
      judges: [conversationJudge()],
      reps: 4,
      seed: 10,
      runDir,
      storage: inMemoryCampaignStorage(),
    })

    const reliability = repeatReliability(campaign.cells, {
      k: 4,
      success: (artifact) => artifact.outcome.passed,
    })
    expect(reliability.scenarios).toEqual([
      {
        scenarioId: flaky.id,
        unit: flaky.id,
        repeats: 4,
        successes: 2,
        meanSuccess: 0.5,
        passAllK: 0,
      },
      {
        scenarioId: steady.id,
        unit: steady.id,
        repeats: 4,
        successes: 4,
        meanSuccess: 1,
        passAllK: 1,
      },
    ])
    expect(reliability).toMatchObject({ k: 4, units: 2, meanSuccess: 0.75, passAllK: 0.5 })
    expect(reliability.incompleteScenarios).toEqual([])

    const oneUnit = repeatReliability(campaign.cells, {
      k: 4,
      success: (artifact) => artifact.outcome.passed,
      independentUnitByScenarioId: new Map([
        [flaky.id, 'customer-1'],
        [steady.id, 'customer-1'],
      ]),
    })
    expect(oneUnit).toMatchObject({ units: 1, meanSuccess: 0.75, passAllK: 0.5 })

    const shortOfK = repeatReliability(campaign.cells, {
      k: 5,
      success: (artifact) => artifact.outcome.passed,
    })
    expect(shortOfK.passAllK).toBeNull()
    expect(shortOfK.incompleteScenarios).toEqual([flaky.id, steady.id])
    expect(shortOfK.meanSuccess).toBe(0.75)
  })

  it('estimates pass^k with the same combinatorics as pass@k', () => {
    expect(passHatK(4, 2, 4)).toBe(0)
    expect(passHatK(4, 4, 4)).toBe(1)
    expect(passHatK(5, 4, 2)).toBeCloseTo(0.6, 12)
    expect(passHatK(10, 3, 5)).toBe(0)
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 12)
    expect(() => passHatK(5, 6, 1)).toThrow(/0 ≤ c ≤ n/)
    expect(() => passHatK(5, 2, 6)).toThrow(/1 ≤ k ≤ n/)
  })
})

/** A GEPA stand-in process that scores the seed candidate on the first train
 *  case through the real callback and records exactly what came back. */
function recordingGepaRunner(observedPath: string) {
  const runtime = {
    python: { implementation: 'CPython', version: '3.12.0' },
    bridge: {
      package: 'agent-eval-rpc',
      version: 'test-bridge',
      sourceUrl: 'https://github.com/tangle-network/agent-eval',
      revision: 'test-bridge-revision',
      sourceSha256: 'a'.repeat(64),
    },
    optimizer: {
      package: 'gepa',
      version: 'test',
      sourceUrl: 'https://github.com/gepa-ai/gepa',
      revision: 'test-revision',
      sourceSha256: 'b'.repeat(64),
    },
    engineModules: [],
  }
  const source = [
    "const fs = require('node:fs')",
    "const crypto = require('node:crypto')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(runtime)}`,
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    ';(async () => {',
    '  const response = await fetch(input.callbackUrl, {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    '    body: JSON.stringify({ candidate: input.seedCandidate, exampleId: input.trainSet[0].id }),',
    '  })',
    '  if (!response.ok) throw new Error("callback failed: " + response.status)',
    '  const scored = await response.json()',
    `  fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify(scored))`,
    '  fs.mkdirSync(input.outputDir, { recursive: true })',
    '  const populationPath = input.outputDir + "/candidate-population-test.json"',
    '  const populationContents = JSON.stringify({ schemaVersion: 1, scope: "gepa-candidate-population", runId: input.runId, bestIndex: 0, candidates: [{ index: 0, candidate: input.seedCandidate, parentIndices: [null], aggregateScore: scored.score, selectionScores: [{ scenarioId: (input.selectionSet[0] || input.trainSet[0]).id, score: scored.score }], discoveryEvaluationCount: 1 }] }, null, 2) + "\\n"',
    '  fs.writeFileSync(populationPath, populationContents)',
    '  const candidatePopulation = { scope: "gepa-candidate-population", path: populationPath, sha256: "sha256:" + crypto.createHash("sha256").update(populationContents).digest("hex"), bytes: Buffer.byteLength(populationContents), runId: input.runId, candidates: 1, bestIndex: 0, maxCandidates: input.maxPopulationCandidates, maxCandidateChars: input.maxCandidateChars, scenarioIds: (input.selectionSet.length ? input.selectionSet : input.trainSet).map((scenario) => scenario.id), surfaceKind: typeof input.seedCandidate === "string" ? "text" : "components" }',
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    '    bestCandidate: input.seedCandidate,',
    '    bestScore: scored.score,',
    '    totalEvaluations: 1,',
    '    recipeKind: input.recipe.kind,',
    '    seedApplied: input.recipe.run.engine === "gepa",',
    '    proposerCostAccounting: "unavailable",',
    '    upstream: runtime.optimizer,',
    '    runId: input.runId,',
    '    resumed: false,',
    '    candidatePopulation,',
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return { command: process.execPath, args: ['-e', source, '--'] }
}
