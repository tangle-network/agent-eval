import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TraceAnalysisEngine } from '../../src/analyst/engine'
import { runTraceAnalyst } from '../../src/analyst/kind-factory'
import type { AnalystUsageReceipt } from '../../src/analyst/types'
import { compareOptimizationMethods } from '../../src/campaign/presets/compare-optimization-methods'
import { inMemoryCampaignStorage } from '../../src/campaign/storage'
import type { DispatchContext, JudgeConfig } from '../../src/campaign/types'
import { defineAgentEval } from '../../src/contract/index'
import type { TraceAnalysisStore } from '../../src/trace-analyst/store'
import type { TraceAnalystSpan } from '../../src/trace-analyst/types'

// A billing endpoint standing in for a sandboxed harness (`box.prompt`): every call costs money,
// whether or not the caller reports it to the eval's cost ledger.
const COST_PER_CALL_USD = 0.0959
let server: Server
let endpoint: string
let billedUsd = 0

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      billedUsd += COST_PER_CALL_USD
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          exitCode: 0,
          inputTokens: 1200,
          outputTokens: 300,
          costUsd: COST_PER_CALL_USD,
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prompt`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

interface Billed {
  exitCode: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

async function promptOutsideLedger(task: string): Promise<Billed> {
  const response = await fetch(endpoint, { method: 'POST', body: task })
  return (await response.json()) as Billed
}

async function promptThroughLedger(task: string, ctx: DispatchContext): Promise<Billed> {
  const paid = await ctx.cost.runPaidCall({
    actor: 'harness',
    model: 'glm-5.3',
    execute: () => promptOutsideLedger(task),
    receipt: (billed) => ({
      model: 'glm-5.3',
      inputTokens: billed.inputTokens,
      outputTokens: billed.outputTokens,
      actualCostUsd: billed.costUsd,
    }),
  })
  if (!paid.succeeded) throw paid.error
  return paid.value
}

const scenarios = [
  { id: 'cli-flag', kind: 'fix' },
  { id: 'null-guard', kind: 'fix' },
]
type Task = (typeof scenarios)[number]

const suite: JudgeConfig<number, Task> = {
  name: 'suite',
  dimensions: [{ key: 'pass', description: 'the tagged test passes after the turn' }],
  score: ({ artifact }) => {
    const pass = artifact === 0 ? 1 : 0
    return { dimensions: { pass }, composite: pass, notes: '' }
  },
}

// The shape of the recorded compare-harnesses run: a deterministic judge and no usage assertion.
function evalKit(agent: (scenarioId: string, ctx: DispatchContext) => Promise<Billed>) {
  return defineAgentEval<Task, number>({
    scenarios,
    baselineSurface: 'claude-code',
    agent: async (_surface, scenario, ctx) => (await agent(scenario.id, ctx)).exitCode,
    judge: suite,
    expectUsage: 'off',
  })
}

// An optimization method that keeps the baseline and spends nothing itself.
const keepBaseline = {
  name: 'keep-baseline',
  optimize: async (input: { baselineSurface: unknown }) => ({
    winnerSurface: input.baselineSurface as string,
    cost: {
      totalCostUsd: 0,
      costProvenance: { kind: 'observed' as const, usd: 0 },
      accountingComplete: true,
      incompleteReasons: [],
    },
  }),
}
// Search, selection and final splits for the optimization reporters.
const tasks = [
  'cli-flag',
  'null-guard',
  'retry-guard',
  'path-escape',
  'json-schema',
  'env-default',
].map((id) => ({ id, kind: 'fix' }))
const missed = (label: string, cellId: string) =>
  `${label}: agent spend for cell '${cellId}' was not captured by the cost ledger`

describe('agent spend the cost ledger never saw', () => {
  it('reports unknown cost, not an observed $0, when every agent call bypasses the ledger', async () => {
    const before = billedUsd
    const result = await evalKit((id) => promptOutsideLedger(id)).evaluate()

    expect(billedUsd - before).toBeCloseTo(2 * COST_PER_CALL_USD, 10)
    expect(result.aggregates.cost).toMatchObject({
      totalCalls: 0,
      costProvenance: { kind: 'uncaptured', usd: null },
      usageComplete: false,
      accountingComplete: false,
    })
    expect(result.aggregates.cost.incompleteReasons).toEqual([
      "agent spend for cell 'cli-flag:0' was not captured by the cost ledger",
      "agent spend for cell 'null-guard:0' was not captured by the cost ledger",
    ])
    for (const cell of result.cells) {
      expect(cell.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
      expect(cell.tokenUsage.tokensKnown).toBe(false)
    }
  })

  it('reports unknown cost when the ledger captured some agent calls and missed others', async () => {
    const before = billedUsd
    const result = await evalKit((id, ctx) =>
      id === 'cli-flag' ? promptThroughLedger(id, ctx) : promptOutsideLedger(id),
    ).evaluate()

    expect(billedUsd - before).toBeCloseTo(2 * COST_PER_CALL_USD, 10)
    expect(result.aggregates.cost).toMatchObject({
      totalCalls: 1,
      costProvenance: { kind: 'uncaptured', usd: null },
      accountingComplete: false,
      incompleteReasons: [
        "agent spend for cell 'null-guard:0' was not captured by the cost ledger",
      ],
    })
    // The captured call stays a known subtotal; it is never presented as the run's cost.
    expect(result.aggregates.cost.totalCostUsd).toBeCloseTo(COST_PER_CALL_USD, 10)
    const captured = result.cells.find((cell) => cell.scenarioId === 'cli-flag')!
    expect(captured.costProvenance).toEqual({ kind: 'observed', usd: COST_PER_CALL_USD })
  })

  it('claims complete observed cost only when the ledger saw every agent call', async () => {
    const before = billedUsd
    const result = await evalKit((id, ctx) => promptThroughLedger(id, ctx)).evaluate()

    const billed = billedUsd - before
    expect(billed).toBeCloseTo(2 * COST_PER_CALL_USD, 10)
    expect(result.aggregates.cost).toMatchObject({
      totalCalls: 2,
      costProvenance: { kind: 'observed' },
      usageComplete: true,
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(result.aggregates.cost.totalCostUsd).toBeCloseTo(billed, 10)
  })
})

describe('reports built from ledger reads count agent spend the ledger never saw', () => {
  it.each(['method', 'proposer'] as const)(
    'improve() in %s mode reports unknown cost, not an observed zero',
    async (mode) => {
      const before = billedUsd
      const result = await evalKit((id) => promptOutsideLedger(id)).improve({
        scenarios: tasks,
        model: 'glm-5.3@2026-11-17',
        storage: inMemoryCampaignStorage(),
        runDir: `mem://improve-outside-ledger-${mode}`,
        budget: {
          holdoutScenarios: tasks.slice(4),
          ...(mode === 'proposer' ? { generations: 1 } : {}),
        },
        ...(mode === 'method'
          ? { method: keepBaseline }
          : { proposer: { kind: 'fixed' as const, propose: async () => ['codex'] } }),
      })

      expect(billedUsd - before).toBeGreaterThan(0)
      expect(result.cost).toMatchObject({
        costProvenance: { kind: 'uncaptured', usd: null },
        accountingComplete: false,
      })
      expect(result.cost.incompleteReasons).toContain(missed('holdout.baseline', 'json-schema:0'))
    },
  )

  it('compareOptimizationMethods reports the final test cost as unknown', async () => {
    const before = billedUsd
    const result = await compareOptimizationMethods<Task, number>({
      methods: [keepBaseline],
      baselineSurface: 'claude-code',
      trainScenarios: tasks.slice(0, 3),
      selectionScenarios: [tasks[3]!],
      testScenarios: tasks.slice(4),
      judges: [suite],
      expectUsage: 'off',
      storage: inMemoryCampaignStorage(),
      runDir: 'mem://compare-outside-ledger',
      dispatchWithSurface: async (_surface, scenario) =>
        (await promptOutsideLedger(scenario.id)).exitCode,
    })

    expect(billedUsd - before).toBeGreaterThan(0)
    for (const cost of [result.testCost, result.totalCost]) {
      expect(cost).toMatchObject({
        costProvenance: { kind: 'uncaptured', usd: null },
        accountingComplete: false,
      })
    }
    expect(result.testCost.incompleteReasons).toContain(missed('test/baseline', 'json-schema:0'))
  })

  it.each([
    [
      'outside the ledger',
      false,
      { calls: 1, tokens: null, cost: { kind: 'uncaptured', usd: null }, knownCostUsd: 0 },
    ],
    ['through the ledger', true, { calls: 1, cost: { kind: 'observed', usd: COST_PER_CALL_USD } }],
  ] as const)(
    'a trace analyst whose engine pays %s reports that spend',
    async (_how, throughLedger, expected) => {
      const before = billedUsd
      const receipts: AnalystUsageReceipt[] = []
      await runTraceAnalyst({
        definition: {
          id: 'auth-failure',
          description: 'Find the causal failure.',
          area: 'failure-mode',
          version: '1.0.0',
          question: 'What caused the failure?',
          instructions: 'Inspect exact spans and cite them.',
          toolGroup: 'discovery',
        },
        engine: billedEngine(throughLedger),
        store: traceStore([traceSpan('step-1', '401 unauthorized')]),
        context: { runId: 'run-1', recordUsage: (receipt) => receipts.push(receipt) },
      })

      expect(billedUsd - before).toBeCloseTo(COST_PER_CALL_USD, 10)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject(expected)
    },
  )
})

