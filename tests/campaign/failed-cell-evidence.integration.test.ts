import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { campaignCellSearchResult, runCampaign, runProfileMatrix } from '../../src/campaign'
import { cellCachePath } from '../../src/campaign/cell-schedule'
import { campaignCellToRunRecord } from '../../src/campaign/run-record'
import type { DispatchContext } from '../../src/campaign/types'
import type { CostReceiptInput } from '../../src/cost-ledger'
import { UNKNOWN_MODEL } from '../../src/run-record'

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'failed-cell-evidence-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('failed cell evidence through persisted campaigns and profile matrices', () => {
  it.each([
    { label: 'measured failure', input: 4, output: 2, cost: 0.2, unknown: false, receipt: true },
    { label: 'measured zero', input: 0, output: 0, cost: 0, unknown: false, receipt: true },
    { label: 'partial usage', input: 4, output: 2, cost: 0, unknown: true, receipt: true },
    { label: 'unpriced usage', input: 4, output: 2, cost: null, unknown: false, receipt: true },
    {
      label: 'absent failure receipt',
      input: 0,
      output: 0,
      cost: null,
      unknown: true,
      receipt: false,
    },
  ])(
    'preserves $label independently of served identity on live and resumed runs',
    async (fixture) => {
      const runDir = directory()
      const receipt: CostReceiptInput = {
        model: 'gpt-4.1',
        inputTokens: fixture.input,
        outputTokens: fixture.output,
        ...(fixture.cost === null ? { costUnknown: true } : { actualCostUsd: fixture.cost }),
        usageUnknown: fixture.unknown,
      }
      let calls = 0
      const options = {
        profiles: [{ name: 'failed', model: { default: 'gpt-4.1' } }],
        scenarios: [{ id: 'failure', kind: 'receipt-boundary' }],
        runDir,
        commitSha: 'receipt-boundary',
        integrity: 'off' as const,
        dispatch: async (_profile: unknown, _scenario: unknown, context: DispatchContext) => {
          calls++
          const result = await context.cost.runPaidCall({
            actor: 'worker',
            model: 'gpt-4.1',
            execute: async (): Promise<string> => {
              throw new Error('provider interrupted after recording usage')
            },
            receipt: () => receipt,
            receiptFromError: () => (fixture.receipt ? receipt : undefined),
          })
          if (!result.succeeded) throw result.error
          return result.value
        },
      }
      const first = await runProfileMatrix(options)
      const campaign = Object.values(first.campaigns)[0]!
      const cell = campaign.cells[0]!
      expect(cell.costCallIds).toHaveLength(1)
      expect(cell.resolvedModel).toBeUndefined()
      expect(cell.tokenUsage).toEqual({
        input: fixture.input,
        output: fixture.output,
        ...(fixture.unknown ? { tokensKnown: false } : {}),
      })
      expect(first.records[0]).toMatchObject({
        model: UNKNOWN_MODEL,
        terminalOutcome: 'failed',
        tokenUsage: cell.tokenUsage,
        costUsd: fixture.cost,
        costProvenance:
          fixture.cost === null
            ? { kind: 'uncaptured', usd: null }
            : { kind: 'observed', usd: fixture.cost },
        outcome: { raw: { tokens_known: fixture.unknown ? 0 : 1 } },
      })
      const failurePath = Object.values(campaign.artifactsByPath).find((path) =>
        path.endsWith('/failure-receipt.json'),
      )!
      expect(JSON.parse(readFileSync(failurePath, 'utf8')).cell.tokenUsage).toEqual(cell.tokenUsage)

      // Reuse the exact durable failed cell and its ledger receipts, including a historical
      // requested-model fallback. Resumption must not dispatch or turn that fallback into evidence.
      writeFileSync(
        cellCachePath(campaign.runDir, cell.cellId),
        JSON.stringify({ ...cell, resolvedModel: 'gpt-4.1-2025-04-14' }),
      )
      const resumed = await runProfileMatrix({ ...options, reuseFailedCells: true })
      expect(calls).toBe(1)
      const resumedCell = Object.values(resumed.campaigns)[0]!.cells[0]!
      expect(resumedCell.cached).toBe(true)
      expect(resumedCell.resolvedModel).toBeUndefined()
      expect(resumed.records[0]?.tokenUsage).toEqual(first.records[0]?.tokenUsage)
      expect(resumed.records[0]?.costProvenance).toEqual(first.records[0]?.costProvenance)
      expect(resumed.records[0]?.model).toBe(UNKNOWN_MODEL)
    },
  )

  it('keeps absent agent receipts unknown in raw cells, persisted failures and both consumer projections', async () => {
    const runDir = directory()
    let calls = 0
    const options = {
      scenarios: [{ id: 'absent', kind: 'receipt-boundary' }],
      runDir,
      dispatchRef: 'before-paid-admission',
      dispatch: async (): Promise<string> => {
        calls++
        throw new Error('execution ended before accounting was reported')
      },
    }
    const campaign = await runCampaign(options)
    const cell = campaign.cells[0]!
    expect(cell.costCallIds).toEqual([])
    expect(cell.tokenUsage).toEqual({ input: 0, output: 0, tokensKnown: false })
    expect(cell.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    const failurePath = Object.values(campaign.artifactsByPath).find((path) =>
      path.endsWith('/failure-receipt.json'),
    )!
    expect(JSON.parse(readFileSync(failurePath, 'utf8')).cell).toMatchObject({
      tokenUsage: cell.tokenUsage,
      costProvenance: cell.costProvenance,
    })
    const record = campaignCellToRunRecord(cell, {
      runId: 'absent',
      experimentId: 'receipt-boundary',
      candidateId: 'failed',
      model: UNKNOWN_MODEL,
      promptHash: 'prompt',
      configHash: 'config',
      commitSha: 'receipt-boundary',
      splitTag: 'search',
    })
    expect(record.costUsd).toBeNull()
    expect(record.tokenUsage.tokensKnown).toBe(false)
    const search = campaignCellSearchResult(cell, {
      execution: {
        agent: { uri: 'fixture:agent', revision: 'a'.repeat(40) },
        benchmark: { uri: 'fixture:benchmark', revision: 'b'.repeat(40) },
        model: { provider: 'test', alias: 'gpt-4.1', unknown: 'unreported' },
      },
      lane: 'test',
    })
    expect(search.accounting.tokens.status).toBe('unknown')
    expect(search.accounting.cost.status).toBe('unknown')

    // Older caches recorded an empty ledger as measured zero. Reconcile the persisted cache
    // through the same path as a live cell, without turning reuse into another paid dispatch.
    writeFileSync(
      cellCachePath(runDir, cell.cellId),
      JSON.stringify({
        ...cell,
        tokenUsage: { input: 0, output: 0 },
        costProvenance: { kind: 'observed', usd: 0 },
      }),
    )
    const resumed = await runCampaign({ ...options, reuseFailedCells: true })
    expect(calls).toBe(1)
    expect(resumed.cells[0]).toMatchObject({
      cached: true,
      tokenUsage: cell.tokenUsage,
      costProvenance: cell.costProvenance,
    })
  })
})
