// Proves runMultishotMatrix plumbs the transport seams into every cell: agent,
// driver, and judge legs each run on the transport the caller supplied, and
// every leg's cost flows into the matrix cost accounting.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it, vi } from 'vitest'
import {
  type MultishotPersona,
  type MultishotShape,
  type MultishotTransport,
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

/** A leg the scenario must never reach — reaching it is the failure. */
function unreachedTransport(leg: string): MultishotTransport {
  return async () => {
    throw new Error(`${leg} leg must not run in this scenario`)
  }
}

function scoringJudgeTransport() {
  return vi.fn(
    async (_req: MultishotTransportRequest): Promise<MultishotTransportResponse> => ({
      message: { content: '{"helpfulness":8,"notes":"fine"}' },
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }),
  )
}

describe('runMultishotMatrix transport seam', () => {
  it('passes injected transports into each cell and totals agent, driver, and judge cost', async () => {
    const judgeTransport = scoringJudgeTransport()

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
            transport: judgeTransport,
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

      // 2 agent turns + 1 driver turn + 1 judge call per cell.
      expect(agentTransport).toHaveBeenCalledTimes(2)
      expect(driverTransport).toHaveBeenCalledTimes(1)
      expect(judgeTransport).toHaveBeenCalledTimes(1)
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
    const judgeTransport = vi.fn(
      async (req: MultishotTransportRequest): Promise<MultishotTransportResponse> => {
        const systemPrompt = String(req.messages[0]?.content)
        const content = systemPrompt.includes('content judge')
          ? 'not json'
          : '{"quality":8,"notes":"fine"}'
        return {
          message: { content },
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }
      },
    )

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
            transport: judgeTransport,
            dimensions: [{ key: 'quality', description: 'conversation quality' }],
            systemPrompt: 'conversation judge',
            buildPrompt: () => 'judge the conversation',
          },
          codeReview: {
            name: 'code',
            transport: judgeTransport,
            dimensions: [{ key: 'quality', description: 'code quality' }],
            systemPrompt: 'code judge',
            buildPrompt: () => 'judge the code',
          },
          contentQuality: {
            name: 'content',
            transport: judgeTransport,
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
        driverTransport: unreachedTransport('driver'),
      })

      // Simulation: 2 agent calls + 2 tools = $0.50.
      // Judges: 3 * (100 input + 100 output tokens on gpt-4o-mini) = $0.000225.
      expect(matrix.cells[0]?.runs[0]?.costUsd).toBeCloseTo(0.500225, 10)
      expect(matrix.summary.totalCostUsd).toBeCloseTo(0.500225, 10)
      expect(judgeTransport).toHaveBeenCalledTimes(3)

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
    const judgeTransport = scoringJudgeTransport()
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
            transport: judgeTransport,
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
        driverTransport: unreachedTransport('driver'),
      })

      expect(matrix.summary.runsExecuted).toBe(1)
      expect(matrix.summary.cellsSkipped).toBe(2)
      expect(matrix.summary.totalCostUsd).toBeCloseTo(0.0000075, 10)
      expect(agentTransport).toHaveBeenCalledOnce()
      expect(judgeTransport).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith('[matrix] cost ceiling reached')
    } finally {
      warn.mockRestore()
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
