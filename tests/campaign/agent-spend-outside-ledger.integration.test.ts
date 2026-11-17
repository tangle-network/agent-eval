import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DispatchContext } from '../../src/campaign/types'
import { defineAgentEval } from '../../src/contract/index'

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

// The shape of the recorded compare-harnesses run: a deterministic judge and no usage assertion.
function evalKit(agent: (scenarioId: string, ctx: DispatchContext) => Promise<Billed>) {
  return defineAgentEval<(typeof scenarios)[number], number>({
    scenarios,
    baselineSurface: 'claude-code',
    agent: async (_surface, scenario, ctx) => (await agent(scenario.id, ctx)).exitCode,
    judge: {
      name: 'suite',
      dimensions: [{ key: 'pass', description: 'the tagged test passes after the turn' }],
      score: ({ artifact }) => {
        const pass = artifact === 0 ? 1 : 0
        return { dimensions: { pass }, composite: pass, notes: '' }
      },
    },
    expectUsage: 'off',
  })
}

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
