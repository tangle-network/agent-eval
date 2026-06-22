import type { AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it, vi } from 'vitest'
import {
  MultishotDriverEmptyError,
  MultishotFatalToolError,
  type MultishotPersona,
  type MultishotShape,
  runMultishot,
} from '../../src/multishot/index'

interface TestPersona extends MultishotPersona {
  id: string
  name: string
}

const PROFILE: AgentProfile = {
  name: 'test',
  prompt: { systemPrompt: 'You are a test agent. Always call delegate_research before answering.' },
}

const SHAPE: MultishotShape<TestPersona> = {
  buildOpener: (p) => `hi i'm ${p.name}, help me.`,
  buildDriverSystemPrompt: (p) => `you are ${p.name}. push back on vague answers.`,
}

const PERSONA: TestPersona = { id: 'alice', name: 'Alice' }

function makeFetchStub(
  responses: Array<{
    content?: string
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  }>,
) {
  let i = 0
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = responses[i++]
    if (!r) throw new Error(`fetch stub exhausted at call ${i}`)
    const message: {
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    } = {
      content: r.content ?? null,
    }
    if (r.toolCalls?.length) {
      message.tool_calls = r.toolCalls.map((tc, idx) => ({
        id: `call-${i}-${idx}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }))
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      text: async () => 'ok',
    } as Response
  })
}

describe('runMultishot', () => {
  it('runs N turns, captures transcript + tool calls + cost', async () => {
    const originalFetch = global.fetch
    // Sequence per turn (maxTurns=2):
    // t0 agent: tool_call delegate_research
    // tool exec: research result (1 call)
    // t0 agent follow-up: text
    // t0 driver: pushback
    // t1 agent: text
    // (no driver turn after last)
    global.fetch = makeFetchStub([
      { toolCalls: [{ name: 'delegate_research', args: { question: 'who is alice?' } }] },
      { content: '# Research Brief\n- Finding 1: alice exists [src: census]' },
      { content: 'after research: hello Alice — based on the brief, you exist.' },
      { content: 'great, but i need more specifics about MY situation' },
      { content: 'specifically, you are user alice. final brief.' },
    ]) as unknown as typeof fetch
    process.env.TANGLE_API_KEY = 'test-key'

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
    })

    expect(result.transcript.filter((m) => m.role === 'assistant').length).toBeGreaterThanOrEqual(2)
    expect(result.toolCalls).toBe(1)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].type).toBe('research')
    expect(result.artifacts[0].invocation.name).toBe('delegate_research')
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    global.fetch = originalFetch
  })

  it('throws MultishotDriverEmptyError when driver returns empty twice', async () => {
    const originalFetch = global.fetch
    // t0 agent: text → t0 driver attempt 1: empty → driver attempt 2: empty → throws
    global.fetch = makeFetchStub([
      { content: 'agent turn 0 text' },
      { content: '' },
      { content: '' },
    ]) as unknown as typeof fetch
    process.env.TANGLE_API_KEY = 'test-key'

    await expect(
      runMultishot({ profile: PROFILE, persona: PERSONA, shape: SHAPE, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(MultishotDriverEmptyError)

    global.fetch = originalFetch
  })

  it('retries driver once and continues when retry produces content', async () => {
    const originalFetch = global.fetch
    global.fetch = makeFetchStub([
      { content: 'agent t0' },
      { content: '' }, // driver attempt 1 empty
      { content: 'driver retry succeeded' },
      { content: 'agent t1' },
    ]) as unknown as typeof fetch
    process.env.TANGLE_API_KEY = 'test-key'

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
    })
    const driverTurns = result.transcript.filter((m) => m.role === 'user').slice(1) // skip opener
    expect(driverTurns[0].content).toBe('driver retry succeeded')

    global.fetch = originalFetch
  })

  it('aborts cleanly when signal is set', async () => {
    process.env.TANGLE_API_KEY = 'test-key'
    const ctl = new AbortController()
    ctl.abort()
    await expect(
      runMultishot({
        profile: PROFILE,
        persona: PERSONA,
        shape: SHAPE,
        maxTurns: 2,
        signal: ctl.signal,
      }),
    ).rejects.toThrow(/aborted/)
  })

  it('respects custom tools + executors', async () => {
    const originalFetch = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'

    const customExecutor = vi.fn(async () => ({ content: 'custom tool result', costUsd: 0.001 }))

    global.fetch = makeFetchStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }] },
      { content: 'agent after custom tool' },
    ]) as unknown as typeof fetch

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 1,
      tools: [
        {
          type: 'function',
          function: {
            name: 'my_custom_tool',
            description: 'test',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      toolExecutors: { my_custom_tool: customExecutor },
      artifactTypeFor: (name) => (name === 'my_custom_tool' ? 'custom' : undefined),
    })

    expect(customExecutor).toHaveBeenCalledOnce()
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].type).toBe('custom')
    expect(result.artifacts[0].content).toBe('custom tool result')

    global.fetch = originalFetch
  })

  it('keeps tools available across follow-up dispatch rounds', async () => {
    const originalFetch = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'

    const customExecutor = vi.fn(async () => ({ content: 'custom tool result', costUsd: 0.001 }))
    const fetchStub = makeFetchStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }] },
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 2 } }] },
      { content: 'agent after two custom tools' },
    ])
    global.fetch = fetchStub as unknown as typeof fetch

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 1,
      tools: [
        {
          type: 'function',
          function: {
            name: 'my_custom_tool',
            description: 'test',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      toolExecutors: { my_custom_tool: customExecutor },
      artifactTypeFor: (name) => (name === 'my_custom_tool' ? 'custom' : undefined),
    })

    expect(customExecutor).toHaveBeenCalledTimes(2)
    expect(result.toolCalls).toBe(2)
    expect(result.artifacts).toHaveLength(2)
    const requestBodies = fetchStub.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>,
    )
    expect(requestBodies[0]).toHaveProperty('tools')
    expect(requestBodies[1]).toHaveProperty('tools')
    expect(requestBodies[2]).toHaveProperty('tools')

    global.fetch = originalFetch
  })

  it('does not send empty transcript messages to the driver after tool-only agent turns', async () => {
    const originalFetch = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'

    const fetchStub = makeFetchStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }] },
      { content: 'agent after custom tool' },
      { content: 'driver saw the tool use and continues' },
      { content: 'final agent answer' },
    ])
    global.fetch = fetchStub as unknown as typeof fetch

    await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      tools: [
        {
          type: 'function',
          function: {
            name: 'my_custom_tool',
            description: 'test',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      toolExecutors: {
        my_custom_tool: async () => ({ content: 'custom tool result', costUsd: 0.001 }),
      },
      artifactTypeFor: (name) => (name === 'my_custom_tool' ? 'custom' : undefined),
    })

    const driverRequest = JSON.parse(String(fetchStub.mock.calls[2][1]?.body)) as {
      messages: Array<{ role: string; content?: unknown }>
    }
    expect(driverRequest.messages.some((msg) => msg.content === '')).toBe(false)
    expect(driverRequest.messages).toContainEqual({
      role: 'user',
      content: 'Agent called tool: my_custom_tool.',
    })

    global.fetch = originalFetch
  })

  it('fails loud when one assistant turn exceeds the tool dispatch cap', async () => {
    const originalFetch = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = makeFetchStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }] },
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 2 } }] },
    ]) as unknown as typeof fetch

    await expect(
      runMultishot({
        profile: PROFILE,
        persona: PERSONA,
        shape: SHAPE,
        maxTurns: 1,
        maxToolDispatches: 1,
        tools: [
          {
            type: 'function',
            function: {
              name: 'my_custom_tool',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolExecutors: {
          my_custom_tool: async () => ({ content: 'custom tool result', costUsd: 0.001 }),
        },
      }),
    ).rejects.toThrow(/tool dispatch cap exceeded/)

    global.fetch = originalFetch
  })

  it('rethrows fatal tool errors instead of feeding them back to the agent', async () => {
    const originalFetch = global.fetch
    process.env.TANGLE_API_KEY = 'test-key'
    global.fetch = makeFetchStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }] },
    ]) as unknown as typeof fetch

    await expect(
      runMultishot({
        profile: PROFILE,
        persona: PERSONA,
        shape: SHAPE,
        maxTurns: 1,
        tools: [
          {
            type: 'function',
            function: {
              name: 'my_custom_tool',
              description: 'test',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolExecutors: {
          my_custom_tool: async () => {
            throw new MultishotFatalToolError('stop repeated tool loop')
          },
        },
      }),
    ).rejects.toBeInstanceOf(MultishotFatalToolError)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    global.fetch = originalFetch
  })
})
