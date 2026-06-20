/**
 * findings-ablation — the empirical gate for the EYES→HANDS wire (roadmap A1.1).
 * Runs the SAME gepa optimizer twice on the SAME extraction corpus, differing in
 * ONE thing: whether the analyst's diagnosis is fed to the proposer.
 *
 *   control   : gepa, ctx.findings stays empty (findings-blind).
 *   treatment : gepa + `analyzeGeneration` that, after each generation, derives a
 *               REAL finding from the eval — the systematically weakest field
 *               (per-dimension mean across the generation's candidates) — and
 *               feeds it to the next generation's propose(). No gold values leak;
 *               the finding names which field is worst and says "tighten its
 *               instruction", the same primitives the control already has.
 *
 * Both winners are scored on the SAME held-out split; the paired-bootstrap CI on
 * (treatment − control) per holdout scenario is the verdict. CI.low > 0 ⇒ feeding
 * the diagnosis measurably helps; CI straddling 0 ⇒ no measurable lift on this
 * task; CI.high < 0 ⇒ it hurt. Honest either way — a flat result means the
 * proposer's built-in bottom-trial evidence already covers what the finding adds.
 *
 * Deterministic exact-match judge (no LLM-judge variance) so the only moving part
 * is the optimizer. `assertRealBackend` aborts on a stub run.
 *
 * CAVEAT (measured 2026-06-01, deepseek-chat): a STRONG model saturates this
 * corpus — control reached holdout 1.0 and 0 findings fired, so the result is
 * "no-measurable-lift" by CEILING, not by the wire being inert. This task only
 * exercises per-scenario failures, which gepa's own bottom-trial evidence
 * already covers. To actually measure the wire's value, use a corpus with
 * CROSS-CUTTING failure patterns a per-trial view misses (behavioral/trace
 * findings — e.g. the AppWorld analyst loop), or a weaker model that does not
 * ceiling. The wire's MECHANISM is proven by the gepa/skill-opt unit tests; its
 * VALUE is task-dependent.
 *
 * Run (DeepSeek, rate-limit-free):
 *   LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=$DEEPSEEK_API_KEY \
 *   LLM_MODEL=deepseek-chat PRICE_IN_PER_M=0.27 PRICE_OUT_PER_M=1.10 \
 *   pnpm tsx examples/findings-ablation/index.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  campaignBreakdown,
  type DispatchContext,
  gepaProposer,
  type RunOptimizationOptions,
  runOptimization,
} from '../../src/campaign'
import { assertRealBackend, summarizeBackendIntegrity } from '../../src/integrity/backend-integrity'
import type { LlmClientOptions } from '../../src/llm-client'
import type { RunRecord } from '../../src/run-record'
import { pairedBootstrap } from '../../src/statistics'
import {
  type Artifact,
  BASELINE_SURFACE,
  type ExtractScenario,
  extractionJudge,
  HOLDOUT,
  MUTATION_PRIMITIVES,
  makeExtractionWorker,
  PROPOSER_TARGET,
  SEARCH,
} from '../_shared/extraction-task'

const API_KEY = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
const BASE_URL = (
  process.env.LLM_BASE_URL ||
  process.env.TANGLE_ROUTER_URL ||
  'https://router.tangle.tools/v1'
).trim()
const MODEL = process.env.LLM_MODEL || 'anthropic/claude-haiku-4-5'
const PRICE_IN_PER_M = Number(process.env.PRICE_IN_PER_M || '1')
const PRICE_OUT_PER_M = Number(process.env.PRICE_OUT_PER_M || '5')
const CALL_TIMEOUT_MS = 30_000
const POPULATION = Number(process.env.POPULATION || '2')
const GENERATIONS = Number(process.env.GENERATIONS || '3')

if (!API_KEY) {
  console.error('FATAL: set LLM_API_KEY (+ LLM_BASE_URL + LLM_MODEL) or TANGLE_API_KEY.')
  process.exit(1)
}

const llm: LlmClientOptions = {
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  maxRetries: 2,
  defaultTimeoutMs: CALL_TIMEOUT_MS,
}

const records: RunRecord[] = []
const worker = makeExtractionWorker({
  llm,
  model: MODEL,
  records,
  priceInPerMTokens: PRICE_IN_PER_M,
  priceOutPerMTokens: PRICE_OUT_PER_M,
  timeoutMs: CALL_TIMEOUT_MS,
  experimentId: 'findings-ablation',
})

const judge = extractionJudge([...SEARCH, ...HOLDOUT])
const round = (n: number) => Math.round(n * 1000) / 1000

/** A noop dispatch ctx for the standalone holdout scoring pass — the worker still
 *  appends a RunRecord (real tokens) so integrity stays verdictable. */
