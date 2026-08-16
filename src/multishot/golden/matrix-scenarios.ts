// Deterministic multishot MATRIX scenarios.
//
// The shot scenarios pin one conversation. These pin the cell body around it:
// profile x persona fan-out, the three judge slots, the cell composite, the
// per-cell files, the run summary, and the cost provenance the cell reports.
//
// Cells run one at a time. Concurrency is the matrix runner's own mechanic and
// is covered by the runner's tests; forcing it to one here makes the recorded
// request ledger a property of the conversation engine alone, not of how two
// engines happen to interleave their microtasks.

import type { AgentProfile } from '@tangle-network/agent-interface'
import type { JudgeConfig } from '../judges'
import type { RunMultishotMatrixOptions } from '../matrix'
import type {
  MultishotPersona,
  MultishotToolDefinition,
  MultishotToolExecutor,
  MultishotTransport,
} from '../types'
import { recordJudgeRequest, recordRequest } from './recording'
import type { MultishotRecordedRequest, RecordedJudgeRequest } from './types'

export interface MultishotMatrixGoldenCase {
  options: RunMultishotMatrixOptions<MultishotPersona>
  requests: MultishotRecordedRequest[]
  /** Judge calls, filled while the case runs. Sorted before comparison. */
  judgeRequests: RecordedJudgeRequest[]
  /** Installs the deterministic judge wire on `globalThis.fetch` and returns
   *  the function that restores the previous one. */
  installJudgeWire: () => () => void
}

export interface MultishotMatrixGoldenScenario {
  readonly id: string
  readonly description: string
  readonly build: (runDir: string) => MultishotMatrixGoldenCase
}

const JUDGE_BASE_URL = 'http://router.invalid/v1'

const personas: MultishotPersona[] = [
  { id: 'retail-founder', ask: 'a launch brief' },
  { id: 'saas-operator', ask: 'a pricing page' },
]

const profiles: Array<{ id: string; value: AgentProfile }> = [
  {
    id: 'baseline',
    value: {
      name: 'multishot-golden-baseline',
      prompt: { systemPrompt: 'You are the baseline operator.' },
    },
  },
  {
    id: 'challenger',
    value: {
      name: 'multishot-golden-challenger',
      prompt: { systemPrompt: 'You are the challenger operator.' },
    },
  },
]

const shape = {
  buildOpener: (p: MultishotPersona) => `I need ${String(p.ask)}. What do you need from me?`,
  buildDriverSystemPrompt: (p: MultishotPersona) => `You are ${p.id}. Demand ${String(p.ask)}.`,
}

const tools: MultishotToolDefinition[] = [
  {
    type: 'function',
    function: { name: 'delegate_research', description: 'research', parameters: {} },
  },
  { type: 'function', function: { name: 'delegate_code', description: 'code', parameters: {} } },
]

function toolExecutors(): Record<string, MultishotToolExecutor> {
  return {
    delegate_research: async (args) => ({
      content: `RESEARCH: ${JSON.stringify(args)}`,
      costUsd: 0.011,
    }),
    delegate_code: async (args) => ({ content: `CODE: ${JSON.stringify(args)}`, costUsd: 0.023 }),
  }
}

const artifactTypeFor = (name: string): string | undefined =>
  name === 'delegate_research' ? 'research' : name === 'delegate_code' ? 'code' : undefined

/** Turn 1 dispatches research silently, turn 2 dispatches code beside text,
 *  turn 3 answers with text — so both artifact kinds exist in every cell and
 *  both artifact judge slots fire. */
const agentTransport: MultishotTransport = async (req) => {
  const userCount = req.messages.filter((m) => m.role === 'user').length
  const last = req.messages[req.messages.length - 1] as { role?: string }
  const afterTools = last?.role === 'tool'
  if (userCount === 1 && !afterTools) {
    return {
      message: {
        content: '',
        tool_calls: [
          {
            id: 'tc-1',
            type: 'function',
            function: { name: 'delegate_research', arguments: '{"topic":"market"}' },
          },
        ],
      },
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }
  }
  if (userCount === 1 && afterTools) {
    return {
      message: { content: 'Research done — here is the direction.' },
      usage: { prompt_tokens: 140, completion_tokens: 30 },
      costUsd: 0.005,
    }
  }
  if (userCount === 2 && !afterTools) {
    return {
      message: {
        content: 'Building it now.',
        tool_calls: [
          {
            id: 'tc-2',
            type: 'function',
            function: { name: 'delegate_code', arguments: '{"spec":"landing page"}' },
          },
        ],
      },
      usage: { prompt_tokens: 200, completion_tokens: 25 },
      costUsd: 0.004,
    }
  }
  if (userCount === 2 && afterTools) {
    return {
      message: { content: 'Shipped the artifact you asked for.' },
      usage: { prompt_tokens: 240, completion_tokens: 40 },
      costUsd: 0.006,
    }
  }
  return {
    message: { content: `Closing summary for turn ${userCount}.` },
    usage: { prompt_tokens: 260, completion_tokens: 15 },
    costUsd: 0.002,
  }
}

