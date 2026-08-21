import type { AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it, vi } from 'vitest'
import {
  MultishotDriverEmptyError,
  MultishotFatalToolError,
  type MultishotPersona,
  type MultishotShape,
  type MultishotToolDefinition,
  type MultishotTransport,
  type MultishotTransportRequest,
  type MultishotTransportResponse,
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

const USAGE = { prompt_tokens: 10, completion_tokens: 20 }

const CUSTOM_TOOL: MultishotToolDefinition = {
  type: 'function',
  function: {
    name: 'my_custom_tool',
    description: 'test',
    parameters: { type: 'object', properties: {} },
  },
}

function makeTransportStub(
  responses: Array<{
    content?: string
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    costUsd?: number
  }>,
) {
  let i = 0
  return vi.fn(async (_req: MultishotTransportRequest): Promise<MultishotTransportResponse> => {
    const r = responses[i++]
    if (!r) throw new Error(`transport stub exhausted at call ${i}`)
    return {
      message: {
        content: r.content ?? null,
        ...(r.toolCalls?.length
          ? {
              tool_calls: r.toolCalls.map((tc, idx) => ({
                id: `t-${i}-${idx}`,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      },
      usage: r.usage,
      costUsd: r.costUsd,
    }
  })
}

/** A leg the scenario must never reach — reaching it is the failure. */
function unreachedTransport(leg: string): MultishotTransport {
  return async () => {
    throw new Error(`${leg} leg must not run in this scenario`)
  }
}

describe('runMultishot', () => {
  it('sends the profile append prompt after the base system prompt', async () => {
    const agentRequests: MultishotTransportRequest[] = []
    await runMultishot({
      profile: {
        ...PROFILE,
        prompt: {
          ...PROFILE.prompt,
          appendSystemPrompt: 'Always cite the research artifact in your answer.',
        },
      },
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 1,
      agentTransport: async (request) => {
        agentRequests.push(request)
        return { message: { content: 'done' }, costUsd: 0 }
      },
      driverTransport: unreachedTransport('driver'),
    })

    expect(agentRequests[0]?.messages[0]).toEqual({
      role: 'system',
      content:
        'You are a test agent. Always call delegate_research before answering.\n\n' +
        'Always cite the research artifact in your answer.',
    })
  })

  it('runs N turns, captures transcript + tool calls + cost', async () => {
    // Agent leg per turn (maxTurns=2):
    // t0 agent: tool_call delegate_research
    // t0 tool leg: the research specialist, which defaults to the agent leg
    // t0 agent follow-up: text
    // t1 agent: text
    const agentTransport = makeTransportStub([
      {
        toolCalls: [{ name: 'delegate_research', args: { question: 'who is alice?' } }],
        usage: USAGE,
      },
      { content: '# Research Brief\n- Finding 1: alice exists [src: census]', usage: USAGE },
      { content: 'after research: hello Alice — based on the brief, you exist.', usage: USAGE },
      { content: 'specifically, you are user alice. final brief.', usage: USAGE },
    ])
    const driverTransport = makeTransportStub([
      { content: 'great, but i need more specifics about MY situation', usage: USAGE },
    ])

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      agentTransport,
      driverTransport,
    })

    expect(result.transcript.filter((m) => m.role === 'assistant').length).toBeGreaterThanOrEqual(2)
    expect(result.toolCalls).toBe(1)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].type).toBe('research')
    expect(result.artifacts[0].invocation.name).toBe('delegate_research')
    expect(result.costUsd).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('throws MultishotDriverEmptyError when driver returns empty twice', async () => {
    const agentTransport = makeTransportStub([{ content: 'agent turn 0 text', usage: USAGE }])
    const driverTransport = makeTransportStub([
      { content: '', usage: USAGE },
      { content: '', usage: USAGE },
    ])

    await expect(
      runMultishot({
        profile: PROFILE,
        persona: PERSONA,
        shape: SHAPE,
        maxTurns: 2,
        agentTransport,
        driverTransport,
      }),
    ).rejects.toBeInstanceOf(MultishotDriverEmptyError)
  })

  it('retries driver once and continues when retry produces content', async () => {
    const agentTransport = makeTransportStub([
      { content: 'agent t0', usage: USAGE },
      { content: 'agent t1', usage: USAGE },
    ])
    const driverTransport = makeTransportStub([
      { content: '', usage: USAGE },
      { content: 'driver retry succeeded', usage: USAGE },
    ])

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      agentTransport,
      driverTransport,
    })
    const driverTurns = result.transcript.filter((m) => m.role === 'user').slice(1) // skip opener
    expect(driverTurns[0].content).toBe('driver retry succeeded')
  })

  it('aborts cleanly when signal is set', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(
      runMultishot({
        profile: PROFILE,
        persona: PERSONA,
        shape: SHAPE,
        maxTurns: 2,
        agentTransport: unreachedTransport('agent'),
        driverTransport: unreachedTransport('driver'),
        signal: ctl.signal,
      }),
    ).rejects.toThrow(/aborted/)
  })

  it('respects custom tools + executors', async () => {
    const customExecutor = vi.fn(async () => ({ content: 'custom tool result', costUsd: 0.001 }))
    const agentTransport = makeTransportStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }], usage: USAGE },
      { content: 'agent after custom tool', usage: USAGE },
    ])

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 1,
      tools: [CUSTOM_TOOL],
      toolExecutors: { my_custom_tool: customExecutor },
      artifactTypeFor: (name) => (name === 'my_custom_tool' ? 'custom' : undefined),
      agentTransport,
      driverTransport: unreachedTransport('driver'),
    })

    expect(customExecutor).toHaveBeenCalledOnce()
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].type).toBe('custom')
    expect(result.artifacts[0].content).toBe('custom tool result')
  })

  it('keeps tools available across follow-up dispatch rounds', async () => {
    const customExecutor = vi.fn(async () => ({ content: 'custom tool result', costUsd: 0.001 }))
    const agentTransport = makeTransportStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }], usage: USAGE },
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 2 } }], usage: USAGE },
      { content: 'agent after two custom tools', usage: USAGE },
    ])

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 1,
      tools: [CUSTOM_TOOL],
      toolExecutors: { my_custom_tool: customExecutor },
      artifactTypeFor: (name) => (name === 'my_custom_tool' ? 'custom' : undefined),
      agentTransport,
      driverTransport: unreachedTransport('driver'),
    })

    expect(customExecutor).toHaveBeenCalledTimes(2)
    expect(result.toolCalls).toBe(2)
    expect(result.artifacts).toHaveLength(2)
    expect(agentTransport).toHaveBeenCalledTimes(3)
    for (const [req] of agentTransport.mock.calls) {
      expect(req.tools).toEqual([CUSTOM_TOOL])
    }
  })

  it('uses configured max token budgets for agent, tool follow-up, and driver calls', async () => {
    const agentTransport = makeTransportStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }], usage: USAGE },
      { content: 'agent after custom tool', usage: USAGE },
      { content: 'final agent answer', usage: USAGE },
    ])
    const driverTransport = makeTransportStub([{ content: 'driver follow-up', usage: USAGE }])

    await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      agentMaxTokens: 111,
      toolFollowupMaxTokens: 222,
      driverMaxTokens: 333,
      tools: [CUSTOM_TOOL],
      toolExecutors: {
        my_custom_tool: async () => ({ content: 'custom tool result', costUsd: 0.001 }),
      },
      agentTransport,
      driverTransport,
    })

    expect(agentTransport.mock.calls.map(([req]) => req.maxTokens)).toEqual([111, 222, 111])
    expect(driverTransport.mock.calls.map(([req]) => req.maxTokens)).toEqual([333])
  })

  it('tries driver fallback models after the primary driver returns empty twice', async () => {
    const agentTransport = makeTransportStub([
      { content: 'agent t0', usage: USAGE },
      { content: 'agent t1', usage: USAGE },
    ])
    const driverTransport = makeTransportStub([
      { content: '', usage: USAGE },
      { content: '', usage: USAGE },
      { content: 'fallback driver response', usage: USAGE },
    ])

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      driverModel: 'primary-driver',
      driverFallbackModels: ['fallback-driver'],
      agentTransport,
      driverTransport,
    })

    expect(agentTransport.mock.calls.map(([req]) => req.model)).toEqual([
      'openai/gpt-5.4',
      'openai/gpt-5.4',
    ])
    expect(driverTransport.mock.calls.map(([req]) => req.model)).toEqual([
      'primary-driver',
      'primary-driver',
      'fallback-driver',
    ])
    expect(
      result.transcript.some((message) => message.content === 'fallback driver response'),
    ).toBe(true)
  })

  it('does not send empty transcript messages to the driver after tool-only agent turns', async () => {
    const agentTransport = makeTransportStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }], usage: USAGE },
      { content: 'agent after custom tool', usage: USAGE },
      { content: 'final agent answer', usage: USAGE },
    ])
    const driverTransport = makeTransportStub([
      { content: 'driver saw the tool use and continues', usage: USAGE },
    ])

    await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      tools: [CUSTOM_TOOL],
      toolExecutors: {
        my_custom_tool: async () => ({ content: 'custom tool result', costUsd: 0.001 }),
      },
      artifactTypeFor: (name) => (name === 'my_custom_tool' ? 'custom' : undefined),
      agentTransport,
      driverTransport,
    })

    const driverMessages = driverTransport.mock.calls[0][0].messages
    expect(driverMessages.some((msg) => msg.content === '')).toBe(false)
    expect(driverMessages).toContainEqual({
      role: 'user',
      content: 'Agent called tool: my_custom_tool.',
    })
  })

  it('fails loud when one assistant turn exceeds the tool dispatch cap', async () => {
    const agentTransport = makeTransportStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }], usage: USAGE },
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 2 } }], usage: USAGE },
    ])

    await expect(
      runMultishot({
        profile: PROFILE,
        persona: PERSONA,
        shape: SHAPE,
        maxTurns: 1,
        maxToolDispatches: 1,
        tools: [CUSTOM_TOOL],
        toolExecutors: {
          my_custom_tool: async () => ({ content: 'custom tool result', costUsd: 0.001 }),
        },
        agentTransport,
        driverTransport: unreachedTransport('driver'),
      }),
    ).rejects.toThrow(/tool dispatch cap exceeded/)
  })

  it('rethrows fatal tool errors instead of feeding them back to the agent', async () => {
    const agentTransport = makeTransportStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }], usage: USAGE },
    ])

    await expect(
      runMultishot({
        profile: PROFILE,
        persona: PERSONA,
        shape: SHAPE,
        maxTurns: 1,
        tools: [CUSTOM_TOOL],
        toolExecutors: {
          my_custom_tool: async () => {
            throw new MultishotFatalToolError('stop repeated tool loop')
          },
        },
        agentTransport,
        driverTransport: unreachedTransport('driver'),
      }),
    ).rejects.toBeInstanceOf(MultishotFatalToolError)

    // The fatal error stops the turn: no follow-up call feeds the failure back.
    expect(agentTransport).toHaveBeenCalledTimes(1)
  })
})

