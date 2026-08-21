// Deterministic multishot scenarios.
//
// Every scenario is a closed system: scripted agent and driver transports,
// scripted tool executors, a fixed persona and profile, fixed token budgets.
// Nothing reads the clock for a recorded field, nothing calls a network, and
// nothing draws a random number. Two runs of the same scenario on the same
// engine produce byte-identical records; the recorder enforces that.
//
// The catalog is the union of the behaviours the merged loop-to-graph parity
// proofs covered. Two scripts run through it:
//
//   delegation-*        a research/code delegation agent: silent multi-tool
//                       turns, an unknown tool, typed artifacts of two kinds,
//                       both cost paths, turn-count edges, driver rotation.
//   sampling-contract-* a tool-using agent with distinct per-leg token
//                       budgets: retry-on-empty, whitespace-only driver
//                       content, an empty assistant follow-up, full rotation.

import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RunMultishotOptions } from '../multishot'
import {
  MultishotFatalToolError,
  type MultishotPersona,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
  type MultishotTransport,
  type MultishotTransportResponse,
} from '../types'
import { recordRequest } from './recording'
import type { MultishotRecordedRequest } from './types'

/** Options plus the ledger the scenario's transports fill while it runs. */
export interface MultishotGoldenCase {
  options: RunMultishotOptions<MultishotPersona>
  /** Every transport call, in issue order. Populated by running the case. */
  requests: MultishotRecordedRequest[]
}

export interface MultishotGoldenScenario {
  readonly id: string
  readonly description: string
  /** Fresh options and a fresh ledger. Scripted transports carry per-run
   *  state, so an engine run and a re-run must never share a case. */
  readonly build: () => MultishotGoldenCase
}

function ledgerTransport(
  ledger: MultishotRecordedRequest[],
  leg: 'agent' | 'driver',
  inner: MultishotTransport,
): MultishotTransport {
  return async (req) => {
    ledger.push(recordRequest(leg, req))
    return inner(req)
  }
}

// ---------------------------------------------------------------------------
// delegation script
// ---------------------------------------------------------------------------

const delegationPersona: MultishotPersona = { id: 'test-owner', ask: 'a launch brief' }

const delegationProfile: AgentProfile = {
  name: 'multishot-golden-delegation',
  prompt: { systemPrompt: 'You are the operator agent under test.' },
}

const delegationShape = {
  buildOpener: (p: MultishotPersona) => `I need ${String(p.ask)}. What do you need from me?`,
  buildDriverSystemPrompt: (p: MultishotPersona) => `You are ${p.id}. Demand ${String(p.ask)}.`,
}

const delegationTools: MultishotToolDefinition[] = [
  {
    type: 'function',
    function: { name: 'delegate_research', description: 'research', parameters: {} },
  },
  { type: 'function', function: { name: 'delegate_code', description: 'code', parameters: {} } },
]

function delegationExecutors(): Record<string, MultishotToolExecutor> {
  return {
    delegate_research: async (args) => ({
      content: `RESEARCH: ${JSON.stringify(args)}`,
      costUsd: 0.011,
    }),
    delegate_code: async (args) => ({ content: `CODE: ${JSON.stringify(args)}`, costUsd: 0.023 }),
  }
}

const delegationArtifactTypeFor = (name: string): string | undefined =>
  name === 'delegate_research' ? 'research' : name === 'delegate_code' ? 'code' : undefined

/** Pure in the request. The turn index is the number of `user` messages; a
 *  trailing `tool` message means the follow-up call after inline execution.
 *  Turn 1 is a SILENT multi-tool turn (empty content, two calls, one of them
 *  an unknown tool with unparseable arguments); turn 2 dispatches one tool
 *  beside text; turn 3 and later answer with text only. */