// A trace-analysis engine whose one model call is billed by the endpoint.
function billedEngine(throughLedger: boolean): TraceAnalysisEngine {
  return {
    id: 'billed-engine',
    description: 'one billed model call',
    model: 'glm-5.3',
    version: '1.0.0',
    executionConfig: { base_url: 'http://127.0.0.1' },
    async analyze(request) {
      if (throughLedger) {
        const paid = await request.costLedger.runPaidCall({
          channel: 'analyst',
          phase: request.costPhase,
          actor: request.analystId,
          model: 'glm-5.3',
          ...(request.costTags ? { tags: request.costTags } : {}),
          execute: () => promptOutsideLedger(request.question),
          receipt: (billed) => ({
            model: 'glm-5.3',
            inputTokens: billed.inputTokens,
            outputTokens: billed.outputTokens,
            actualCostUsd: billed.costUsd,
          }),
        })
        if (!paid.succeeded) throw paid.error
      } else {
        await promptOutsideLedger(request.question)
      }
      return {
        answer: 'The first call failed authentication.',
        findings: [
          {
            severity: 'high',
            claim: 'Authentication failed before useful work began.',
            subject: 'auth-failure',
            confidence: 0.9,
            evidence: [{ uri: 'trace://run-1/span/step-1', excerpt: '401 unauthorized' }],
          },
        ],
        trajectory: [],
        modelCalls: 1,
        toolCalls: 0,
        runtime: { engine: 'billed-engine' },
      }
    },
  }
}

function traceSpan(spanId: string, content: string): TraceAnalystSpan {
  return {
    trace_id: 'run-1',
    span_id: spanId,
    parent_span_id: null,
    name: 'message.assistant',
    kind: 'LLM',
    start_time: '2026-11-17T00:00:00.000Z',
    end_time: '2026-11-17T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: 'test',
    agent_name: 'test-agent',
    model_name: 'glm-5.3',
    tool_name: null,
    attributes: { content },
  }
}

function traceStore(rows: TraceAnalystSpan[]): TraceAnalysisStore {
  const store: Pick<TraceAnalysisStore, 'hasSpans' | 'viewSpans'> = {
    async hasSpans({ trace_id, span_ids }) {
      return rows
        .filter((span) => span.trace_id === trace_id && span_ids.includes(span.span_id))
        .map((span) => span.span_id)
    },
    async viewSpans({ trace_id, span_ids }) {
      const found = rows.filter(
        (span) => span.trace_id === trace_id && span_ids.includes(span.span_id),
      )
      return {
        trace_id,
        spans: found,
        missing_span_ids: span_ids.filter((id) => !found.some((span) => span.span_id === id)),
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
  }
  return store as unknown as TraceAnalysisStore
}