function scoringCtx(cellId: string): DispatchContext {
  return {
    cellId,
    cost: { observe: () => {}, observeTokens: () => {} },
  } as unknown as DispatchContext
}

/** Score a surface on the holdout split, per scenario, deterministically. */
async function scoreOnHoldout(surface: string): Promise<number[]> {
  const out: number[] = []
  for (const scenario of HOLDOUT) {
    const artifact = await worker(surface, scenario, scoringCtx(`holdout-${scenario.id}`))
    const scored = await judge.score({ artifact, scenario } as Parameters<typeof judge.score>[0])
    out.push(scored.composite)
  }
  return out
}

function makeProposer() {
  return gepaProposer({
    llm,
    model: MODEL,
    target: PROPOSER_TARGET,
    mutationPrimitives: MUTATION_PRIMITIVES,
  })
}

function optBase(runDir: string): RunOptimizationOptions<ExtractScenario, Artifact> {
  return {
    scenarios: SEARCH,
    baselineSurface: BASELINE_SURFACE,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as ExtractScenario, ctx),
    judges: [judge],
    proposer: makeProposer(),
    populationSize: POPULATION,
    maxGenerations: GENERATIONS,
    promoteTopK: 1,
    runDir,
    seed: 42,
  }
}

/** The honest finding producer: the systematically weakest field across this
 *  generation's candidates, derived purely from per-dimension eval means. */
function weakestDimensionFinding(
  candidates: Array<{ campaign: Parameters<typeof campaignBreakdown>[0] }>,
): unknown[] {
  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  for (const c of candidates) {
    for (const [dim, val] of Object.entries(campaignBreakdown(c.campaign).dimensions)) {
      sums[dim] = (sums[dim] ?? 0) + val
      counts[dim] = (counts[dim] ?? 0) + 1
    }
  }
  const means = Object.entries(sums)
    .map(([d, s]) => [d, s / (counts[d] ?? 1)] as const)
    .sort((a, b) => a[1] - b[1])
  const weakest = means[0]
  if (!weakest || weakest[1] >= 0.95) return [] // nothing systematically weak
  const [dim, mean] = weakest
  return [
    {
      severity: 'high',
      area: 'extraction',
      claim: `The '${dim}' field is the systematically weakest across this generation (mean ${mean.toFixed(2)} of 1.0); most scenario failures share it.`,
      recommended_action: `Tighten the surface's instruction for the '${dim}' field specifically — make its required format/value explicit and unambiguous.`,
    },
  ]
}

