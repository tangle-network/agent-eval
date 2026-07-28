// Proves runMultishotMatrix plumbs the transport seams into every cell:
// agent + driver legs run through the injected transports (no router HTTP),
// judges keep using the router, and agent/driver/judge cost flows into the
// matrix cost accounting.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type MultishotPersona,
  type MultishotShape,
  type MultishotTransportRequest,
  type MultishotTransportResponse,
  runMultishotMatrix,
} from '../../src/multishot/index'

interface TestPersona extends MultishotPersona {
  id: string
  name: string
}

const PROFILE: AgentProfile = {
  name: 'seam-test',
  prompt: { systemPrompt: 'You are a test agent.' },
}

const SHAPE: MultishotShape<TestPersona> = {
  buildOpener: (p) => `hi i'm ${p.name}`,
  buildDriverSystemPrompt: (p) => `you are ${p.name}`,
}

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

function judgeOnlyFetch() {
  // Serves the conversation judge; any other HTTP call is a seam leak.
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> }
    if (!String(body.messages[0]?.content).includes('judge')) {
      throw new Error('unexpected non-judge HTTP call — transport seam leaked')
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"helpfulness":8,"notes":"fine"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      text: async () => 'ok',
    } as Response
  })
}

describe('runMultishotMatrix transport seam', () => {
  it('passes injected transports into each cell and totals agent, driver, and judge cost', async () => {
    process.env.TANGLE_API_KEY = 'test-key'
    const fetchStub = judgeOnlyFetch()
    global.fetch = fetchStub as unknown as typeof fetch

    const agentTransport = vi.fn(
      async (_req: MultishotTransportRequest): Promise<MultishotTransportResponse> => ({
        message: { content: 'agent answer via seam' },
        costUsd: 0.2,
      }),
    )
    const driverTransport = vi.fn(
      async (_req: MultishotTransportRequest): Promise<MultishotTransportResponse> => ({
        message: { content: 'driver follow-up via seam' },
        costUsd: 0.1,
      }),
    )

    const runDir = mkdtempSync(join(tmpdir(), 'multishot-seam-'))
    try {
      const { matrix } = await runMultishotMatrix<TestPersona>({
        profiles: [{ id: 'p1', value: PROFILE }],
        personas: [{ id: 'alice', name: 'Alice' }],
        shape: SHAPE,
        judges: {
          conversation: {
            name: 'conversation',
            dimensions: [{ key: 'helpfulness', description: 'is it helpful' }],
            systemPrompt: 'you are a judge',
            buildPrompt: () => 'judge this transcript',
          },
        },
        runDir,
        maxTurns: 2,
        agentTransport,
        driverTransport,
      })

      // 2 agent turns + 1 driver turn per cell.
      expect(agentTransport).toHaveBeenCalledTimes(2)
      expect(driverTransport).toHaveBeenCalledTimes(1)
      // Judge ran over HTTP; the agent/driver legs did not.
      expect(fetchStub).toHaveBeenCalledTimes(1)
      // Transport costUsd (0.2*2 + 0.1) plus the judge's estimated usage cost
      // flows into the cell and matrix totals.
      expect(matrix.cells[0]?.runs[0]?.costUsd).toBeCloseTo(0.5000075, 10)
      expect(matrix.summary.totalCostUsd).toBeCloseTo(0.5000075, 10)

      const transcript = JSON.parse(
        readFileSync(join(runDir, 'p1', 'alice', 'rep-0', 'transcript.json'), 'utf8'),
      ) as Array<{ role: string; content: string }>
      expect(transcript.some((m) => m.content === 'agent answer via seam')).toBe(true)
      expect(transcript.some((m) => m.content === 'driver follow-up via seam')).toBe(true)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('counts conversation, code, and content judge calls, including parse failures', async () => {
    process.env.TANGLE_API_KEY = 'test-key'
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> }
      const systemPrompt = String(body.messages[0]?.content)
      const content = systemPrompt.includes('content judge')
        ? 'not json'
        : '{"quality":8,"notes":"fine"}'
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
        text: async () => 'ok',
      } as Response
    })
    global.fetch = fetchStub as unknown as typeof fetch

    const agentTransport = vi
      .fn<(req: MultishotTransportRequest) => Promise<MultishotTransportResponse>>()
      .mockResolvedValueOnce({
        message: {
          content: null,
          tool_calls: [
            {
              id: 'code-call',
              type: 'function',
              function: { name: 'write_code', arguments: '{}' },
            },
            {
              id: 'content-call',
              type: 'function',
              function: { name: 'write_content', arguments: '{}' },
            },
          ],
        },
        costUsd: 0.2,
      })
      .mockResolvedValueOnce({
        message: { content: 'completed both artifacts' },
        costUsd: 0.2,
      })

    const runDir = mkdtempSync(join(tmpdir(), 'multishot-all-judge-costs-'))
    try {
      const { matrix } = await runMultishotMatrix<TestPersona>({
        profiles: [{ id: 'p1', value: PROFILE }],
        personas: [{ id: 'alice', name: 'Alice' }],
        shape: SHAPE,
        judges: {
          conversation: {
            name: 'conversation',
            dimensions: [{ key: 'quality', description: 'conversation quality' }],
            systemPrompt: 'conversation judge',
            buildPrompt: () => 'judge the conversation',
          },
          codeReview: {
            name: 'code',
            dimensions: [{ key: 'quality', description: 'code quality' }],
            systemPrompt: 'code judge',
            buildPrompt: () => 'judge the code',
          },
          contentQuality: {
            name: 'content',
            dimensions: [{ key: 'quality', description: 'content quality' }],
            systemPrompt: 'content judge',
            buildPrompt: () => 'judge the content',
          },
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'write_code',
              description: 'produce code',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function',
            function: {
              name: 'write_content',
              description: 'produce content',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolExecutors: {
          write_code: async () => ({ content: 'const answer = 42', costUsd: 0.05 }),
          write_content: async () => ({ content: 'A useful draft', costUsd: 0.05 }),
        },
        artifactTypeFor: (name) => (name === 'write_code' ? 'code' : 'research'),
        runDir,
        maxTurns: 1,
        agentTransport,
      })

      // Simulation: 2 agent calls + 2 tools = $0.50.
      // Judges: 3 * (100 input + 100 output tokens on gpt-4o-mini) = $0.000225.
      expect(matrix.cells[0]?.runs[0]?.costUsd).toBeCloseTo(0.500225, 10)
      expect(matrix.summary.totalCostUsd).toBeCloseTo(0.500225, 10)
      expect(fetchStub).toHaveBeenCalledTimes(3)

      const scores = JSON.parse(
        readFileSync(join(runDir, 'p1', 'alice', 'rep-0', 'scores.json'), 'utf8'),
      ) as {
        contentQuality: {
          perArtifact: Array<{
            failed?: boolean
            llmCall?: {
              costUsd: number | null
              usage: { promptTokens: number; completionTokens: number; captured?: boolean }
            }
          }>
        }
      }
      expect(scores.contentQuality.perArtifact[0]).toMatchObject({
        failed: true,
        llmCall: {
          costUsd: null,
          usage: { promptTokens: 100, completionTokens: 100, captured: true },
        },
      })
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('uses judge cost when deciding whether to schedule another cell', async () => {
    process.env.TANGLE_API_KEY = 'test-key'
    const fetchStub = judgeOnlyFetch()
    global.fetch = fetchStub as unknown as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agentTransport = vi.fn(
      async (_req: MultishotTransportRequest): Promise<MultishotTransportResponse> => ({
        message: { content: 'agent answer' },
        costUsd: 0,
      }),
    )

    const runDir = mkdtempSync(join(tmpdir(), 'multishot-judge-cost-ceiling-'))
    try {
      const { matrix } = await runMultishotMatrix<TestPersona>({
        profiles: [
          { id: 'p1', value: PROFILE },
          { id: 'p2', value: PROFILE },
          { id: 'p3', value: PROFILE },
        ],
        personas: [{ id: 'alice', name: 'Alice' }],
        shape: SHAPE,
        judges: {
          conversation: {
            name: 'conversation',
            dimensions: [{ key: 'helpfulness', description: 'is it helpful' }],
            systemPrompt: 'you are a judge',
            buildPrompt: () => 'judge this transcript',
          },
        },
        runDir,
        maxTurns: 1,
        maxConcurrency: 1,
        costCeiling: 0.000007,
        agentTransport,
      })

      expect(matrix.summary.runsExecuted).toBe(1)
      expect(matrix.summary.cellsSkipped).toBe(2)
      expect(matrix.summary.totalCostUsd).toBeCloseTo(0.0000075, 10)
      expect(agentTransport).toHaveBeenCalledOnce()
      expect(fetchStub).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith('[matrix] cost ceiling reached')
    } finally {
      warn.mockRestore()
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
