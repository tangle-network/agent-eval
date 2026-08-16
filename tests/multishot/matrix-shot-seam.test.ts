// The shot seam on `runMultishotMatrix`.
//
// Three claims, in order:
//   1. Parity — a shot that delegates to `runMultishot` produces a matrix and
//      per-cell artifacts identical to the default path, and receives every
//      forwarded option.
//   2. Load-bearing — an independent engine that never touches `runMultishot`
//      drives the whole cell body, and a perturbation of its result moves the
//      matrix output (the same oracle then fails).
//   3. Fail loud — a shot result outside `MultishotResult` errors the cell and
//      never falls back to the default engine.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ArtifactJudgeInput,
  assertMultishotShotResult,
  type ConversationJudgeInput,
  type JudgeConfig,
  type MultishotCellOutput,
  type MultishotJudges,
  type MultishotPersona,
  type MultishotResult,
  type MultishotShape,
  type MultishotShot,
  MultishotShotResultError,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
  type MultishotTransport,
  type RunMultishotMatrixOptions,
  type RunMultishotMatrixResult,
  type RunMultishotOptions,
  runMultishot,
  runMultishotMatrix,
} from '../../src/multishot/index'

interface TestPersona extends MultishotPersona {
  id: string
  name: string
}

const PERSONAS: TestPersona[] = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
]

const PROFILES: Array<{ id: string; value: AgentProfile }> = [
  { id: 'p1', value: { name: 'p1', prompt: { systemPrompt: 'agent one' } } },
  { id: 'p2', value: { name: 'p2', prompt: { systemPrompt: 'agent two' } } },
]

const SHAPE: MultishotShape<TestPersona> = {
  buildOpener: (p) => `opener for ${p.name}`,
  buildDriverSystemPrompt: (p) => `driver for ${p.name}`,
}

const TOOLS: MultishotToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'make_code',
      description: 'emit a code artifact',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_notes',
      description: 'emit a research artifact',
      parameters: { type: 'object', properties: {} },
    },
  },
]

const TOOL_EXECUTORS: Record<string, MultishotToolExecutor> = {
  make_code: async () => ({ content: 'CODE-ARTIFACT', costUsd: 0.01 }),
  make_notes: async () => ({ content: 'NOTES-ARTIFACT', costUsd: 0.02 }),
}

function artifactTypeFor(toolName: string): string | undefined {
  if (toolName === 'make_code') return 'code'
  if (toolName === 'make_notes') return 'research'
  return undefined
}

const JUDGE_COST_USD = 0.001

// Judge scores are a pure function of the prompt marker, so every composite in
// this file is an arithmetic consequence of the shot's result.
function judgeScoreForPrompt(prompt: string): number {
  const conversation = /^CONVERSATION turns=(\d+)/.exec(prompt)
  if (conversation) return Math.min(10, Number(conversation[1]))
  if (prompt.startsWith('CODE ')) return 7
  if (prompt.startsWith('CONTENT ')) return 5
  throw new Error(`unscripted judge prompt: ${prompt.slice(0, 60)}`)
}

function judgeConfig<TInput>(
  name: string,
  buildPrompt: (input: TInput) => string,
): JudgeConfig<TInput> {
  return {
    name,
    model: 'openai/gpt-4o-mini',
    dimensions: [{ key: 'quality', description: 'overall quality' }],
    systemPrompt: 'score the input',
    buildPrompt,
    apiKey: 'judge-key',
    baseUrl: 'http://judge.invalid/v1',
  }
}

const JUDGES: MultishotJudges<TestPersona> = {
  conversation: judgeConfig<ConversationJudgeInput<TestPersona>>(
    'conversation',
    (input) => `CONVERSATION turns=${input.transcript.length} persona=${input.persona.id}`,
  ),
  codeReview: judgeConfig<ArtifactJudgeInput<TestPersona>>(
    'code',
    (input) => `CODE ${input.artifact.content}`,
  ),
  contentQuality: judgeConfig<ArtifactJudgeInput<TestPersona>>(
    'content',
    (input) => `CONTENT ${input.artifact.content}`,
  ),
}

/** Agent leg for the default engine: one tool-calling turn, then a final
 *  answer once tool results are back. Stateless, so concurrent cells are
 *  deterministic. */
