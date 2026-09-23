import { describe, expect, it } from 'vitest'
import type { PrimeBridgeTransportRequest } from '../analyst/prime-bridge-transport'
import {
  diagnoseSpans,
  epochMillis,
  holdsSecret,
  ingestSpans,
  redactSecrets,
  validateDiagnosisFindings,
} from './index'

// Built at runtime so no literal credential shape sits in the source tree.
const OPENAI = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('-')
const GITHUB = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`
const SLACK = ['xoxb', '123456789012', 'abcdefABCDEF'].join('-')
const AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`
const JWT = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
].join('.')

const NS = (iso: string, plusMs = 0) => `${BigInt(Date.parse(iso) + plusMs) * 1_000_000n}`

function span(over: Record<string, unknown>): Record<string, unknown> {
  return {
    trace_id: 't1',
    span_id: 's1',
    parent_span_id: null,
    name: 'step',
    start_time: NS('2026-09-22T10:00:00Z'),
    end_time: NS('2026-09-22T10:00:01Z'),
    status_code: 'STATUS_CODE_OK',
    attributes: {},
    ...over,
  }
}

/** One run: a root agent span and six Bash calls, four failing, three identical in a row. */
function sampleRun(traceId = 't1', prefix = ''): Record<string, unknown>[] {
  const out = [
    span({
      trace_id: traceId,
      span_id: `${prefix}root`,
      name: 'session',
      status_code: 'STATUS_CODE_ERROR',
      status_message: 'agent gave up',
      attributes: { 'openinference.span.kind': 'AGENT' },
    }),
  ]
  for (let i = 0; i < 6; i += 1) {
    out.push(
      span({
        trace_id: traceId,
        span_id: `${prefix}tool${i}`,
        parent_span_id: `${prefix}root`,
        name: 'Bash',
        start_time: NS('2026-09-22T10:00:00Z', (i + 1) * 1000),
        end_time: NS('2026-09-22T10:00:00Z', (i + 1) * 1000 + 500),
        status_code: i < 4 ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK',
        status_message: i < 4 ? 'command not found' : undefined,
        attributes: {
          'openinference.span.kind': 'TOOL',
          'tool.name': 'Bash',
          input: i < 3 ? 'make test' : `echo ${i}`,
        },
      }),
    )
  }
  return out
}

