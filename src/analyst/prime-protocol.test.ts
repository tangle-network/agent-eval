import { describe, expect, it } from 'vitest'
import type { CustomTokenPricing } from '../cost-ledger'
import type { PrimeBridgeTransport, PrimeBridgeTransportRequest } from './prime-bridge-transport'
import {
  analystUsageReceiptFromPrimeUsage,
  buildPrimePrompt,
  buildPrimeRepairPrompt,
  emptyPrimeRawUsage,
  extractPrimeJsonObject,
  mergePrimeRawUsage,
  normalizePrimeUsage,
  type PrimeProjectionSource,
  type PrimeRawUsage,
  type PrimeReplyContract,
  primeProtocolSha256,
  primeReplyDefect,
  projectPrimeTrajectory,
  runPrimeExchange,
} from './prime-protocol'
import { assertValidAnalystUsageReceipt } from './usage-receipt'

const PRICING: CustomTokenPricing = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
const URL = 'http://bridge.test:4181/v1/chat/completions'
const MODEL = 'prime/zai/glm-5.2'

/**
 * A span-grounded row grammar with no CodeTraceBench vocabulary anywhere: the
 * protocol core is exercised the way a second consumer would bind it.
 */
interface SpanRow {
  spanIds: string[]
  claim: string
}

const SPAN_CONTRACT: PrimeReplyContract<SpanRow> = {
  rowsField: 'findings',
  contractLines: ['  "findings": array of {"span_ids": [string, ...], "claim": string}'],
  repairContractLines: ['  "findings": array of {"span_ids": [string, ...], "claim": string}'],
  maxRows: 2,
  decodeRow(row) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return { ok: false, reason: 'row is not an object' }
    }
    const record = row as Record<string, unknown>
    if (!Array.isArray(record.span_ids) || record.span_ids.length === 0) {
      return { ok: false, reason: 'span_ids must be a non-empty array' }
    }
    if (typeof record.claim !== 'string' || record.claim.length === 0) {
      return { ok: false, reason: 'claim must be a non-empty string' }
    }
    return { ok: true, row: { spanIds: record.span_ids as string[], claim: record.claim } }
  },
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

function fencedRows(rows: unknown[], answer = 'One sentence.'): string {
  return `Prose first.\n\`\`\`json\n${JSON.stringify({ answer, findings: rows })}\n\`\`\`\n`
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

function exchange(transport: PrimeBridgeTransport, overrides: Record<string, unknown> = {}) {
  return runPrimeExchange({
    contract: SPAN_CONTRACT,
    prompt: 'PROMPT BODY',
    transport,
    url: URL,
    model: MODEL,
    timeoutMs: 30_000,
    repair: true,
    ...overrides,
  })
}

describe('buildPrimePrompt', () => {
  it('composes question, task definition, contract, trajectory, and trailer in order', () => {
    expect(
      buildPrimePrompt({
        question: 'What broke?',
        taskDefinition: 'Read the trajectory.',
        contractLines: ['CONTRACT LINE A', 'CONTRACT LINE B'],
        trajectoryHeader: 'TRAJECTORY (2 spans):',
        renderedTrajectory: '[{"span_id":"a"}]',
        trailer: 'FINAL VERIFICATION SPANS:\n[]',
      }),
    ).toBe(
      [
        'QUESTION: What broke?',
        '',
        'TASK DEFINITION:',
        'Read the trajectory.',
        '',
        'CONTRACT LINE A',
        'CONTRACT LINE B',
        '',
        'TRAJECTORY (2 spans):',
        '[{"span_id":"a"}]',
        '',
        'FINAL VERIFICATION SPANS:\n[]',
      ].join('\n'),
    )
  })

  it('omits the task-definition heading and the trailer when the consumer supplies neither', () => {
    expect(
      buildPrimePrompt({
        question: 'What broke?',
        contractLines: ['CONTRACT LINE A'],
        trajectoryHeader: 'TRAJECTORY (2 spans):',
        renderedTrajectory: '[]',
      }),
    ).toBe(
      ['QUESTION: What broke?', '', 'CONTRACT LINE A', '', 'TRAJECTORY (2 spans):', '[]'].join(
        '\n',
      ),
    )
  })
})

describe('buildPrimeRepairPrompt', () => {
  it('carries the defect, the contract, and the previous reply — never the trajectory', () => {
    const prompt = buildPrimeRepairPrompt({
      defect: 'no parseable JSON object',
      previousReply: 'the reply was prose',
      repairContractLines: ['  "findings": array'],
    })

    expect(prompt).toContain('structurally malformed')
    expect(prompt).toContain('no parseable JSON object')
    expect(prompt).toContain('  "findings": array')
    expect(prompt).toContain('PREVIOUS REPLY:\nthe reply was prose')
    expect(prompt).not.toContain('TRAJECTORY')
  })
})

describe('extractPrimeJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractPrimeJsonObject('{"findings": []}')).toEqual({ findings: [] })
  })

  it('prefers the LAST fenced block when the model emits several', () => {
    const text = '```json\n{"findings":["first"]}\n```\nthen\n```json\n{"findings":["last"]}\n```'
    expect(extractPrimeJsonObject(text)).toEqual({ findings: ['last'] })
  })

  it('falls back to the outermost brace slice for prose-wrapped JSON', () => {
    expect(extractPrimeJsonObject('Here it is: {"findings": [1]} — done.')).toEqual({
      findings: [1],
    })
  })

  it('returns null for prose and for a bare array', () => {
    expect(extractPrimeJsonObject('no json here')).toBeNull()
    expect(extractPrimeJsonObject('[1, 2, 3]')).toBeNull()
  })
})

