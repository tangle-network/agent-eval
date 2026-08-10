/**
 * THE DEFINITION PARITY KILL TEST.
 *
 * Each benchmark arm exists twice: as its historical entry point and as an
 * `AnalystDefinition` compiled through `bindAnalyst`. This suite runs both
 * over the same fixture rows with a fake transport and asserts BYTE-IDENTICAL
 * request bodies plus equal protocol identity digests. A mismatch anywhere
 * means the declarative layer lost expression — the suite fails, on purpose.
 * Never loosen these assertions; report the construct that cannot be
 * expressed instead.
 */

import { describe, expect, it } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { otlpTextToTraceAnalysisStore } from '../trace-analyst/store-otlp'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import {
  createPublicBenchmarkDirectRunner,
  publicDirectAnalystDefinition,
} from './benchmark-public-model'
import {
  publicBenchmarkProtocolSha256,
  publicBenchmarkRlmInstructions,
  publicBenchmarkSystemPrompt,
} from './benchmark-public-prompt'
import {
  createPublicBenchmarkRlmRunner,
  publicRlmAnalystDefinition,
  rlmEngineLimits,
} from './benchmark-public-rlm'
import type { PublicAnalystBenchmarkModelConfig } from './benchmark-public-types'
import {
  createPrimeBenchmarkRunner,
  primeAnalystProtocolSha256,
  primeCodeTraceAnalystDefinition,
} from './benchmark-runner-prime'
import { bindAnalyst } from './bind'
import {
  AnalystExpressivenessError,
  analystDefinitionAsymmetries,
  analystDefinitionProtocolSha256,
} from './definition'
import { RAW_FINDING_SCHEMA_PROMPT } from './finding-signature'
import { testModelExecutionOwner } from './model-execution.test-support'
import type { PrimeBridgeTransport, PrimeBridgeTransportRequest } from './prime-bridge-transport'
import type { AnalystRunInputs } from './types'

const TEST_PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }

/** Findings with the wall-clock stamp neutralized; every other byte must match. */
function clockFree(findings: ReadonlyArray<{ produced_at: string }> | undefined) {
  return (findings ?? []).map((finding) => ({ ...finding, produced_at: '<clock>' }))
}

// ── Digest identity ─────────────────────────────────────────────────

describe('definition protocol identity', () => {
  it('prime: the definition digest equals the digest the arm always recorded', () => {
    const definition = primeCodeTraceAnalystDefinition({ timeoutMs: 30_000, repairTurns: 1 })
    expect(analystDefinitionProtocolSha256(definition)).toBe(primeAnalystProtocolSha256())
    expect(definition.protocolSha256).toBe(primeAnalystProtocolSha256())
  })

  it.each(['agentrx', 'codetracebench'] as const)(
    'direct %s: the definition composes the exact one-shot system prompt and records the dataset digest',
    (dataset) => {
      const definition = publicDirectAnalystDefinition(dataset, {
        timeoutMs: 5_000,
        maxOutputTokens: 64,
        maxCostUsd: 1,
      })
      const composed = [definition.taskDefinition, ...definition.replyContract.contractLines].join(
        '\n\n',
      )
      expect(composed).toBe(publicBenchmarkSystemPrompt(dataset))
      expect(definition.protocolSha256).toBe(publicBenchmarkProtocolSha256(dataset))
    },
  )

  it.each(['agentrx', 'codetracebench'] as const)(
    'dspy-rlm %s: the definition carries the exact stock instructions and records the dataset digest',
    (dataset) => {
      const definition = publicRlmAnalystDefinition(dataset, {
        instructions: publicBenchmarkRlmInstructions(dataset),
        protocolSha256: publicBenchmarkProtocolSha256(dataset),
        timeoutMs: 5_000,
        maxOutputTokens: 64,
        maxCostUsd: 1,
        engineLimits: {
          maxIterations: 14,
          maxLlmCalls: 8,
          maxToolCalls: 80,
          maxOutputChars: 8_000,
        },
      })
      expect(definition.taskDefinition).toBe(publicBenchmarkRlmInstructions(dataset))
      expect(definition.protocolSha256).toBe(publicBenchmarkProtocolSha256(dataset))
    },
  )
})

// ── Equal-terms comparison ──────────────────────────────────────────

