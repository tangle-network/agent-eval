// Money a cell spends before it fails must reach the matrix.
//
// Three claims:
//   1. `runMultishot` declares what the conversation spent when it throws,
//      including every driver attempt that billed and returned nothing.
//   2. `runMultishotMatrix` bills a cell whose shot result fails validation.
//   3. A judge whose cost the router never reported marks the cell's total as
//      a subtotal instead of presenting it as complete.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCellSpend } from '../../src/matrix'
import {
  type ConversationJudgeInput,
  type JudgeConfig,
  type MultishotJudges,
  type MultishotPersona,
  type MultishotResult,
  type MultishotShape,
  type MultishotShot,
  type MultishotTransport,
  runMultishot,
  runMultishotMatrix,
} from '../../src/multishot/index'

interface TestPersona extends MultishotPersona {
  id: string
  name: string
}

const PERSONA: TestPersona = { id: 'alice', name: 'Alice' }
const PROFILE: AgentProfile = { name: 'p1', prompt: { systemPrompt: 'agent one' } }

const SHAPE: MultishotShape<TestPersona> = {
  buildOpener: (p) => `opener for ${p.name}`,
  buildDriverSystemPrompt: (p) => `driver for ${p.name}`,
}

function conversationJudge(): JudgeConfig<ConversationJudgeInput<TestPersona>> {
  return {
    name: 'conversation',
    model: 'openai/gpt-4o-mini',
    dimensions: [{ key: 'quality', description: 'overall quality' }],
    systemPrompt: 'score the input',
    buildPrompt: (input) => `CONVERSATION turns=${input.transcript.length}`,
    apiKey: 'judge-key',
    baseUrl: 'http://judge.invalid/v1',
  }
}

const JUDGES: MultishotJudges<TestPersona> = { conversation: conversationJudge() }

let tempDirs: string[] = []

function newRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multishot-cell-cost-'))
  tempDirs.push(dir)
  return dir
}

/** Judge leg: a router reply whose cost is reported, or withheld by a model
 *  the ledger cannot price. */
function stubJudgeFetch(options: { reportCost: boolean; model?: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ quality: 8, notes: 'fine' }) } }],
        model: options.model ?? 'openai/gpt-4o-mini',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        ...(options.reportCost ? { cost_usd: 0.002 } : {}),
      }),
    })),
  )
}

beforeEach(() => {
  tempDirs = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('runMultishot — a throw declares the conversation spend', () => {
  it('bills every driver attempt behind MultishotDriverEmptyError', async () => {
    const agentTransport = vi.fn<MultishotTransport>(async () => ({
      message: { content: 'agent answered' },
      costUsd: 0.05,
    }))
    // Never returns content: two attempts per model, two models = four billed
    // calls, none of them usable.
    const driverTransport = vi.fn<MultishotTransport>(async () => ({
      message: { content: '' },
      costUsd: 0.01,
    }))

    const err = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      agentModel: 'openai/gpt-5.4',
      driverModel: 'openai/gpt-4o-mini',
      driverFallbackModels: ['openai/gpt-4.1-mini'],
      agentTransport,
      driverTransport,
      apiKey: 'agent-key',
      baseUrl: 'http://agent.invalid/v1',
    }).then(
      () => undefined,
      (e: unknown) => e,
    )

    expect((err as Error).name).toBe('MultishotDriverEmptyError')
    expect(driverTransport).toHaveBeenCalledTimes(4)
    // One agent call at 0.05 plus four driver attempts at 0.01.
    const spend = readCellSpend(err)
    expect(spend?.kind).toBe('estimated')
    expect(spend?.costUsd).toBeCloseTo(0.09, 10)
    expect(spend?.durationMs).toEqual(expect.any(Number))
  })

  it('marks the spend uncaptured when a call reports neither cost nor usage', async () => {
    const agentTransport = vi.fn<MultishotTransport>(async () => ({
      message: { content: 'agent answered' },
    }))
    const driverTransport = vi.fn<MultishotTransport>(async () => ({
      message: { content: '' },
      costUsd: 0.01,
    }))

    const err = await runMultishot({
      profile: PROFILE,
      persona: PERSONA,
      shape: SHAPE,
      maxTurns: 2,
      driverModel: 'openai/gpt-4o-mini',
      agentTransport,
      driverTransport,
      apiKey: 'agent-key',
      baseUrl: 'http://agent.invalid/v1',
    }).then(
      () => undefined,
      (e: unknown) => e,
    )

    const spend = readCellSpend(err)
    expect(spend?.kind).toBe('uncaptured')
    // The driver attempts still count — an uncaptured subtotal is not zero.
    expect(spend?.costUsd).toBeCloseTo(0.02, 10)
  })
})