const agentTransport = vi.fn<MultishotTransport>(async (req) => {
  const last = req.messages[req.messages.length - 1] as { role?: string } | undefined
  if (last?.role === 'tool') return { message: { content: 'final answer' }, costUsd: 0.05 }
  return {
    message: {
      content: null,
      tool_calls: [
        { id: 'tc-code', type: 'function', function: { name: 'make_code', arguments: '{}' } },
        { id: 'tc-notes', type: 'function', function: { name: 'make_notes', arguments: '{}' } },
      ],
    },
    costUsd: 0.05,
  }
})

const driverTransport = vi.fn<MultishotTransport>(async () => ({
  message: { content: 'driver says more' },
  costUsd: 0.001,
}))

let judgeCalls = 0
let tempDirs: string[] = []

function newRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multishot-shot-seam-'))
  tempDirs.push(dir)
  return dir
}

function baseOptions(runDir: string): RunMultishotMatrixOptions<TestPersona> {
  return {
    profiles: PROFILES,
    personas: PERSONAS,
    shape: SHAPE,
    judges: JUDGES,
    tools: TOOLS,
    toolExecutors: TOOL_EXECUTORS,
    artifactTypeFor,
    runDir,
    reps: 2,
    maxTurns: 1,
    maxToolDispatches: 4,
    maxConcurrency: 2,
    agentModel: 'openai/gpt-5.4',
    driverModel: 'openai/gpt-4o-mini',
    driverFallbackModels: ['openai/gpt-4.1-mini'],
    agentMaxTokens: 1234,
    toolFollowupMaxTokens: 555,
    driverMaxTokens: 321,
    judgeMaxTokens: 999,
    agentTransport,
    driverTransport,
    apiKey: 'agent-key',
    baseUrl: 'http://agent.invalid/v1',
  }
}

beforeEach(() => {
  judgeCalls = 0
  tempDirs = []
  agentTransport.mockClear()
  driverTransport.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      judgeCalls++
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      const prompt = body.messages[1]?.content ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({ quality: judgeScoreForPrompt(prompt), notes: 'ok' }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          model: 'openai/gpt-4o-mini',
          _response_cost: JUDGE_COST_USD,
        }),
        text: async () => 'ok',
      } as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Wall-clock fields differ run to run; every other field must match. */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'durationMs' || k === 'meanDurationMs' || k === 'matrixId') continue
      out[k] = stripVolatile(v)
    }
    return out
  }
  return value
}

function readCellJson(runDir: string, profileId: string, personaId: string, file: string): unknown {
  return JSON.parse(readFileSync(join(runDir, profileId, personaId, 'rep-0', file), 'utf8'))
}

interface ShotOracle {
  turns: number
  toolCalls: number
  artifactCount: number
  conversationScore: number
  codeScore: number
  contentScore: number
  shotCostUsd: number
  judgeCallsPerCell: number
  durationMs: number
}

/** Independent recomputation of everything the matrix derives from one shot
 *  result. Every number below comes from the shot, not from the substrate. */