describe('analystDefinitionAsymmetries', () => {
  const prime = () => primeCodeTraceAnalystDefinition({ timeoutMs: 30_000, repairTurns: 1 })
  const rlm = () =>
    publicRlmAnalystDefinition('codetracebench', {
      instructions: publicBenchmarkRlmInstructions('codetracebench'),
      protocolSha256: publicBenchmarkProtocolSha256('codetracebench'),
      timeoutMs: 30_000,
      maxOutputTokens: 64,
      maxCostUsd: 1,
      engineLimits: { maxIterations: 14, maxLlmCalls: 8, maxToolCalls: 80, maxOutputChars: 8_000 },
    })
  const direct = () =>
    publicDirectAnalystDefinition('codetracebench', {
      timeoutMs: 30_000,
      maxOutputTokens: 64,
      maxCostUsd: 1,
    })

  it('renders declared differences for arms with equal repair turns', () => {
    const report = analystDefinitionAsymmetries([prime(), rlm()])
    expect(report.ids).toEqual(['prime', 'dspy-rlm'])
    expect(report.repairTurns).toBe(1)
    expect(report.sharedProjectionMode).toBeNull()
    expect(report.asymmetries.map((entry) => entry.projectionMode)).toEqual([
      'inline',
      'repl-variable',
    ])
  })

  it('refuses a set whose arms earn unequal repair turns', () => {
    expect(() => analystDefinitionAsymmetries([prime(), direct()])).toThrow(
      /a retry is a second sample/,
    )
  })
})

// ── bindAnalyst refusals ────────────────────────────────────────────

describe('bindAnalyst', () => {
  it('refuses a projection × transport pair no strategy compiles', () => {
    const definition = {
      ...primeCodeTraceAnalystDefinition({ timeoutMs: 30_000, repairTurns: 1 }),
      projection: { mode: 'agent-tools', toolGroup: 'singleTrace' } as const,
    }
    expect(() =>
      bindAnalyst(definition, {
        kind: 'prime-bridge',
        baseUrl: 'http://bridge.test:4181',
        model: 'prime/zai/glm-5.2',
      }),
    ).toThrow(AnalystExpressivenessError)
  })
})

// ── Prime arm request parity ────────────────────────────────────────

const PRIME_TRACE_ID = 'traj-7'
const PRIME_CASE = { caseId: `codetrace:${PRIME_TRACE_ID}`, repetition: 0 }

function primeSpanLine(spanId: string, content: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    trace_id: PRIME_TRACE_ID,
    span_id: spanId,
    parent_span_id: null,
    name: `assistant ${spanId}`,
    kind: 'LLM',
    start_time: '2026-07-30T00:00:00.000Z',
    end_time: '2026-07-30T00:00:01.000Z',
    status: 'OK',
    attributes: { content, 'openinference.span.kind': 'LLM' },
    ...overrides,
  })
}

function primeFixtureInput(): AnalystRunInputs {
  const lines = [1, 2, 3].map((step) =>
    primeSpanLine(`step-${step}`, `Step ${step} action. ${'x'.repeat(40)}`),
  )
  lines.push(
    primeSpanLine('benchmark-verification-outcome', 'FAILED: hidden assertion failed', {
      kind: 'SPAN',
      name: 'benchmark verification outcome',
      attributes: {
        content: 'FAILED: hidden assertion failed',
        'openinference.span.kind': 'SPAN',
        'benchmark.evidence.role': 'final-verification-outcome',
      },
    }),
  )
  return { traceStore: otlpTextToTraceAnalysisStore(`${lines.join('\n')}\n`) }
}

function queuedPrimeTransport(replies: string[]): {
  transport: PrimeBridgeTransport
  requests: PrimeBridgeTransportRequest[]
} {
  const requests: PrimeBridgeTransportRequest[] = []
  const queue = [...replies]
  const transport: PrimeBridgeTransport = async (request) => {
    requests.push(request)
    const reply = queue.shift()
    if (reply === undefined) throw new Error('fake transport queue exhausted')
    return {
      status: 200,
      text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }),
    }
  }
  return { transport, requests }
}

