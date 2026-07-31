import { createServer, type Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import { createPublicBenchmarkRlmRunner } from './benchmark-public-rlm'

const CHILD_SCRIPT = `
const fs = require('node:fs')
const inputPath = process.argv[process.argv.indexOf('--input') + 1]
const outputPath = process.argv[process.argv.indexOf('--output') + 1]
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
async function main() {
  const model = await fetch(input.modelProxy.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + input.modelProxy.apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: input.modelProxy.model,
      messages: [{ role: 'user', content: input.question }],
      max_tokens: input.modelProxy.maxOutputTokens,
    }),
  })
  if (!model.ok) throw new Error('model proxy failed: ' + await model.text())
  await model.json()
  fs.writeFileSync(outputPath, JSON.stringify({
    answer: 'Engine answer for the abstention-floor test.',
    findings: __FINDINGS__,
    trajectory: [],
    modelCalls: 1,
    runtime: { engine: 'test-bridge' },
  }))
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
`

const FAILING_CHILD_SCRIPT = `
process.stderr.write('ENGINE_CRASH_MARKER')
process.exit(1)
`

function childScript(findingsJson: string): string {
  return CHILD_SCRIPT.replace('__FINDINGS__', findingsJson)
}

describe('createPublicBenchmarkRlmRunner', () => {
  it('falls back to one direct call when the engine completes with zero findings', async () => {
    const { provider, baseUrl } = await startFakeProvider()
    const traceId = 'trace-1'
    const spans = [
      span(traceId, 'step-2', 'writeFile("broken configuration file")'),
      span(traceId, 'step-3', 'runCommand("deploy --config broken")'),
    ]
    const fallbackFetch = vi.fn(async () =>
      directModelResponse({
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
      }),
    ) as typeof fetch

    try {
      const runner = createPublicBenchmarkRlmRunner('codetracebench', {
        baseUrl,
        apiKey: 'provider-secret',
        model: 'glm-5.2',
        maxOutputTokens: 64,
        timeoutMs: 5_000,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        dspyRlm: { runner: { command: process.execPath, args: ['-e', childScript('[]'), '--'] } },
        fetchImpl: fallbackFetch,
      })
      const output = await runner.analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

      expect(output.error).toBeUndefined()
      expect(fallbackFetch).toHaveBeenCalledTimes(1)
      expect(output.metadata).toMatchObject({
        abstentionFallback: 'direct',
        abstentionFallbackMetadata: expect.objectContaining({
          analysisMode: 'direct-baseline',
        }),
      })
      expect(output.findings).toHaveLength(1)
      expect(output.findings[0]).toMatchObject({
        analyst_id: 'direct',
        subject: 'incorrect-step-2',
        metadata: expect.objectContaining({ block_first_step: 2, block_last_step: 2 }),
      })
      // Both the engine's provider call and the fallback call settle under the
      // same benchmark case and repetition tags in the shared ledger.
      expect(output.usage).toMatchObject({
        calls: 2,
        tokens: { input: 103, output: 52 },
      })
    } finally {
      await closeServer(provider)
    }
  })

  it('keeps a case empty, with the marker, when the fallback also finds nothing', async () => {
    const { provider, baseUrl } = await startFakeProvider()
    const traceId = 'trace-1'
    const spans = [span(traceId, 'step-2', 'runCommand("verify everything works")')]
    const fallbackFetch = vi.fn(async () =>
      directModelResponse({ report: 'No incorrect steps were found.', findings: [] }),
    ) as typeof fetch

    try {
      const runner = createPublicBenchmarkRlmRunner('codetracebench', {
        baseUrl,
        apiKey: 'provider-secret',
        model: 'glm-5.2',
        maxOutputTokens: 64,
        timeoutMs: 5_000,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        dspyRlm: { runner: { command: process.execPath, args: ['-e', childScript('[]'), '--'] } },
        fetchImpl: fallbackFetch,
      })
      const output = await runner.analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

      expect(output.error).toBeUndefined()
      expect(fallbackFetch).toHaveBeenCalledTimes(1)
      expect(output.findings).toEqual([])
      expect(output.metadata).toMatchObject({ abstentionFallback: 'direct' })
    } finally {
      await closeServer(provider)
    }
  })

  it('does not invoke the fallback when the engine itself fails', async () => {
    const traceId = 'trace-1'
    const spans = [span(traceId, 'step-2', 'runCommand("deploy --config broken")')]
    const fallbackFetch = vi.fn() as typeof fetch

    const runner = createPublicBenchmarkRlmRunner('codetracebench', {
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'provider-secret',
      model: 'glm-5.2',
      maxOutputTokens: 64,
      timeoutMs: 5_000,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      dspyRlm: { runner: { command: process.execPath, args: ['-e', FAILING_CHILD_SCRIPT, '--'] } },
      fetchImpl: fallbackFetch,
    })
    const output = await runner.analyze(
      { traceStore: singleTraceStore(traceId, spans) },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(output.error).toBeDefined()
    expect(output.error?.message).toContain('exited 1')
    expect(fallbackFetch).not.toHaveBeenCalled()
    expect(output.metadata?.abstentionFallback).toBeUndefined()
    expect(output.findings).toEqual([])
  })

  it('retains block metadata parsed from the subject on rawFindings of a failed case', async () => {
    const { provider, baseUrl } = await startFakeProvider()
    const traceId = 'trace-1'
    const spans = [span(traceId, 'step-2', 'runCommand("deploy --config broken")')]
    const fallbackFetch = vi.fn() as typeof fetch
    const bridgeFindings = JSON.stringify([
      {
        severity: 'info',
        claim: 'The trajectory is clean.',
        subject: 'clean',
        confidence: 0.9,
        evidence: [{ uri: `trace://${traceId}/span/step-2` }],
      },
      {
        severity: 'high',
        claim: 'Steps 10 through 12 corrupted the build.',
        subject: 'incorrect-steps-10-12-unescaped-consequence-12',
        confidence: 0.9,
        evidence: [{ uri: `trace://${traceId}/span/step-2` }],
      },
    ])

    try {
      const runner = createPublicBenchmarkRlmRunner('codetracebench', {
        baseUrl,
        apiKey: 'provider-secret',
        model: 'glm-5.2',
        maxOutputTokens: 64,
        timeoutMs: 5_000,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        dspyRlm: {
          runner: { command: process.execPath, args: ['-e', childScript(bridgeFindings), '--'] },
        },
        fetchImpl: fallbackFetch,
      })
      const output = await runner.analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

      expect(output.error?.message).toContain('mixed a clean verdict')
      expect(fallbackFetch).not.toHaveBeenCalled()
      const rawFindings = output.metadata?.rawFindings as Array<{
        subject?: string
        metadata?: Record<string, unknown>
      }>
      expect(rawFindings).toHaveLength(2)
      expect(rawFindings[1]).toMatchObject({
        subject: 'incorrect-steps-10-12-unescaped-consequence-12',
        metadata: expect.objectContaining({
          block_first_step: 10,
          block_last_step: 12,
          block_consequence_step: 12,
          escape_status: 'unescaped',
        }),
      })
      expect(rawFindings[0]?.metadata?.block_first_step).toBeUndefined()
    } finally {
      await closeServer(provider)
    }
  })
})

async function startFakeProvider(): Promise<{ provider: Server; baseUrl: string }> {
  const provider = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'investigate' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', () => {
      provider.off('error', reject)
      resolve()
    })
  })
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('provider did not bind')
  return { provider, baseUrl: `http://127.0.0.1:${address.port}/v1` }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function directModelResponse(value: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: 'glm-5.2',
      choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function span(traceId: string, spanId: string, content: string): TraceAnalystSpan {
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
  }
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
