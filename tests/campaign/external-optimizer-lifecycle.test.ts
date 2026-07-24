import { describe, expect, it } from 'vitest'
import {
  startExternalOptimizerCallback,
  startExternalOptimizerModelProxy,
} from '../../src/campaign/external-optimizer-process'
import { CostLedger } from '../../src/cost-ledger'

describe('external optimizer server lifecycle', () => {
  it('waits for active callback evaluation work and rejects new work during close', async () => {
    const evaluation = deferred<void>()
    const started = deferred<void>()
    let activeEvaluations = 0
    const callback = await startExternalOptimizerCallback({
      token: 'secret',
      maxEvaluations: 2,
      evaluate: async () => {
        activeEvaluations += 1
        started.resolve()
        await evaluation.promise
        activeEvaluations -= 1
        return { score: 1 }
      },
    })
    const firstRequest = settled(postEvaluation(callback.url, callback.token))
    await started.promise

    const closing = callback.close()
    expect(callback.close()).toBe(closing)
    await delay(20)
    expect(activeEvaluations).toBe(1)
    expect(await isPending(closing)).toBe(true)
    expect(await postStatus(callback.url, callback.token)).not.toBe(200)
    expect(callback.evaluations()).toBe(1)

    evaluation.resolve()
    await closing
    await firstRequest
    expect(activeEvaluations).toBe(0)
  })

  it('waits for provider completion and cost settlement after aborting a request', async () => {
    const provider = deferred<void>()
    const started = deferred<void>()
    const ledger = new CostLedger()
    let activeProviderCalls = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget(),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        activeProviderCalls += 1
        started.resolve()
        await provider.promise
        activeProviderCalls -= 1
        return successfulProviderResponse()
      },
    })
    const request = settled(postModel(proxy, validModelRequest()))
    await started.promise
    expect(ledger.summary().pendingCalls).toBe(1)

    const closing = proxy.close()
    expect(proxy.close()).toBe(closing)
    await delay(20)
    expect(await isPending(closing)).toBe(true)
    expect(activeProviderCalls).toBe(1)
    expect(ledger.summary().pendingCalls).toBe(1)
    expect(await postModelStatus(proxy, validModelRequest())).not.toBe(200)

    provider.resolve()
    await closing
    await request
    expect(activeProviderCalls).toBe(0)
    expect(ledger.summary()).toMatchObject({
      totalCalls: 1,
      pendingCalls: 0,
      accountingComplete: true,
    })
    expect(proxy.requestAttempts()).toBe(1)
    expect(proxy.successfulCompletions()).toBe(1)
  })

  it('counts failed attempts separately from successful provider completions', async () => {
    const ledger = new CostLedger()
    let providerAttempts = 0
    const proxy = await startExternalOptimizerModelProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'provider-secret',
      model: 'model-a',
      budget: modelBudget(),
      costLedger: ledger,
      phase: 'optimizer',
      actor: 'official-library',
      fetchImpl: async () => {
        providerAttempts += 1
        if (providerAttempts === 1) throw new Error('transient provider failure')
        return successfulProviderResponse()
      },
    })

    try {
      expect((await postModel(proxy, validModelRequest())).status).not.toBe(200)
      expect((await postModel(proxy, validModelRequest())).status).toBe(200)
      expect(proxy.requestAttempts()).toBe(2)
      expect(proxy.requestAttempts()).toBe(2)
      expect(proxy.successfulCompletions()).toBe(1)
      expect(ledger.summary()).toMatchObject({
        totalCalls: 2,
        pendingCalls: 0,
      })
      expect(ledger.list()[0]).toMatchObject({
        costUnknown: true,
        usageUnknown: true,
      })
      expect(ledger.list()[1]).toMatchObject({
        costUnknown: false,
        usageUnknown: false,
      })
    } finally {
      await proxy.close()
    }
  })
})

function postEvaluation(url: string, token: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ candidate: 'candidate', exampleId: 'case' }),
    signal,
  })
}

function postModel(
  proxy: { baseUrl: string; apiKey: string },
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${proxy.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
}

async function postStatus(url: string, token: string): Promise<number> {
  const result = await settled(postEvaluation(url, token, AbortSignal.timeout(250)))
  return result instanceof Response ? result.status : 0
}

async function postModelStatus(
  proxy: { baseUrl: string; apiKey: string },
  body: Record<string, unknown>,
): Promise<number> {
  const result = await settled(postModel(proxy, body, AbortSignal.timeout(250)))
  return result instanceof Response ? result.status : 0
}

function validModelRequest(): Record<string, unknown> {
  return {
    model: 'model-a',
    messages: [{ role: 'user', content: 'improve this' }],
    max_tokens: 20,
  }
}

function successfulProviderResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'revised' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function modelBudget() {
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
  }
}

async function settled<T>(promise: Promise<T>): Promise<T | Error> {
  try {
    return await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => false), delay(10).then(() => true)])
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
