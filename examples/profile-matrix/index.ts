/**
 * Run the SAME cases across several agent profiles with `runProfileMatrix`.
 *
 * The matrix is the bridge between "I have N profiles" and "I have paper-grade
 * RunRecords": one campaign per profile, every cell mapped to a validated
 * RunRecord, and a backend-integrity guard that fails loudly when a run that
 * claims to be real reported no token usage.
 *
 * This example is offline: the dispatch is a deterministic function of the
 * profile, no model is called, and `integrity: 'off'` says so explicitly.
 * A live run keeps the default `integrity: 'assert'` and reports every paid
 * call through `ctx.cost.runPaidCall` — that receipt is what the guard checks.
 */

import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '../../src/index'
import { runProfileMatrix } from '../../src/campaign/index'

interface TicketScenario {
  id: string
  kind: 'support'
  question: string
}

const scenarios: TicketScenario[] = [
  { id: 'refund', kind: 'support', question: 'Can I get a refund?' },
  { id: 'shipping', kind: 'support', question: 'Where is my order?' },
  { id: 'cancel', kind: 'support', question: 'Cancel my subscription.' },
]

// ── Axis 3: the profiles under test ──────────────────────────────────────
// Each profile is one column of the matrix. In a live run these differ by
// model, prompt, tools, or harness; here they differ by prompt style only.
const terse: AgentProfile = {
  name: 'support-terse',
  model: { default: 'example-model@2026-01-01' },
  prompt: { systemPrompt: 'Answer in one sentence.' },
}

const cited: AgentProfile = {
  name: 'support-cited',
  model: { default: 'example-model@2026-01-01' },
  prompt: { systemPrompt: 'Answer in one sentence and cite the ticket id.' },
}

async function main(): Promise<void> {
  const result = await runProfileMatrix<TicketScenario, string>({
    profiles: [terse, cited],
    scenarios,
    // One cell = (profile, scenario). A live dispatch calls the model named by
    // the profile and reports usage via ctx.cost.runPaidCall; this one is a
    // deterministic offline stand-in.
    dispatch: async (profile, scenario) =>
      profile.name === 'support-cited'
        ? `Ticket ${scenario.id}: handled.`
        : 'Handled.',
    judges: [
      {
        name: 'ticket-id',
        dimensions: [{ key: 'present', description: 'The answer includes the ticket id' }],
        score: ({ artifact, scenario }) => {
          const present = artifact.includes(scenario.id) ? 1 : 0
          return { dimensions: { present }, composite: present, notes: '' }
        },
      },
    ],
    runDir: mkdtempSync(join(tmpdir(), 'profile-matrix-')),
    commitSha: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
    // Offline: no paid calls happen, so the backend-integrity guard must not
    // treat this run as a stubbed live run. Keep the default 'assert' whenever
    // the dispatch calls a real model.
    integrity: 'off',
  })

  for (const [profileId, summary] of Object.entries(result.byProfile)) {
    const mean = summary.meanComposite === null ? 'n/a' : summary.meanComposite.toFixed(2)
    console.log(`${profileId}: mean composite ${mean} over ${summary.records} records`)
  }

  // result.records is one validated RunRecord per (profile, scenario, rep) —
  // ready for analyzeRuns, HeldOutGate, scorecards, or the hosted wire format.
  console.log(`records: ${result.records.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
