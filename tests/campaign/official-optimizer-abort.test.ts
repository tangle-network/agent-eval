import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  type OptimizationMethod,
  type Scenario,
  skillOptOptimizationMethod,
} from '../../src/campaign'

interface TestScenario extends Scenario {
  prompt: string
}

interface TestArtifact {
  text: string
}

describe.each(['gepa', 'skillopt'] as const)('%s cancellation', (optimizer) => {
  it('stops its callback, model proxy, and detached process promptly', async () => {
    const runDir = await mkdtemp(join(tmpdir(), `agent-eval-${optimizer}-abort-`))
    const readyPath = join(runDir, 'optimizer-ready.json')
    const owner = new AbortController()
    const method = createMethod(optimizer, readyPath)
    const running = compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: 'baseline',
      trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'train' }],
      selectionScenarios: [{ id: 'selection', kind: 'qa', prompt: 'selection' }],
      testScenarios: [
        { id: 'test-1', kind: 'qa', prompt: 'test 1' },
        { id: 'test-2', kind: 'qa', prompt: 'test 2' },
      ],
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [
        {
          name: 'identity',
          dimensions: [{ key: 'identity', description: 'identity score' }],
          score: () => ({
            dimensions: { identity: 1 },
            composite: 1,
            notes: '',
          }),
        },
      ],
      runDir,
      signal: owner.signal,
      resamples: 40,
      expectUsage: 'off',
    })

    try {
      await waitFor(() => existsSync(readyPath))
      const endpoints = JSON.parse(await readFile(readyPath, 'utf8')) as {
        callbackUrl: string
        callbackToken: string
        modelBaseUrl: string
        modelApiKey: string
      }
      const abortedAt = performance.now()
      owner.abort(new Error(`stop ${optimizer}`))

      await expect(running).rejects.toThrow(`stop ${optimizer}`)
      expect(performance.now() - abortedAt).toBeLessThan(1_000)
      expect(await callbackStatus(endpoints)).toBe(0)
      expect(await modelProxyStatus(endpoints)).toBe(0)
    } finally {
      owner.abort(new Error('test cleanup'))
      await running.catch(() => undefined)
      await rm(runDir, { recursive: true, force: true })
    }
  }, 10_000)
})

function createMethod(
  optimizer: 'gepa' | 'skillopt',
  readyPath: string,
): OptimizationMethod<TestScenario, TestArtifact> {
  const runner = fakeOptimizerRunner(optimizer, readyPath)
  if (optimizer === 'gepa') {
    return gepaOptimizationMethod<TestScenario, TestArtifact>({
      objective: 'Improve the candidate.',
      evaluationId: 'abort-integration',
      recipe: {
        kind: 'engine',
        run: {
          engine: 'gepa',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      optimizer: optimizerModel(),
      runner,
    })
  }
  return skillOptOptimizationMethod<TestScenario, TestArtifact>({
    objective: 'Improve the candidate.',
    evaluationId: 'abort-integration',
    trainer: { epochs: 1, batchSize: 1 },
    optimizer: optimizerModel(),
    maxEvaluations: 1,
    runner,
  })
}

function fakeOptimizerRunner(optimizer: 'gepa' | 'skillopt', readyPath: string) {
  const runtime = {
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
      package: optimizer,
      version: 'test-optimizer',
      sourceUrl: `https://github.com/example/${optimizer}`,
      revision: 'test-optimizer-revision',
      sourceSha256: 'b'.repeat(64),
    },
    engineModules: [],
  }
  const source = [
    "const fs = require('node:fs')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(runtime)}`,
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    'const modelProxy = input.modelProxy || {',
    '  baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,',
    '  apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,',
    '}',
    `fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({`,
    '  callbackUrl: input.callbackUrl,',
    '  callbackToken: input.callbackToken,',
    '  modelBaseUrl: modelProxy.baseUrl,',
    '  modelApiKey: modelProxy.apiKey,',
    '}))',
    'setInterval(() => {}, 1_000)',
  ].join('\n')
  return {
    command: process.execPath,
    args: ['-e', source, '--'],
  }
}

function optimizerModel() {
  return {
    model: 'model',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'provider-secret',
    budget: {
      maxCostUsd: 1,
      maxRequests: 2,
      maxRequestBytes: 100_000,
      maxResponseBytes: 100_000,
      maxOutputTokensPerRequest: 100,
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      },
    },
  }
}

async function callbackStatus(endpoints: {
  callbackUrl: string
  callbackToken: string
}): Promise<number> {
  return requestStatus(
    fetch(endpoints.callbackUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoints.callbackToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ candidate: 'candidate', exampleId: 'train' }),
      signal: AbortSignal.timeout(250),
    }),
  )
}

async function modelProxyStatus(endpoints: {
  modelBaseUrl: string
  modelApiKey: string
}): Promise<number> {
  return requestStatus(
    fetch(`${endpoints.modelBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoints.modelApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'model',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(250),
    }),
  )
}

async function requestStatus(request: Promise<Response>): Promise<number> {
  try {
    return (await request).status
  } catch {
    return 0
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('optimizer did not start')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