describe('secret filter', () => {
  it('redacts the lines trace-archive holds_secret matches and keeps the key name', () => {
    const cases = [
      `GH_TOKEN=${'x1y2z3'.repeat(4)}`,
      `export TANGLE_ROUTER_KEY="${'Ab12'.repeat(6)}"`,
      `  api_key: ${'q9w8e7r6'.repeat(3)}  # prod`,
      `DB_PASSWORD='${'Pa55word'.repeat(3)}'`,
    ]
    expect(redactSecrets(`cd x && GH_TOKEN=${'x1y2z3'.repeat(4)} gh pr list`)).toContain(
      'GH_TOKEN=[REDACTED:inline-assignment] gh',
    )
    for (const line of cases) {
      expect(holdsSecret(line)).toBe(true)
      const out = redactSecrets(line)
      expect(out).toContain('[REDACTED:secret-assignment]')
      expect(out).toMatch(/TOKEN|KEY|key|PASSWORD/)
    }
  })

  it('passes what holds_secret passes: variable references, dotenvx ciphertext, short or digit-free values', () => {
    for (const line of [
      'GH_TOKEN=$GITHUB_TOKEN',
      'API_KEY="encrypted:BD3fQx9xZqg0aa1234567890"',
      'token: short1',
      'password: correcthorsebatterystaple',
    ]) {
      expect(redactSecrets(line)).toBe(line)
    }
  })

  it('removes token shapes wherever they appear, including inside JSON and prose', () => {
    const text = [
      `run with ${OPENAI} now`,
      `{"authToken":"${'k3y'.repeat(8)}","input_tokens":"123"}`,
      `clone https://drew:${'s3cret'.repeat(3)}@github.com/x/y`,
      `Authorization: Bearer ${'abc123XYZ'.repeat(3)}`,
      GITHUB,
      SLACK,
      AWS,
      JWT,
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    const report = { redactionCount: 0, byRule: {} as Record<string, number> }
    const out = redactSecrets(text, report)
    for (const secret of [
      OPENAI,
      GITHUB,
      SLACK,
      AWS,
      JWT,
      'k3yk3y',
      's3crets3cret',
      'abc123XYZabc',
      'b3BlbnNzaC1rZXk',
    ]) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('"input_tokens":"123"')
    expect(Object.keys(report.byRule).sort()).toEqual(
      [
        'aws-access-key',
        'bearer',
        'github-token',
        'json-secret',
        'jwt',
        'openai-key',
        'pem-block',
        'slack-token',
        'url-credentials',
      ].sort(),
    )
  })
})

describe('ingest', () => {
  it('reads OTLP nanoseconds, epoch milliseconds and ISO times', () => {
    const ms = Date.parse('2026-09-22T10:00:00Z')
    expect(epochMillis(NS('2026-09-22T10:00:00Z'))).toBe(ms)
    expect(epochMillis(String(ms))).toBe(ms)
    expect(epochMillis('2026-09-22T10:00:00Z')).toBe(ms)
    expect(epochMillis('')).toBeNull()
  })

  it('drops content attributes when content is not included, after taking the input digest', () => {
    const { spans, report } = ingestSpans(sampleRun(), { contentIncluded: false })
    const tool = spans.find((s) => s.spanId === 'tool0')!
    expect(tool.attributes.input).toBeUndefined()
    expect(tool.inputDigest).toMatch(/^[0-9a-f]{16}$/)
    expect(report.droppedAttributes).toContain('input')
  })

  it('keeps a span id shared by two runs but marks it ambiguous', () => {
    const { spans, report } = ingestSpans([...sampleRun('t1'), ...sampleRun('t2')], {
      contentIncluded: true,
    })
    expect(spans).toHaveLength(14)
    expect(report.ambiguousSpanIds).toContain('tool0')
  })
})

describe('diagnoseSpans, deterministic mode', () => {
  it('returns a valid document with observed findings, measures with denominators, and resolvable evidence', async () => {
    const result = await diagnoseSpans(
      sampleRun(),
      { subject: 'customer', label: 'Casework intake agent' },
      { mode: 'deterministic', reason: 'the customer declined third-party processing' },
    )
    const doc = result.document
    expect(
      validateDiagnosisFindings(doc, {
        spanIds: new Set(sampleRun().map((s) => s.span_id as string)),
      }),
    ).toEqual([])
    expect(doc.subject).toMatchObject({ runCount: 1, contentIncluded: false })
    expect(doc.findings.every((f) => f.confidence === 'observed')).toBe(true)
    const tool = doc.findings.find((f) => f.claim.includes('Bash'))!
    expect(tool.measure).toEqual({
      name: 'Bash tool failure rate',
      value: 66.7,
      unit: '%',
      denominator: '6 calls to Bash',
    })
    expect(tool.evidence).toEqual(['tool0', 'tool1', 'tool2', 'tool3'])
    expect(doc.findings.some((f) => f.claim.startsWith('1 of 1 runs ended with an error'))).toBe(
      true,
    )
    expect(doc.findings.some((f) => f.claim.includes('identical tool call'))).toBe(true)
    expect(doc.coverage.skipped).toContainEqual({
      analysis: 'model reading of the runs',
      reason: 'the customer declined third-party processing',
    })
    expect(doc.coverage.capabilities['token-accounting']).toMatchObject({ available: false })
    expect(doc.coverage.capabilities['token-accounting']!.reason).toMatch(/gen_ai\.usage/)
    expect(result.facts).toMatchObject({ runs: 1, spans: 7, errorSpans: 5, toolCalls: 6 })
    expect(result.model.used).toBe(false)
  })

  it('refuses a customer context that carries a topology', async () => {
    await expect(
      diagnoseSpans(
        [],
        { subject: 'customer', label: 'x', topology: { runs: [] } },
        { mode: 'deterministic' },
      ),
    ).rejects.toThrow(/internal only/)
  })
})

describe('diagnoseSpans, model mode', () => {
  function fakeTransport(reply: (prompt: string) => unknown) {
    const prompts: string[] = []
    const transport = async (request: PrimeBridgeTransportRequest) => {
      const prompt = request.body.messages[0]!.content
      prompts.push(prompt)
      return {
        status: 200,
        text: JSON.stringify({
          choices: [
            { message: { content: `\`\`\`json\n${JSON.stringify(reply(prompt))}\n\`\`\`` } },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 100, model_requests: 1 },
        }),
      }
    }
    return { transport, prompts }
  }

  const modelOptions = (transport: ReturnType<typeof fakeTransport>['transport']) => ({
    transport,
    url: 'prime-agent://tangle-router',
    model: 'deepseek/deepseek-v4.1-flash',
    pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  })

  it('keeps inferred findings with resolvable evidence and rejects the rest with a reason', async () => {
    const { transport, prompts } = fakeTransport(() => ({
      answer: 'The agent retried a missing command.',
      rows: [
        {
          kind: 'finding',
          severity: 'high',
          claim: 'The agent kept calling make without a Makefile.',
          consequence: 'Four wasted turns.',
          recommendation: 'Check for the Makefile first.',
          evidence: ['tool0', 'tool1'],
        },
        {
          kind: 'finding',
          severity: 'low',
          claim: 'Invented evidence.',
          consequence: 'None.',
          evidence: ['nope'],
        },
        {
          kind: 'operator',
          claim: 'Operator critique must not reach a customer.',
          evidence: ['root'],
        },
        { kind: 'question', question: 'Is make installed in the sandbox image?' },
      ],
    }))
    const planted = sampleRun()
    ;(planted[1]!.attributes as Record<string, unknown>).input =
      `curl -H "Authorization: Bearer ${'zz9'.repeat(8)}" ${OPENAI}`
    const result = await diagnoseSpans(
      planted,
      {
        subject: 'customer',
        label: 'Casework',
        contentIncluded: true,
        focus: `why does it fail? key ${OPENAI}`,
      },
      { mode: 'model', model: modelOptions(transport) },
    )

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain(OPENAI)
    expect(prompts[0]).not.toContain('zz9zz9')
    expect(prompts[0]).toContain('[REDACTED:openai-key]')
    expect(prompts[0]).not.toContain('withheld at the owner')
    const inferred = result.document.findings.filter((f) => f.confidence === 'inferred')
    expect(inferred).toHaveLength(1)
    expect(inferred[0]!.evidence).toEqual(['tool0', 'tool1'])
    expect(result.rejected.map((r) => r.reason).join('\n')).toMatch(/nope/)
    expect(result.rejected.map((r) => r.reason).join('\n')).toMatch(/kind operator is not allowed/)
    expect(result.notes).toEqual([])
    expect(result.questions).toEqual([
      { question: 'Is make installed in the sandbox image?', traceId: 't1' },
    ])
    expect(result.model.usage).toEqual({
      exchanges: 1,
      inputTokens: 1000,
      outputTokens: 100,
      usd: 0.0012,
    })
    expect(validateDiagnosisFindings(result.document)).toEqual([])
  })

  it('reads operator critique and a redacted topology for internal runs', async () => {
    const { transport, prompts } = fakeTransport((prompt) =>
      prompt.includes('RUN GRAPH')
        ? {
            answer: 'One operator fanned out to two workers.',
            rows: [
              {
                kind: 'topology',
                claim: 'The workers never messaged each other.',
                evidence: ['run_a', 'run_ghost'],
              },
            ],
          }
        : {
            answer: 'ok',
            rows: [
              {
                kind: 'operator',
                claim: 'The operator asked for tests without naming the target.',
                evidence: ['root'],
                project: 'agent-eval',
              },
            ],
          },
    )
    const result = await diagnoseSpans(
      sampleRun(),
      {
        subject: 'internal',
        label: 'daily',
        contentIncluded: true,
        topology: {
          runs: [{ id: 'run_a', cwd: `/tmp token=${'Q1w2E3r4'.repeat(3)}` }, { id: 'run_b' }],
          edges: [],
        },
      },
      { mode: 'model', model: modelOptions(transport) },
    )
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toContain('Q1w2E3r4Q1w2')
    expect(result.notes.map((n) => n.kind)).toEqual(['operator', 'topology', 'topology'])
    expect(result.notes.find((n) => n.text.startsWith('The workers'))!.evidence).toEqual(['run_a'])
  })

  it('reads a long run as whole segments and records the segments it did not read', async () => {
    const { transport, prompts } = fakeTransport(() => ({ answer: 'ok', rows: [] }))
    const result = await diagnoseSpans(
      sampleRun(),
      { subject: 'customer', label: 'x', contentIncluded: true },
      {
        mode: 'model',
        model: { ...modelOptions(transport), maxInlineChars: 450, maxSegmentsPerRun: 2 },
      },
    )
    const segments = result.model.runs.map((run) => run.delivery?.segments)
    expect(prompts).toHaveLength(2)
    expect(segments[0]).toBeGreaterThan(2)
    expect(
      result.document.coverage.skipped.some(
        (s) => s.analysis === 'model reading of part of run t1',
      ),
    ).toBe(true)
  })

  it('records a transport failure as a skipped analysis instead of throwing', async () => {
    const transport = async () => ({ status: 503, text: 'provider_pricing_unavailable' })
    const result = await diagnoseSpans(
      sampleRun(),
      { subject: 'customer', label: 'x' },
      { mode: 'model', model: modelOptions(transport) },
    )
    expect(result.document.coverage.skipped.some((s) => s.reason.includes('503'))).toBe(true)
    expect(result.document.findings.every((f) => f.confidence === 'observed')).toBe(true)
  })
})
