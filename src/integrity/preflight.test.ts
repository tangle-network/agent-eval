import { describe, expect, it } from 'vitest'
import { assertModelsServed, ModelsUnreachableError, preflightModels } from './preflight'
import { PROBE_MAX_TOKENS } from './served-model'

const BASE = 'https://router.tangle.tools/v1'
const KEY = 'test-key'

function listResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Build a fetch fake whose chat-completions responses are keyed by model id.
 * A 200 with no explicit body echoes the requested model, matching what an
 * OpenAI-compatible provider sends; pass a body with a different `model` to
 * simulate a gateway substituting one.
 */
function makeFetch(
  listedIds: string[],
  probeByModel: Record<string, { status: number; body?: unknown }> = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/models')) return listResponse(listedIds)
    if (url.endsWith('/chat/completions')) {
      const model = JSON.parse(String(init?.body)).model as string
      const spec = probeByModel[model] ?? { status: 200 }
      const body = spec.body === undefined && spec.status === 200 ? { model } : (spec.body ?? {})
      return new Response(JSON.stringify(body), {
        status: spec.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected url ${url}`)
  }) as typeof fetch
}

describe('preflightModels — membership only', () => {
  it('marks listed vs unlisted models, served null when not probed', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6', 'opencode/zai-coding-plan/glm-5.1'],
      fetchImpl: makeFetch(['claude-sonnet-4-6', 'deepseek-v4-pro']),
    })
    expect(out.succeeded).toBe(true)
    expect(out.error).toBeNull()
    expect(out.value).toEqual([
      {
        model: 'claude-sonnet-4-6',
        listed: true,
        served: null,
        status: null,
        detail: null,
        budgetExhausted: false,
        substitution: null,
      },
      {
        model: 'opencode/zai-coding-plan/glm-5.1',
        listed: false,
        served: null,
        status: null,
        detail: null,
        budgetExhausted: false,
        substitution: null,
      },
    ])
  })

  it('tolerates a trailing slash on baseUrl', async () => {
    const out = await preflightModels({
      baseUrl: `${BASE}/`,
      apiKey: KEY,
      models: ['claude-haiku-4-5'],
      fetchImpl: makeFetch(['claude-haiku-4-5']),
    })
    expect(out.value?.[0]?.listed).toBe(true)
  })
})

describe('preflightModels — probe', () => {
  it('served true on 200', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      probe: true,
      fetchImpl: makeFetch(['claude-sonnet-4-6'], { 'claude-sonnet-4-6': { status: 200 } }),
    })
    expect(out.value).toEqual([
      {
        model: 'claude-sonnet-4-6',
        listed: true,
        served: true,
        status: 200,
        detail: null,
        budgetExhausted: false,
        substitution: {
          requested: 'claude-sonnet-4-6',
          served: 'claude-sonnet-4-6',
          requestedFamily: 'anthropic',
          servedFamily: 'anthropic',
          verdict: 'exact',
          substituted: false,
        },
      },
    ])
  })

  it('served false on 401 and captures the body error.message as detail', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['opencode/zai-coding-plan/glm-5.1'],
      probe: true,
      fetchImpl: makeFetch([], {
        'opencode/zai-coding-plan/glm-5.1': {
          status: 401,
          body: {
            message: 'No API key configured for model opencode/zai-coding-plan/glm-5.1',
            code: 'model_not_found',
          },
        },
      }),
    })
    expect(out.value).toEqual([
      {
        model: 'opencode/zai-coding-plan/glm-5.1',
        listed: false,
        served: false,
        status: 401,
        detail: 'No API key configured for model opencode/zai-coding-plan/glm-5.1',
        budgetExhausted: false,
        substitution: null,
      },
    ])
  })

  it('served false on 503 with no usable body message', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['deepseek-v4-pro'],
      probe: true,
      fetchImpl: makeFetch(['deepseek-v4-pro'], { 'deepseek-v4-pro': { status: 503, body: {} } }),
    })
    expect(out.value).toEqual([
      {
        model: 'deepseek-v4-pro',
        listed: true,
        served: false,
        status: 503,
        detail: null,
        budgetExhausted: false,
        substitution: null,
      },
    ])
  })

  it('reads error.message nested under error', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['gpt-4.1-mini'],
      probe: true,
      fetchImpl: makeFetch(['gpt-4.1-mini'], {
        'gpt-4.1-mini': { status: 429, body: { error: { message: 'rate limited' } } },
      }),
    })
    expect(out.value?.[0]).toMatchObject({ served: false, status: 429, detail: 'rate limited' })
  })
})

describe('preflightModels — network failure', () => {
  it('GET failure returns a typed outcome, never throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      fetchImpl,
    })
    expect(out.succeeded).toBe(false)
    expect(out.value).toBeNull()
    expect(out.error).toContain('ECONNREFUSED')
  })

  it('non-2xx /models returns a typed outcome with the status', async () => {
    const fetchImpl = (async () => new Response('forbidden', { status: 403 })) as typeof fetch
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      fetchImpl,
    })
    expect(out.succeeded).toBe(false)
    expect(out.error).toContain('403')
  })

  it('probe POST failure returns a typed outcome', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/models')) return listResponse(['claude-sonnet-4-6'])
      throw new Error('socket hang up')
    }) as typeof fetch
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['claude-sonnet-4-6'],
      probe: true,
      fetchImpl,
    })
    expect(out.succeeded).toBe(false)
    expect(out.error).toContain('socket hang up')
  })
})

describe('assertModelsServed', () => {
  it('passes silently when every model is served', async () => {
    const models = ['claude-sonnet-4-6', 'deepseek-v4-pro', 'gpt-4.1-mini']
    await expect(
      assertModelsServed({ baseUrl: BASE, apiKey: KEY, models, fetchImpl: makeFetch(models) }),
    ).resolves.toHaveLength(3)
  })

  it('throws naming EVERY dead model — unlisted and probe-failed alike', async () => {
    const models = [
      'claude-sonnet-4-6',
      'opencode/dead-a',
      'kimi-code/dead-b',
      'claude-code/dead-c',
    ]
    let thrown: unknown
    try {
      await assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models,
        probe: true,
        fetchImpl: makeFetch(['claude-sonnet-4-6', 'claude-code/dead-c'], {
          'claude-sonnet-4-6': { status: 200 },
          'opencode/dead-a': {
            status: 401,
            body: { message: 'No API key configured for model opencode/dead-a' },
          },
          'kimi-code/dead-b': {
            status: 401,
            body: { message: 'No API key configured for model kimi-code/dead-b' },
          },
          // listed but unconfigured: caught only by the probe
          'claude-code/dead-c': {
            status: 401,
            body: { message: 'No API key configured for model claude-code/dead-c' },
          },
        }),
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ModelsUnreachableError)
    const msg = (thrown as Error).message
    expect(msg).toContain('opencode/dead-a')
    expect(msg).toContain('kimi-code/dead-b')
    expect(msg).toContain('claude-code/dead-c')
    expect(msg).toContain('3/4')
    // the served model is never named
    expect(msg).not.toContain('claude-sonnet-4-6')
    expect((thrown as ModelsUnreachableError).results).toHaveLength(4)
  })

  it('a listed-but-probe-failed model is dead (no partial silent pass)', async () => {
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek-v4-pro'],
        probe: true,
        fetchImpl: makeFetch(['deepseek-v4-pro'], { 'deepseek-v4-pro': { status: 503, body: {} } }),
      }),
    ).rejects.toThrow(ModelsUnreachableError)
  })

  // A 200 from the wrong model is the failure a reachability-only gate waves
  // through: the id is listed, the probe succeeds, and the campaign then
  // reports numbers for a model it never called.
  it('fails an id the router answers from a different family', async () => {
    let thrown: unknown
    try {
      await assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['gpt-4.1-mini'],
        probe: true,
        fetchImpl: makeFetch(['gpt-4.1-mini'], {
          'gpt-4.1-mini': { status: 200, body: { model: 'gemini-2.5-flash-lite' } },
        }),
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ModelsUnreachableError)
    const msg = (thrown as Error).message
    expect(msg).toContain('gpt-4.1-mini')
    expect(msg).toContain('gemini-2.5-flash-lite')
    expect(msg).toContain('substituted-cross-family')
    const results = (thrown as ModelsUnreachableError).results
    expect(results[0]?.served).toBe(true)
    expect(results[0]?.substitution?.substituted).toBe(true)
  })

  it('fails a 200 that echoes no model id — reachable is not identified', async () => {
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek-v4-pro'],
        probe: true,
        fetchImpl: makeFetch(['deepseek-v4-pro'], {
          'deepseek-v4-pro': { status: 200, body: {} },
        }),
      }),
    ).rejects.toThrow(/identity unproven/)
  })

  it('accepts an unreported id only when the caller opts in', async () => {
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek-v4-pro'],
        probe: true,
        allowUnreported: true,
        fetchImpl: makeFetch(['deepseek-v4-pro'], {
          'deepseek-v4-pro': { status: 200, body: {} },
        }),
      }),
    ).resolves.toHaveLength(1)
  })

  it('accepts a same-family swap only when the caller opts in', async () => {
    const fetchImpl = makeFetch(['deepseek/deepseek-v3.2'], {
      'deepseek/deepseek-v3.2': { status: 200, body: { model: 'deepseek-v4-flash' } },
    })
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek/deepseek-v3.2'],
        probe: true,
        fetchImpl,
      }),
    ).rejects.toThrow(ModelsUnreachableError)
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek/deepseek-v3.2'],
        probe: true,
        allowWithinFamily: true,
        fetchImpl,
      }),
    ).resolves.toHaveLength(1)
  })

  it('treats a provider-prefixed request answered by the bare id as the same model', async () => {
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['zai/glm-5.2'],
        probe: true,
        fetchImpl: makeFetch(['zai/glm-5.2'], {
          'zai/glm-5.2': { status: 200, body: { model: 'glm-5.2' } },
        }),
      }),
    ).resolves.toHaveLength(1)
  })

  it('rethrows a network failure rather than reporting a partial pass', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    await expect(
      assertModelsServed({ baseUrl: BASE, apiKey: KEY, models: ['claude-sonnet-4-6'], fetchImpl }),
    ).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('preflightModels — probe budget', () => {
  /** Capture the max_tokens each probe requested. */
  function recordingFetch(
    sent: number[],
    spec: Record<string, { status: number; body?: unknown }>,
  ) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/models')) return listResponse(Object.keys(spec))
      const request = JSON.parse(String(init?.body))
      sent.push(request.max_tokens)
      const outcome = spec[request.model as string] ?? { status: 200 }
      const body =
        outcome.body === undefined && outcome.status === 200
          ? { model: request.model }
          : (outcome.body ?? {})
      return new Response(JSON.stringify(body), {
        status: outcome.status,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  }

  it('spends the shared probe budget, not a budget a reasoning model cannot answer within', async () => {
    const sent: number[] = []
    await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['deepseek-v4-pro'],
      probe: true,
      fetchImpl: recordingFetch(sent, { 'deepseek-v4-pro': { status: 200 } }),
    })
    expect(sent).toEqual([PROBE_MAX_TOKENS])
    expect(PROBE_MAX_TOKENS).toBeGreaterThanOrEqual(64)
  })

  it('honours an explicit probeMaxTokens', async () => {
    const sent: number[] = []
    await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['deepseek-v4-pro'],
      probe: true,
      probeMaxTokens: 512,
      fetchImpl: recordingFetch(sent, { 'deepseek-v4-pro': { status: 200 } }),
    })
    expect(sent).toEqual([512])
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses probeMaxTokens %s instead of probing with a nonsense budget',
    async (probeMaxTokens) => {
      const out = await preflightModels({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek-v4-pro'],
        probe: true,
        probeMaxTokens,
        fetchImpl: makeFetch(['deepseek-v4-pro']),
      })
      expect(out.succeeded).toBe(false)
      expect(out.error).toMatch(/probeMaxTokens must be a positive integer/)
    },
  )

  const exhausted = {
    status: 503,
    body: { error: { message: 'reasoning_budget_exhausted', code: 'reasoning_budget_exhausted' } },
  }

  it('reports a reasoning model that ran out of budget as alive, not dead', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['deepseek-v4-pro'],
      probe: true,
      probeMaxTokens: 5,
      fetchImpl: makeFetch(['deepseek-v4-pro'], { 'deepseek-v4-pro': exhausted }),
    })
    expect(out.value?.[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      listed: true,
      served: true,
      status: 503,
      budgetExhausted: true,
    })
    // The provider echoed no model id, so identity stays unproven.
    expect(out.value?.[0]?.substitution?.verdict).toBe('unreported')
  })

  it.each([
    'reasoning budget exhausted',
    'Reasoning-Budget-Exhausted for this request',
    'upstream error: reasoning_budget_exhausted',
  ])('recognises the budget signature in %j', async (message) => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['deepseek-v4-pro'],
      probe: true,
      fetchImpl: makeFetch(['deepseek-v4-pro'], {
        'deepseek-v4-pro': { status: 503, body: { error: { message } } },
      }),
    })
    expect(out.value?.[0]?.budgetExhausted).toBe(true)
    expect(out.value?.[0]?.served).toBe(true)
  })

  it('leaves an ordinary 503 scored as dead', async () => {
    const out = await preflightModels({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['kimi-k2.6'],
      probe: true,
      fetchImpl: makeFetch(['kimi-k2.6'], {
        'kimi-k2.6': { status: 503, body: { error: { message: 'No provider configured' } } },
      }),
    })
    expect(out.value?.[0]).toMatchObject({ served: false, budgetExhausted: false })
  })

  it('still blocks the run, naming the budget rather than declaring the model dead', async () => {
    const failure = await assertModelsServed({
      baseUrl: BASE,
      apiKey: KEY,
      models: ['deepseek-v4-pro'],
      probe: true,
      probeMaxTokens: 5,
      fetchImpl: makeFetch(['deepseek-v4-pro'], { 'deepseek-v4-pro': exhausted }),
    }).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(ModelsUnreachableError)
    const message = (failure as Error).message
    expect(message).toMatch(/ran out of reasoning budget/)
    expect(message).toMatch(/Raise probeMaxTokens/)
    expect(message).not.toMatch(/not in \/models/)
  })

  it('accepts a budget-exhausted probe when the caller allows unproven identity', async () => {
    await expect(
      assertModelsServed({
        baseUrl: BASE,
        apiKey: KEY,
        models: ['deepseek-v4-pro'],
        probe: true,
        probeMaxTokens: 5,
        allowUnreported: true,
        fetchImpl: makeFetch(['deepseek-v4-pro'], { 'deepseek-v4-pro': exhausted }),
      }),
    ).resolves.toHaveLength(1)
  })
})