describe('primeReplyDefect', () => {
  it('names the consumer-specific rows field', () => {
    expect(primeReplyDefect(null, 'blocks')).toBe('no parseable JSON object')
    expect(primeReplyDefect({ answer: 'x' }, 'blocks')).toBe('JSON has no "blocks" array')
    expect(primeReplyDefect({ answer: 'x' }, 'findings')).toBe('JSON has no "findings" array')
    expect(primeReplyDefect({ findings: [] }, 'findings')).toBeNull()
  })
})

describe('runPrimeExchange', () => {
  it('decodes a well-formed reply and reports the raw row count beside the accepted rows', async () => {
    const { transport, requests } = queuedTransport([
      bridgeReply(fencedRows([{ span_ids: ['a'], claim: 'first' }]), {
        prompt_tokens: 100,
        completion_tokens: 20,
        model_requests: 4,
      }),
    ])
    const outcome = await exchange(transport)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).toEqual({
      model: MODEL,
      messages: [{ role: 'user', content: 'PROMPT BODY' }],
    })
    expect(outcome.answer).toBe('One sentence.')
    expect(outcome.rows).toEqual([{ spanIds: ['a'], claim: 'first' }])
    expect(outcome.rejected).toEqual([])
    expect(outcome.reportedRows).toBe(1)
    expect(outcome.overflow).toBe(0)
    expect(outcome.repair).toEqual({ attempted: false, succeeded: null })
    expect(outcome.usage).toEqual({
      calls: 4,
      inputTokens: 100,
      outputTokens: 20,
      bridgeEstimated: false,
    })
    expect(outcome.turns).toEqual([
      {
        turn: 'first',
        usage: { calls: 4, inputTokens: 100, outputTokens: 20, bridgeEstimated: false },
        rawUsage: { prompt_tokens: 100, completion_tokens: 20, model_requests: 4 },
      },
    ])
  })

  it('rejects malformed rows with their index and reason while valid siblings survive', async () => {
    const { transport } = queuedTransport([
      bridgeReply(
        fencedRows([
          { span_ids: [], claim: 'empty' },
          'not-an-object',
          { span_ids: ['b'], claim: 'kept' },
        ]),
      ),
    ])
    const outcome = await exchange(transport)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.rows).toEqual([{ spanIds: ['b'], claim: 'kept' }])
    expect(outcome.rejected).toEqual([
      { index: 0, reason: 'span_ids must be a non-empty array' },
      { index: 1, reason: 'row is not an object' },
    ])
    expect(outcome.reportedRows).toBe(3)
  })

  it('applies the row cap to ACCEPTED rows, so malformed rows never starve a valid one', async () => {
    const { transport } = queuedTransport([
      bridgeReply(
        fencedRows([
          'malformed',
          'malformed',
          { span_ids: ['a'], claim: 'first valid' },
          { span_ids: ['b'], claim: 'second valid' },
          { span_ids: ['c'], claim: 'over the cap' },
        ]),
      ),
    ])
    const outcome = await exchange(transport)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.rows.map((row) => row.claim)).toEqual(['first valid', 'second valid'])
    expect(outcome.rejected).toHaveLength(2)
    expect(outcome.overflow).toBe(1)
    expect(outcome.reportedRows).toBe(5)
  })

  it('repairs a malformed reply in one bounded turn and sums usage across both turns', async () => {
    const { transport, requests } = queuedTransport([
      bridgeReply('prose, not JSON', { prompt_tokens: 900, completion_tokens: 90 }),
      bridgeReply(fencedRows([{ span_ids: ['a'], claim: 'repaired' }]), {
        prompt_tokens: 100,
        completion_tokens: 10,
      }),
    ])
    const outcome = await exchange(transport)

    expect(requests).toHaveLength(2)
    expect(requests[1]!.body.messages[0]!.content).toContain('PREVIOUS REPLY:\nprose, not JSON')
    expect(requests[1]!.body.messages[0]!.content).not.toContain('PROMPT BODY')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.repair).toEqual({ attempted: true, succeeded: true })
    expect(outcome.usage).toEqual({
      calls: null,
      inputTokens: 1_000,
      outputTokens: 100,
      bridgeEstimated: false,
    })
    expect(outcome.turns.map((turn) => turn.turn)).toEqual(['first', 'repair'])
  })

  it('reports a malformed reply that survives the repair turn, keeping the reply as evidence', async () => {
    const { transport } = queuedTransport([
      bridgeReply('still prose'),
      bridgeReply('{"answer": "no findings field"}'),
    ])
    const outcome = await exchange(transport)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toEqual({
      kind: 'malformed-reply',
      message: 'JSON has no "findings" array in prime reply even after the bounded repair turn',
    })
    expect(outcome.repair).toEqual({ attempted: true, succeeded: false })
    expect(outcome.reply).toBe('{"answer": "no findings field"}')
  })

  it('skips the repair turn when repair is disabled', async () => {
    const { transport, requests } = queuedTransport([bridgeReply('prose')])
    const outcome = await exchange(transport, { repair: false })

    expect(requests).toHaveLength(1)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.message).toBe('no parseable JSON object in prime reply')
    expect(outcome.repair).toEqual({ attempted: false, succeeded: null })
  })

  it('classifies a non-200 reply as http-status with its status and body snippet', async () => {
    const { transport } = queuedTransport([{ status: 502, text: 'bad gateway' }])
    const outcome = await exchange(transport)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toEqual({
      kind: 'http-status',
      message: 'bridge HTTP 502: bad gateway',
      status: 502,
      bodySnippet: 'bad gateway',
    })
    expect(outcome.turns).toEqual([])
  })

  it('classifies an unreadable body and an empty message separately', async () => {
    const unparseable = await exchange(
      queuedTransport([{ status: 200, text: 'not json' }]).transport,
    )
    expect(unparseable.ok).toBe(false)
    if (!unparseable.ok) {
      expect(unparseable.failure).toEqual({
        kind: 'unparseable-json',
        message: 'bridge returned unparseable JSON (8 bytes)',
      })
    }

    const empty = await exchange(
      queuedTransport([{ status: 200, text: JSON.stringify({ choices: [] }) }]).transport,
    )
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.failure).toEqual({
        kind: 'no-content',
        message: 'bridge reply carries no message content',
      })
    }
  })

  it('classifies a refused connection as transport', async () => {
    const { transport } = queuedTransport([{ error: new Error('ECONNREFUSED') }])
    const outcome = await exchange(transport)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toEqual({
      kind: 'transport',
      message: 'bridge transport failure: ECONNREFUSED',
    })
  })

  it('separates a blown deadline from a transport failure', async () => {
    const transport: PrimeBridgeTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('socket destroyed')), {
          once: true,
        })
      })
    const outcome = await exchange(transport, { timeoutMs: 20 })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toEqual({ kind: 'deadline', message: 'bridge call exceeded 20ms' })
  })

  it('separates a caller cancellation from both, and carries the original error as its cause', async () => {
    const controller = new AbortController()
    const cancelled = new Error('cancelled by the operator')
    const transport: PrimeBridgeTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(cancelled), { once: true })
        controller.abort()
      })
    const outcome = await exchange(transport, { signal: controller.signal })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.kind).toBe('aborted')
    if (outcome.failure.kind !== 'aborted') return
    expect(outcome.failure.cause).toBe(cancelled)
  })
})