describe('prime arm parity', () => {
  it('the compiled definition and the entry point send byte-identical bodies across both turns', async () => {
    const goodReply = `\`\`\`json\n${JSON.stringify({
      answer: 'Traced from the failing verification.',
      blocks: [
        {
          first_step: 2,
          last_step: 3,
          consequence_step: 3,
          escape_status: 'unescaped',
          severity: 'high',
          claim: 'Edited the wrong module.',
          confidence: 0.8,
        },
      ],
    })}\n\`\`\`\n`
    // A malformed first reply forces the bounded repair turn, so parity covers
    // both prompts the arm can ever send.
    const replies = () => ['the reply is prose, not JSON', goodReply]
    const bespokeSide = queuedPrimeTransport(replies())
    const compiledSide = queuedPrimeTransport(replies())

    const bespoke = createPrimeBenchmarkRunner({
      baseUrl: 'http://bridge.test:4181',
      model: 'prime/zai/glm-5.2',
      timeoutMs: 30_000,
      repair: true,
      pricing: TEST_PRICING,
      transport: bespokeSide.transport,
    })
    const compiled = bindAnalyst(
      primeCodeTraceAnalystDefinition({ timeoutMs: 30_000, repairTurns: 1 }),
      {
        kind: 'prime-bridge',
        baseUrl: 'http://bridge.test:4181',
        model: 'prime/zai/glm-5.2',
        pricing: TEST_PRICING,
        transport: compiledSide.transport,
      },
    )

    const bespokeOutput = await bespoke.analyze(primeFixtureInput(), PRIME_CASE)
    const compiledOutput = await compiled.analyze(primeFixtureInput(), PRIME_CASE)

    expect(bespokeOutput.error).toBeUndefined()
    expect(compiledOutput.error).toBeUndefined()
    expect(bespokeSide.requests).toHaveLength(2)
    expect(compiledSide.requests).toHaveLength(2)
    for (const [index, request] of bespokeSide.requests.entries()) {
      expect(JSON.stringify(compiledSide.requests[index]!.body)).toBe(JSON.stringify(request.body))
      expect(compiledSide.requests[index]!.url).toBe(request.url)
    }
    expect(clockFree(compiledOutput.findings)).toEqual(clockFree(bespokeOutput.findings))
    expect(compiledOutput.metadata?.protocolSha256).toBe(bespokeOutput.metadata?.protocolSha256)
    expect(compiledOutput.metadata?.protocolSha256).toBe(primeAnalystProtocolSha256())
  })
})

// ── Shared caller-owned-path fixtures ───────────────────────────────

function fixtureSpan(traceId: string, spanId: string, content: string): TraceAnalystSpan {
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: 'root',
    name: 'message.assistant',
    kind: 'LLM',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: null,
    agent_name: 'assistant',
    model_name: null,
    tool_name: null,
    attributes: { content },
  } as TraceAnalystSpan
}