describe('runMultishot cost metering', () => {
  it('meters the cost the agent transport reports on the request it received', async () => {
    const agentTransport = makeTransportStub([
      { content: 'hi from injected backend', costUsd: 0.123 },
    ])
    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 1,
      agentTransport,
      driverTransport: unreachedTransport('driver'),
    })

    const req = agentTransport.mock.calls[0][0]
    expect(req.model).toBe('openai/gpt-5.4')
    expect(req.maxTokens).toBe(2500)
    expect(req.tools?.length).toBeGreaterThan(0)
    expect(req.messages[0]).toMatchObject({ role: 'system' })
    expect(result.transcript.at(-1)?.content).toBe('hi from injected backend')
    expect(result.costUsd).toBe(0.123)
  })

  it('meters transport usage through the estimator when costUsd is omitted', async () => {
    const agentTransport = makeTransportStub([
      { content: 'usage-only', usage: { prompt_tokens: 1000, completion_tokens: 1000 } },
    ])
    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 1,
      agentTransport,
      driverTransport: unreachedTransport('driver'),
    })

    // gpt-5.4 estimator: (1000 * 0.003 + 1000 * 0.015) / 1000
    expect(result.costUsd).toBeCloseTo(0.018, 10)
  })

  it('sums agent, tool, and driver spend into one shot cost', async () => {
    const executor = vi.fn(async () => ({ content: 'tool output', costUsd: 0.002 }))
    const agentTransport = makeTransportStub([
      { toolCalls: [{ name: 'my_custom_tool', args: { x: 1 } }], costUsd: 0.01 },
      { content: 'agent after tool', costUsd: 0.01 },
      { content: 'final agent answer', costUsd: 0.01 },
    ])
    const driverTransport = makeTransportStub([{ content: 'driver pushback', costUsd: 0.005 }])

    const result = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      tools: [CUSTOM_TOOL],
      toolExecutors: { my_custom_tool: executor },
      artifactTypeFor: (name) => (name === 'my_custom_tool' ? 'custom' : undefined),
      agentTransport,
      driverTransport,
    })

    expect(agentTransport).toHaveBeenCalledTimes(3)
    expect(executor).toHaveBeenCalledOnce()
    expect(driverTransport.mock.calls[0][0].model).toBe('openai/gpt-4o-mini')
    expect(result.artifacts).toHaveLength(1)
    expect(result.transcript.some((m) => m.content === 'driver pushback')).toBe(true)
    // 3 agent calls at 0.01, one tool executor at 0.002, one driver call at 0.005.
    expect(result.costUsd).toBeCloseTo(0.037, 10)
    expect(result.costProvenance?.kind).toBe('estimated')
  })
})