describe('prime usage normalization', () => {
  it('reads the bridge usage object, keeping the derived-counts flag', () => {
    expect(
      normalizePrimeUsage({
        prompt_tokens: 500,
        completion_tokens: 25,
        model_requests: 3,
        estimated: true,
      }),
    ).toEqual({ calls: 3, inputTokens: 500, outputTokens: 25, bridgeEstimated: true })
  })

  it('keeps a one-sided count rather than collapsing the whole receipt', () => {
    expect(normalizePrimeUsage({ prompt_tokens: 500 })).toEqual({
      calls: null,
      inputTokens: 500,
      outputTokens: null,
      bridgeEstimated: false,
    })
    expect(normalizePrimeUsage({ completion_tokens: 25 })).toEqual({
      calls: null,
      inputTokens: null,
      outputTokens: 25,
      bridgeEstimated: false,
    })
  })

  it('treats a missing, non-integer, or negative count as uncaptured rather than as a number', () => {
    expect(normalizePrimeUsage(undefined)).toEqual(emptyPrimeRawUsage())
    expect(normalizePrimeUsage({ prompt_tokens: 12.5, completion_tokens: -1 })).toEqual(
      emptyPrimeRawUsage(),
    )
  })

  it('poisons each side independently so a measured count survives its missing partner', () => {
    const first: PrimeRawUsage = {
      calls: 2,
      inputTokens: 100,
      outputTokens: null,
      bridgeEstimated: false,
    }
    const second: PrimeRawUsage = {
      calls: 3,
      inputTokens: 40,
      outputTokens: 7,
      bridgeEstimated: true,
    }

    expect(mergePrimeRawUsage(first, second)).toEqual({
      calls: 5,
      inputTokens: 140,
      outputTokens: null,
      bridgeEstimated: true,
    })
  })
})