const delegationAgent: MultishotTransport = async (req) => {
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
          {
            id: 'tc-2',
            type: 'function',
            function: { name: 'mystery_tool', arguments: 'not json' },
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
            id: 'tc-3',
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

/** Pure in the request: the reply indexes on how many prior driver replies the
 *  point-of-view-translated conversation already carries. */
const delegationDriver: MultishotTransport = async (req) => {
  const priorReplies = req.messages.filter((m) => m.role === 'assistant').length
  return {
    message: { content: `Driver follow-up #${priorReplies}: sharper, please.` },
    usage: { prompt_tokens: 80, completion_tokens: 18 },
    costUsd: 0.001,
  }
}

interface DelegationOverrides {
  maxTurns?: number
  maxToolDispatches?: number
  driverFallbackModels?: string[]
  toolExecutors?: Record<string, MultishotToolExecutor>
  agent?: MultishotTransport
  driver?: MultishotTransport
}

function delegationCase(overrides: DelegationOverrides = {}): MultishotGoldenCase {
  const requests: MultishotRecordedRequest[] = []
  const options: RunMultishotOptions<MultishotPersona> = {
    profile: delegationProfile,
    persona: delegationPersona,
    shape: delegationShape,
    tools: delegationTools,
    toolExecutors: overrides.toolExecutors ?? delegationExecutors(),
    artifactTypeFor: delegationArtifactTypeFor,
    maxTurns: overrides.maxTurns ?? 3,
    agentModel: 'test/agent-model',
    driverModel: 'test/driver-model',
    agentTransport: ledgerTransport(requests, 'agent', overrides.agent ?? delegationAgent),
    driverTransport: ledgerTransport(requests, 'driver', overrides.driver ?? delegationDriver),
  }
  if (overrides.maxToolDispatches !== undefined) {
    options.maxToolDispatches = overrides.maxToolDispatches
  }
  if (overrides.driverFallbackModels !== undefined) {
    options.driverFallbackModels = overrides.driverFallbackModels
  }
  return { options, requests }
}

/** Silent on the primary model, substantive on any other — the rotation path. */
const delegationSilentPrimaryDriver: MultishotTransport = async (req) => {
  if (req.model === 'test/driver-model') {
    return { message: { content: '' }, usage: { prompt_tokens: 10, completion_tokens: 0 } }
  }
  const priorReplies = req.messages.filter((m) => m.role === 'assistant').length
  return {
    message: { content: `Fallback follow-up #${priorReplies}.` },
    usage: { prompt_tokens: 80, completion_tokens: 18 },
    costUsd: 0.003,
  }
}

const delegationAlwaysSilentDriver: MultishotTransport = async () => ({
  message: { content: '' },
  usage: { prompt_tokens: 10, completion_tokens: 0 },
})

/** One tool call per assistant turn, forever — walks past any dispatch cap. */
const delegationToolStormAgent: MultishotTransport = async (req) => ({
  message: {
    content: '',
    tool_calls: [
      {
        id: `tc-${req.messages.length}`,
        type: 'function',
        function: { name: 'delegate_research', arguments: '{}' },
      },
    ],
  },
  usage: { prompt_tokens: 10, completion_tokens: 5 },
})

// ---------------------------------------------------------------------------
// sampling-contract script
// ---------------------------------------------------------------------------

const SAMPLING_AGENT_MAX_TOKENS = 111
const SAMPLING_FOLLOWUP_MAX_TOKENS = 222
const SAMPLING_DRIVER_MAX_TOKENS = 333

const samplingPersona: MultishotPersona = { id: 'parity-persona', name: 'Parity Persona' }

const samplingProfile: AgentProfile = {
  name: 'multishot-golden-sampling',
  prompt: { systemPrompt: 'You are the domain agent under test.' },
}

const samplingShape = {
  buildOpener: () => 'I need help with my CA return.',
  buildDriverSystemPrompt: (p: MultishotPersona) => `You simulate taxpayer ${p.id}.`,
}

const samplingTools: MultishotToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'state_tax_search',
      description: 'search state tax rules',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_source_documents',
      description: 'list docs',
      parameters: { type: 'object', properties: {} },
    },
  },
]

