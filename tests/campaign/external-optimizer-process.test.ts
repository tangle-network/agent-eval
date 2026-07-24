import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runExternalOptimizerProcess,
  startExternalOptimizerCallback,
  startExternalOptimizerModelProxy,
} from '../../src/campaign/external-optimizer-process'
import { CostLedger } from '../../src/cost-ledger'

const openCallbacks: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(openCallbacks.splice(0).map((callback) => callback.close()))
})

describe('external optimizer callback', () => {
  it('authenticates requests and enforces the limit under concurrency', async () => {
    let accepted = 0
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 2,
      evaluate: async () => {
        accepted += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { score: 1 }
      },
    })
    openCallbacks.push(callback)

    const unauthorized = await post(callback.url, 'wrong')
    expect(unauthorized.status).toBe(401)
    expect(callback.evaluations()).toBe(0)

    const responses = await Promise.all([
      post(callback.url, 'secret'),
      post(callback.url, 'secret'),
      post(callback.url, 'secret'),
      post(callback.url, 'secret'),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429, 429])
    expect(accepted).toBe(2)
    expect(callback.evaluations()).toBe(2)
  })
})

describe('external optimizer process', () => {
  it('passes only safe inherited variables plus explicit runner environment', async () => {
    process.env.AGENT_EVAL_TEST_SECRET = 'must-not-leak'
    const script = [
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      'writeFileSync(output, JSON.stringify({ inherited: process.env.AGENT_EVAL_TEST_SECRET ?? null, explicit: process.env.EXPLICIT_VALUE }))',
    ].join(';')

    try {
      const result = await runExternalOptimizerProcess<{
        inherited: string | null
        explicit: string
      }>({
        label: 'isolated optimizer',
        tempPrefix: 'agent-eval-isolated-env-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
          env: { EXPLICIT_VALUE: 'present' },
        },
        timeoutMs: 5_000,
      })
      expect(result).toEqual({ inherited: null, explicit: 'present' })
    } finally {
      delete process.env.AGENT_EVAL_TEST_SECRET
    }
  })

  it('retains the final exception after large process output', async () => {
    const script = [
      "process.stderr.write('HEAD_MARKER\\n')",
      "process.stderr.write('x'.repeat(70_000))",
      "process.stderr.write('\\nTAIL_MARKER\\n')",
      'process.exit(9)',
    ].join(';')

    await expect(
      runExternalOptimizerProcess({
        label: 'large-output optimizer',
        tempPrefix: 'agent-eval-large-output-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/HEAD_MARKER.*TAIL_MARKER/),
      }),
    )
  })

  it('rejects an oversized result file before reading it', async () => {
    const script = [
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      "writeFileSync(output, 'x'.repeat(4 * 1024 * 1024 + 1))",
    ].join(';')

    await expect(
      runExternalOptimizerProcess({
        label: 'oversized optimizer',
        tempPrefix: 'agent-eval-oversized-result-',
        module: 'unused',
        input: {},
        runner: {
          command: process.execPath,
          args: ['-e', script, '--'],
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('output exceeds 4194304 bytes')
  })

  it('terminates optimizer descendants when the process times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-descendant-'))
    const marker = join(dir, 'descendant-survived.txt')
    const descendant = [
      "const { writeFileSync } = require('node:fs')",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
      'setTimeout(() => process.exit(0), 2_000)',
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1_000)',
    ].join(';')

    try {
      await expect(
        runExternalOptimizerProcess({
          label: 'timed optimizer',
          tempPrefix: 'agent-eval-timeout-',
          module: 'unused',
          input: {},
          runner: {
            command: process.execPath,
            args: ['-e', parent, '--'],
          },
          timeoutMs: 100,
        }),
      ).rejects.toThrow('timed optimizer exceeded 100ms')
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('terminates optimizer descendants after a successful parent exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-success-descendant-'))
    const marker = join(dir, 'descendant-survived.txt')
    const descendant = [
      "const { writeFileSync } = require('node:fs')",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
      'setTimeout(() => process.exit(0), 2_000)',
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const output = process.argv[process.argv.indexOf('--output') + 1]",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      "writeFileSync(output, JSON.stringify({ status: 'complete' }))",
      'process.exit(0)',
    ].join(';')

    try {
      await expect(
        runExternalOptimizerProcess({
          label: 'successful optimizer',
          tempPrefix: 'agent-eval-successful-',
          module: 'unused',
          input: {},
          runner: {
            command: process.execPath,
            args: ['-e', parent, '--'],
          },
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual({ status: 'complete' })
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('terminates optimizer descendants after a nonzero parent exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-failed-descendant-'))
    const marker = join(dir, 'descendant-survived.txt')
    const descendant = [
      "const { writeFileSync } = require('node:fs')",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 1_000)`,
      'setTimeout(() => process.exit(0), 2_000)',
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      "process.stderr.write('PARENT_FAILURE_MARKER\\n')",
      'process.exit(9)',
    ].join(';')

    try {
      await expect(
        runExternalOptimizerProcess({
          label: 'failed optimizer',
          tempPrefix: 'agent-eval-failed-',
          module: 'unused',
          input: {},
          runner: {
            command: process.execPath,
            args: ['-e', parent, '--'],
          },
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/exited 9.*PARENT_FAILURE_MARKER/),
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)
})

describe('external optimizer model proxy', () => {
  it('meters a provider call while keeping the provider credential out of the child', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 1 })
    let upstreamAuthorization = ''
    let upstreamUrl = ''
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'skillopt.optimizer',
      actor: 'skillopt',
      fetchImpl: async (input, init) => {
        upstreamUrl = String(input)
        upstreamAuthorization = new Headers(init?.headers).get('authorization') ?? ''
        return new Response(
          JSON.stringify({
            id: 'completion-1',
            choices: [{ message: { role: 'assistant', content: 'revised' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'improve this' }],
        max_tokens: 20,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: 'revised' } }],
      })
      expect(upstreamUrl).toBe('https://provider.example/v1/chat/completions')
      expect(upstreamAuthorization).toBe('Bearer provider-secret')
      expect(proxy.requestAttempts()).toBe(1)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          channel: 'optimizer',
          phase: 'skillopt.optimizer',
          actor: 'skillopt',
          model: 'model-a',
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.00002,
          costUnknown: false,
          usageUnknown: false,
        }),
      ])
      expect(ledger.list()[0]?.actualCostUsd).toBeUndefined()
      expect(ledger.list()[0]?.pricing).toEqual({
        inputUsdPerThousand: 0.001,
        outputUsdPerThousand: 0.002,
      })
    } finally {
      await proxy.close()
    }
  })

  it('uses a finite nonnegative provider cost without also attaching estimated pricing', async () => {
    const ledger = new CostLedger()
    const providerCosts = [0, 0.000017]
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        const cost = providerCosts[providerCalls]
        providerCalls += 1
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              cost,
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      for (const expectedCost of providerCosts) {
        const response = await postModel(proxy, {
          model: 'model-a',
          messages: [{ role: 'user', content: 'improve this' }],
          max_tokens: 20,
        })
        expect(response.status).toBe(200)
        const receipt = ledger.list().at(-1)
        expect(receipt).toEqual(
          expect.objectContaining({
            inputTokens: 10,
            outputTokens: 5,
            costUsd: expectedCost,
            actualCostUsd: expectedCost,
            costUnknown: false,
          }),
        )
        expect(receipt?.pricing).toBeUndefined()
      }
    } finally {
      await proxy.close()
    }
  })

  it('uses configured rates when provider cost is negative or non-finite', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        providerCalls += 1
        const cost = providerCalls === 1 ? '-1' : '1e999'
        return new Response(
          `{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":${cost}}}`,
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      for (let request = 0; request < 2; request += 1) {
        const response = await postModel(proxy, {
          model: 'model-a',
          messages: [{ role: 'user', content: 'improve this' }],
          max_tokens: 20,
        })
        expect(response.status).toBe(200)
      }
      expect(ledger.list()).toHaveLength(2)
      for (const receipt of ledger.list()) {
        expect(receipt.actualCostUsd).toBeUndefined()
        expect(receipt.costUsd).toBe(0.00002)
        expect(receipt.pricing).toEqual({
          inputUsdPerThousand: 0.001,
          outputUsdPerThousand: 0.002,
        })
      }
    } finally {
      await proxy.close()
    }
  })

  it('prices Chat Completions cache reads and cache writes without double-counting input', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 3,
          outputUsdPerMillion: 4,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              prompt_tokens_details: {
                cached_tokens: 20,
                cache_creation_tokens: 30,
              },
              completion_tokens_details: { reasoning_tokens: 4 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'x'.repeat(200) }],
        max_tokens: 10,
      })
      expect(response.status).toBe(200)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 50,
          cachedTokens: 20,
          cacheWriteTokens: 30,
          outputTokens: 10,
          reasoningTokens: 4,
          costUnknown: false,
        }),
      ])
      expect(ledger.list()[0]?.costUsd).toBeCloseTo(0.00024, 12)
      expect(ledger.list()[0]?.actualCostUsd).toBeUndefined()
    } finally {
      await proxy.close()
    }
  })

  it('fails closed when cache token details contradict total input usage', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              prompt_tokens_details: {
                cached_tokens: 8,
                cache_creation_tokens: 3,
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 5,
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: 'optimizer model response omitted complete token usage',
      })
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          costUnknown: true,
          usageUnknown: true,
        }),
      ])
    } finally {
      await proxy.close()
    }
  })

  it('parses Responses API input and output token details', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 3,
          outputUsdPerMillion: 4,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'response-1',
            output: [],
            usage: {
              input_tokens: 120,
              output_tokens: 20,
              input_tokens_details: {
                cached_tokens: 50,
                cache_write_tokens: 20,
              },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })

    try {
      const response = await postResponses(proxy, {
        model: 'model-a',
        input: 'improve this',
        max_output_tokens: 20,
      })
      expect(response.status).toBe(200)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          inputTokens: 50,
          cachedTokens: 50,
          cacheWriteTokens: 20,
          outputTokens: 20,
          reasoningTokens: 5,
          costUsd: 0.000265,
          costUnknown: false,
        }),
      ])
    } finally {
      await proxy.close()
    }
  })

  it('rejects disallowed requests before any provider call', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1, maxOutputTokensPerRequest: 10 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        providerCalls += 1
        return new Response('{}')
      },
    })

    try {
      const wrongModel = await postModel(proxy, {
        model: 'other',
        messages: [],
        max_tokens: 1,
      })
      const tooManyTokens = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 11,
      })
      const streaming = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
        stream: true,
      })
      const multipleCompletions = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
        n: 2,
      })
      const hiddenLargerLimit = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_output_tokens: 1,
        max_tokens: 11,
      })
      expect([
        wrongModel.status,
        tooManyTokens.status,
        streaming.status,
        multipleCompletions.status,
        hiddenLargerLimit.status,
      ]).toEqual([400, 400, 400, 400, 400])
      expect(providerCalls).toBe(0)
      expect(ledger.list()).toEqual([])
    } finally {
      await proxy.close()
    }
  })

  it('joins OpenAI-compatible paths with base URLs that omit /v1', async () => {
    const ledger = new CostLedger()
    let upstreamUrl = ''
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/api',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async (input) => {
        upstreamUrl = String(input)
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(200)
      expect(upstreamUrl).toBe('https://provider.example/api/v1/chat/completions')
    } finally {
      await proxy.close()
    }
  })

  it('stops before a request would exceed the optimizer model budget', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({
        maxCostUsd: 0.000001,
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        providerCalls += 1
        return new Response('{}')
      },
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 1,
      })
      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: 'optimizer model cost limit reached' })
      expect(providerCalls).toBe(0)
      expect(proxy.requestAttempts()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  it('applies prior request and cost use to a resumed model budget', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 2 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      tags: { optimizerRun: 'run', optimizerAttempt: 'attempt-b' },
      initialUsage: { requests: 1, costUsd: 0 },
      fetchImpl: async () => {
        providerCalls += 1
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const first = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      const second = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      expect(first.status).toBe(200)
      expect(second.status).toBe(429)
      expect(await second.json()).toEqual({ error: 'optimizer model request limit reached' })
      expect(providerCalls).toBe(1)
      expect(proxy.requestAttempts()).toBe(1)
      expect(ledger.list()[0]?.tags).toEqual({
        optimizerRun: 'run',
        optimizerAttempt: 'attempt-b',
      })
    } finally {
      await proxy.close()
    }
  })

  it('rejects resumed model use that already exceeds the configured limit', async () => {
    await expect(
      startExternalOptimizerModelProxy({
        upstreamBaseUrl: 'https://provider.example/v1',
        upstreamApiKey: 'provider-secret',
        model: 'model-a',
        budget: modelBudget({ maxRequests: 1 }),
        costLedger: new CostLedger(),
        phase: 'optimizer',
        actor: 'official-library',
        initialUsage: { requests: 2, costUsd: 0 },
      }),
    ).rejects.toThrow('initialUsage exceeds the configured budget')
  })

  it('reserves input at the most expensive configured cache class', async () => {
    const ledger = new CostLedger()
    let providerCalls = 0
    const requestBody = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1,
    }
    const requestBytes = Buffer.byteLength(JSON.stringify(requestBody))
    const normalInputMaximum = (requestBytes + 1) / 1_000_000
    const cacheWriteMaximum = (requestBytes * 50 + 1) / 1_000_000
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({
        maxCostUsd: (normalInputMaximum + cacheWriteMaximum) / 2,
        maxRequests: 1,
        pricing: {
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 0.1,
          cacheWriteUsdPerMillion: 50,
          outputUsdPerMillion: 1,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        providerCalls += 1
        return new Response('{}')
      },
    })

    try {
      const response = await postModel(proxy, requestBody)
      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: 'optimizer model cost limit reached' })
      expect(providerCalls).toBe(0)
      expect(proxy.requestAttempts()).toBe(0)
      expect(ledger.list()).toEqual([])
    } finally {
      await proxy.close()
    }
  })

  it('keeps concurrent reservations within the optimizer model budget', async () => {
    const ledger = new CostLedger()
    const requestBody = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1,
    }
    const requestBytes = Buffer.byteLength(JSON.stringify(requestBody))
    const maximumPerRequest = (requestBytes + 1) / 1_000_000
    let releaseProvider: (() => void) | undefined
    const providerPending = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    let providerCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({
        maxCostUsd: maximumPerRequest * 1.5,
        maxRequests: 2,
        pricing: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
        },
      }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        providerCalls += 1
        await providerPending
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const first = postModel(proxy, requestBody)
      await waitFor(() => providerCalls === 1)
      const second = await postModel(proxy, requestBody)
      expect(second.status).toBe(429)
      expect(await second.json()).toEqual({ error: 'optimizer model cost limit reached' })
      expect(providerCalls).toBe(1)
      releaseProvider?.()
      expect((await first).status).toBe(200)
      expect(proxy.requestAttempts()).toBe(1)
      expect(ledger.summary().totalCostUsd).toBe(0.000002)
    } finally {
      releaseProvider?.()
      await proxy.close()
    }
  })

  it('fails closed when the provider omits token usage', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'no usage' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(502)
      expect(ledger.summary().accountingComplete).toBe(false)
      expect(ledger.summary().incompleteReasons.length).toBeGreaterThan(0)
      expect(ledger.list()).toEqual([
        expect.objectContaining({
          costUnknown: true,
          usageUnknown: true,
        }),
      ])
      expect(ledger.list()[0]?.actualCostUsd).toBeUndefined()
    } finally {
      await proxy.close()
    }
  })

  it('bounds provider responses before buffering them', async () => {
    const ledger = new CostLedger()
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget({ maxRequests: 1, maxResponseBytes: 16 }),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () =>
        new Response('x'.repeat(17), {
          headers: { 'content-type': 'application/json' },
        }),
    })

    try {
      const response = await postModel(proxy, {
        model: 'model-a',
        messages: [],
        max_tokens: 1,
      })
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: 'optimizer model response exceeds maxResponseBytes',
      })
      expect(ledger.summary().accountingComplete).toBe(false)
    } finally {
      await proxy.close()
    }
  })
})

function post(url: string, token: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ candidate: 'candidate', exampleId: 'case' }),
  })
}

function postModel(
  proxy: { baseUrl: string; apiKey: string },
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function postResponses(
  proxy: { baseUrl: string; apiKey: string },
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${proxy.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not met')
}

function modelBudget(
  overrides: Partial<{
    maxCostUsd: number
    maxRequests: number
    maxRequestBytes: number
    maxResponseBytes: number
    maxOutputTokensPerRequest: number
    pricing: {
      inputUsdPerMillion: number
      cachedInputUsdPerMillion?: number
      cacheWriteUsdPerMillion?: number
      outputUsdPerMillion: number
    }
  }> = {},
) {
  return {
    maxCostUsd: 0.1,
    maxRequests: 2,
    maxRequestBytes: 10_000,
    maxResponseBytes: 10_000,
    maxOutputTokensPerRequest: 100,
    pricing: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    },
    ...overrides,
  }
}