describe('analystUsageReceiptFromPrimeUsage', () => {
  it('prices a complete receipt and leaves it unmarked', () => {
    const receipt = analystUsageReceiptFromPrimeUsage(
      { calls: 3, inputTokens: 1_000, outputTokens: 200, bridgeEstimated: false },
      PRICING,
    )

    expect(receipt).toEqual({
      calls: 3,
      tokens: { input: 1_000, output: 200 },
      cost: { kind: 'estimated', usd: (1_000 * 0.6 + 200 * 2.2) / 1_000_000 },
    })
    expect(() => assertValidAnalystUsageReceipt(receipt)).not.toThrow()
  })

  it('marks a receipt whose token counts the bridge derived rather than measured', () => {
    const receipt = analystUsageReceiptFromPrimeUsage(
      { calls: 1, inputTokens: 10, outputTokens: 2, bridgeEstimated: true },
      PRICING,
    )

    expect(receipt.tokensEstimated).toBe(true)
    expect(receipt.cost.kind).toBe('estimated')
    expect(() => assertValidAnalystUsageReceipt(receipt)).not.toThrow()
  })

  it('carries a one-sided count beside a null total and prices it as a lower bound', () => {
    const receipt = analystUsageReceiptFromPrimeUsage(
      { calls: 2, inputTokens: 1_000, outputTokens: null, bridgeEstimated: false },
      PRICING,
    )

    expect(receipt).toEqual({
      calls: 2,
      tokens: null,
      partialTokens: { input: 1_000, output: null },
      cost: { kind: 'uncaptured', usd: null },
      knownCostUsd: (1_000 * 0.6) / 1_000_000,
    })
    expect(() => assertValidAnalystUsageReceipt(receipt)).not.toThrow()
  })

  it('reports nothing extra when the bridge reported no counts at all', () => {
    expect(analystUsageReceiptFromPrimeUsage(emptyPrimeRawUsage(), PRICING)).toEqual({
      calls: null,
      tokens: null,
      cost: { kind: 'uncaptured', usd: null },
    })
  })
})

