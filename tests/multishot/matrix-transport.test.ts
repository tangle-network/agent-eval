// Proves runMultishotMatrix plumbs the transport seams into every cell:
// agent + driver legs run through the injected transports (no router HTTP),
// judges keep using the router, and transport costUsd flows into the matrix
// cost accounting.

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
  it('passes agentTransport + driverTransport into each cell and meters their costUsd', async () => {
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
      // Transport costUsd (0.2*2 + 0.1) flows into the matrix cost summary.
      expect(matrix.summary.totalCostUsd).toBeCloseTo(0.5, 10)

      const transcript = JSON.parse(
        readFileSync(join(runDir, 'p1', 'alice', 'rep-0', 'transcript.json'), 'utf8'),
      ) as Array<{ role: string; content: string }>
      expect(transcript.some((m) => m.content === 'agent answer via seam')).toBe(true)
      expect(transcript.some((m) => m.content === 'driver follow-up via seam')).toBe(true)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