const driverTransport: MultishotTransport = async (req) => {
  const priorReplies = req.messages.filter((m) => m.role === 'assistant').length
  return {
    message: { content: `Driver follow-up #${priorReplies}: sharper, please.` },
    usage: { prompt_tokens: 80, completion_tokens: 18 },
    costUsd: 0.001,
  }
}

const dimensions = [
  { key: 'usefulness', description: 'Was it useful? (0-10)' },
  { key: 'specificity', description: 'Was it specific? (0-10)' },
]

function judge<TInput>(name: string, buildPrompt: (input: TInput) => string): JudgeConfig<TInput> {
  return {
    name,
    model: 'test/judge-model',
    dimensions,
    systemPrompt: `JUDGE:${name}`,
    buildPrompt,
    apiKey: 'golden-key',
    baseUrl: JUDGE_BASE_URL,
  }
}

/** True while some case holds `globalThis.fetch`. Module scope, because the
 *  resource being guarded is the process's own fetch. */
let judgeWireInstalled = false

/** Scores keyed by judge name, so the wire is a pure function of the request. */
const JUDGE_SCORES: Record<string, { usefulness: number; specificity: number }> = {
  conversation: { usefulness: 8, specificity: 7 },
  'code-review': { usefulness: 6, specificity: 9 },
  'content-quality': { usefulness: 5, specificity: 4 },
}

export function multishotMatrixGoldenScenarios(): MultishotMatrixGoldenScenario[] {
  return [
    {
      id: 'matrix-two-profiles-two-personas',
      description:
        'a 2x2 matrix at one replicate: every cell produces both artifact kinds, all three judge slots score, and the run persists per-cell files plus the summary',
      build: (runDir: string) => buildMatrixCase(runDir),
    },
  ]
}

function buildMatrixCase(runDir: string): MultishotMatrixGoldenCase {
  const requests: MultishotRecordedRequest[] = []
  const judgeRequests: RecordedJudgeRequest[] = []

  const options: RunMultishotMatrixOptions<MultishotPersona> = {
    profiles,
    personas,
    shape,
    judges: {
      conversation: judge(
        'conversation',
        (input: { transcript: unknown[] }) =>
          `Score this conversation of ${input.transcript.length} messages.`,
      ),
      codeReview: judge(
        'code-review',
        (input: { artifact: { content: string } }) => `Score this code: ${input.artifact.content}`,
      ),
      contentQuality: judge(
        'content-quality',
        (input: { artifact: { content: string } }) =>
          `Score this content: ${input.artifact.content}`,
      ),
    },
    tools,
    toolExecutors: toolExecutors(),
    artifactTypeFor,
    runDir,
    reps: 1,
    maxTurns: 3,
    maxConcurrency: 1,
    agentModel: 'test/agent-model',
    driverModel: 'test/driver-model',
    apiKey: 'golden-key',
    baseUrl: JUDGE_BASE_URL,
    agentTransport: async (req) => {
      requests.push(recordRequest('agent', req))
      return agentTransport(req)
    },
    driverTransport: async (req) => {
      requests.push(recordRequest('driver', req))
      return driverTransport(req)
    },
  }

  const installJudgeWire = (): (() => void) => {
    // The wire is process-wide, so two matrix checks running at once in one
    // process would cross their judge ledgers. Refuse the second one instead of
    // recording a mixture: a golden check that silently reads another run's
    // calls reports a mismatch nobody can explain.
    if (judgeWireInstalled) {
      throw new Error(
        'multishot golden judge wire: another matrix check already holds globalThis.fetch — run matrix checks serially within one process',
      )
    }
    judgeWireInstalled = true
    const previous = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      // The judge leg is the ONLY call allowed to reach the wire; the agent
      // and driver legs run on the scripted transports above. Anything else is
      // a wiring defect in the engine under test, so fail loud.
      if (String(url) !== `${JUDGE_BASE_URL}/chat/completions`) {
        throw new Error(`multishot golden judge wire: unexpected request to ${String(url)}`)
      }
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      judgeRequests.push(recordJudgeRequest(body))
      const messages = (body.messages ?? []) as Array<{ role: string; content: string }>
      const system = messages.find((m) => m.role === 'system')?.content ?? ''
      const name = system.replace('JUDGE:', '')
      const score = JUDGE_SCORES[name]
      if (!score) {
        throw new Error(`multishot golden judge wire: unknown judge system prompt ${system}`)
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ ...score, notes: `${name} ok` }) } }],
          usage: { prompt_tokens: 300, completion_tokens: 25 },
          model: 'test/judge-model',
          _response_cost: 0.0007,
        }),
        text: async () => '',
      }
    }) as unknown as typeof globalThis.fetch
    return () => {
      globalThis.fetch = previous
      judgeWireInstalled = false
    }
  }

  return { options, requests, judgeRequests, installJudgeWire }
}
