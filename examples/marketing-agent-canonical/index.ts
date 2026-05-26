/**
 * # Canonical Phase-B demo — runnable end-to-end.
 *
 * What this is: a high-fidelity dry run of the design-partner pairing
 * built around a real multi-step marketing agent. Drive shows:
 *
 *   1. Baseline `runEval` across 15 marketing scenarios on the
 *      out-of-the-box system prompt.
 *   2. `runImprovementLoop` with `gepaDriver` + `defaultProductionGate`
 *      that mutates the final-pass system prompt over 3 generations.
 *   3. A markdown report showing baseline vs winner, per-scenario lift,
 *      gate decision, and the shipped prompt diff.
 *
 * The agent talks to ANY OpenAI-compatible endpoint via fetch.
 * Recommended: point at Tangle Router so every LLM call is routable +
 * billable on your side.
 *
 *   OPENAI_BASE_URL=https://router.tangle.tools/v1
 *   OPENAI_API_KEY=<your tangle router key>
 *   MODEL_ID=anthropic/claude-sonnet-4.6
 *   JUDGE_MODEL_ID=anthropic/claude-opus-4.7   # optional, stronger judge
 *   pnpm tsx examples/marketing-agent-canonical/index.ts
 *
 * Without env vars, runs against deterministic stubs so the wiring is
 * verifiable in CI; you just don't get a real lift.
 *
 * This IS the pairing kit demo. When the design partner says yes, you
 * swap their `Dispatch` in for `runMarketingAgent`, swap their judge
 * dimensions in for the `MARKETING_JUDGE_DIMENSIONS`, and run the same
 * loop on their use case — typically 4 hours start to finish.
 *
 * See `docs/phase-b-pairing-kit.md` for the partner-facing runbook.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Dispatch,
  defaultProductionGate,
  fsCampaignStorage,
  gepaDriver,
  runEval,
  runImprovementLoop,
} from '../../src/contract'
import type { CampaignResult } from '../../src/campaign/types'
import {
  type AgentConfig,
  type MarketingArtifact,
  DEFAULT_FINAL_PASS_SYSTEM_PROMPT,
  runMarketingAgent,
} from './agent'
import { buildMarketingJudge } from './judge'
import { MARKETING_SCENARIOS, type MarketingScenario } from './scenarios'

const apiKey = process.env.OPENAI_API_KEY
const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://router.tangle.tools/v1'
const model = process.env.MODEL_ID ?? 'anthropic/claude-sonnet-4.6'
const judgeModel = process.env.JUDGE_MODEL_ID ?? model

// Train / hold-out split — 4 scenarios held out for the gate so promotion
// signal is genuine out-of-distribution, not just memorized training.
const HOLDOUT_IDS = ['m05-healthtech-h1', 'm08-fitness-push', 'm11-dev-newsletter-subject', 'm15-saas-followup-subject']

function buildDispatch(finalPassSystemPrompt: string): Dispatch<MarketingScenario, MarketingArtifact> {
  const cfg: AgentConfig = { apiKey, baseUrl, model, finalPassSystemPrompt }
  return (scenario, ctx) => runMarketingAgent(scenario, cfg, ctx.signal)
}

function meanComposite(result: CampaignResult<MarketingArtifact, MarketingScenario>): number {
  const aggs = Object.values(result.aggregates.byScenario)
  return aggs.length === 0 ? 0 : aggs.reduce((s, a) => s + a.meanComposite, 0) / aggs.length
}

function formatScore(n: number): string {
  return n.toFixed(3).padStart(5, ' ')
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('Canonical Phase-B demo — marketing agent self-improvement loop')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`endpoint: ${baseUrl}`)
  console.log(`agent model: ${model}`)
  console.log(`judge model: ${judgeModel}`)
  console.log(`mode: ${apiKey ? 'LIVE (real LLM calls)' : 'STUB (heuristic — wiring check only)'}`)
  console.log(`scenarios: ${MARKETING_SCENARIOS.length} (${MARKETING_SCENARIOS.length - HOLDOUT_IDS.length} train + ${HOLDOUT_IDS.length} holdout)`)
  console.log('')

  const judge = buildMarketingJudge({ apiKey, baseUrl, model: judgeModel })
  const runRoot = join(process.cwd(), '.phase-b-runs', `${Date.now()}`)
  await mkdir(runRoot, { recursive: true })
  const storage = fsCampaignStorage()

  // ── Baseline ────────────────────────────────────────────────────
  console.log('─── Baseline ───')
  const baselineStart = Date.now()
  const baseline = await runEval<MarketingScenario, MarketingArtifact>({
    scenarios: MARKETING_SCENARIOS,
    dispatch: buildDispatch(DEFAULT_FINAL_PASS_SYSTEM_PROMPT),
    judges: [judge],
    storage,
    runDir: join(runRoot, 'baseline'),
    maxConcurrency: 3,
  })
  const baselineScore = meanComposite(baseline)
  console.log(`composite mean: ${formatScore(baselineScore)} (took ${((Date.now() - baselineStart) / 1000).toFixed(1)}s, $${baseline.aggregates.totalCostUsd.toFixed(4)})`)

  // Per-scenario baseline scores so the report can show lift per scenario.
  const baselineByScenario: Record<string, number> = {}
  for (const [id, agg] of Object.entries(baseline.aggregates.byScenario)) {
    baselineByScenario[id] = agg.meanComposite
  }

  if (!apiKey) {
    console.log('\nNo OPENAI_API_KEY — stopping after baseline (stub mode). Set the env vars at the top of this file to run the full improvement loop with real lift.')
    return
  }

  // ── Self-improvement loop ───────────────────────────────────────
  console.log('\n─── Self-improvement loop (gepaDriver + defaultProductionGate) ───')
  const trainScenarios = MARKETING_SCENARIOS.filter((s) => !HOLDOUT_IDS.includes(s.id))
  const holdoutScenarios = MARKETING_SCENARIOS.filter((s) => HOLDOUT_IDS.includes(s.id))
  console.log(`train: ${trainScenarios.length} scenarios (${trainScenarios.map((s) => s.id).join(', ')})`)
  console.log(`holdout: ${holdoutScenarios.length} scenarios (${holdoutScenarios.map((s) => s.id).join(', ')})`)
  console.log('')

  const improveStart = Date.now()
  const result = await runImprovementLoop<MarketingScenario, MarketingArtifact>({
    scenarios: trainScenarios,
    baselineSurface: DEFAULT_FINAL_PASS_SYSTEM_PROMPT,
    dispatchWithSurface: (surface, scenario, ctx) => {
      const prompt = typeof surface === 'string' ? surface : JSON.stringify(surface)
      return runMarketingAgent(scenario, { apiKey, baseUrl, model, finalPassSystemPrompt: prompt }, ctx.signal)
    },
    driver: gepaDriver({
      llm: { apiKey, baseUrl },
      model: judgeModel,
      target: 'final-pass system prompt for a multi-step marketing copy agent',
      mutationPrimitives: [
        'Tighten the hook rule: lead with the specific user outcome, not the category.',
        'Replace any generic adjective ("powerful", "seamless") with a specific verb or proof number.',
        'Anchor every claim in a brief.proofPoints item, not in the LLM\'s prior knowledge.',
        'Make the surface-length constraint a hard requirement, not a guideline.',
        'Match the audience\'s actual vocabulary (a CTO reads differently from a Product Hunt browser).',
      ],
    }),
    judges: [judge],
    populationSize: 2,
    maxGenerations: 3,
    holdoutScenarios,
    gate: defaultProductionGate({
      holdoutScenarios,
      deltaThreshold: 0.05,
    }),
    autoOnPromote: 'none',
    storage,
    runDir: join(runRoot, 'improve'),
    maxConcurrency: 3,
  })

  const baselineHoldout = meanComposite(result.baselineOnHoldout)
  const winnerHoldout = meanComposite(result.winnerOnHoldout)
  const lift = winnerHoldout - baselineHoldout
  const improveDuration = (Date.now() - improveStart) / 1000

  console.log(`\nGenerations explored: ${result.generations.length}`)
  console.log(`Gate decision:        ${result.gateResult.decision}`)
  console.log(`Holdout baseline:     ${formatScore(baselineHoldout)}`)
  console.log(`Holdout winner:       ${formatScore(winnerHoldout)} (Δ ${lift >= 0 ? '+' : ''}${lift.toFixed(3)})`)
  console.log(`Took ${improveDuration.toFixed(1)}s`)

  // ── Report ──────────────────────────────────────────────────────
  const reportPath = join(runRoot, 'phase-b-report.md')
  await writeFile(reportPath, buildReport({
    baselineScore,
    baselineByScenario,
    baselineOnHoldout: result.baselineOnHoldout,
    winnerOnHoldout: result.winnerOnHoldout,
    winnerSurface: result.winnerSurface,
    gateDecision: result.gateResult.decision,
    generations: result.generations.length,
    durationSec: improveDuration,
    holdoutScenarios,
  }))

  console.log(`\nReport: ${reportPath}`)
}

function buildReport(args: {
  baselineScore: number
  baselineByScenario: Record<string, number>
  baselineOnHoldout: CampaignResult<MarketingArtifact, MarketingScenario>
  winnerOnHoldout: CampaignResult<MarketingArtifact, MarketingScenario>
  winnerSurface: unknown
  gateDecision: string
  generations: number
  durationSec: number
  holdoutScenarios: MarketingScenario[]
}): string {
  const lines: string[] = []
  lines.push('# Phase-B canonical demo — report')
  lines.push('')
  lines.push(`- Endpoint: \`${baseUrl}\``)
  lines.push(`- Agent model: \`${model}\``)
  lines.push(`- Judge model: \`${judgeModel}\``)
  lines.push(`- Generations: ${args.generations}`)
  lines.push(`- Duration: ${args.durationSec.toFixed(1)}s`)
  lines.push(`- Gate decision: **${args.gateDecision}**`)
  lines.push('')

  lines.push('## Held-out scenarios — baseline vs winner')
  lines.push('')
  lines.push('| Scenario | Baseline | Winner | Δ |')
  lines.push('|---|---:|---:|---:|')
  for (const s of args.holdoutScenarios) {
    const b = args.baselineOnHoldout.aggregates.byScenario[s.id]?.meanComposite ?? 0
    const w = args.winnerOnHoldout.aggregates.byScenario[s.id]?.meanComposite ?? 0
    const d = w - b
    lines.push(`| \`${s.id}\` (${s.surface}) | ${b.toFixed(3)} | ${w.toFixed(3)} | ${d >= 0 ? '+' : ''}${d.toFixed(3)} |`)
  }
  lines.push('')

  const winnerSurfaceStr = typeof args.winnerSurface === 'string'
    ? args.winnerSurface
    : JSON.stringify(args.winnerSurface, null, 2)
  lines.push('## Shipped prompt (winner)')
  lines.push('')
  lines.push('```')
  lines.push(winnerSurfaceStr)
  lines.push('```')
  lines.push('')

  lines.push('## Original prompt (baseline)')
  lines.push('')
  lines.push('```')
  lines.push(DEFAULT_FINAL_PASS_SYSTEM_PROMPT)
  lines.push('```')

  return lines.join('\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