async function main() {
  const runRoot = join(process.cwd(), '.evolve', 'findings-ablation', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })
  const startedAt = Date.now()

  console.log('findings-ablation — gepa findings-BLIND vs findings-FED (same corpus, same seed)')
  console.log(`  model=${MODEL}  base=${BASE_URL}`)
  console.log(
    `  search=${SEARCH.length} holdout=${HOLDOUT.length} pop=${POPULATION} gens=${GENERATIONS}`,
  )
  console.log()

  // Control: findings-blind.
  console.log('▶ control (findings-blind) …')
  const control = await runOptimization<ExtractScenario, Artifact>(
    optBase(join(runRoot, 'control')),
  )

  // Treatment: findings-fed — the analyst re-diagnoses each generation.
  let producedFindings = 0
  console.log('▶ treatment (findings-fed) …')
  const treatment = await runOptimization<ExtractScenario, Artifact>({
    ...optBase(join(runRoot, 'treatment')),
    analyzeGeneration: async ({ candidates }) => {
      const f = weakestDimensionFinding(candidates)
      if (f.length > 0) producedFindings++
      return f
    },
  })

  // Score baseline + both winners on the SAME holdout, per scenario.
  const baselineHoldout = await scoreOnHoldout(BASELINE_SURFACE)
  const controlHoldout = await scoreOnHoldout(String(control.winnerSurface))
  const treatmentHoldout = await scoreOnHoldout(String(treatment.winnerSurface))

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  // Paired bootstrap on (treatment − control) per holdout scenario — the gate.
  const boot = pairedBootstrap(controlHoldout, treatmentHoldout, {
    confidence: 0.95,
    resamples: 4000,
    statistic: 'mean',
    seed: 1337,
  })

  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })
  const totalCostUsd = records.reduce((a, r) => a + r.costUsd, 0)
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)

  const verdict =
    boot.low > 0
      ? 'findings-help (CI clears zero)'
      : boot.high < 0
        ? 'findings-hurt (CI below zero)'
        : 'no-measurable-lift (CI straddles zero)'

  const artifact = {
    task: 'structured-field-extraction (deterministic exact-match judge)',
    hypothesis:
      'feeding the analyst diagnosis (ctx.findings) to gepa propose() raises held-out lift vs findings-blind',
    backend: { model: MODEL, baseUrl: BASE_URL, verdict: integrity.verdict },
    integrity: {
      verdict: integrity.verdict,
      realRecords: integrity.realRecords,
      stubRecords: integrity.stubRecords,
      totalInputTokens: integrity.totalInputTokens,
      totalOutputTokens: integrity.totalOutputTokens,
    },
    dataset: { search: SEARCH.length, holdout: HOLDOUT.length },
    findingsProducedDuringTreatment: producedFindings,
    holdout: {
      baselineMean: round(mean(baselineHoldout)),
      controlMean: round(mean(controlHoldout)),
      treatmentMean: round(mean(treatmentHoldout)),
      controlPerScenario: controlHoldout.map(round),
      treatmentPerScenario: treatmentHoldout.map(round),
    },
    liftFindingsFedVsBlind: {
      deltaMean: round(boot.mean),
      deltaMedian: round(boot.median),
      ci95: { low: round(boot.low), high: round(boot.high) },
      n: boot.n,
    },
    controlWinnerSurface: String(control.winnerSurface),
    treatmentWinnerSurface: String(treatment.winnerSurface),
    totalCostUsd: round(totalCostUsd),
    llmCalls: records.length,
    elapsedSec,
    verdict,
    publishedAt: new Date(startedAt).toISOString(),
  }

  const artifactPath = join(runRoot, 'lift-findings.json')
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
  writeFileSync(
    join(process.cwd(), '.evolve', 'findings-ablation', 'latest.json'),
    JSON.stringify(artifact, null, 2),
  )

  console.log('── FINDINGS ABLATION (held-out, paired bootstrap) ──────────')
  console.log(`  baseline mean   : ${artifact.holdout.baselineMean}`)
  console.log(`  control  mean   : ${artifact.holdout.controlMean}  (findings-blind)`)
  console.log(
    `  treatment mean  : ${artifact.holdout.treatmentMean}  (findings-fed, ${producedFindings} findings produced)`,
  )
  console.log(
    `  Δ (fed − blind) : ${artifact.liftFindingsFedVsBlind.deltaMean >= 0 ? '+' : ''}${artifact.liftFindingsFedVsBlind.deltaMean}  ` +
      `CI95[${artifact.liftFindingsFedVsBlind.ci95.low}, ${artifact.liftFindingsFedVsBlind.ci95.high}]  n=${boot.n}`,
  )
  console.log(
    `  backend         : ${integrity.verdict} (${records.length} calls, $${round(totalCostUsd)}, ${elapsedSec}s)`,
  )
  console.log(`  VERDICT         : ${verdict}`)
  console.log(`  artifact        : ${artifactPath}`)
}

main().catch((err) => {
  console.error('FINDINGS-ABLATION FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
