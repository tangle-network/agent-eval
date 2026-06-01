/**
 * compareDrivers canonical — the REAL head-to-head: gepa-reflection vs
 * gepa-pareto vs skill-opt on ONE corpus through a real LLM backend, scored
 * UNIFORMLY on the held-out split, with paired-bootstrap lift CIs. This is the
 * empirical companion to the deterministic mechanism gate (the compareDrivers
 * unit tests in CI): the tests prove the harness ranks correctly; THIS proves
 * the optimizers move a real held-out number and tells us which wins.
 *
 * Provider-agnostic: defaults to the Tangle router, but any OpenAI-compatible
 * endpoint works — set LLM_BASE_URL + LLM_API_KEY + LLM_MODEL (+ optional
 * PRICE_IN_PER_M / PRICE_OUT_PER_M for an honest $cost). The backend is
 * recorded honestly in the artifact. `assertRealBackend` aborts on a stub
 * (zero-token) run, so a fake $0 lift can never be reported.
 *
 * Bounded: population 2 × 2 generations (gepa), 3 epochs (skill-opt), 8 search
 * + 6 held-out scenarios, deterministic exact-match judge (no LLM-judge
 * variance). Completes in a few minutes / cents.
 *
 * Run (DeepSeek example):
 *   LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=$DEEPSEEK_API_KEY \
 *   LLM_MODEL=deepseek-v4-pro PRICE_IN_PER_M=0.27 PRICE_OUT_PER_M=1.10 \
 *   pnpm tsx examples/compare-drivers-canonical/index.ts
 *
 * Run (Tangle router):
 *   TANGLE_API_KEY=$(cat /tmp/.tk) pnpm tsx examples/compare-drivers-canonical/index.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareDrivers,
  gepaParetoEntry,
  gepaReflectionEntry,
  type OptimizerEntryConfig,
  skillOptEntry,
} from '../../src/campaign'
import { assertRealBackend, summarizeBackendIntegrity } from '../../src/integrity/backend-integrity'
import type { LlmClientOptions } from '../../src/llm-client'
import type { RunRecord } from '../../src/run-record'
import {
  type Artifact,
  BASELINE_SURFACE,
  DRIVER_TARGET,
  type ExtractScenario,
  extractionJudge,
  HOLDOUT,
  MUTATION_PRIMITIVES,
  makeExtractionWorker,
  SEARCH,
} from '../_shared/extraction-task'

// ── Config (provider-agnostic) ────────────────────────────────────────────
// `||` (not `??`) throughout: CI passes empty strings for unset `vars`, and an
// empty BASE_URL / NaN price would corrupt the run — empty must fall through.
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
const GENERATIONS = Number(process.env.GENERATIONS || '2')
const EPOCHS = Number(process.env.EPOCHS || '3')

if (!API_KEY) {
  console.error(
    'FATAL: set LLM_API_KEY (+ LLM_BASE_URL + LLM_MODEL) or TANGLE_API_KEY for a live run.',
  )
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
  experimentId: 'compare-drivers-canonical',
})

const round = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000

async function main() {
  const runRoot = join(process.cwd(), '.evolve', 'compare-drivers-canonical', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })
  const startedAt = Date.now()

  console.log(
    'compareDrivers canonical — gepa-reflection vs gepa-pareto vs skill-opt, real backend',
  )
  console.log(`  model=${MODEL}  base=${BASE_URL}`)
  console.log(
    `  search=${SEARCH.length}  holdout=${HOLDOUT.length}  pop=${POPULATION} gens=${GENERATIONS} epochs=${EPOCHS}`,
  )
  console.log()

  // Shared corpus + transport for all three optimizer entries.
  const config: OptimizerEntryConfig<ExtractScenario, Artifact> = {
    baselineSurface: BASELINE_SURFACE,
    trainScenarios: SEARCH,
    holdoutScenarios: HOLDOUT,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as ExtractScenario, ctx),
    judges: [extractionJudge([...SEARCH, ...HOLDOUT])],
    llm,
    model: MODEL,
    target: DRIVER_TARGET,
    mutationPrimitives: MUTATION_PRIMITIVES,
    runDir: join(runRoot, 'optimizers'),
    seed: 42,
    populationSize: POPULATION,
    maxGenerations: GENERATIONS,
    maxEpochs: EPOCHS,
  }

  const comparison = await compareDrivers<ExtractScenario, Artifact>({
    drivers: [
      gepaReflectionEntry(config, 'gepa-reflection'),
      gepaParetoEntry(config, 'gepa-pareto'),
      skillOptEntry(config, 'skill-opt'),
    ],
    baselineSurface: BASELINE_SURFACE,
    holdoutScenarios: HOLDOUT,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as ExtractScenario, ctx),
    judges: [extractionJudge([...SEARCH, ...HOLDOUT])],
    runDir: join(runRoot, 'score'),
    seed: 42,
    resamples: 4000,
    confidence: 0.95,
    expectUsage: 'assert',
  })

  // ── Backend integrity: a benchmark on a stub is worthless. ─────────────
  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })

  const best = comparison.best
  // CI clears zero ⇒ a real measurable lift for the winning driver.
  const honestVerdict = best.liftCi.low > 0 ? 'lift-proven' : 'no-measurable-lift'
  const totalCostUsd = records.reduce((a, r) => a + r.costUsd, 0)
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)

  const artifact = {
    task: 'structured-field-extraction (deterministic exact-match judge)',
    backend: { model: MODEL, baseUrl: BASE_URL, verdict: integrity.verdict },
    pricing: { inPerMTokens: PRICE_IN_PER_M, outPerMTokens: PRICE_OUT_PER_M },
    integrity: {
      verdict: integrity.verdict,
      realRecords: integrity.realRecords,
      stubRecords: integrity.stubRecords,
      totalInputTokens: integrity.totalInputTokens,
      totalOutputTokens: integrity.totalOutputTokens,
      diagnosis: integrity.diagnosis,
    },
    dataset: { search: SEARCH.length, holdout: HOLDOUT.length },
    baselineSurface: BASELINE_SURFACE,
    holdoutScenarioIds: comparison.holdoutScenarioIds,
    scores: comparison.scores.map((s) => ({
      name: s.name,
      rank: s.rank,
      baselineComposite: round(s.baselineComposite),
      winnerComposite: round(s.winnerComposite),
      lift: round(s.lift),
      liftCi: { low: round(s.liftCi.low), high: round(s.liftCi.high) },
      costUsd: round6(s.costUsd),
      winnerSurface:
        typeof s.winnerSurface === 'string' ? s.winnerSurface : JSON.stringify(s.winnerSurface),
    })),
    best: {
      name: best.name,
      lift: round(best.lift),
      liftCi: { low: round(best.liftCi.low), high: round(best.liftCi.high) },
    },
    pairwise: comparison.pairwise.map((p) => ({
      a: p.a,
      b: p.b,
      deltaMean: round(p.deltaMean),
      ci: { low: round(p.low), high: round(p.high) },
      favored: p.favored,
    })),
    totalCostUsd: round6(totalCostUsd),
    llmCalls: records.length,
    elapsedSec,
    honestVerdict,
    publishedAt: new Date(startedAt).toISOString(),
  }

  const artifactPath = join(runRoot, 'lift-drivers.json')
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
  writeFileSync(
    join(process.cwd(), '.evolve', 'compare-drivers-canonical', 'latest.json'),
    JSON.stringify(artifact, null, 2),
  )

  console.log('── DRIVER COMPARISON (ranked by held-out lift) ─────────────')
  for (const s of artifact.scores) {
    console.log(
      `  #${s.rank} ${s.name.padEnd(16)} lift=${s.lift >= 0 ? '+' : ''}${s.lift}  ` +
        `CI[${s.liftCi.low}, ${s.liftCi.high}]  base=${s.baselineComposite}→win=${s.winnerComposite}  $${s.costUsd}`,
    )
  }
  console.log('── PAIRWISE (best vs others) ───────────────────────────────')
  for (const p of artifact.pairwise) {
    console.log(
      `  ${p.a} − ${p.b}: Δ=${p.deltaMean} CI[${p.ci.low}, ${p.ci.high}] → favored: ${p.favored}`,
    )
  }
  console.log('── INTEGRITY ───────────────────────────────────────────────')
  console.log(
    `  backend verdict      : ${integrity.verdict} (${integrity.totalInputTokens}in/${integrity.totalOutputTokens}out tokens, ${records.length} calls)`,
  )
  console.log(`  total cost           : $${round6(totalCostUsd)}`)
  console.log(`  elapsed              : ${elapsedSec}s`)
  console.log(
    `  BEST DRIVER          : ${best.name} (lift=${round(best.lift)}, CI.low=${round(best.liftCi.low)})`,
  )
  console.log(`  HONEST VERDICT       : ${honestVerdict}`)
  console.log(`  artifact: ${artifactPath}`)
}

main().catch((err) => {
  console.error('COMPARE-DRIVERS FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
