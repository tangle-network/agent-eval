import { describe, expect, it } from 'vitest'
import { extractUsage, extractUsageFromResponse, extractUsageFromSse } from './extract-usage'

describe('extractUsage', () => {
  it('reads the OpenAI prompt/completion shape', () => {
    expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({
      input: 10,
      output: 5,
    })
  })

  it('keeps Anthropic cache reads and writes separate', () => {
    expect(
      extractUsage({
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      }),
    ).toEqual({ input: 12, output: 7, cached: 3, cacheWrite: 4 })
  })

  it('reads camelCase variants and a body that IS the usage object', () => {
    expect(extractUsage({ promptTokens: 4, completionTokens: 2 })).toEqual({ input: 4, output: 2 })
  })

  it('does not drop a cache-only usage payload', () => {
    expect(extractUsage({ usage: { cache_creation_input_tokens: 9 } })).toEqual({
      input: 0,
      output: 0,
      cacheWrite: 9,
    })
  })

  it('reads OpenCode nested cache usage and distinct reasoning tokens', () => {
    expect(
      extractUsage({
        input: 250,
        output: 1264,
        reasoning: 41,
        cache: { read: 12096, write: 7 },
      }),
    ).toEqual({ input: 250, output: 1305, reasoning: 41, cached: 12096, cacheWrite: 7 })
  })

  it('reads provider detail objects without double-counting reasoning', () => {
    expect(
      extractUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      }),
    ).toEqual({ input: 100, output: 50, reasoning: 30, cached: 80 })
    expect(
      extractUsage({
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 12 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      }),
    ).toEqual({ input: 20, output: 10, reasoning: 4, cached: 12 })
    expect(
      extractUsage({
        input_tokens: 100,
        output_tokens: 50,
        reasoning_output_tokens: 30,
      }),
    ).toEqual({ input: 100, output: 50, reasoning: 30 })
  })

  it('returns null (not a silent zero) when no usage is present', () => {
    expect(extractUsage({ choices: [] })).toBeNull()
    expect(extractUsage('not an object')).toBeNull()
    expect(extractUsage(null)).toBeNull()
  })

  it('ignores negative / non-finite counts', () => {
    expect(extractUsage({ usage: { prompt_tokens: -1, completion_tokens: 5 } })).toEqual({
      input: 0,
      output: 5,
    })
  })
})

describe('extractUsageFromSse', () => {
  it('sums usage across data: chunks and skips [DONE]', () => {
    const sse = [
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":1}}',
      '',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: {"usage":{"prompt_tokens":0,"completion_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    expect(extractUsageFromSse(sse, { mode: 'delta' })).toEqual({ input: 10, output: 5 })
  })

  it('does not add cumulative usage snapshots together', () => {
    const sse = [
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":1}}',
      '',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      '',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      '',
    ].join('\n')

    expect(extractUsageFromSse(sse)).toEqual({ input: 10, output: 5 })
  })

  it('parses standard multiline data fields as one SSE event', () => {
    const sse = [
      'event: usage',
      'data: {"usage":',
      'data: {"input_tokens":2,"output_tokens":6}}',
      '',
    ].join('\n')

    expect(extractUsageFromSse(sse)).toEqual({ input: 2, output: 6 })
  })

  it('sums cache reads and writes across data chunks', () => {
    const sse = [
      'data: {"usage":{"input_tokens":1,"cache_read_input_tokens":3}}',
      '',
      'data: {"usage":{"output_tokens":2,"cache_creation_input_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    expect(extractUsageFromSse(sse)).toEqual({
      input: 1,
      output: 2,
      cached: 3,
      cacheWrite: 4,
    })
  })

  it('returns null when no chunk carried usage', () => {
    expect(extractUsageFromSse('data: {"choices":[]}\ndata: [DONE]\n')).toBeNull()
  })
})

describe('extractUsageFromResponse', () => {
  it('parses a JSON response without consuming the caller body', async () => {
    const res = new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 9 } }))
    const usage = await extractUsageFromResponse(res)
    expect(usage).toEqual({ input: 3, output: 9 })
    // original body still readable by the caller
    expect(await res.text()).toContain('prompt_tokens')
  })

  it('falls back to SSE accumulation for a streamed body', async () => {
    const res = new Response(
      'data: {"usage":{"input_tokens":2,"output_tokens":6}}\n\ndata: [DONE]\n\n',
    )
    expect(await extractUsageFromResponse(res)).toEqual({ input: 2, output: 6 })
  })
})
