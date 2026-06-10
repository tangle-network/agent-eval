import { describe, expect, it } from 'vitest'
import { extractUsage, extractUsageFromResponse, extractUsageFromSse } from './extract-usage'

describe('extractUsage', () => {
  it('reads the OpenAI prompt/completion shape', () => {
    expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({
      input: 10,
      output: 5,
    })
  })

  it('reads the Anthropic input/output shape and cache reads', () => {
    expect(
      extractUsage({ usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 } }),
    ).toEqual({ input: 12, output: 7, cached: 3 })
  })

  it('reads camelCase variants and a body that IS the usage object', () => {
    expect(extractUsage({ promptTokens: 4, completionTokens: 2 })).toEqual({ input: 4, output: 2 })
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
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"usage":{"prompt_tokens":0,"completion_tokens":4}}',
      'data: [DONE]',
      '',
    ].join('\n')
    expect(extractUsageFromSse(sse)).toEqual({ input: 10, output: 5 })
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
    const res = new Response('data: {"usage":{"input_tokens":2,"output_tokens":6}}\ndata: [DONE]\n')
    expect(await extractUsageFromResponse(res)).toEqual({ input: 2, output: 6 })
  })
})