describe('runMultishotMatrix — a failed cell keeps its spend', () => {
  it('bills the shot that spent before returning a malformed result', async () => {
    stubJudgeFetch({ reportCost: true })
    const runShot: MultishotShot<TestPersona> = async () =>
      ({
        transcript: 'not an array',
        artifacts: [],
        toolCalls: 0,
        durationMs: 12,
        costUsd: 0.7,
      }) as unknown as MultishotResult

    const { matrix } = await runMultishotMatrix<TestPersona>({
      profiles: [{ id: 'p1', value: PROFILE }],
      personas: [PERSONA],
      shape: SHAPE,
      judges: JUDGES,
      runDir: newRunDir(),
      runShot,
    })

    const run = matrix.cells[0]?.runs[0]
    expect(run?.error?.kind).toBe('MultishotShotResultError')
    expect(run?.costUsd).toBe(0.7)
    expect(run?.costProvenance).toEqual({ kind: 'estimated', usd: 0.7 })
    expect(matrix.summary.totalCostUsd).toBe(0.7)
    expect(matrix.summary.costUncapturedCells).toBe(0)
  })

  it('records the cell as uncaptured when the shot result carries no usable cost', async () => {
    stubJudgeFetch({ reportCost: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runShot: MultishotShot<TestPersona> = async () =>
      ({
        transcript: [],
        artifacts: [],
        toolCalls: 0,
        durationMs: 12,
        costUsd: 'lots',
      }) as unknown as MultishotResult

    const { matrix } = await runMultishotMatrix<TestPersona>({
      profiles: [{ id: 'p1', value: PROFILE }],
      personas: [PERSONA],
      shape: SHAPE,
      judges: JUDGES,
      runDir: newRunDir(),
      runShot,
    })

    const run = matrix.cells[0]?.runs[0]
    expect(run?.error?.kind).toBe('MultishotShotResultError')
    expect(run?.costUsd).toBe(0)
    expect(run?.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(matrix.summary.costUncapturedCells).toBe(1)
    warn.mockRestore()
  })

  it('stops scheduling once failed cells spend past the ceiling', async () => {
    stubJudgeFetch({ reportCost: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let shots = 0
    const runShot: MultishotShot<TestPersona> = async () => {
      shots++
      return {
        transcript: 'not an array',
        artifacts: [],
        toolCalls: 0,
        durationMs: 5,
        costUsd: 0.4,
      } as unknown as MultishotResult
    }

    const { matrix } = await runMultishotMatrix<TestPersona>({
      profiles: [
        { id: 'p1', value: PROFILE },
        { id: 'p2', value: PROFILE },
        { id: 'p3', value: PROFILE },
        { id: 'p4', value: PROFILE },
      ],
      personas: [PERSONA],
      shape: SHAPE,
      judges: JUDGES,
      runDir: newRunDir(),
      maxConcurrency: 1,
      costCeiling: 0.5,
      runShot,
    })

    expect(shots).toBe(2)
    expect(matrix.summary.runsExecuted).toBe(2)
    expect(matrix.summary.cellsSkipped).toBe(2)
    expect(matrix.summary.totalCostUsd).toBeCloseTo(0.8, 10)
    expect(warn).toHaveBeenCalledWith('[matrix] cost ceiling reached')
    warn.mockRestore()
  })

  it('marks a successful cell uncaptured when the SHOT priced a call at nothing', async () => {
    // Judges report their cost; only the agent leg is unpriced, so the cell can
    // only learn its total is a subtotal from the shot itself.
    stubJudgeFetch({ reportCost: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agentTransport = vi.fn<MultishotTransport>(async () => ({
      message: { content: 'agent answered' },
    }))

    const { matrix } = await runMultishotMatrix<TestPersona>({
      profiles: [{ id: 'p1', value: PROFILE }],
      personas: [PERSONA],
      shape: SHAPE,
      judges: JUDGES,
      runDir: newRunDir(),
      maxTurns: 1,
      agentTransport,
      apiKey: 'agent-key',
      baseUrl: 'http://agent.invalid/v1',
    })

    const run = matrix.cells[0]?.runs[0]
    expect(run?.error).toBeUndefined()
    expect(run?.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(matrix.summary.costUncapturedCells).toBe(1)
    warn.mockRestore()
  })

  it('reports a fully priced shot as a complete estimate', async () => {
    stubJudgeFetch({ reportCost: true })
    const agentTransport = vi.fn<MultishotTransport>(async () => ({
      message: { content: 'agent answered' },
      costUsd: 0.2,
    }))

    const { matrix } = await runMultishotMatrix<TestPersona>({
      profiles: [{ id: 'p1', value: PROFILE }],
      personas: [PERSONA],
      shape: SHAPE,
      judges: JUDGES,
      runDir: newRunDir(),
      maxTurns: 1,
      agentTransport,
      apiKey: 'agent-key',
      baseUrl: 'http://agent.invalid/v1',
    })

    const run = matrix.cells[0]?.runs[0]
    expect(run?.costProvenance?.kind).toBe('estimated')
    expect(matrix.summary.costUncapturedCells).toBe(0)
  })

  it('rejects a shot that claims an uncaptured provenance with a total', async () => {
    stubJudgeFetch({ reportCost: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runShot: MultishotShot<TestPersona> = async () =>
      ({
        transcript: [],
        artifacts: [],
        toolCalls: 0,
        durationMs: 12,
        costUsd: 0.4,
        costProvenance: { kind: 'uncaptured', usd: 0.4 },
      }) as unknown as MultishotResult

    const { matrix } = await runMultishotMatrix<TestPersona>({
      profiles: [{ id: 'p1', value: PROFILE }],
      personas: [PERSONA],
      shape: SHAPE,
      judges: JUDGES,
      runDir: newRunDir(),
      runShot,
    })

    const run = matrix.cells[0]?.runs[0]
    expect(run?.error?.kind).toBe('MultishotShotResultError')
    expect(run?.error?.message).toContain('uncaptured costProvenance.usd must be null')
    // The shot's own subtotal is still billed.
    expect(run?.costUsd).toBe(0.4)
    warn.mockRestore()
  })

  it('marks a successful cell uncaptured when a judge cost was never reported', async () => {
    stubJudgeFetch({ reportCost: false, model: 'vendor/unpriced-model' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runShot: MultishotShot<TestPersona> = async () => ({
      transcript: [{ role: 'user', content: 'hello' }],
      artifacts: [],
      toolCalls: 0,
      durationMs: 12,
      costUsd: 0.3,
    })

    const { matrix } = await runMultishotMatrix<TestPersona>({
      profiles: [{ id: 'p1', value: PROFILE }],
      personas: [PERSONA],
      // An unpriced model leaves the judge call with no reportable cost.
      judges: { conversation: { ...conversationJudge(), model: 'vendor/unpriced-model' } },
      shape: SHAPE,
      runDir: newRunDir(),
      runShot,
    })

    const run = matrix.cells[0]?.runs[0]
    expect(run?.error).toBeUndefined()
    expect(run?.verdict.notes).toContain('judge-cost-incomplete')
    expect(run?.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(matrix.summary.costUncapturedCells).toBe(1)
    warn.mockRestore()
  })
})
