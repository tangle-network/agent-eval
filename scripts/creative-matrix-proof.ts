/** Replay retained production renders through campaign scoring and the official
 * GEPA bridge without generating a candidate or making a model request.
 * node --import tsx scripts/creative-matrix-proof.ts manifest.json output-dir python
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CostLedger, type CostReceiptInput } from '../src/cost-ledger'
import { measureCampaignCost } from '../src/campaign/cost-breakdown'
import { createExternalTextEvaluator } from '../src/campaign/external-text-evaluation'
import type { Scenario } from '../src/campaign/types'

interface RetainedScenario extends Scenario {
  png: string
  sha256: string
  objectives: Record<string, number>
  source: string
}
interface ProofManifest {
  scenarios: RetainedScenario[]
  /** An already-settled raw seat receipt, never a fabricated token example. */
  receipt?: CostReceiptInput
  receiptSource?: string
  sandbox?: { seconds: number; cpu: number; memoryGB: number; diskGB: number }
}
const [manifestPath, outputPath, python] = process.argv.slice(2)
if (!manifestPath || !outputPath || !python) throw new Error('Expected manifest.json output-dir python')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProofManifest
if (manifest.scenarios.length < 3) throw new Error('Requires at least three retained scenarios')
const root = resolve(outputPath)
mkdirSync(root, { recursive: true })
const ledger = new CostLedger()
const objectives = [...new Set(manifest.scenarios.flatMap((s) => Object.keys(s.objectives)))]
for (const scenario of manifest.scenarios) {
  const bytes = readFileSync(scenario.png)
  if (createHash('sha256').update(bytes).digest('hex') !== scenario.sha256) throw new Error(`PNG digest mismatch: ${scenario.id}`)
  if (!scenario.source || objectives.some((key) => !Number.isFinite(scenario.objectives[key]))) throw new Error(`Missing source/objective: ${scenario.id}`)
}
const evaluator = createExternalTextEvaluator({
  input: {
    baselineSurface: 'retained-source',
    trainScenarios: manifest.scenarios,
    selectionScenarios: [],
    dispatchWithSurface: async (_surface, scenario: RetainedScenario) => scenario,
    judges: [{
      name: 'retained-measurements',
      dimensions: objectives.map((key) => ({ key, description: 'Higher-is-better retained deterministic measurement' })),
      score: ({ artifact }: { artifact: RetainedScenario }) => ({
        dimensions: artifact.objectives,
        composite: Object.values(artifact.objectives).reduce((a, b) => a + b, 0) / objectives.length,
        notes: `Retained measurement replay: ${artifact.source}. No new generation or taste judgment.`,
      }),
    }],
    runDir: root, seed: 1, runOptions: { expectUsage: 'off', resumable: false }, costLedger: ledger,
  },
  label: 'Creative matrix retained proof', runDir: root, compatibleRunId: 'retained-artifacts',
  costPhase: 'retained-proof', costLedger: ledger,
  scenarioById: new Map(manifest.scenarios.map((s) => [s.id, s])),
  maxCandidateChars: 1_000, maxEvidenceChars: 8_000_000,
  describeArtifact: (artifact: RetainedScenario) => ({
    source: artifact.source, sha256: artifact.sha256,
    image: { type: 'image', mimeType: 'image/png', data: readFileSync(artifact.png).toString('base64') },
  }),
})
const responses = []
for (const scenario of manifest.scenarios) {
  const response = await evaluator({ candidate: 'retained-source', exampleId: scenario.id })
  if (response.info.status !== 'scored') throw new Error(`Unscored case: ${scenario.id}`)
  responses.push(response)
}
const evidencePath = resolve(root, 'evaluations.json')
writeFileSync(evidencePath, JSON.stringify(responses))
const child = spawnSync(python, ['-m', 'agent_eval_rpc.gepa_bridge_proof', evidencePath, root], {
  env: { PATH: process.env.PATH, PYTHONPATH: resolve('clients/python/src'), PYTHONNOUSERSITE: '1' },
  encoding: 'utf8', timeout: 120_000, maxBuffer: 1_000_000,
})
writeFileSync(resolve(root, 'gepa.log'), `${child.stdout}\n${child.stderr}`)
if (child.status !== 0) throw new Error(`GEPA artifact proof failed: ${child.stderr || child.error}`)
let cost: unknown = { status: 'UNMEASURED', reason: 'No retained seat usage receipt supplied' }
if (manifest.receipt) {
  if (!manifest.receiptSource) throw new Error('Retained usage needs a source')
  const receipt = manifest.receipt
  const costBreakdown = await measureCampaignCost({
    ...(receipt.actualCostUsd === undefined ? {} : { routerUsd: receipt.actualCostUsd }),
    sandbox: manifest.sandbox, seat: { model: receipt.model, usage: receipt },
  })
  const settled = await ledger.runPaidCall({
    actor: 'retained-seat-receipt', channel: 'agent', phase: 'retained-proof',
    execute: async () => receipt,
    receipt: () => ({ ...receipt, costBreakdown }),
  })
  if (!settled.succeeded) throw settled.error
  cost = { source: manifest.receiptSource, costBreakdown, receipt: settled.receipt, summary: ledger.summary() }
}
writeFileSync(resolve(root, 'cost.json'), JSON.stringify(cost, null, 2))
console.log(`Retained ${responses.length}-scenario bridge proof saved to ${root}; model requests: 0`)
