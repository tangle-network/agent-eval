import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareOptimizationMethods,
  type JudgeConfig,
  type MutableSurface,
  type Scenario,
  skillOptOptimizationMethod,
} from '../../src/campaign'

interface TestScenario extends Scenario {
  prompt: string
  privateNote: string
}

interface TestArtifact {
  text: string
}

let runDir: string
const openServers: Server[] = []

const OPTIMIZER_BUDGET = {
  maxCostUsd: 0.1,
  maxRequests: 2,
  maxRequestBytes: 100_000,
  maxResponseBytes: 100_000,
  maxOutputTokensPerRequest: 100,
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  },
}

const SKILLOPT_RUNTIME_IDENTITY = {
  python: {
    implementation: 'CPython',
    version: '3.12.0',
  },
  bridge: {
    package: 'agent-eval-rpc',
    version: 'test-bridge',
    sourceUrl: 'https://github.com/tangle-network/agent-eval',
    revision: 'test-bridge-revision',
    sourceSha256: 'a'.repeat(64),
  },
  optimizer: {
    package: 'skillopt',
    version: '0.2.0',
    sourceUrl: 'https://github.com/microsoft/SkillOpt',
    revision: 'test-skillopt-revision',
    sourceSha256: 'c'.repeat(64),
  },
  engineModules: [],
} as const

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'skillopt-method-'))
})

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections?.()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
  rmSync(runDir, { recursive: true, force: true })
})

