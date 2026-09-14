import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  costFromLedgerSummary,
  type OptimizationMethod,
  runCampaign,
} from '@tangle-network/agent-eval/campaign'
import { type JudgeConfig, type Scenario, selfImprove } from '@tangle-network/agent-eval/contract'
import {
  defineEvaluationClaim,
  openFinalEvidenceLedger,
} from '@tangle-network/agent-eval/experiment'
import { canonicalString, hashCanonical } from '@tangle-network/agent-eval/ledger-core'
import { auditEvaluator } from '@tangle-network/agent-eval/meta-eval'

interface SumCase extends Scenario {
  sourceId: string
  left: number
  right: number
}
interface Answer {
  total: number
}
const runDir = resolve(process.argv[2] ?? '.agent-eval/evaluation-integrity-example')
mkdirSync(runDir, { recursive: true })

function correct(artifact: Answer, scenario: SumCase): boolean {
  return artifact.total === scenario.left + scenario.right
}
const judge: JudgeConfig<Answer, SumCase> = {
  name: 'sum',
  dimensions: [{ key: 'correct', description: 'The sum equals the reference' }],
  score: ({ artifact, scenario }) => {
    const value = Number(correct(artifact, scenario))
    return { composite: value, dimensions: { correct: value }, notes: '' }
  },
}
const evaluatorDigest = hashCanonical({ rule: correct.toString(), version: 'offline-sum-v1' })
const scenarios: SumCase[] = Array.from({ length: 40 }, (_, source) =>
  [0, 1].map((variant) => ({
    id: `task-${source}:${variant}`,
    kind: 'sum',
    sourceId: `source-${source}`,
    left: source,
    right: variant + 1,
  })),
).flat()

// Both candidates execute through the public evaluation path before selection.
const method: OptimizationMethod<SumCase, Answer> = {
  name: 'two-candidate-search',
  optimize: async (input) => {
    let selected = input.baselineSurface
    let best = -Infinity
    for (const surface of ['subtract', 'add']) {
      const result = await runCampaign({
        ...input.runOptions,
        scenarios: [...input.selectionScenarios],
        judges: [...input.judges],
        dispatch: (scenario, ctx) => input.dispatchWithSurface(surface, scenario, ctx),
        costLedger: input.costLedger,
        runDir: `${input.runDir}/${surface}`,
      })
      const mean =
        result.cells.reduce((sum, cell) => sum + cell.judgeScores.sum!.composite, 0) /
        result.cells.length
      if (mean > best) {
        best = mean
        selected = surface
      }
    }
    return { winnerSurface: selected, cost: costFromLedgerSummary(input.costLedger.summary()) }
  },
}

const controls = Array.from({ length: 100 }, (_, i) =>
  (['accept', 'reject'] as const).map((expected) => {
    const scenario: SumCase = {
      id: `audit-${i}`,
      kind: 'sum',
      sourceId: `audit-source-${i}`,
      left: i,
      right: 2,
    }
    return { scenario, artifact: { total: i + 2 + Number(expected === 'reject') }, expected }
  }),
).flat()
writeFileSync(`${runDir}/audit-controls.json`, `${canonicalString(controls)}\n`)
const evaluatorAudit = auditEvaluator({
  evaluatorDigest,
  population: 'Deterministic arithmetic controls',
  samplingFrame: 'One correct and one incorrect answer for each of 100 fixture sources',
  authority: {
    evaluatorAuthorId: 'fixture-author',
    auditorId: 'fixture-auditor',
    independenceEvidenceRef: 'offline-example:declared-roles-only',
  },
  policy: { confidence: 0.95, maxFalseAcceptanceRate: 0.05, maxFalseRejectionRate: 0.05 },
  observations: controls.map((control, i) => ({
    id: `control-${i}`,
    independentUnitId: control.scenario.sourceId,
    evidenceRef: hashCanonical(control),
    expected: control.expected,
    observed: correct(control.artifact, control.scenario) ? 'accept' : 'reject',
    exposure: 'fresh',
  })),
})
assert.equal(evaluatorAudit.verdict, 'admit')

const result = await selfImprove({
  scenarios,
  judge,
  method,
  baselineSurface: 'subtract',
  runDir,
  model: 'deterministic-arithmetic@2026-09-13',
  expectUsage: 'off',
  agent: async (surface, scenario) => ({
    total: surface === 'add' ? scenario.left + scenario.right : scenario.left - scenario.right,
  }),
  claim: defineEvaluationClaim({
    use: 'comparison',
    population: { id: 'arithmetic-fixtures', description: 'The deterministic fixture roster' },
    samplingFrame: 'Forty source tasks with two variants; no deployment population is sampled',
    independentUnit: 'sourceId',
    generalization: 'fixed-roster',
    minimumEffect: 0.05,
  }),
  finalEvidence: {
    ledger: openFinalEvidenceLedger({ path: `${runDir}/final-evidence.jsonl` }),
    requestId: 'arithmetic-comparison',
    evaluatorDigest,
  },
})
assert.equal(result.winner.surface, 'add')
assert.equal(result.lift, 1)
assert.equal(result.gateDecision, 'ship')
assert.equal(result.totalCostUsd, 0)
assert.ok(result.finalEvidence?.record.exposure)

const report = {
  purpose: 'Offline integration fixture; not evidence of general optimizer effectiveness',
  evaluatorAudit,
  claim: result.claim,
  finalEvidence: result.finalEvidence,
  winner: result.winner,
  lift: result.lift,
  gateDecision: result.gateDecision,
  totalCostUsd: result.totalCostUsd,
}
writeFileSync(`${runDir}/report.json`, `${canonicalString(report)}\n`)
console.log(`${runDir}/report.json`)
