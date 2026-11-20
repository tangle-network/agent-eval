import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CampaignTraceWriter,
  type JudgeConfig,
  runCampaign,
  type Scenario,
} from '../../src/campaign'
import { campaignToRunRecords } from '../../src/rl'

// Each test runs a real campaign on the filesystem and reads back what it wrote.

const scenarios: Scenario[] = [
  { id: 'first', kind: 'qa' },
  { id: 'second', kind: 'qa' },
]

const judge: JudgeConfig<string, Scenario> = {
  name: 'exact',
  dimensions: [{ key: 'correct', description: 'the output is the expected answer' }],
  score: ({ artifact }) => {
    const correct = artifact === 'answer' ? 1 : 0
    return { composite: correct, dimensions: { correct }, notes: '' }
  },
}

/** A dispatch that writes one span through its cell's trace writer, then answers. */
async function tracedDispatch(_scenario: Scenario, ctx: { trace: CampaignTraceWriter }) {
  ctx.trace.span('agent.step', { step: 1 }).end()
  return 'answer'
}

const recordContext = {
  experimentId: 'trace-capture',
  model: 'gpt-4.1-2025-04-14',
  commitSha: 'a'.repeat(40),
  promptHash: 'prompt',
  configHash: 'config',
}

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'campaign-trace-capture-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

function findFiles(root: string, name: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) found.push(path)
    if (entry.isDirectory()) found.push(...findFiles(path, name))
  }
  return found
}

describe('a run record names the trace its campaign cell measured', () => {
  it('carries the trace id of every cell whose trace writer named one', async () => {
    const campaign = await runCampaign<Scenario, string>({
      scenarios,
      dispatch: tracedDispatch,
      judges: [judge],
      runDir,
      expectUsage: 'off',
    })
    const records = campaignToRunRecords(campaign, recordContext)

    expect(records).toHaveLength(2)
    for (const record of records) {
      const cell = campaign.cells.find((candidate) => candidate.scenarioId === record.scenarioId)!
      expect(cell.traceRef).toHaveProperty('traceId')
      const traceId = (cell.traceRef as { traceId: string }).traceId
      expect(record.traceRef).toEqual({ traceId })
    }
    // The id finds the spans: every written span carries its cell's record's trace id.
    const spanTraceIds = findFiles(runDir, 'spans.jsonl').flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { traceId: string }).traceId),
    )
    expect([...new Set(spanTraceIds)].sort()).toEqual(
      records.map((record) => record.traceRef!.traceId).sort(),
    )
  })

  it('leaves the trace off the record when the cell names none, instead of inventing one', async () => {
    const campaign = await runCampaign<Scenario, string>({
      scenarios,
      dispatch: tracedDispatch,
      judges: [judge],
      runDir,
      expectUsage: 'off',
      buildTraceWriter: () => ({
        span: () => ({ end: () => undefined, setAttribute: () => undefined }),
        flush: async () => undefined,
      }),
    })
    const records = campaignToRunRecords(campaign, recordContext)

    expect(records).toHaveLength(2)
    for (const cell of campaign.cells) expect(cell.traceRef).toHaveProperty('unknown')
    for (const record of records) expect(record.traceRef).toBeUndefined()
  })
})

describe("runCampaign's tracing option decides whether spans are captured", () => {
  it("captures no span and names no trace with tracing: 'off'", async () => {
    const campaign = await runCampaign<Scenario, string>({
      scenarios,
      dispatch: tracedDispatch,
      judges: [judge],
      runDir,
      expectUsage: 'off',
      tracing: 'off',
    })

    expect(campaign.cells).toHaveLength(2)
    for (const cell of campaign.cells) {
      expect(cell.error).toBeUndefined()
      expect(cell.traceRef).toEqual({
        unknown: `tracing is off for the campaign that measured cell ${cell.cellId}`,
      })
    }
    expect(findFiles(runDir, 'spans.jsonl')).toEqual([])
  })

  it("captures every attempt's spans by default and with tracing: 'on'", async () => {
    for (const tracing of [undefined, 'on'] as const) {
      const dir = join(runDir, tracing ?? 'default')
      const campaign = await runCampaign<Scenario, string>({
        scenarios,
        dispatch: tracedDispatch,
        judges: [judge],
        runDir: dir,
        expectUsage: 'off',
        ...(tracing ? { tracing } : {}),
      })
      for (const cell of campaign.cells) expect(cell.traceRef).toHaveProperty('traceId')
      expect(findFiles(dir, 'spans.jsonl')).toHaveLength(2)
    }
  })

  it("refuses tracing: 'off' together with a caller's trace writer", async () => {
    await expect(
      runCampaign<Scenario, string>({
        scenarios,
        dispatch: tracedDispatch,
        judges: [judge],
        runDir,
        expectUsage: 'off',
        tracing: 'off',
        buildTraceWriter: () => ({
          span: () => ({ end: () => undefined, setAttribute: () => undefined }),
          flush: async () => undefined,
        }),
      }),
    ).rejects.toThrow(/tracing 'off'/)
  })
})
