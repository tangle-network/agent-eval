import { describe, expect, it } from 'vitest'
import { otlpTextToTraceAnalysisStore } from '../trace-analyst/store-otlp'
import {
  createPrimeBenchmarkRunner,
  type PrimeBenchmarkRunnerOptions,
  type PrimeBridgeTransport,
  type PrimeBridgeTransportRequest,
  primeAnalystProtocolSha256,
} from './benchmark-runner-prime'
import type { AnalystRunInputs } from './types'

const TRACE_ID = 'traj-7'
const CASE_ID = `codetrace:${TRACE_ID}`
const CONTEXT = { caseId: CASE_ID, repetition: 0 }
const GLM_INPUT_USD_PER_MILLION = 0.6
const GLM_OUTPUT_USD_PER_MILLION = 2.2

function spanLine(
  spanId: string,
  content: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    trace_id: TRACE_ID,
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

function fixtureInput(options: { steps?: number; stepChars?: number } = {}): AnalystRunInputs {
  const steps = options.steps ?? 3
  const stepChars = options.stepChars ?? 40
  const lines = Array.from({ length: steps }, (_, index) =>
    spanLine(`step-${index + 1}`, `Step ${index + 1} action. ${'x'.repeat(stepChars)}`),
  )
  lines.push(
    spanLine('benchmark-verification-outcome', 'FAILED: hidden assertion failed', {
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

interface QueuedReply {
  status?: number
  text?: string
  error?: Error
}

function bridgeReply(content: string, usage?: Record<string, unknown>): QueuedReply {
  return {
    status: 200,
    text: JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      ...(usage ? { usage } : {}),
    }),
  }
}

function fencedBlocks(blocks: unknown[], answer = 'Traced from the failing verification.'): string {
  return `Analysis complete.\n\`\`\`json\n${JSON.stringify({ answer, blocks })}\n\`\`\`\n`
}

const GOOD_BLOCK = {
  first_step: 2,
  last_step: 3,
  consequence_step: 3,
  escape_status: 'unescaped',
  severity: 'high',
  claim: 'Edited the wrong module.',
  confidence: 0.8,
}

function queuedTransport(replies: QueuedReply[]): {
  transport: PrimeBridgeTransport
  requests: PrimeBridgeTransportRequest[]
} {
  const requests: PrimeBridgeTransportRequest[] = []
  const queue = [...replies]
  const transport: PrimeBridgeTransport = async (request) => {
    requests.push(request)
    const reply = queue.shift()
    if (!reply) throw new Error('fake transport queue exhausted')
    if (reply.error) throw reply.error
    return { status: reply.status ?? 200, text: reply.text ?? '' }
  }
  return { transport, requests }
}

function runner(
  transport: PrimeBridgeTransport,
  overrides: Partial<PrimeBenchmarkRunnerOptions> = {},
) {
  return createPrimeBenchmarkRunner({
    baseUrl: 'http://bridge.test:4181',
    model: 'prime/zai/glm-5.2',
    timeoutMs: 30_000,
    repair: true,
    transport,
    ...overrides,
  })
}

describe('createPrimeBenchmarkRunner', () => {
  it('expands a well-formed block reply into per-step findings with a usage receipt', async () => {
    const { transport, requests } = queuedTransport([
      bridgeReply(fencedBlocks([GOOD_BLOCK]), {
        prompt_tokens: 1_000,
        completion_tokens: 200,
        model_requests: 1,
      }),
    ])
    const output = await runner(transport).analyze(fixtureInput(), CONTEXT)

    expect(output.error).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://bridge.test:4181/v1/chat/completions')
    expect(requests[0]!.body.model).toBe('prime/zai/glm-5.2')
    expect(output.findings.map((finding) => finding.subject)).toEqual([
      'incorrect-step-2',
      'incorrect-step-3',
    ])
    for (const finding of output.findings) {
      expect(finding.analyst_id).toBe('prime')
    }
    expect(output.findings[0]!.evidence_refs).toEqual([
      expect.objectContaining({ kind: 'span', uri: `trace://${TRACE_ID}/span/step-2` }),
    ])
    expect(output.usage).toEqual({
      calls: 1,
      tokens: { input: 1_000, output: 200 },
      cost: {
        kind: 'estimated',
        usd: (1_000 * GLM_INPUT_USD_PER_MILLION + 200 * GLM_OUTPUT_USD_PER_MILLION) / 1_000_000,
      },
    })
    expect(output.metadata).toMatchObject({
      analysisMode: 'prime-rlm',
      engine: 'prime',
      answer: 'Traced from the failing verification.',
      delivery: { mode: 'inline-json', fetch: 'view-trace', perAttributeByteCap: null },
      repair: { attempted: false, succeeded: null },
      protocolSha256: primeAnalystProtocolSha256(),
    })
  })

  it('sends the task definition, output contract, trajectory, and verification spans in one prompt', async () => {
    const { transport, requests } = queuedTransport([bridgeReply(fencedBlocks([]))])
    await runner(transport).analyze(fixtureInput(), CONTEXT)

    const prompt = requests[0]!.body.messages[0]!.content
    expect(requests[0]!.body.messages).toHaveLength(1)
    expect(prompt).toContain('Which assistant steps are incorrect under the CodeTraceBench')
    expect(prompt).toContain('TASK DEFINITION:')
    expect(prompt).toContain('Analyze exactly one coding-agent trajectory')
    expect(prompt).toContain('OUTPUT CONTRACT')
    expect(prompt).toContain('Do NOT include a rationale field. Keep every string SHORT')
    expect(prompt).toContain(`TRAJECTORY (trace_id ${TRACE_ID}; 3 assistant step spans`)
    expect(prompt).toContain('FINAL VERIFICATION SPANS:')
    expect(prompt).toContain('benchmark-verification-outcome')
  })

  it('repairs a malformed reply with one bounded turn that never carries the trajectory', async () => {
    const { transport, requests } = queuedTransport([
      bridgeReply('the reply is prose, not JSON', { prompt_tokens: 900, completion_tokens: 90 }),
      bridgeReply(fencedBlocks([GOOD_BLOCK]), { prompt_tokens: 100, completion_tokens: 10 }),
    ])
    const output = await runner(transport).analyze(fixtureInput(), CONTEXT)

    expect(requests).toHaveLength(2)
    const repairPrompt = requests[1]!.body.messages[0]!.content
    expect(repairPrompt).toContain('structurally malformed')
    expect(repairPrompt).toContain('no parseable JSON object')
    expect(repairPrompt).toContain('PREVIOUS REPLY:')
    expect(repairPrompt).toContain('the reply is prose, not JSON')
    expect(repairPrompt).not.toContain('TRAJECTORY (trace_id')
    expect(repairPrompt).not.toContain('Step 1 action.')
    expect(output.error).toBeUndefined()
    expect(output.findings).toHaveLength(2)
    expect(output.usage).toEqual({
      calls: null,
      tokens: { input: 1_000, output: 100 },
      cost: {
        kind: 'estimated',
        usd: (1_000 * GLM_INPUT_USD_PER_MILLION + 100 * GLM_OUTPUT_USD_PER_MILLION) / 1_000_000,
      },
    })
    expect(output.metadata).toMatchObject({ repair: { attempted: true, succeeded: true } })
  })

  it('records a typed failed observation when the reply stays malformed after the repair turn', async () => {
    const { transport, requests } = queuedTransport([
      bridgeReply('still prose', { prompt_tokens: 900, completion_tokens: 90 }),
      bridgeReply('{"answer": "no blocks field"}'),
    ])
    const output = await runner(transport).analyze(fixtureInput(), CONTEXT)

    expect(requests).toHaveLength(2)
    expect(output.findings).toEqual([])
    expect(output.error).toEqual({
      class: 'PrimeMalformedReplyError',
      message: 'JSON has no "blocks" array in prime reply even after the bounded repair turn',
    })
    // The repair reply carried no usage, so the merged receipt is uncaptured.
    expect(output.usage).toEqual({
      calls: null,
      tokens: null,
      cost: { kind: 'uncaptured', usd: null },
    })
    expect(output.metadata).toMatchObject({
      repair: { attempted: true, succeeded: false },
      reply: '{"answer": "no blocks field"}',
    })
  })

  it('fails without a second call when repair is disabled', async () => {
    const { transport, requests } = queuedTransport([bridgeReply('prose')])
    const output = await runner(transport, { repair: false }).analyze(fixtureInput(), CONTEXT)

    expect(requests).toHaveLength(1)
    expect(output.error).toEqual({
      class: 'PrimeMalformedReplyError',
      message: 'no parseable JSON object in prime reply',
    })
    expect(output.metadata).toMatchObject({ repair: { attempted: false, succeeded: null } })
  })

  it('treats zero blocks from a well-formed reply as an honest null, not a failure', async () => {
    const { transport } = queuedTransport([bridgeReply(fencedBlocks([]))])
    const output = await runner(transport).analyze(fixtureInput(), CONTEXT)

    expect(output.error).toBeUndefined()
    expect(output.findings).toEqual([])
  })

  it('drops invalid block rows with a recorded reason while valid siblings survive', async () => {
    const { transport } = queuedTransport([
      bridgeReply(
        fencedBlocks([
          { ...GOOD_BLOCK, first_step: 0 },
          { ...GOOD_BLOCK, first_step: 2, last_step: 2, consequence_step: 2 },
        ]),
      ),
    ])
    const output = await runner(transport).analyze(fixtureInput(), CONTEXT)

    expect(output.error).toBeUndefined()
    expect(output.findings.map((finding) => finding.subject)).toEqual(['incorrect-step-2'])
    expect(output.metadata).toMatchObject({
      rejectedRows: [{ index: 0, reason: 'first_step must be a positive integer' }],
    })
  })

  it('falls back to chunked viewSpans projection when the full trace view is oversized', async () => {
    // 60 spans at ~4KB of content each exceed the store's 150KB per-call byte
    // ceiling under the default 4096-byte attribute cap, forcing the fallback.
    const input = fixtureInput({ steps: 60, stepChars: 4_000 })
    const { transport, requests } = queuedTransport([
      bridgeReply(
        fencedBlocks([{ ...GOOD_BLOCK, first_step: 2, last_step: 2, consequence_step: 2 }]),
      ),
    ])
    const output = await runner(transport).analyze(input, CONTEXT)

    expect(output.error).toBeUndefined()
    expect(output.metadata).toMatchObject({
      delivery: {
        mode: 'inline-json',
        fetch: 'view-spans-chunked',
        perAttributeByteCap: 1_200,
      },
    })
    const prompt = requests[0]!.body.messages[0]!.content
    expect(prompt).toContain(`TRAJECTORY (trace_id ${TRACE_ID}; 60 assistant step spans`)
    expect(prompt).toContain('"span_id":"step-60"')
    expect(output.findings.map((finding) => finding.subject)).toEqual(['incorrect-step-2'])
  })

  it('keeps token accounting uncaptured when the bridge reports no usage', async () => {
    const { transport } = queuedTransport([bridgeReply(fencedBlocks([]))])
    const output = await runner(transport).analyze(fixtureInput(), CONTEXT)

    expect(output.usage).toEqual({
      calls: null,
      tokens: null,
      cost: { kind: 'uncaptured', usd: null },
    })
  })

  it('records a typed failed observation for a non-200 bridge response', async () => {
    const { transport } = queuedTransport([{ status: 502, text: 'bad gateway' }])
    const output = await runner(transport).analyze(fixtureInput(), CONTEXT)

    expect(output.findings).toEqual([])
    expect(output.error).toEqual({
      class: 'PrimeBridgeHttpError',
      message: 'bridge HTTP 502: bad gateway',
    })
  })

  it('records a typed failed observation when the bridge call exceeds its deadline', async () => {
    const transport: PrimeBridgeTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('socket destroyed')), {
          once: true,
        })
      })
    const output = await runner(transport, { timeoutMs: 20 }).analyze(fixtureInput(), CONTEXT)

    expect(output.findings).toEqual([])
    expect(output.error).toEqual({
      class: 'PrimeBridgeTransportError',
      message: 'bridge call exceeded 20ms',
    })
  })

  it('rethrows when the benchmark abort signal cancels the analysis', async () => {
    const controller = new AbortController()
    const transport: PrimeBridgeTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        controller.abort()
      })
    await expect(
      runner(transport).analyze(fixtureInput(), { ...CONTEXT, signal: controller.signal }),
    ).rejects.toThrow('aborted')
  })

  it('refuses to construct without pricing for an uncatalogued model', () => {
    const { transport } = queuedTransport([])
    expect(() => runner(transport, { model: 'no-such-model-family-v9' })).toThrow(
      /no pricing is configured/,
    )
  })
})