describe('skillOptOptimizationMethod', () => {
  it('rejects credentials in persisted trainer settings', () => {
    expect(() =>
      skillOptOptimizationMethod({
        objective: 'Improve the skill.',
        evaluationId: 'test',
        trainer: {
          epochs: 1,
          batchSize: 1,
          overrides: { api_key: 'secret' },
        },
        optimizer: optimizerModel(),
        maxEvaluations: 3,
      }),
    ).toThrow('must be supplied through optimizer')
  })

  it('rejects credentials nested inside trainer arrays', () => {
    expect(() =>
      skillOptOptimizationMethod({
        objective: 'Improve the skill.',
        evaluationId: 'test',
        trainer: {
          epochs: 1,
          batchSize: 1,
          overrides: { providers: [{ accessToken: 'secret' }] },
        },
        optimizer: optimizerModel(),
        maxEvaluations: 3,
      }),
    ).toThrow('must be supplied through optimizer')
  })

  it('allows official token-limit settings', () => {
    expect(() =>
      skillOptOptimizationMethod({
        objective: 'Improve the skill.',
        evaluationId: 'test',
        trainer: {
          epochs: 1,
          batchSize: 1,
          overrides: {
            rewrite_max_completion_tokens: 2_000,
            qwen_chat_max_tokens: 1_000,
          },
        },
        optimizer: optimizerModel(),
        maxEvaluations: 3,
      }),
    ).not.toThrow()
  })

  it('rejects invalid trainer controls before starting Python', () => {
    expect(() =>
      skillOptOptimizationMethod({
        objective: 'Improve the skill.',
        evaluationId: 'test',
        trainer: {
          epochs: 1,
          batchSize: 1,
          learningRateSchedule: 'random' as never,
        },
        optimizer: optimizerModel(),
        maxEvaluations: 3,
      }),
    ).toThrow('trainer.learningRateSchedule must be one of')

    expect(() =>
      skillOptOptimizationMethod({
        objective: 'Improve the skill.',
        evaluationId: 'test',
        trainer: {
          epochs: 1,
          batchSize: 1,
          editBudget: 1,
          minEditBudget: 2,
        },
        optimizer: optimizerModel(),
        maxEvaluations: 3,
      }),
    ).toThrow('trainer.minEditBudget must not exceed trainer.editBudget')
  })

  it('routes only described train and selection cases through the official bridge', async () => {
    const observedInputPath = join(runDir, 'external-input.json')
    const upstreamBaseUrl = await startModelServer()
    const method = skillOptOptimizationMethod<TestScenario, TestArtifact>({
      objective: 'Improve the skill.',
      evaluationId: 'test',
      trainer: {
        epochs: 1,
        batchSize: 1,
      },
      optimizer: optimizerModel(upstreamBaseUrl),
      maxEvaluations: 3,
      describeScenario: (scenario) => ({ prompt: scenario.prompt }),
      describeArtifact: (artifact) => ({ text: artifact.text }),
      runner: fakeSkillOptRunner(observedInputPath),
    })

    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: 'baseline',
      trainScenarios: [
        { id: 'train', kind: 'qa', prompt: 'visible train', privateNote: 'TRAIN_SECRET' },
      ],
      selectionScenarios: [
        {
          id: 'selection',
          kind: 'qa',
          prompt: 'visible selection',
          privateNote: 'SELECTION_SECRET',
        },
      ],
      testScenarios: [
        { id: 'final', kind: 'qa', prompt: 'private final', privateNote: 'FINAL_SECRET' },
        { id: 'final-2', kind: 'qa', prompt: 'second final', privateNote: 'FINAL_SECRET_2' },
      ],
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [betterJudge],
      runDir,
      seed: 13,
      resamples: 40,
      expectUsage: 'off',
    })

    const observed = JSON.parse(readFileSync(observedInputPath, 'utf8')) as Record<string, unknown>
    expect(observed).toMatchObject({
      resume: 'never',
      evaluationId: 'test',
      seed: 13,
      optimizerModel: 'model',
      trainSet: [{ id: 'train', data: { prompt: 'visible train' } }],
      selectionSet: [{ id: 'selection', data: { prompt: 'visible selection' } }],
      modelBudget: OPTIMIZER_BUDGET,
      maxEvaluations: 3,
    })
    expect(JSON.stringify(observed)).not.toContain('SECRET')
    expect(observed).not.toHaveProperty('testSet')
    expect(observed).not.toHaveProperty('test_set')
    expect(result.scores[0]!.winnerSurface).toBe('better')
    expect(result.scores[0]!.winnerComposite).toBe(1)
    expect(result.scores[0]!.optimizationCost).toEqual({
      totalCostUsd: 0.00002,
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(result.scores[0]!.provenance).toMatchObject({
      source: {
        kind: 'package',
        evidence: 'observed',
        package: 'skillopt',
        version: '0.2.0',
        sourceUrl: 'https://github.com/microsoft/SkillOpt',
        revision: 'test-skillopt-revision',
        sourceSha256: 'c'.repeat(64),
      },
      bridge: {
        kind: 'package',
        evidence: 'observed',
        package: 'agent-eval-rpc',
        version: 'test-bridge',
        sourceUrl: 'https://github.com/tangle-network/agent-eval',
        revision: 'test-bridge-revision',
        sourceSha256: 'a'.repeat(64),
      },
      modules: [],
      python: {
        implementation: 'CPython',
        version: '3.12.0',
      },
      compatibleRunId: expect.stringMatching(/^[0-9a-f]{64}$/),
      runId: expect.stringMatching(/^[0-9a-f]{64}-[0-9a-f]{32}$/),
      resumed: false,
      evaluationCount: 1,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        calls: 1,
      },
    })
    expect(result.scores[0]!.provenance?.runId).toMatch(
      new RegExp(`^${result.scores[0]!.provenance?.compatibleRunId}-[0-9a-f]{32}$`),
    )
  })

  it('keeps evaluation and optimizer-model budgets cumulative across resumes', async () => {
    const upstreamBaseUrl = await startModelServer()
    const resumeMarker = join(runDir, 'fake-skillopt-resume')
    const method = skillOptOptimizationMethod<TestScenario, TestArtifact>({
      objective: 'Improve the skill.',
      evaluationId: 'resume-budget',
      trainer: { epochs: 1, batchSize: 1 },
      optimizer: optimizerModel(upstreamBaseUrl),
      maxEvaluations: 2,
      resume: 'if-compatible',
      runner: fakeSkillOptRunner(join(runDir, 'observed.json'), resumeMarker),
    })

    const first = await compareOptimizationMethods(skillOptComparisonOptions(method))
    const second = await compareOptimizationMethods(skillOptComparisonOptions(method))

    expect(first.scores[0]!.provenance).toMatchObject({
      resumed: false,
      evaluationCount: 1,
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1 },
    })
    expect(second.scores[0]!.optimizationCost).toEqual({
      totalCostUsd: 0.00004,
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(second.scores[0]!.provenance).toMatchObject({
      resumed: true,
      evaluationCount: 2,
      tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, calls: 2 },
    })
    expect(first.scores[0]!.provenance?.runId).toBe(first.scores[0]!.provenance?.compatibleRunId)
    expect(second.scores[0]!.provenance?.runId).toBe(first.scores[0]!.provenance?.compatibleRunId)
    await expect(compareOptimizationMethods(skillOptComparisonOptions(method))).rejects.toThrow(
      'model failed: 429',
    )
  })
})

const betterJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'better',
  dimensions: [{ key: 'better', description: 'candidate is better' }],
  score: ({ artifact }) => {
    const score = artifact.text === 'better' ? 1 : 0
    return { dimensions: { better: score }, composite: score, notes: '' }
  },
}

function fakeSkillOptRunner(observedInputPath: string, resumeMarker?: string) {
  const source = [
    "const fs = require('node:fs')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(SKILLOPT_RUNTIME_IDENTITY)}`,
    'if (process.env.OPENAI_API_KEY) throw new Error("upstream secret reached child")',
    'if (process.env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS secret reached child")',
    'if (process.env.CUSTOM_AUTH_TOKEN) throw new Error("custom token reached child")',
    'if (process.env.OPENAI_COMPATIBLE_API_KEY === "provider-secret") throw new Error("proxy secret was not isolated")',
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    `fs.writeFileSync(${JSON.stringify(observedInputPath)}, JSON.stringify(input))`,
    ...(resumeMarker
      ? [
          `const resumed = fs.existsSync(${JSON.stringify(resumeMarker)})`,
          `fs.writeFileSync(${JSON.stringify(resumeMarker)}, "seen")`,
        ]
      : ['const resumed = false']),
    ';(async () => {',
    '  const completionResponse = await fetch(process.env.OPENAI_COMPATIBLE_BASE_URL + "/chat/completions", {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + process.env.OPENAI_COMPATIBLE_API_KEY, "content-type": "application/json" },',
    '    body: JSON.stringify({ model: "model", messages: [{ role: "user", content: "improve" }], max_tokens: 20 }),',
    '  })',
    '  if (!completionResponse.ok) throw new Error("model failed: " + completionResponse.status + " " + await completionResponse.text())',
    '  const completion = await completionResponse.json()',
    '  const response = await fetch(input.callbackUrl, {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    '    body: JSON.stringify({ candidate: "better", exampleId: input.trainSet[0].id }),',
    '  })',
    '  if (!response.ok) throw new Error("callback failed: " + response.status)',
    '  const scored = await response.json()',
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    '    bestCandidate: "better",',
    '    bestScore: scored.score,',
    '    totalEvaluations: 1,',
    '    totalSteps: 1,',
    '    tokenUsage: { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens, totalTokens: completion.usage.total_tokens, calls: 1 },',
    '    upstream: runtime.optimizer,',
    '    runId: input.runId,',
    '    resumed,',
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return {
    command: process.execPath,
    args: ['-e', source, '--'],
    env: {
      OPENAI_API_KEY: 'unrelated-provider-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      CUSTOM_AUTH_TOKEN: 'custom-secret',
    },
  }
}

function skillOptComparisonOptions(
  method: ReturnType<typeof skillOptOptimizationMethod<TestScenario, TestArtifact>>,
) {
  return {
    methods: [method],
    baselineSurface: 'baseline',
    trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'visible train', privateNote: '' }],
    selectionScenarios: [
      { id: 'selection', kind: 'qa', prompt: 'visible selection', privateNote: '' },
    ],
    testScenarios: [
      { id: 'final', kind: 'qa', prompt: 'final', privateNote: '' },
      { id: 'final-2', kind: 'qa', prompt: 'final 2', privateNote: '' },
    ],
    dispatchWithSurface: async (surface: MutableSurface) => ({ text: String(surface) }),
    judges: [betterJudge],
    runDir,
    seed: 13,
    resamples: 40,
    expectUsage: 'off' as const,
  }
}

async function startModelServer(): Promise<string> {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before replying.
    }
    if (request.headers.authorization !== 'Bearer provider-secret') {
      response.writeHead(401)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id: 'completion-1',
        choices: [{ message: { role: 'assistant', content: 'better' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
  })
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('model server failed to bind')
  return `http://127.0.0.1:${address.port}/v1`
}

function optimizerModel(baseUrl = 'http://127.0.0.1:1/v1') {
  return {
    model: 'model',
    baseUrl,
    apiKey: 'provider-secret',
    budget: OPTIMIZER_BUDGET,
  }
}
