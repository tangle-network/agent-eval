import { mkdtemp } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// Emits one findings array per invocation, in order, so each sequential
// consensus sample sees a different draw. The counter survives on disk
// because every engine call runs a fresh child process.
const SEQUENCE_CHILD_SCRIPT = `
const fs = require('node:fs')
const inputPath = process.argv[process.argv.indexOf('--input') + 1]
const outputPath = process.argv[process.argv.indexOf('--output') + 1]
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const counterPath = __COUNTER_PATH__
const samples = __SAMPLES__
async function main() {
  let index = 0
  try { index = Number(fs.readFileSync(counterPath, 'utf8')) } catch {}
  fs.writeFileSync(counterPath, String(index + 1))
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
    answer: 'Sample ' + index + ' answer.',
    findings: samples[Math.min(index, samples.length - 1)],
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

async function sequenceChildScript(findingsPerSample: unknown[][]): Promise<string> {
  const counterPath = join(await mkdtemp(join(tmpdir(), 'rlm-consensus-')), 'counter')
  return SEQUENCE_CHILD_SCRIPT.replace('__COUNTER_PATH__', JSON.stringify(counterPath)).replace(
    '__SAMPLES__',
    JSON.stringify(findingsPerSample),
  )
}

function blockFinding(options: {
  first: number
  last: number
  consequence: number
  escape?: 'escaped' | 'unescaped'
  severity?: string
  claim: string
  confidence: number
  citeStep: number
  excerpt: string
}): Record<string, unknown> {
  return {
    severity: options.severity ?? 'high',
    claim: options.claim,
    subject: `incorrect-steps-${options.first}-${options.last}-${options.escape ?? 'unescaped'}-consequence-${options.consequence}`,
    confidence: options.confidence,
    evidence: [{ uri: `trace://trace-1/span/step-${options.citeStep}`, excerpt: options.excerpt }],
  }
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

  it('emits the step-level majority across three samples with donor metadata and merged usage', async () => {
    const { provider, baseUrl } = await startFakeProvider()
    const traceId = 'trace-1'
    const spans = [
      span(traceId, 'step-2', 'writeFile("broken configuration file")'),
      span(traceId, 'step-3', 'runCommand("deploy --config broken")'),
      span(traceId, 'step-5', 'runCommand("cleanup")'),
    ]
    const fallbackFetch = vi.fn() as typeof fetch
    const script = await sequenceChildScript([
      [
        blockFinding({
          first: 2,
          last: 3,
          consequence: 3,
          claim: 'Steps two and three broke the deploy.',
          confidence: 0.6,
          citeStep: 2,
          excerpt: 'writeFile("broken configuration file")',
        }),
      ],
      [
        blockFinding({
          first: 2,
          last: 2,
          consequence: 2,
          escape: 'escaped',
          severity: 'medium',
          claim: 'Step two wrote the wrong file.',
          confidence: 0.9,
          citeStep: 2,
          excerpt: 'writeFile("broken configuration file")',
        }),
      ],
      [
        blockFinding({
          first: 5,
          last: 5,
          consequence: 5,
          severity: 'low',
          claim: 'Step five is wrong.',
          confidence: 0.8,
          citeStep: 5,
          excerpt: 'runCommand("cleanup")',
        }),
      ],
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
          samples: 3,
          runner: { command: process.execPath, args: ['-e', script, '--'] },
        },
        fetchImpl: fallbackFetch,
      })
      const output = await runner.analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

      expect(output.error).toBeUndefined()
      expect(fallbackFetch).not.toHaveBeenCalled()
      // Step 2 has two of three votes; steps 3 and 5 have one each.
      expect(output.findings).toHaveLength(1)
      expect(output.findings[0]).toMatchObject({
        analyst_id: 'dspy-rlm',
        subject: 'incorrect-step-2',
        claim: 'Step 2 is incorrect. Step two wrote the wrong file.',
        severity: 'medium',
        metadata: expect.objectContaining({
          block_first_step: 2,
          block_last_step: 2,
          block_consequence_step: 2,
          escape_status: 'escaped',
          consensus_samples: 3,
          consensus_contributors: 2,
          consensus_donor_sample: 1,
        }),
      })
      expect(output.findings[0]!.confidence).toBeCloseTo(0.75, 10)
      expect(output.metadata).toMatchObject({
        analysisMode: 'recursive',
        engine: 'dspy-rlm',
        samples: 3,
        modelCalls: 3,
      })
      expect(output.metadata?.abstentionFallback).toBeUndefined()
      const sampleRuns = output.metadata?.sampleRuns as Array<Record<string, unknown>>
      expect(sampleRuns).toHaveLength(3)
      expect(sampleRuns[0]).toMatchObject({
        sample: 0,
        answer: 'Sample 0 answer.',
        steps: [2, 3],
        blocks: [expect.objectContaining({ firstStep: 2, lastStep: 3, acceptedSteps: [2, 3] })],
        usage: expect.objectContaining({ calls: 1, tokens: { input: 3, output: 2 } }),
      })
      expect(sampleRuns[2]).toMatchObject({ sample: 2, steps: [5] })
      expect(output.metadata?.consensus).toMatchObject({
        samples: 3,
        threshold: 2,
        stepVotes: [
          { step: 2, votes: 2, kept: true },
          { step: 3, votes: 1, kept: false },
          { step: 5, votes: 1, kept: false },
        ],
        blocks: [
          expect.objectContaining({
            firstStep: 2,
            lastStep: 2,
            donor: expect.objectContaining({ sample: 1, overlapSteps: 1 }),
          }),
        ],
      })
      // All three samples' provider calls settle on the one case.
      expect(output.usage).toMatchObject({
        calls: 3,
        tokens: { input: 9, output: 6 },
      })
    } finally {
      await closeServer(provider)
    }
  })

  it('falls back to one direct call when voting leaves no majority step', async () => {
    const { provider, baseUrl } = await startFakeProvider()
    const traceId = 'trace-1'
    const spans = [
      span(traceId, 'step-2', 'writeFile("broken configuration file")'),
      span(traceId, 'step-3', 'runCommand("deploy --config broken")'),
      span(traceId, 'step-5', 'runCommand("cleanup")'),
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
    const script = await sequenceChildScript([
      [
        blockFinding({
          first: 2,
          last: 2,
          consequence: 2,
          claim: 'A.',
          confidence: 0.9,
          citeStep: 2,
          excerpt: 'writeFile("broken configuration file")',
        }),
      ],
      [
        blockFinding({
          first: 3,
          last: 3,
          consequence: 3,
          claim: 'B.',
          confidence: 0.9,
          citeStep: 3,
          excerpt: 'runCommand("deploy --config broken")',
        }),
      ],
      [
        blockFinding({
          first: 5,
          last: 5,
          consequence: 5,
          claim: 'C.',
          confidence: 0.9,
          citeStep: 5,
          excerpt: 'runCommand("cleanup")',
        }),
      ],
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
          samples: 3,
          runner: { command: process.execPath, args: ['-e', script, '--'] },
        },
        fetchImpl: fallbackFetch,
      })
      const output = await runner.analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

      expect(output.error).toBeUndefined()
      // Every sample found something, yet nothing reached ceil(3/2) votes:
      // the fallback is a post-consensus decision, not a per-sample one.
      expect(fallbackFetch).toHaveBeenCalledTimes(1)
      expect(output.metadata).toMatchObject({
        samples: 3,
        abstentionFallback: 'direct',
        abstentionFallbackMetadata: expect.objectContaining({
          analysisMode: 'direct-baseline',
        }),
      })
      expect(output.findings).toHaveLength(1)
      expect(output.findings[0]).toMatchObject({
        analyst_id: 'direct',
        subject: 'incorrect-step-2',
      })
      // Three engine calls plus the single fallback call on the same case.
      expect(output.usage).toMatchObject({
        calls: 4,
        tokens: { input: 109, output: 56 },
      })
    } finally {
      await closeServer(provider)
    }
  })

  it('applies the abstention fallback once after consensus when every sample abstains', async () => {
    const { provider, baseUrl } = await startFakeProvider()
    const traceId = 'trace-1'
    const spans = [span(traceId, 'step-2', 'runCommand("verify everything works")')]
    const fallbackFetch = vi.fn(async () =>
      directModelResponse({ report: 'No incorrect steps were found.', findings: [] }),
    ) as typeof fetch
    const script = await sequenceChildScript([[], [], []])

    try {
      const runner = createPublicBenchmarkRlmRunner('codetracebench', {
        baseUrl,
        apiKey: 'provider-secret',
        model: 'glm-5.2',
        maxOutputTokens: 64,
        timeoutMs: 5_000,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        dspyRlm: {
          samples: 3,
          runner: { command: process.execPath, args: ['-e', script, '--'] },
        },
        fetchImpl: fallbackFetch,
      })
      const output = await runner.analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

      expect(output.error).toBeUndefined()
      expect(fallbackFetch).toHaveBeenCalledTimes(1)
      expect(output.findings).toEqual([])
      expect(output.metadata).toMatchObject({ samples: 3, abstentionFallback: 'direct' })
      const consensus = output.metadata?.consensus as { stepVotes: unknown[] }
      expect(consensus.stepVotes).toEqual([])
    } finally {
      await closeServer(provider)
    }
  })

  it('behaves exactly like the single-sample runner when samples is 1', async () => {
    const { provider, baseUrl } = await startFakeProvider()
    const traceId = 'trace-1'
    const spans = [
      span(traceId, 'step-2', 'writeFile("broken configuration file")'),
      span(traceId, 'step-3', 'runCommand("deploy --config broken")'),
    ]
    const fallbackFetch = vi.fn() as typeof fetch
    const bridgeFindings = JSON.stringify([
      blockFinding({
        first: 2,
        last: 2,
        consequence: 3,
        claim: 'Step two wrote the wrong file.',
        confidence: 0.9,
        citeStep: 2,
        excerpt: 'writeFile("broken configuration file")',
      }),
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
          samples: 1,
          runner: { command: process.execPath, args: ['-e', childScript(bridgeFindings), '--'] },
        },
        fetchImpl: fallbackFetch,
      })
      const output = await runner.analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

      expect(output.error).toBeUndefined()
      expect(fallbackFetch).not.toHaveBeenCalled()
      expect(output.findings).toHaveLength(1)
      expect(output.findings[0]).toMatchObject({ subject: 'incorrect-step-2' })
      // The single-sample path carries no consensus fields at all.
      expect(output.metadata?.samples).toBeUndefined()
      expect(output.metadata?.sampleRuns).toBeUndefined()
      expect(output.metadata?.consensus).toBeUndefined()
      expect(output.metadata?.answer).toBeDefined()
      expect(output.usage).toMatchObject({ calls: 1, tokens: { input: 3, output: 2 } })
    } finally {
      await closeServer(provider)
    }
  })

  it('refuses consensus sampling outside CodeTraceBench', () => {
    expect(() =>
      createPublicBenchmarkRlmRunner('agentrx', {
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'provider-secret',
        model: 'glm-5.2',
        maxOutputTokens: 64,
        timeoutMs: 5_000,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        dspyRlm: { samples: 2 },
      }),
    ).toThrow(/requires the codetracebench dataset/)
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