function singleTraceStore(traceId: string, spans: TraceAnalystSpan[]): TraceAnalysisStore {
  return {
    async getOverview() {
      return {
        total_traces: 1,
        raw_jsonl_bytes: 1,
        services: [],
        agents: [],
        models: [],
        tool_names: [],
        sample_trace_ids: [traceId],
        errors: { trace_count: 0, span_count: 0 },
        error_clusters: [],
        time_range: {
          earliest: '2026-01-01T00:00:00.000Z',
          latest: '2026-01-01T00:00:01.000Z',
        },
      }
    },
    async viewTrace() {
      return { trace_id: traceId, spans }
    },
    async hasSpans(input: { span_ids: readonly string[] }) {
      const known = new Set(spans.map((candidate) => candidate.span_id))
      return input.span_ids.filter((id) => known.has(id))
    },
    async viewSpans(input: { span_ids: readonly string[] }) {
      const requested = new Set(input.span_ids)
      const found = spans.filter((candidate) => requested.has(candidate.span_id))
      const foundIds = new Set(found.map((candidate) => candidate.span_id))
      return {
        trace_id: traceId,
        spans: found,
        missing_span_ids: input.span_ids.filter((id) => !foundIds.has(id)),
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
  } as unknown as TraceAnalysisStore
}

function capturingOwner(reply: Record<string, unknown>): {
  owner: ReturnType<typeof testModelExecutionOwner>
  bodies: string[]
} {
  const bodies: string[] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return new Response(
      JSON.stringify({
        model: 'glm-5.2',
        choices: [
          { message: { role: 'assistant', content: JSON.stringify(reply) }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return {
    owner: testModelExecutionOwner({
      baseUrl: 'https://provider.invalid/v1',
      fetchImpl,
      pricing: TEST_PRICING,
    }),
    bodies,
  }
}

function ownerConfig(
  owner: ReturnType<typeof testModelExecutionOwner>,
): PublicAnalystBenchmarkModelConfig {
  return {
    ...owner,
    model: 'glm-5.2',
    maxOutputTokens: 64,
    timeoutMs: 5_000,
    pricing: TEST_PRICING,
  }
}

// ── Direct arm request parity ───────────────────────────────────────

const DIRECT_FIXTURES = {
  codetracebench: {
    caseId: 'codetrace:trace-1',
    traceId: 'trace-1',
    reply: {
      report: 'Step 2 wrote the configuration that broke the deploy at step 3.',
      findings: [
        {
          first_step: 2,
          last_step: 2,
          consequence_step: 3,
          escape_status: 'unescaped',
          severity: 'high',
          claim: 'Step 2 wrote an invalid configuration.',
          confidence: 0.9,
        },
      ],
    },
  },
  agentrx: {
    caseId: 'agentrx:trace-1',
    traceId: 'trace-1',
    reply: {
      report: 'Step 2 invoked the tool with an invalid payload.',
      findings: [
        {
          step: 2,
          severity: 'high',
          claim: 'Step 2 invoked the tool with an invalid payload.',
          confidence: 0.9,
          category: 'invalid-invocation',
        },
      ],
    },
  },
} as const

describe('direct arm parity', () => {
  it.each(['codetracebench', 'agentrx'] as const)(
    '%s: the compiled definition and the entry point send byte-identical bodies',
    async (dataset) => {
      const fixture = DIRECT_FIXTURES[dataset]
      const spans = [
        fixtureSpan(fixture.traceId, 'step-2', 'writeFile("broken configuration file")'),
        fixtureSpan(fixture.traceId, 'step-3', 'runCommand("deploy --config broken")'),
      ]
      const bespokeSide = capturingOwner(fixture.reply)
      const compiledSide = capturingOwner(fixture.reply)

      const bespoke = createPublicBenchmarkDirectRunner(dataset, ownerConfig(bespokeSide.owner))
      const compiled = bindAnalyst(
        publicDirectAnalystDefinition(dataset, {
          timeoutMs: 5_000,
          maxOutputTokens: 64,
          maxCostUsd: 1,
        }),
        { kind: 'model-owner', config: ownerConfig(compiledSide.owner) },
      )

      const context = { caseId: fixture.caseId, repetition: 0 }
      const bespokeOutput = await bespoke.analyze(
        { traceStore: singleTraceStore(fixture.traceId, spans) },
        context,
      )
      const compiledOutput = await compiled.analyze(
        { traceStore: singleTraceStore(fixture.traceId, spans) },
        context,
      )

      expect(bespokeOutput.error).toBeUndefined()
      expect(compiledOutput.error).toBeUndefined()
      expect(bespokeSide.bodies).toHaveLength(1)
      expect(compiledSide.bodies).toHaveLength(1)
      expect(compiledSide.bodies[0]).toBe(bespokeSide.bodies[0])
      expect(clockFree(compiledOutput.findings)).toEqual(clockFree(bespokeOutput.findings))
      expect(compiledOutput.metadata?.protocolSha256).toBe(bespokeOutput.metadata?.protocolSha256)
      expect(compiledOutput.metadata?.protocolSha256).toBe(publicBenchmarkProtocolSha256(dataset))

      // Independent reconstruction from the prompt module and the store: the
      // sent messages are exactly the published system prompt plus the
      // rendered single-trace projection at the ladder's first cap.
      const sent = JSON.parse(bespokeSide.bodies[0]!) as {
        messages: Array<{ role: string; content: string }>
      }
      expect(sent.messages[0]).toEqual({
        role: 'system',
        content: publicBenchmarkSystemPrompt(dataset),
      })
      const rendered = JSON.stringify({
        trace_id: fixture.traceId,
        per_attribute_byte_cap: 4_096,
        spans,
      })
      expect(sent.messages[1]).toEqual({
        role: 'user',
        content: `TRACE DATA:\n${rendered}\n\nReturn the analysis JSON object.`,
      })
    },
  )
})

// ── DSPy RLM arm request parity ─────────────────────────────────────

/**
 * The kill-test engine child: renders every protocol-bearing field of the
 * engine request into the model call it makes through the proxy, so the
 * captured provider body is byte-identical exactly when the composed engine
 * request is.
 */
const RLM_PARITY_CHILD = `
const fs = require('node:fs')
const inputPath = process.argv[process.argv.indexOf('--input') + 1]
const outputPath = process.argv[process.argv.indexOf('--output') + 1]
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
async function main() {
  const content = JSON.stringify({
    question: input.question,
    instructions: input.instructions,
    toolSpecs: input.toolSpecs,
    limits: input.limits,
    controlAdapter: input.controlAdapter,
  })
  const model = await fetch(input.modelProxy.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + input.modelProxy.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.modelProxy.model,
      messages: [{ role: 'user', content }],
      max_tokens: input.modelProxy.maxOutputTokens,
    }),
  })
  if (!model.ok) throw new Error('model proxy failed: ' + await model.text())
  await model.json()
  fs.writeFileSync(outputPath, JSON.stringify({
    answer: 'Parity child answer.',
    findings: [{
      severity: 'high',
      claim: 'Step 2 wrote an invalid configuration.',
      subject: 'incorrect-steps-2-2-unescaped-consequence-3',
      confidence: 0.9,
      evidence: [{ uri: 'trace://trace-1/span/step-2', excerpt: 'writeFile("broken configuration file")' }],
    }],
    trajectory: [],
    modelCalls: 1,
    runtime: { engine: 'parity-child' },
  }))
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
`

describe('dspy-rlm arm parity', () => {
  it('codetracebench: the compiled definition and the entry point compose byte-identical engine requests', async () => {
    const traceId = 'trace-1'
    const spans = [
      fixtureSpan(traceId, 'step-2', 'writeFile("broken configuration file")'),
      fixtureSpan(traceId, 'step-3', 'runCommand("deploy --config broken")'),
    ]
    const reply = { unused: true }
    const bespokeSide = capturingOwner(reply)
    const compiledSide = capturingOwner(reply)
    const runner = { command: process.execPath, args: ['-e', RLM_PARITY_CHILD, '--'] }

    const bespoke = createPublicBenchmarkRlmRunner('codetracebench', {
      ...ownerConfig(bespokeSide.owner),
      dspyRlm: { runner },
    })
    const config = { ...ownerConfig(compiledSide.owner), dspyRlm: { runner } }
    const compiled = bindAnalyst(
      publicRlmAnalystDefinition('codetracebench', {
        instructions: publicBenchmarkRlmInstructions('codetracebench'),
        protocolSha256: publicBenchmarkProtocolSha256('codetracebench'),
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.maxOutputTokens,
        maxCostUsd: 1,
        engineLimits: rlmEngineLimits(config),
      }),
      { kind: 'model-owner', config },
    )

    const context = { caseId: `codetrace:${traceId}`, repetition: 0 }
    const bespokeOutput = await bespoke.analyze(
      { traceStore: singleTraceStore(traceId, spans) },
      context,
    )
    const compiledOutput = await compiled.analyze(
      { traceStore: singleTraceStore(traceId, spans) },
      context,
    )

    expect(bespokeOutput.error).toBeUndefined()
    expect(compiledOutput.error).toBeUndefined()
    expect(bespokeSide.bodies).toHaveLength(1)
    expect(compiledSide.bodies).toHaveLength(1)
    expect(compiledSide.bodies[0]).toBe(bespokeSide.bodies[0])
    expect(compiledOutput.metadata?.protocolSha256).toBe(bespokeOutput.metadata?.protocolSha256)
    expect(compiledOutput.metadata?.protocolSha256).toBe(
      publicBenchmarkProtocolSha256('codetracebench'),
    )
    expect(clockFree(compiledOutput.findings)).toEqual(clockFree(bespokeOutput.findings))

    // Independent reconstruction of the engine request the child rendered:
    // stock instructions plus the schema prompt plus the fixed engine tail.
    const provider = JSON.parse(bespokeSide.bodies[0]!) as {
      messages: Array<{ role: string; content: string }>
    }
    const engineRequest = JSON.parse(provider.messages[0]!.content) as {
      question: string
      instructions: string
      limits: Record<string, number>
    }
    expect(engineRequest.question).toBe(
      'Which assistant steps are incorrect under the CodeTraceBench definition?',
    )
    expect(engineRequest.instructions).toBe(
      [
        publicBenchmarkRlmInstructions('codetracebench').trim(),
        RAW_FINDING_SCHEMA_PROMPT,
        'Return a direct prose answer and a strict findings array. Use trace tools to investigate. Do not infer trace facts from the question alone.',
      ].join('\n\n'),
    )
    expect(engineRequest.limits).toEqual({
      maxIterations: 14,
      maxLlmCalls: 8,
      maxOutputChars: 8_000,
    })
  }, 30_000)
})