describe('projectPrimeTrajectory', () => {
  function source(
    full: readonly unknown[] | null,
    capped: readonly unknown[],
  ): PrimeProjectionSource<unknown> & { cappedCalls: number } {
    const tracked = {
      cappedCalls: 0,
      full: async () => full,
      capped: async () => {
        tracked.cappedCalls += 1
        return capped
      },
      cappedDescription: 'per-attribute cap 1200',
    }
    return tracked
  }

  it('inlines the full projection when it fits', async () => {
    const projection = source([{ a: 1 }], [{ a: 0 }])
    const outcome = await projectPrimeTrajectory(projection, { maxInlineChars: 1_000 })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.items).toEqual([{ a: 1 }])
    expect(outcome.rendered).toBe('[{"a":1}]')
    expect(outcome.delivery).toEqual({ mode: 'inline-json', fetch: 'full', renderedChars: 9 })
    expect(projection.cappedCalls).toBe(0)
  })

  it('falls back to the capped projection when the source declares itself oversized', async () => {
    const projection = source(null, [{ a: 0 }])
    const outcome = await projectPrimeTrajectory(projection, { maxInlineChars: 1_000 })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.delivery.fetch).toBe('capped')
    expect(projection.cappedCalls).toBe(1)
  })

  it('falls back once when the rendered full projection exceeds the inline budget', async () => {
    const projection = source([{ a: 'x'.repeat(200) }], [{ a: 'x' }])
    const outcome = await projectPrimeTrajectory(projection, { maxInlineChars: 50 })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.delivery).toEqual({ mode: 'inline-json', fetch: 'capped', renderedChars: 11 })
    expect(projection.cappedCalls).toBe(1)
  })

  it('refuses rather than truncating when even the capped projection is oversized', async () => {
    const projection = source([{ a: 'x'.repeat(200) }], [{ a: 'x'.repeat(100) }])
    const outcome = await projectPrimeTrajectory(projection, { maxInlineChars: 50 })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.renderedChars).toBe(110)
    expect(outcome.reason).toBe(
      'trajectory renders to 110 chars even at per-attribute cap 1200; inline delivery impossible',
    )
  })
})

describe('primeProtocolSha256', () => {
  const identity = {
    question: 'Which assistant steps are incorrect?',
    taskDefinition: 'Read the trajectory.',
    contractLines: ['CONTRACT'],
    repairContractLines: ['REPAIR'],
    limits: { maxRows: 10 },
  }

  it('is stable for the same composed contract', () => {
    expect(primeProtocolSha256(identity)).toBe(primeProtocolSha256({ ...identity }))
  })

  it('separates two consumers that both stamp prime but ask different questions', () => {
    expect(primeProtocolSha256({ ...identity, question: 'Diagnose this trajectory.' })).not.toBe(
      primeProtocolSha256(identity),
    )
    expect(primeProtocolSha256({ ...identity, contractLines: ['OTHER'] })).not.toBe(
      primeProtocolSha256(identity),
    )
    expect(primeProtocolSha256({ ...identity, limits: { maxRows: 16 } })).not.toBe(
      primeProtocolSha256(identity),
    )
  })

  it('separates a consumer that states a task definition from one that does not', () => {
    const { taskDefinition, ...withoutTask } = identity
    expect(primeProtocolSha256(withoutTask)).not.toBe(primeProtocolSha256(identity))
  })
})
