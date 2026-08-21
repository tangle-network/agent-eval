import { describe, expect, it } from 'vitest'
import {
  assertModelsServed,
  type ModelEndpointRequest,
  ModelsUnreachableError,
  preflightModels,
} from './preflight'
import { PROBE_MAX_TOKENS } from './served-model'

function listResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Build an endpoint fake whose probe responses are keyed by model id. A 200
 * with no explicit body echoes the requested model, matching what an
 * OpenAI-compatible provider sends; pass a body with a different `model` to
 * simulate a gateway substituting one.
 */
function makeRequest(
  listedIds: string[],
  probeByModel: Record<string, { status: number; body?: unknown }> = {},
): ModelEndpointRequest {
  return async (check) => {
    if (check.kind === 'list-models') return listResponse(listedIds)
    const spec = probeByModel[check.model] ?? { status: 200 }
    const body =
      spec.body === undefined && spec.status === 200 ? { model: check.model } : (spec.body ?? {})
    return new Response(JSON.stringify(body), {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('preflightModels — membership only', () => {
  it('marks listed vs unlisted models, served null when not probed', async () => {
    const out = await preflightModels({
      models: ['claude-sonnet-4-6', 'opencode/zai-coding-plan/glm-5.1'],
      request: makeRequest(['claude-sonnet-4-6', 'deepseek-v4-pro']),
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
})

describe('preflightModels — probe', () => {
  it('served true on 200', async () => {
    const out = await preflightModels({
      models: ['claude-sonnet-4-6'],
      probe: true,
      request: makeRequest(['claude-sonnet-4-6'], { 'claude-sonnet-4-6': { status: 200 } }),
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
      models: ['opencode/zai-coding-plan/glm-5.1'],
      probe: true,
      request: makeRequest([], {
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
      models: ['deepseek-v4-pro'],
      probe: true,
      request: makeRequest(['deepseek-v4-pro'], { 'deepseek-v4-pro': { status: 503, body: {} } }),
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
      models: ['gpt-4.1-mini'],
      probe: true,
      request: makeRequest(['gpt-4.1-mini'], {
        'gpt-4.1-mini': { status: 429, body: { error: { message: 'rate limited' } } },
      }),
    })
    expect(out.value?.[0]).toMatchObject({ served: false, status: 429, detail: 'rate limited' })
  })
})

describe('preflightModels — network failure', () => {
  it('GET failure returns a typed outcome, never throws', async () => {
    const request: ModelEndpointRequest = async () => {
      throw new Error('ECONNREFUSED')
    }
    const out = await preflightModels({
      models: ['claude-sonnet-4-6'],
      request,
    })
    expect(out.succeeded).toBe(false)
    expect(out.value).toBeNull()
    expect(out.error).toContain('ECONNREFUSED')
  })

  it('non-2xx /models returns a typed outcome with the status', async () => {
    const request: ModelEndpointRequest = async () => new Response('forbidden', { status: 403 })
    const out = await preflightModels({
      models: ['claude-sonnet-4-6'],
      request,
    })
    expect(out.succeeded).toBe(false)
    expect(out.error).toContain('403')
  })

  it('probe POST failure returns a typed outcome', async () => {
    const request: ModelEndpointRequest = async (check) => {
      if (check.kind === 'list-models') return listResponse(['claude-sonnet-4-6'])
      throw new Error('socket hang up')
    }
    const out = await preflightModels({
      models: ['claude-sonnet-4-6'],
      probe: true,
      request,
    })
    expect(out.succeeded).toBe(false)
    expect(out.error).toContain('socket hang up')
  })
})

describe('assertModelsServed', () => {
  it('passes silently when every model is served', async () => {
    const models = ['claude-sonnet-4-6', 'deepseek-v4-pro', 'gpt-4.1-mini']
    await expect(
      assertModelsServed({ models, request: makeRequest(models) }),
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
        models,
        probe: true,
        request: makeRequest(['claude-sonnet-4-6', 'claude-code/dead-c'], {
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
        models: ['deepseek-v4-pro'],
        probe: true,
        request: makeRequest(['deepseek-v4-pro'], { 'deepseek-v4-pro': { status: 503, body: {} } }),
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
        models: ['gpt-4.1-mini'],
        probe: true,
        request: makeRequest(['gpt-4.1-mini'], {
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
        models: ['deepseek-v4-pro'],
        probe: true,
        request: makeRequest(['deepseek-v4-pro'], {
          'deepseek-v4-pro': { status: 200, body: {} },
        }),
      }),
    ).rejects.toThrow(/identity unproven/)
  })

  it('accepts an unreported id only when the caller opts in', async () => {
    await expect(
      assertModelsServed({
        models: ['deepseek-v4-pro'],
        probe: true,
        allowUnreported: true,
        request: makeRequest(['deepseek-v4-pro'], {
          'deepseek-v4-pro': { status: 200, body: {} },
        }),
      }),
    ).resolves.toHaveLength(1)
  })

  it('accepts a same-family swap only when the caller opts in', async () => {
    const request = makeRequest(['deepseek/deepseek-v3.2'], {
      'deepseek/deepseek-v3.2': { status: 200, body: { model: 'deepseek-v4-flash' } },
    })
    await expect(
      assertModelsServed({
        models: ['deepseek/deepseek-v3.2'],
        probe: true,
        request,
      }),
    ).rejects.toThrow(ModelsUnreachableError)
    await expect(
      assertModelsServed({
        models: ['deepseek/deepseek-v3.2'],
        probe: true,
        allowWithinFamily: true,
        request,
      }),
    ).resolves.toHaveLength(1)
  })

  it('treats a provider-prefixed request answered by the bare id as the same model', async () => {
    await expect(
      assertModelsServed({
        models: ['zai/glm-5.2'],
        probe: true,
        request: makeRequest(['zai/glm-5.2'], {
          'zai/glm-5.2': { status: 200, body: { model: 'glm-5.2' } },
        }),
      }),
    ).resolves.toHaveLength(1)
  })

  it('rethrows a network failure rather than reporting a partial pass', async () => {
    const request: ModelEndpointRequest = async () => {
      throw new Error('ECONNREFUSED')
    }
    await expect(assertModelsServed({ models: ['claude-sonnet-4-6'], request })).rejects.toThrow(
      /ECONNREFUSED/,
    )
  })
})

describe('preflightModels — probe budget', () => {
  /** Capture the output-token budget each probe requested. */
  function recordingRequest(
    sent: number[],
    spec: Record<string, { status: number; body?: unknown }>,
  ): ModelEndpointRequest {
    return async (check) => {
      if (check.kind === 'list-models') return listResponse(Object.keys(spec))
      sent.push(check.maxOutputTokens)
      const outcome = spec[check.model] ?? { status: 200 }
      const body =
        outcome.body === undefined && outcome.status === 200
          ? { model: check.model }
          : (outcome.body ?? {})
      return new Response(JSON.stringify(body), {
        status: outcome.status,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  it('spends the shared probe budget, not a budget a reasoning model cannot answer within', async () => {
    const sent: number[] = []
    await preflightModels({
      models: ['deepseek-v4-pro'],
      probe: true,
      request: recordingRequest(sent, { 'deepseek-v4-pro': { status: 200 } }),
    })
    expect(sent).toEqual([PROBE_MAX_TOKENS])
    expect(PROBE_MAX_TOKENS).toBeGreaterThanOrEqual(64)
  })

  it('honours an explicit probeMaxTokens', async () => {
    const sent: number[] = []
    await preflightModels({
      models: ['deepseek-v4-pro'],
      probe: true,
      probeMaxTokens: 512,
      request: recordingRequest(sent, { 'deepseek-v4-pro': { status: 200 } }),
    })
    expect(sent).toEqual([512])
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses probeMaxTokens %s instead of probing with a nonsense budget',
    async (probeMaxTokens) => {
      const out = await preflightModels({
        models: ['deepseek-v4-pro'],
        probe: true,
        probeMaxTokens,
        request: makeRequest(['deepseek-v4-pro']),
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
      models: ['deepseek-v4-pro'],
      probe: true,
      probeMaxTokens: 5,
      request: makeRequest(['deepseek-v4-pro'], { 'deepseek-v4-pro': exhausted }),
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
      models: ['deepseek-v4-pro'],
      probe: true,
      request: makeRequest(['deepseek-v4-pro'], {
        'deepseek-v4-pro': { status: 503, body: { error: { message } } },
      }),
    })
    expect(out.value?.[0]?.budgetExhausted).toBe(true)
    expect(out.value?.[0]?.served).toBe(true)
  })

  it('leaves an ordinary 503 scored as dead', async () => {
    const out = await preflightModels({
      models: ['kimi-k2.6'],
      probe: true,
      request: makeRequest(['kimi-k2.6'], {
        'kimi-k2.6': { status: 503, body: { error: { message: 'No provider configured' } } },
      }),
    })
    expect(out.value?.[0]).toMatchObject({ served: false, budgetExhausted: false })
  })

  it('still blocks the run, naming the budget rather than declaring the model dead', async () => {
    const failure = await assertModelsServed({
      models: ['deepseek-v4-pro'],
      probe: true,
      probeMaxTokens: 5,
      request: makeRequest(['deepseek-v4-pro'], { 'deepseek-v4-pro': exhausted }),
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
        models: ['deepseek-v4-pro'],
        probe: true,
        probeMaxTokens: 5,
        allowUnreported: true,
        request: makeRequest(['deepseek-v4-pro'], { 'deepseek-v4-pro': exhausted }),
      }),
    ).resolves.toHaveLength(1)
  })
})
