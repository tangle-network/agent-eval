import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CostCallConflictError, CostLedger, type CostLedgerPersistence } from '../cost-ledger'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import {
  createPublicBenchmarkDirectRunner,
  MAX_INCORRECT_BLOCK_STEPS,
  MAX_INCORRECT_BLOCKS,
  type PublicAnalystBenchmarkModelConfig,
  publicBenchmarkProtocolSha256,
} from './benchmark-real-model'
import { publicBenchmarkCallId } from './benchmark-response-cache'
import { testModelExecutionOwner } from './model-execution.test-support'
import { buildTraceToolsForGroup } from './tool-groups'

function directConfig(
  fetchImpl: typeof fetch,
  overrides: Partial<PublicAnalystBenchmarkModelConfig> = {},
): PublicAnalystBenchmarkModelConfig {
  return {
    ...testModelExecutionOwner({ fetchImpl }),
    model: 'glm-5.2',
    maxOutputTokens: 1_024,
    timeoutMs: 30_000,
    ...overrides,
  }
}

describe('createPublicBenchmarkDirectRunner', () => {
  it('makes one bounded structured call and expands a failure block into per-step findings', async () => {
    const traceId = 'trace-1'
    const actions = new Map([
      [2, 'writeFile("broken configuration")'],
      [3, 'runCommand("deploy --config broken")'],
      [4, 'writeFile("workaround for the broken deploy")'],
      [5, 'runCommand("verify --config")'],
    ])
    const spans = [...actions].map(([step, action]) => span(traceId, `step-${step}`, action))
    const requestedCaps: number[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        model: 'glm-5.2',
        max_tokens: 1_024,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      })
      const prompt = (body.messages as Array<{ content: string }>)
        .map((message) => message.content)
        .join('\n')
      expect(prompt).toContain('"first_step": a positive integer')
      expect(prompt).toContain('"consequence_step"')
      expect(prompt).toContain('"escape_status"')
      expect(prompt).toContain('constructs exact trace URIs and action previews')
      expect(prompt).not.toContain('"uri"')
      expect(prompt).not.toContain('"excerpt"')
      return modelResponse({
        report: 'Steps 2 through 4 wrote and compounded the configuration that caused the failure.',
        findings: [
          {
            first_step: 2,
            last_step: 4,
            consequence_step: 5,
            escape_status: 'unescaped',
            severity: 'high',
            claim: 'The block wrote and deployed an invalid configuration.',
            confidence: 0.95,
          },
        ],
      })
    }) as typeof fetch
    const runner = createPublicBenchmarkDirectRunner('codetracebench', directConfig(fetchImpl))

    const output = await runner.analyze(
      {
        traceStore: singleTraceStore(traceId, spans, {
          fitAtCap: 1_024,
          onView: (cap) => requestedCaps.push(cap),
        }),
      },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(requestedCaps).toEqual([4_096, 2_048, 1_024])
    expect(output.error).toBeUndefined()
    expect(output.findings).toHaveLength(3)
    for (const [index, step] of [2, 3, 4].entries()) {
      expect(output.findings[index]).toMatchObject({
        analyst_id: 'direct',
        subject: `incorrect-step-${step}`,
        claim: `Step ${step} is incorrect. The block wrote and deployed an invalid configuration.`,
        evidence_refs: [
          {
            uri: `trace://trace-1/span/step-${step}`,
            excerpt: actions.get(step),
          },
        ],
        metadata: {
          block_first_step: 2,
          block_last_step: 4,
          block_consequence_step: 5,
          escape_status: 'unescaped',
        },
      })
    }
    expect(output.usage).toMatchObject({
      calls: 1,
      tokens: { input: 100, output: 50 },
    })
    expect(output.metadata).toMatchObject({
      analysisMode: 'direct-baseline',
      providerModel: 'glm-5.2',
      outputAdapter: 'codetracebench-incorrect-block',
    })
  })

  it('keeps usable blocks when one block is malformed and reports the rejection', async () => {
    const traceId = 'trace-1'
    const spans = [2, 3, 4].map((step) => span(traceId, `step-${step}`, `runCommand("${step}")`))
    const output = await createPublicBenchmarkDirectRunner(
      'codetracebench',
      directConfig(
        vi.fn(async () =>
          modelResponse({
            report: 'One usable block and one malformed block.',
            findings: [
              { first_step: 3, last_step: 2, escape_status: 'unescaped' },
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
        ) as typeof fetch,
      ),
    ).analyze(
      { traceStore: singleTraceStore(traceId, spans) },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(output.error).toBeUndefined()
    expect(output.findings.map((finding) => finding.subject)).toEqual(['incorrect-step-2'])
    const diagnostics = (output.metadata as { blockDiagnostics?: { rejectedBlocks?: string[] } })
      .blockDiagnostics
    expect(diagnostics?.rejectedBlocks).toHaveLength(1)
    expect(diagnostics?.rejectedBlocks?.[0]).toContain('block 0')
  })

  it('fails the case when every reported block is malformed', async () => {
    const traceId = 'trace-1'
    const output = await createPublicBenchmarkDirectRunner(
      'codetracebench',
      directConfig(
        vi.fn(async () =>
          modelResponse({
            report: 'Every block is malformed.',
            findings: [{ first_step: 3, last_step: 2, escape_status: 'unescaped' }],
          }),
        ) as typeof fetch,
      ),
    ).analyze(
      { traceStore: singleTraceStore(traceId, [span(traceId, 'step-2', 'runCommand("2")')]) },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(output.findings).toEqual([])
    expect(output.error?.message).toContain('every reported failure block was malformed')
  })

  it('emits one finding for a singleton block', async () => {
    const traceId = 'trace-1'
    const action = 'writeFile("broken configuration")'
    const fetchImpl = vi.fn(async () =>
      modelResponse({
        report: 'Step 2 wrote the configuration that caused the final failure.',
        findings: [
          {
            first_step: 2,
            last_step: 2,
            consequence_step: 3,
            escape_status: 'unescaped',
            severity: 'high',
            claim: 'Step 2 wrote an invalid configuration.',
            confidence: 0.95,
          },
        ],
      }),
    ) as typeof fetch
    const runner = createPublicBenchmarkDirectRunner('codetracebench', directConfig(fetchImpl))

    const output = await runner.analyze(
      {
        traceStore: singleTraceStore(traceId, [
          span(traceId, 'step-2', action),
          span(traceId, 'step-3', 'runCommand("deploy")'),
        ]),
      },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(output.error).toBeUndefined()
    expect(output.findings).toHaveLength(1)
    expect(output.findings[0]).toMatchObject({
      analyst_id: 'direct',
      subject: 'incorrect-step-2',
      claim: 'Step 2 is incorrect. Step 2 wrote an invalid configuration.',
      evidence_refs: [
        {
          uri: 'trace://trace-1/span/step-2',
          excerpt: action,
        },
      ],
      metadata: {
        block_first_step: 2,
        block_last_step: 2,
        block_consequence_step: 3,
        escape_status: 'unescaped',
      },
    })
  })

  it('scores an escaped block exactly like an unescaped one and records the decision', async () => {
    const traceId = 'trace-1'
    const spans = [1, 2, 3, 4, 5].map((step) =>
      span(traceId, `step-${step}`, `runCommand("attempt ${step}")`),
    )
    const escapedBlock = {
      first_step: 1,
      last_step: 2,
      consequence_step: 3,
      escape_status: 'escaped',
      severity: 'medium',
      claim: 'The failed install was rerun successfully and left no trace in the final state.',
      confidence: 0.8,
    }
    const run = async (findings: unknown[]) =>
      createPublicBenchmarkDirectRunner(
        'codetracebench',
        directConfig(
          vi.fn(async () =>
            modelResponse({ report: 'Escape decisions per block.', findings }),
          ) as typeof fetch,
        ),
      ).analyze(
        { traceStore: singleTraceStore(traceId, spans) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

    const mixed = await run([
      escapedBlock,
      {
        first_step: 4,
        last_step: 4,
        consequence_step: 5,
        escape_status: 'unescaped',
        severity: 'high',
        claim: 'The regression persisted into the final state.',
        confidence: 0.9,
      },
    ])
    expect(mixed.error).toBeUndefined()
    expect(mixed.findings.map((finding) => finding.subject)).toEqual([
      'incorrect-step-1',
      'incorrect-step-2',
      'incorrect-step-4',
    ])
    expect(mixed.findings[0]?.metadata).toMatchObject({ escape_status: 'escaped' })
    expect(mixed.findings[2]?.metadata).toMatchObject({ escape_status: 'unescaped' })
    expect(mixed.metadata).toMatchObject({
      blockDiagnostics: { reportedBlocks: 2, escapedBlocks: 1 },
    })

    const allEscaped = await run([escapedBlock])
    expect(allEscaped.error).toBeUndefined()
    expect(allEscaped.findings.map((finding) => finding.subject)).toEqual([
      'incorrect-step-1',
      'incorrect-step-2',
    ])
    expect(allEscaped.metadata).toMatchObject({
      blockDiagnostics: { reportedBlocks: 1, escapedBlocks: 1 },
    })
  })

  it('drops a block whose consequence step is not a real assistant step', async () => {
    const traceId = 'trace-1'
    const output = await createPublicBenchmarkDirectRunner(
      'codetracebench',
      directConfig(
        vi.fn(async () =>
          modelResponse({
            report: 'One block has downstream evidence and one does not.',
            findings: [
              {
                first_step: 1,
                last_step: 1,
                consequence_step: 99,
                escape_status: 'unescaped',
                severity: 'high',
                claim: 'An accusation with no downstream evidence.',
                confidence: 0.9,
              },
              {
                first_step: 2,
                last_step: 2,
                consequence_step: 3,
                escape_status: 'unescaped',
                severity: 'high',
                claim: 'An accusation whose damage shows at step 3.',
                confidence: 0.9,
              },
            ],
          }),
        ) as typeof fetch,
      ),
    ).analyze(
      {
        traceStore: singleTraceStore(
          traceId,
          [1, 2, 3].map((step) => span(traceId, `step-${step}`, `runCommand("attempt ${step}")`)),
        ),
      },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(output.error).toBeUndefined()
    expect(output.findings.map((finding) => finding.subject)).toEqual(['incorrect-step-2'])
    expect(output.metadata).toMatchObject({
      blockDiagnostics: {
        reportedBlocks: 2,
        blocksWithoutConsequenceEvidence: [expect.objectContaining({ consequenceStep: 99 })],
      },
    })
  })

  it('rejects malformed failure blocks with a loud schema error', async () => {
    const traceId = 'trace-1'
    const run = async (findings: unknown[]) =>
      createPublicBenchmarkDirectRunner(
        'codetracebench',
        directConfig(
          vi.fn(async () =>
            modelResponse({ report: 'Malformed block shapes.', findings }),
          ) as typeof fetch,
        ),
      ).analyze(
        { traceStore: singleTraceStore(traceId, [span(traceId, 'step-2', 'runCommand("x")')]) },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )
    const validBlock = (firstStep: number, lastStep: number) => ({
      first_step: firstStep,
      last_step: lastStep,
      consequence_step: lastStep + 1,
      escape_status: 'unescaped',
      severity: 'high',
      claim: 'Block claim.',
      confidence: 0.9,
    })
    const rejected: unknown[][] = [
      [validBlock(3, 2)],
      [validBlock(1, MAX_INCORRECT_BLOCK_STEPS + 1)],
      [{ ...validBlock(3, 4), consequence_step: 2 }],
      [{ ...validBlock(2, 2), consequence_step: undefined }],
      [
        {
          first_step: 2,
          last_step: 2,
          consequence_step: 3,
          severity: 'high',
          claim: 'Missing escape status.',
          confidence: 0.9,
        },
      ],
      [{ ...validBlock(2, 2), escape_status: 'recovered' }],
      [{ step: 2, severity: 'high', claim: 'Legacy shape.', confidence: 0.9 }],
      Array.from({ length: MAX_INCORRECT_BLOCKS + 1 }, (_, index) =>
        validBlock(index + 1, index + 1),
      ),
      [validBlock(1.5 as number, 2)],
      [validBlock(0, 2)],
      [validBlock(-1, 2)],
    ]

    for (const findings of rejected) {
      const output = await run(findings)
      expect(output.findings).toEqual([])
      // Envelope violations (too many blocks) are caught by the response schema;
      // a response whose every block is malformed is rejected block-by-block.
      // Both are loud and produce no findings, which is the guarantee that matters.
      expect(['ValidationError', 'ModelOutputValidationError']).toContain(output.error?.class)
    }
  })

  it('drops an interior hole the runner derived but fails on a boundary the model named', async () => {
    const traceId = 'trace-1'
    const run = async (firstStep: number, lastStep: number) =>
      createPublicBenchmarkDirectRunner(
        'codetracebench',
        directConfig(
          vi.fn(async () =>
            modelResponse({
              report: 'A block spanning a hole in the trajectory.',
              findings: [
                {
                  first_step: firstStep,
                  last_step: lastStep,
                  consequence_step: 5,
                  escape_status: 'unescaped',
                  severity: 'high',
                  claim: 'The block covers a hole in the trajectory.',
                  confidence: 0.9,
                },
              ],
            }),
          ) as typeof fetch,
        ),
      ).analyze(
        {
          traceStore: singleTraceStore(traceId, [
            span(traceId, 'step-1', 'runCommand("a")'),
            span(traceId, 'step-3', 'runCommand("b")'),
            span(traceId, 'step-5', 'runCommand("c")'),
          ]),
        },
        { caseId: `codetrace:${traceId}`, repetition: 0 },
      )

    const interiorHole = await run(1, 3)
    expect(interiorHole.error).toBeUndefined()
    expect(interiorHole.findings.map((finding) => finding.subject)).toEqual([
      'incorrect-step-1',
      'incorrect-step-3',
    ])
    expect(interiorHole.metadata).toMatchObject({
      blockDiagnostics: { unresolvedBlockInteriorSteps: [2] },
    })

    const missingBoundary = await run(2, 3)
    expect(missingBoundary.findings).toEqual([])
    expect(missingBoundary.error).toMatchObject({
      class: 'BenchmarkEvidenceError',
      message: expect.stringContaining('unavailable assistant steps'),
    })
  })

  it('gives a contested step to the first block and records the overlap', async () => {
    const traceId = 'trace-1'
    const spans = [2, 3, 4, 5, 6].map((step) =>
      span(traceId, `step-${step}`, `runCommand("attempt ${step}")`),
    )
    const output = await createPublicBenchmarkDirectRunner(
      'codetracebench',
      directConfig(
        vi.fn(async () =>
          modelResponse({
            report: 'Two overlapping blocks.',
            findings: [
              {
                first_step: 2,
                last_step: 4,
                consequence_step: 6,
                escape_status: 'unescaped',
                severity: 'high',
                claim: 'First block.',
                confidence: 0.9,
              },
              {
                first_step: 3,
                last_step: 5,
                consequence_step: 6,
                escape_status: 'unescaped',
                severity: 'low',
                claim: 'Second block.',
                confidence: 0.5,
              },
            ],
          }),
        ) as typeof fetch,
      ),
    ).analyze(
      { traceStore: singleTraceStore(traceId, spans) },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(output.error).toBeUndefined()
    expect(output.findings.map((finding) => finding.subject)).toEqual([
      'incorrect-step-2',
      'incorrect-step-3',
      'incorrect-step-4',
      'incorrect-step-5',
    ])
    for (const index of [0, 1, 2]) {
      expect(output.findings[index]).toMatchObject({
        claim: expect.stringContaining('First block.'),
        severity: 'high',
        metadata: { block_first_step: 2, block_last_step: 4 },
      })
    }
    expect(output.findings[3]).toMatchObject({
      claim: expect.stringContaining('Second block.'),
      severity: 'low',
      metadata: { block_first_step: 3, block_last_step: 5 },
    })
    expect(output.metadata).toMatchObject({
      blockDiagnostics: { overlappingBlockSteps: [3, 4] },
    })
  })

  it('bounds one case at the product of the block caps', () => {
    expect(MAX_INCORRECT_BLOCK_STEPS).toBe(12)
    expect(MAX_INCORRECT_BLOCKS).toBe(16)
    expect(MAX_INCORRECT_BLOCKS * MAX_INCORRECT_BLOCK_STEPS).toBe(192)
  })

  it('maps AgentRx category and step output onto exact trace evidence', async () => {
    const traceId = 'agentrx-trace'
    const action = 'handoff({ result: "not checked" })'
    const fetchImpl = vi.fn(async () =>
      modelResponse({
        report: 'The handoff accepted an unchecked tool result.',
        findings: [
          {
            step: 4,
            category: 'misinterpretation-of-tool-output-handoff-failure',
            severity: 'high',
            claim: 'The assistant treated an unchecked tool result as valid.',
            confidence: 0.9,
          },
        ],
      }),
    ) as typeof fetch
    const runner = createPublicBenchmarkDirectRunner('agentrx', directConfig(fetchImpl))

    const output = await runner.analyze(
      { traceStore: singleTraceStore(traceId, [span(traceId, 'step-4', action)]) },
      { caseId: `agentrx:${traceId}`, repetition: 0 },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(output.error).toBeUndefined()
    expect(output.findings).toHaveLength(1)
    expect(output.findings[0]).toMatchObject({
      area: 'misinterpretation-of-tool-output-handoff-failure',
      subject: 'root-cause',
      evidence_refs: [
        {
          uri: 'trace://agentrx-trace/span/step-4',
          excerpt: action,
        },
      ],
    })
    expect(output.metadata).toMatchObject({
      outputAdapter: 'agentrx-taxonomy-and-root-step',
      providerModel: 'glm-5.2',
    })
  })

  it('records a stable paid-call identity and refuses duplication after settlement persistence fails', async () => {
    const traceId = 'trace-1'
    const durability = {
      runIdentitySha256: 'a'.repeat(64),
      responseCacheDir: mkdtempSync(join(tmpdir(), 'benchmark-model-cache-')),
    }
    const state = { events: '', revision: '0', rejectSettlement: true }
    const persistence: CostLedgerPersistence = {
      read: () => ({ revision: state.revision, events: state.events }),
      append(expectedRevision, event) {
        if (expectedRevision !== state.revision) return undefined
        const parsed = JSON.parse(event) as { record?: { status?: string } }
        if (state.rejectSettlement && parsed.record?.status === 'settled') return undefined
        state.events += event
        state.revision = String(Buffer.byteLength(state.events))
        return state.revision
      },
    }
    const ledger = new CostLedger({ persistence })
    const fetchImpl = vi.fn(async () =>
      modelResponse({
        report: 'Step 2 caused the failure.',
        findings: [
          {
            first_step: 2,
            last_step: 2,
            consequence_step: 3,
            escape_status: 'unescaped',
            severity: 'high',
            claim: 'Step 2 wrote the invalid configuration.',
            confidence: 0.9,
          },
        ],
      }),
    ) as typeof fetch
    const executionRecords: Array<{ callId?: string }> = []
    const config = directConfig(fetchImpl, {
      ...testModelExecutionOwner({
        fetchImpl,
        onExecution: (observation) => {
          executionRecords.push(structuredClone(observation))
        },
      }),
      costLedger: ledger,
      durability,
    })
    const input = {
      traceStore: singleTraceStore(traceId, [
        span(traceId, 'step-2', 'writeFile("invalid configuration")'),
        span(traceId, 'step-3', 'runCommand("deploy")'),
      ]),
    }
    const context = { caseId: `codetrace:${traceId}`, repetition: 0 }

    await expect(
      createPublicBenchmarkDirectRunner('codetracebench', config).analyze(input, context),
    ).rejects.toBeInstanceOf(CostCallConflictError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(ledger.listPending?.()).toHaveLength(1)
    const expectedCallId = publicBenchmarkCallId({
      runIdentitySha256: durability.runIdentitySha256,
      caseId: context.caseId,
      repetition: context.repetition,
    })
    expect(executionRecords).toEqual([expect.objectContaining({ callId: expectedCallId })])

    state.rejectSettlement = false
    await expect(
      createPublicBenchmarkDirectRunner('codetracebench', config).analyze(input, context),
    ).rejects.toBeInstanceOf(CostCallConflictError)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(ledger.listPending?.()).toHaveLength(1)
    expect(executionRecords).toHaveLength(1)
  })

  it('refuses to replay an interrupted provider request without a cached response', async () => {
    const traceId = 'trace-1'
    const durability = {
      runIdentitySha256: 'b'.repeat(64),
      responseCacheDir: mkdtempSync(join(tmpdir(), 'benchmark-model-cache-')),
    }
    const state = { events: '', revision: '0' }
    const persistence: CostLedgerPersistence = {
      read: () => ({ revision: state.revision, events: state.events }),
      append(expectedRevision, event) {
        if (expectedRevision !== state.revision) return undefined
        state.events += event
        state.revision = String(Buffer.byteLength(state.events))
        return state.revision
      },
    }
    const input = {
      traceStore: singleTraceStore(traceId, [
        span(traceId, 'step-2', 'writeFile("invalid configuration")'),
      ]),
    }
    const context = { caseId: `codetrace:${traceId}`, repetition: 0 }
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const providerCallIds: string[] = []
    const interruptedFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      providerCallIds.push(new Headers(init?.headers).get('Idempotency-Key') ?? '')
      markStarted()
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }) as typeof fetch
    const firstRunner = createPublicBenchmarkDirectRunner(
      'codetracebench',
      directConfig(interruptedFetch, {
        costLedger: new CostLedger({ persistence }),
        durability,
      }),
    )
    const interrupted = firstRunner.analyze(input, { ...context, signal: controller.signal })
    await started
    controller.abort()
    await expect(interrupted).rejects.toMatchObject({ name: 'AbortError' })

    const resumedFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerCallIds.push(new Headers(init?.headers).get('Idempotency-Key') ?? '')
      return modelResponse({
        report: 'No incorrect step is supported.',
        findings: [],
      })
    }) as typeof fetch
    await expect(
      createPublicBenchmarkDirectRunner('codetracebench', {
        ...directConfig(resumedFetch, {
          costLedger: new CostLedger({ persistence }),
          durability,
        }),
      }).analyze(input, context),
    ).rejects.toBeInstanceOf(CostCallConflictError)

    expect(resumedFetch).not.toHaveBeenCalled()
    expect(providerCallIds).toHaveLength(1)
    expect(providerCallIds[0]).toMatch(/^analyst-benchmark-[a-f0-9]{64}$/)
  })

  it.each([401, 429])('persists HTTP %i without the provider body or bearer', async (status) => {
    const secret = 'AUDIT_SECRET_456'
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: `Bearer ${secret}` }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch
    const runner = createPublicBenchmarkDirectRunner('codetracebench', directConfig(fetchImpl))

    const output = await runner.analyze(
      { traceStore: singleTraceStore('trace-1', [span('trace-1', 'step-1', 'Inspect.')]) },
      { caseId: 'codetrace:trace-1', repetition: 0 },
    )

    expect(output.error).toEqual({
      class: 'LlmCallError',
      code: 'judge',
      status: 502,
      message: 'Provider request failed with HTTP 502.',
    })
    expect(JSON.stringify(output)).not.toContain(secret)
  })

  it('distinguishes timeout, malformed output, and unavailable evidence failures', async () => {
    const run = async (
      response: () => Promise<Response>,
      spans = [span('trace-1', 'step-1', 'A')],
    ) =>
      createPublicBenchmarkDirectRunner(
        'codetracebench',
        directConfig(vi.fn(response) as typeof fetch),
      ).analyze(
        { traceStore: singleTraceStore('trace-1', spans) },
        { caseId: 'codetrace:trace-1', repetition: 0 },
      )

    await expect(
      run(async () => {
        throw new DOMException('timed out', 'AbortError')
      }),
    ).resolves.toMatchObject({ error: { class: 'LlmCallError', status: 502 } })
    await expect(run(async () => modelTextResponse('not-json'))).resolves.toMatchObject({
      error: { class: 'LlmResponseError' },
    })
    await expect(
      run(async () =>
        modelResponse({
          report: 'Selected a step that does not exist.',
          findings: [
            {
              first_step: 99,
              last_step: 99,
              consequence_step: 100,
              escape_status: 'unescaped',
              severity: 'high',
              claim: 'Missing.',
              confidence: 0.9,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        class: 'BenchmarkEvidenceError',
        message: expect.stringContaining('unavailable assistant steps'),
      },
    })
  })

  it('uses the focused one-trace tool set without dataset pagination', () => {
    const tools = buildTraceToolsForGroup('singleTrace', {} as never)
    expect(tools.map((tool) => tool.name)).toEqual([
      'getDatasetOverview',
      'viewTrace',
      'viewSpans',
      'searchTrace',
      'searchSpan',
    ])
  })

  it('binds each dataset to an explicit analyst protocol digest', () => {
    const codeTrace = publicBenchmarkProtocolSha256('codetracebench')
    const agentRx = publicBenchmarkProtocolSha256('agentrx')

    expect(codeTrace).toMatch(/^[a-f0-9]{64}$/)
    expect(agentRx).toMatch(/^[a-f0-9]{64}$/)
    expect(codeTrace).not.toBe(agentRx)
  })
})

function singleTraceStore(
  traceId: string,
  spans: TraceAnalystSpan[],
  options: { fitAtCap?: number; onView?: (cap: number) => void } = {},
): TraceAnalysisStore {
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
    async viewTrace(input: { per_attribute_byte_cap?: number }) {
      const cap = input.per_attribute_byte_cap ?? 4_096
      options.onView?.(cap)
      if (cap > (options.fitAtCap ?? 4_096)) {
        return {
          trace_id: traceId,
          oversized: {
            span_count: spans.length,
            top_span_names: [],
            span_response_bytes_max: 1,
            error_span_count: 0,
          },
        }
      }
      return { trace_id: traceId, spans }
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

function modelResponse(
  value: Record<string, unknown>,
  usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
): Response {
  return new Response(
    JSON.stringify({
      model: 'glm-5.2',
      choices: [
        {
          message: { content: JSON.stringify(value) },
          finish_reason: 'stop',
        },
      ],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function modelTextResponse(
  content: string,
  usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
): Response {
  return new Response(
    JSON.stringify({
      model: 'glm-5.2',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