function assertMatrixMatchesShot(
  result: RunMultishotMatrixResult,
  runDir: string,
  expected: ShotOracle,
): void {
  const composite = (expected.conversationScore + expected.codeScore + expected.contentScore) / 3
  const cellCost = expected.shotCostUsd + expected.judgeCallsPerCell * JUDGE_COST_USD
  const cells = PROFILES.length * PERSONAS.length * 2

  expect(result.matrix.summary.totalCells).toBe(cells)
  expect(result.matrix.summary.runsExecuted).toBe(cells)
  expect(result.matrix.summary.cellsSkipped).toBe(0)
  expect(result.matrix.summary.overallPassRate).toBe(composite >= 5 ? 1 : 0)
  expect(result.matrix.summary.overallMeanScore).toBeCloseTo(composite, 10)
  expect(result.matrix.summary.totalCostUsd).toBeCloseTo(cells * cellCost, 8)

  for (const { runs } of result.matrix.cells) {
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.error).toBeUndefined()
    expect(run.output).toEqual({
      turns: expected.turns,
      toolCalls: expected.toolCalls,
      artifactCount: expected.artifactCount,
    })
    expect(run.verdict.valid).toBe(composite >= 5)
    expect(run.verdict.score).toBeCloseTo(composite, 10)
    expect(run.verdict.notes).toBe(
      `convo=${expected.conversationScore.toFixed(1)} code=${expected.codeScore.toFixed(1)} content=${expected.contentScore.toFixed(1)}`,
    )
    expect(run.costUsd).toBeCloseTo(cellCost, 8)
    expect(run.durationMs).toBe(expected.durationMs)
  }

  for (const axis of ['profile', 'persona'] as const) {
    const summaries = Object.values(result.matrix.byAxis[axis] ?? {})
    expect(summaries).toHaveLength(2)
    for (const summary of summaries) {
      expect(summary.cells).toBe(cells / 2)
      expect(summary.meanScore).toBeCloseTo(composite, 10)
      expect(summary.totalCostUsd).toBeCloseTo((cells / 2) * cellCost, 8)
    }
  }

  expect(judgeCalls).toBe(cells * expected.judgeCallsPerCell)

  const scores = readCellJson(runDir, 'p1', 'alice', 'scores.json') as {
    composite: number
    conversation: { composite: number }
    codeReview: { composite: number; perArtifact: unknown[] }
    contentQuality: { composite: number; perArtifact: unknown[] }
  }
  expect(scores.composite).toBeCloseTo(composite, 10)
  expect(scores.conversation.composite).toBe(expected.conversationScore)
  expect(scores.codeReview.composite).toBe(expected.codeScore)
  expect(scores.contentQuality.composite).toBe(expected.contentScore)

  const transcript = readCellJson(runDir, 'p1', 'alice', 'transcript.json') as unknown[]
  const artifacts = readCellJson(runDir, 'p1', 'alice', 'artifacts.json') as unknown[]
  expect(transcript).toHaveLength(expected.turns)
  expect(artifacts).toHaveLength(expected.artifactCount)

  const summaryJson = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')) as {
    cells: number
    meanScore: number
  }
  expect(summaryJson.cells).toBe(cells)
  expect(summaryJson.meanScore).toBeCloseTo(composite, 10)
  expect(readFileSync(join(runDir, 'summary.md'), 'utf8')).toContain(`**Cells**: ${cells}`)
}

/** An engine that shares no code with `runMultishot`. */
function syntheticShot(
  mutate?: (result: MultishotResult) => MultishotResult,
): MultishotShot<TestPersona> {
  return async (opts) => {
    const result: MultishotResult = {
      transcript: [
        { role: 'user', content: `synthetic opener for ${opts.persona.id}` },
        { role: 'assistant', content: 'synthetic plan' },
        { role: 'tool', content: 'CODE-ARTIFACT', toolCallId: 'syn-1' },
        { role: 'tool', content: 'CODE-ARTIFACT', toolCallId: 'syn-2' },
        { role: 'tool', content: 'NOTES-ARTIFACT', toolCallId: 'syn-3' },
        { role: 'assistant', content: 'synthetic answer' },
      ],
      artifacts: [
        {
          type: 'code',
          turn: 0,
          invocation: { name: 'syn_code', args: {} },
          content: 'CODE-ARTIFACT',
        },
        {
          type: 'code',
          turn: 0,
          invocation: { name: 'syn_code', args: {} },
          content: 'CODE-ARTIFACT',
        },
        {
          type: 'research',
          turn: 0,
          invocation: { name: 'syn_notes', args: {} },
          content: 'NOTES-ARTIFACT',
        },
      ],
      toolCalls: 3,
      durationMs: 1234,
      costUsd: 0.5,
    }
    return mutate ? mutate(result) : result
  }
}

const SYNTHETIC_ORACLE: ShotOracle = {
  turns: 6,
  toolCalls: 3,
  artifactCount: 3,
  conversationScore: 6,
  codeScore: 7,
  contentScore: 5,
  shotCostUsd: 0.5,
  judgeCallsPerCell: 4,
  durationMs: 1234,
}