function samplingExecutors(): Record<string, MultishotToolExecutor> {
  return {
    state_tax_search: async (args) => ({
      content: JSON.stringify({ ok: true, echo: args }),
      costUsd: 0.01,
    }),
    list_source_documents: async () => ({ content: '', costUsd: 0 }),
  }
}

/** A transport that answers from a fixed list and fails loud past its end. An
 *  engine that issues more calls than the script has steps is a divergence,
 *  not a longer conversation. */
function scriptedTransport(steps: MultishotTransportResponse[], label: string): MultishotTransport {
  let index = 0
  return async () => {
    const step = steps[index++]
    if (!step) throw new Error(`${label}: unscripted call ${index}`)
    return step
  }
}

/** Three agent turns: a silent multi-tool dispatch with one unparseable
 *  argument payload, a priced follow-up, a text-plus-unknown-tool turn, an
 *  EMPTY follow-up with no usage at all (the uncaptured cost path), and a
 *  closing answer priced from usage alone. */
function samplingAgentScript(): MultishotTransportResponse[] {
  return [
    {
      message: {
        content: '',
        tool_calls: [
          {
            id: 'tc-1',
            type: 'function',
            function: { name: 'state_tax_search', arguments: '{"state":"CA"}' },
          },
          {
            id: 'tc-2',
            type: 'function',
            function: { name: 'list_source_documents', arguments: 'not-json' },
          },
        ],
      },
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
    {
      message: { content: 'Here is my CA analysis.' },
      usage: { prompt_tokens: 140, completion_tokens: 30 },
      costUsd: 0.002,
    },
    {
      message: {
        content: 'Checking one more source.',
        tool_calls: [
          { id: 'tc-3', type: 'function', function: { name: 'mystery_tool', arguments: '{}' } },
        ],
      },
      usage: { prompt_tokens: 200, completion_tokens: 15 },
    },
    { message: { content: '' } },
    {
      message: { content: 'Final answer: file CA 540.' },
      usage: { prompt_tokens: 260, completion_tokens: 40 },
    },
  ]
}

/** Two driver turns: retry-on-empty on the primary, then a whitespace-only
 *  reply that must count as empty, then full rotation to the fallback. */
function samplingDriverScript(): MultishotTransportResponse[] {
  return [
    { message: { content: '' } },
    {
      message: { content: 'Follow-up question A.' },
      usage: { prompt_tokens: 50, completion_tokens: 12 },
    },
    { message: { content: '' } },
    { message: { content: '  ' } },
    { message: { content: 'Follow-up question B.' }, costUsd: 0.0004 },
  ]
}

interface SamplingOverrides {
  maxToolDispatches?: number
  toolExecutors?: Record<string, MultishotToolExecutor>
  agentScript?: MultishotTransportResponse[]
  driverScript?: MultishotTransportResponse[]
}

function samplingCase(overrides: SamplingOverrides = {}): MultishotGoldenCase {
  const requests: MultishotRecordedRequest[] = []
  const options: RunMultishotOptions<MultishotPersona> = {
    profile: samplingProfile,
    persona: samplingPersona,
    shape: samplingShape,
    tools: samplingTools,
    toolExecutors: overrides.toolExecutors ?? samplingExecutors(),
    artifactTypeFor: (toolName: string) =>
      toolName.startsWith('state_tax_') ? 'state-tax-tool' : undefined,
    maxTurns: 3,
    agentMaxTokens: SAMPLING_AGENT_MAX_TOKENS,
    toolFollowupMaxTokens: SAMPLING_FOLLOWUP_MAX_TOKENS,
    driverMaxTokens: SAMPLING_DRIVER_MAX_TOKENS,
    maxToolDispatches: overrides.maxToolDispatches ?? 4,
    agentModel: 'scripted/agent',
    driverModel: 'primary/driver',
    driverFallbackModels: ['fallback/driver'],
    agentTransport: ledgerTransport(
      requests,
      'agent',
      scriptedTransport(overrides.agentScript ?? samplingAgentScript(), 'agent transport'),
    ),
    driverTransport: ledgerTransport(
      requests,
      'driver',
      scriptedTransport(overrides.driverScript ?? samplingDriverScript(), 'driver transport'),
    ),
  }
  return { options, requests }
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

/** Every recorded shot scenario, in record order. */
export function multishotGoldenScenarios(): MultishotGoldenScenario[] {
  return [
    {
      id: 'delegation-three-turns',
      description:
        'three turns with a silent multi-tool dispatch, an unknown tool, both typed artifact kinds, and both cost paths',
      build: () => delegationCase(),
    },
    {
      id: 'delegation-ten-turns',
      description: 'ten turns — the function default depth, past any short driver-turn budget',
      build: () => delegationCase({ maxTurns: 10 }),
    },
    {
      id: 'delegation-zero-turns',
      description: 'maxTurns 0 returns the opener-only result and spends nothing',
      build: () => delegationCase({ maxTurns: 0 }),
    },
    {
      id: 'delegation-nan-turns',
      description: 'a non-numeric maxTurns behaves as zero turns, not as the default',
      build: () => delegationCase({ maxTurns: Number('not-a-number') }),
    },
    {
      id: 'delegation-single-turn',
      description: 'maxTurns 1 never calls the driver leg',
      build: () => delegationCase({ maxTurns: 1 }),
    },
    {
      id: 'delegation-driver-rotation',
      description: 'a silent primary driver rotates to the fallback model after two attempts',
      build: () =>
        delegationCase({
          driver: delegationSilentPrimaryDriver,
          driverFallbackModels: ['test/driver-fallback'],
        }),
    },
    {
      id: 'delegation-fatal-tool-error',
      description:
        'MultishotFatalToolError from an executor aborts the shot and declares its spend',
      build: () =>
        delegationCase({
          toolExecutors: {
            ...delegationExecutors(),
            delegate_research: async () => {
              throw new MultishotFatalToolError('research backend down')
            },
          },
        }),
    },
    {
      id: 'delegation-driver-empty',
      description: 'a driver silent on every model raises MultishotDriverEmptyError',
      build: () => delegationCase({ driver: delegationAlwaysSilentDriver }),
    },
    {
      id: 'delegation-dispatch-cap',
      description: 'a tool storm trips the dispatch cap with the exact cap message',
      build: () =>
        delegationCase({ agent: delegationToolStormAgent, maxToolDispatches: 2, maxTurns: 3 }),
    },
    {
      id: 'sampling-contract-three-turns',
      description:
        'per-leg token budgets, driver retry-on-empty, a whitespace-only driver reply, an empty assistant follow-up with no usage, and full rotation',
      build: () => samplingCase(),
    },
    {
      id: 'sampling-contract-fatal-tool-error',
      description: 'MultishotFatalToolError propagates unchanged out of the first tool dispatch',
      build: () =>
        samplingCase({
          toolExecutors: {
            state_tax_search: async () => {
              throw new MultishotFatalToolError('citation budget exhausted')
            },
            list_source_documents: async () => ({ content: '', costUsd: 0 }),
          },
        }),
    },
    {
      id: 'sampling-contract-driver-empty-after-rotation',
      description:
        'MultishotDriverEmptyError names the turn only after both attempts on both models',
      build: () =>
        samplingCase({
          driverScript: [
            { message: { content: '' } },
            { message: { content: '' } },
            { message: { content: '' } },
            { message: { content: '' } },
          ],
        }),
    },
    {
      id: 'sampling-contract-dispatch-cap',
      description: 'three calls against a cap of two fail loud on turn 0',
      build: () =>
        samplingCase({
          maxToolDispatches: 2,
          agentScript: [
            {
              message: {
                content: '',
                tool_calls: [1, 2, 3].map((n) => ({
                  id: `tc-${n}`,
                  type: 'function' as const,
                  function: { name: 'state_tax_search', arguments: '{}' },
                })),
              },
            },
          ],
          driverScript: [],
        }),
    },
  ]
}
