/**
 * Inspect the per-case grid before a campaign spends anything.
 *
 * Run with: pnpm tsx examples/plan-before-you-spend/index.ts
 *
 * A campaign runs one cell per case per replicate. `planCampaignRun()` reports
 * which cells are reusable, which must run, and which are blocked, without
 * dispatching. `runCampaign()` then executes the same grid.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planCampaignRun, runCampaign } from '../../src/campaign'
import type { JudgeConfig, Scenario } from '../../src/contract'

interface ExtractionCase extends Scenario {
  input: string
  expected: string
}

const scenarios: ExtractionCase[] = [
  { id: 'invoice', kind: 'extract', input: 'Invoice 4417 is due', expected: '4417' },
  { id: 'order', kind: 'extract', input: 'Order 9032 shipped', expected: '9032' },
  { id: 'ticket', kind: 'extract', input: 'Ticket 1188 reopened', expected: '1188' },
]

/** The agent under test. Replace with your product call. */
async function dispatch(scenario: ExtractionCase): Promise<string> {
  return scenario.input.match(/\d+/)?.[0] ?? ''
}

const judge: JudgeConfig<string, ExtractionCase> = {
  name: 'exact-id',
  dimensions: [{ key: 'exact', description: 'The extracted id matches the expected id' }],
  score: ({ artifact, scenario }) => {
    const exact = artifact === scenario.expected ? 1 : 0
    return { dimensions: { exact }, composite: exact, notes: '' }
  },
}

const runDir = mkdtempSync(join(tmpdir(), 'agent-eval-plan-'))

// Nothing has run yet, so every cell is runnable and none is reusable.
const plan = planCampaignRun({ scenarios, dispatch, judges: [judge], runDir })
console.table(plan.cells)

const first = await runCampaign({
  scenarios,
  dispatch,
  judges: [judge],
  runDir,
  // Stop the whole campaign on the first failed cell instead of paying for
  // the rest of the grid. The failed cell writes its receipt first.
  abortOnCellError: true,
  expectUsage: 'off',
})
console.log('cells run:', first.cells.length)

// The same plan after a complete run: every cell is now reusable.
const second = planCampaignRun({ scenarios, dispatch, judges: [judge], runDir })
console.table(second.cells)