describe('runMultishotMatrix shot seam', () => {
  it('drives the default engine identically through an explicit shot', async () => {
    const defaultDir = newRunDir()
    const defaultRun = await runMultishotMatrix(baseOptions(defaultDir))

    judgeCalls = 0
    agentTransport.mockClear()
    const seen: Array<RunMultishotOptions<TestPersona>> = []
    const seamDir = newRunDir()
    const seamRun = await runMultishotMatrix({
      ...baseOptions(seamDir),
      runShot: async (opts) => {
        seen.push(opts)
        return runMultishot(opts)
      },
    })

    expect(stripVolatile(seamRun.matrix)).toEqual(stripVolatile(defaultRun.matrix))

    for (const profile of PROFILES) {
      for (const persona of PERSONAS) {
        for (const file of ['transcript.json', 'artifacts.json']) {
          expect(readCellJson(seamDir, profile.id, persona.id, file)).toEqual(
            readCellJson(defaultDir, profile.id, persona.id, file),
          )
        }
        expect(stripVolatile(readCellJson(seamDir, profile.id, persona.id, 'scores.json'))).toEqual(
          stripVolatile(readCellJson(defaultDir, profile.id, persona.id, 'scores.json')),
        )
      }
    }

    // The seam forwards the whole cell input, not a subset.
    expect(seen).toHaveLength(PROFILES.length * PERSONAS.length * 2)
    const input = seen[0]!
    expect(PROFILES.map((p) => p.value)).toContain(input.profile)
    expect(PERSONAS).toContain(input.persona)
    expect(input.shape).toBe(SHAPE)
    expect(input.tools).toBe(TOOLS)
    expect(input.toolExecutors).toBe(TOOL_EXECUTORS)
    expect(input.artifactTypeFor).toBe(artifactTypeFor)
    expect(input.maxTurns).toBe(1)
    expect(input.maxToolDispatches).toBe(4)
    expect(input.agentModel).toBe('openai/gpt-5.4')
    expect(input.driverModel).toBe('openai/gpt-4o-mini')
    expect(input.driverFallbackModels).toEqual(['openai/gpt-4.1-mini'])
    expect(input.agentMaxTokens).toBe(1234)
    expect(input.toolFollowupMaxTokens).toBe(555)
    expect(input.driverMaxTokens).toBe(321)
    expect(input.agentTransport).toBe(agentTransport)
    expect(input.driverTransport).toBe(driverTransport)
    expect(input.apiKey).toBe('agent-key')
    expect(input.baseUrl).toBe('http://agent.invalid/v1')
  })

  it('runs the whole cell body on an independent engine', async () => {
    const runDir = newRunDir()
    const result = await runMultishotMatrix({ ...baseOptions(runDir), runShot: syntheticShot() })

    // The seam replaces the conversation outright — no default-engine legs ran.
    expect(agentTransport).not.toHaveBeenCalled()
    expect(driverTransport).not.toHaveBeenCalled()

    assertMatrixMatchesShot(result, runDir, SYNTHETIC_ORACLE)

    // The writers persist the shot's own transcript and artifacts verbatim.
    const reference = await syntheticShot()({
      profile: PROFILES[0]!.value,
      persona: PERSONAS[0]!,
    })
    expect(readCellJson(runDir, 'p1', 'alice', 'transcript.json')).toEqual(reference.transcript)
    expect(readCellJson(runDir, 'p1', 'alice', 'artifacts.json')).toEqual(reference.artifacts)
  })

  it('moves every matrix number when the shot result is perturbed', async () => {
    const runDir = newRunDir()
    const perturbed = await runMultishotMatrix({
      ...baseOptions(runDir),
      runShot: syntheticShot((result) => ({
        ...result,
        transcript: [...result.transcript, { role: 'assistant', content: 'one more turn' }],
        artifacts: [
          ...result.artifacts,
          {
            type: 'code',
            turn: 1,
            invocation: { name: 'syn_code', args: {} },
            content: 'CODE-ARTIFACT',
          },
        ],
        toolCalls: result.toolCalls + 1,
        costUsd: result.costUsd + 0.25,
        durationMs: result.durationMs + 1000,
      })),
    })

    // The oracle that held for the unperturbed shot must now fail.
    expect(() => assertMatrixMatchesShot(perturbed, runDir, SYNTHETIC_ORACLE)).toThrow()

    assertMatrixMatchesShot(perturbed, runDir, {
      turns: 7,
      toolCalls: 4,
      artifactCount: 4,
      conversationScore: 7,
      codeScore: 7,
      contentScore: 5,
      shotCostUsd: 0.75,
      judgeCallsPerCell: 5,
      durationMs: 2234,
    })
  })

  // A consumer engine is declared generically over the persona, exactly like
  // `runMultishot`. It must land on `runShot` with no cast and no structural
  // copy of the cell output — that is what lets the consumer delete its fork.
  it('accepts an engine declared with the same generic signature as the default', async () => {
    async function consumerEngine<TAnyPersona extends MultishotPersona>(
      opts: RunMultishotOptions<TAnyPersona>,
    ): Promise<MultishotResult> {
      return {
        transcript: [{ role: 'user', content: `consumer engine for ${opts.persona.id}` }],
        artifacts: [],
        toolCalls: 0,
        durationMs: 7,
        costUsd: 0,
      }
    }

    const runDir = newRunDir()
    const result = await runMultishotMatrix<TestPersona>({
      ...baseOptions(runDir),
      runShot: consumerEngine,
    })

    const output: MultishotCellOutput = result.matrix.cells[0]!.runs[0]!.output
    expect(output).toEqual({ turns: 1, toolCalls: 0, artifactCount: 0 })
    expect(agentTransport).not.toHaveBeenCalled()
  })

  it('fails the cell loud when the shot resolves with a non-result', async () => {
    const runDir = newRunDir()
    const result = await runMultishotMatrix({
      ...baseOptions(runDir),
      runShot: async () => undefined as unknown as MultishotResult,
    })

    expect(result.matrix.summary.runsExecuted).toBe(8)
    for (const { runs } of result.matrix.cells) {
      expect(runs[0]!.error?.kind).toBe('MultishotShotResultError')
      expect(runs[0]!.error?.message).toContain('expected an object, received undefined')
    }
    expect(result.matrix.summary.overallPassRate).toBe(0)
    // No silent fallback: the default engine never ran, no judge ran, and no
    // cell artifacts were written.
    expect(agentTransport).not.toHaveBeenCalled()
    expect(judgeCalls).toBe(0)
    expect(existsSync(join(runDir, 'p1', 'alice', 'rep-0'))).toBe(false)
  })

  it('fails the cell loud when the shot reports a non-finite cost', async () => {
    const runDir = newRunDir()
    const result = await runMultishotMatrix({
      ...baseOptions(runDir),
      runShot: syntheticShot((r) => ({ ...r, costUsd: Number.NaN })),
    })

    for (const { runs } of result.matrix.cells) {
      expect(runs[0]!.error?.kind).toBe('MultishotShotResultError')
      expect(runs[0]!.error?.message).toContain('costUsd must be a finite number >= 0')
    }
    // A NaN that reached the ledger would poison the cumulative sum and
    // disable the cost ceiling for the rest of the run.
    expect(Number.isFinite(result.matrix.summary.totalCostUsd)).toBe(true)
    expect(result.matrix.summary.totalCostUsd).toBe(0)
  })
})

describe('assertMultishotShotResult', () => {
  const valid: MultishotResult = {
    transcript: [],
    artifacts: [],
    toolCalls: 0,
    durationMs: 0,
    costUsd: 0,
  }

  it('accepts a well-formed result', () => {
    expect(() => assertMultishotShotResult(valid)).not.toThrow()
  })

  it.each([
    ['null', null, 'expected an object, received null'],
    ['a string', 'nope', 'expected an object, received string nope'],
    ['a missing transcript', { ...valid, transcript: undefined }, 'transcript must be an array'],
    ['a missing artifacts list', { ...valid, artifacts: null }, 'artifacts must be an array'],
    ['a negative toolCalls', { ...valid, toolCalls: -1 }, 'toolCalls must be a finite number >= 0'],
    ['an infinite durationMs', { ...valid, durationMs: Infinity }, 'durationMs must be a finite'],
    ['a NaN costUsd', { ...valid, costUsd: Number.NaN }, 'costUsd must be a finite number >= 0'],
  ])('rejects %s', (_label, value, reason) => {
    expect(() => assertMultishotShotResult(value)).toThrow(MultishotShotResultError)
    expect(() => assertMultishotShotResult(value)).toThrow(reason)
  })
})
