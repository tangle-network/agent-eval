/**
 * Compare three optimization methods on shared train, selection, and test
 * data. Candidate generation uses an OpenAI-compatible model endpoint; final
 * scoring uses deterministic exact matching.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BuiltinOptimizationMethodConfig,
  compareOptimizationMethods,
  gepaParetoMethod,
  gepaReflectionMethod,
  skillOptMethod,
} from '../../src/campaign'
import { assertRealBackend, summarizeBackendIntegrity } from '../../src/integrity/backend-integrity'
import type { LlmClientOptions } from '../../src/llm-client'
import type { RunRecord } from '../../src/run-record'
import { optionalNonNegativeNumberEnv, positiveIntegerEnv, positiveNumberEnv } from '../_shared/env'
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

// CI may provide unset variables as empty strings, so these defaults use `||`.
const API_KEY = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
const BASE_URL = (
  process.env.LLM_BASE_URL ||
  process.env.TANGLE_ROUTER_URL ||
  'https://router.tangle.tools/v1'
).trim()
const MODEL = process.env.LLM_MODEL || 'anthropic/claude-haiku-4-5'
const PRICE_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_IN_PER_M')
const PRICE_OUT_PER_M = optionalNonNegativeNumberEnv('PRICE_OUT_PER_M')
const CALL_TIMEOUT_MS = positiveIntegerEnv('CALL_TIMEOUT_MS', 30_000)
const POPULATION = positiveIntegerEnv('POPULATION', 2)
const GENERATIONS = positiveIntegerEnv('GENERATIONS', 2)
const EPOCHS = positiveIntegerEnv('EPOCHS', 3)
const OPTIMIZATION_CONCURRENCY = positiveIntegerEnv('OPTIMIZATION_CONCURRENCY', 1)
const MAX_OPTIMIZATION_COST_USD = positiveNumberEnv('MAX_OPTIMIZATION_COST_USD', 5)
const MAX_TEST_COST_USD = positiveNumberEnv('MAX_TEST_COST_USD', 2)
const SELECTION_N = 3
const TRAIN = SEARCH.slice(0, -SELECTION_N)
const SELECTION = SEARCH.slice(-SELECTION_N)
const TEST = HOLDOUT

if ((PRICE_IN_PER_M === undefined) !== (PRICE_OUT_PER_M === undefined)) {
  throw new Error('PRICE_IN_PER_M and PRICE_OUT_PER_M must be set together')
}
const CUSTOM_TOKEN_PRICING =
  PRICE_IN_PER_M === undefined || PRICE_OUT_PER_M === undefined
    ? undefined
    : { inputUsdPerMillion: PRICE_IN_PER_M, outputUsdPerMillion: PRICE_OUT_PER_M }

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
  ...(CUSTOM_TOKEN_PRICING ? { customTokenPricing: CUSTOM_TOKEN_PRICING } : {}),
}

const records: RunRecord[] = []
const worker = makeExtractionWorker({
  llm,
  model: MODEL,
  records,
  ...(PRICE_IN_PER_M === undefined || PRICE_OUT_PER_M === undefined
    ? {}
    : { priceInPerMTokens: PRICE_IN_PER_M, priceOutPerMTokens: PRICE_OUT_PER_M }),
  timeoutMs: CALL_TIMEOUT_MS,
  experimentId: 'compare-optimization-methods',
})

const round = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000

async function main() {
  const runRoot = join(process.cwd(), '.evolve', 'compare-optimization-methods', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })
  const startedAt = Date.now()

  console.log('Optimization methods: gepa-reflection vs gepa-pareto vs skill-opt')
  console.log(`  model=${MODEL}  base=${BASE_URL}`)
  console.log(
    `  train=${TRAIN.length} selection=${SELECTION.length} test=${TEST.length}  pop=${POPULATION} gens=${GENERATIONS} epochs=${EPOCHS}`,
  )
  console.log()

  // Settings that differ by optimization method.
  const config: BuiltinOptimizationMethodConfig<ExtractScenario, Artifact> = {
    llm,
    model: MODEL,
    target: PROPOSER_TARGET,
    mutationPrimitives: MUTATION_PRIMITIVES,
    populationSize: POPULATION,
    maxGenerations: GENERATIONS,
    maxEpochs: EPOCHS,
  }

  const comparison = await compareOptimizationMethods<ExtractScenario, Artifact>({
    methods: [
      gepaReflectionMethod(config, 'gepa-reflection'),
      gepaParetoMethod(config, 'gepa-pareto'),
      skillOptMethod(config, 'skill-opt'),
    ],
    baselineSurface: BASELINE_SURFACE,
    trainScenarios: TRAIN,
    selectionScenarios: SELECTION,
    testScenarios: TEST,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as ExtractScenario, ctx),
    judges: [extractionJudge([...TRAIN, ...SELECTION, ...TEST])],
    runDir: join(runRoot, 'comparison'),
    seed: 42,
    resamples: 4000,
    confidence: 0.95,
    optimizationConcurrency: OPTIMIZATION_CONCURRENCY,
    optimizationRunOptions: {
      costCeiling: MAX_OPTIMIZATION_COST_USD,
      dispatchTimeoutMs: CALL_TIMEOUT_MS,
      expectUsage: 'assert',
    },
    costCeiling: MAX_TEST_COST_USD,
    dispatchTimeoutMs: CALL_TIMEOUT_MS,
    expectUsage: 'assert',
  })

  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })

  const best = comparison.best
  const testResult = best.liftCi.low > 0 ? 'interval-above-zero' : 'interval-includes-zero'
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)

  const artifact = {
    task: 'structured-field-extraction (deterministic exact-match judge)',
    backend: { model: MODEL, baseUrl: BASE_URL, verdict: integrity.verdict },
    pricing: {
      source: PRICE_IN_PER_M === undefined ? 'provider-or-package-table' : 'environment',
      inPerMTokens: PRICE_IN_PER_M ?? null,
      outPerMTokens: PRICE_OUT_PER_M ?? null,
    },
    integrity: {
      verdict: integrity.verdict,
      realRecords: integrity.realRecords,
      stubRecords: integrity.stubRecords,
      totalInputTokens: integrity.totalInputTokens,
      totalOutputTokens: integrity.totalOutputTokens,
      diagnosis: integrity.diagnosis,
    },
    dataset: { train: TRAIN.length, selection: SELECTION.length, test: TEST.length },
    baselineSurface: BASELINE_SURFACE,
    testScenarioIds: comparison.testScenarioIds,
    scores: comparison.scores.map((s) => ({
      name: s.name,
      rank: s.rank,
      baselineComposite: round(s.baselineComposite),
      winnerComposite: round(s.winnerComposite),
      lift: round(s.lift),
      liftCi: { low: round(s.liftCi.low), high: round(s.liftCi.high) },
      scenarioScores: s.scenarioScores,
      optimizationCost: {
        totalCostUsd: round6(s.optimizationCost.totalCostUsd),
        accountingComplete: s.optimizationCost.accountingComplete,
        incompleteReasons: s.optimizationCost.incompleteReasons,
      },
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
    statistics: {
      seed: comparison.seed,
      resamples: comparison.resamples,
      reps: comparison.reps,
      confidence: comparison.confidence,
      intervalConfidence: comparison.intervalConfidence,
      comparisonCount: comparison.comparisonCount,
    },
    cost: {
      optimization: comparison.optimizationCost,
      test: comparison.testCost,
      total: comparison.totalCost,
    },
    workerLlmCalls: records.length,
    elapsedSec,
    testResult,
    publishedAt: new Date(startedAt).toISOString(),
  }

  const artifactPath = join(runRoot, 'comparison.json')
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
  writeFileSync(
    join(process.cwd(), '.evolve', 'compare-optimization-methods', 'latest.json'),
    JSON.stringify(artifact, null, 2),
  )

  console.log('Comparison results, ranked by test lift')
  for (const s of artifact.scores) {
    console.log(
      `  #${s.rank} ${s.name.padEnd(16)} lift=${s.lift >= 0 ? '+' : ''}${s.lift}  ` +
        `CI[${s.liftCi.low}, ${s.liftCi.high}]  baseline=${s.baselineComposite} winner=${s.winnerComposite}  $${s.optimizationCost.totalCostUsd}`,
    )
  }
  console.log('Best method compared with each other method')
  for (const p of artifact.pairwise) {
    console.log(
      `  ${p.a} - ${p.b}: delta=${p.deltaMean} CI[${p.ci.low}, ${p.ci.high}] favored=${p.favored}`,
    )
  }
  console.log('Run details')
  console.log(
    `  backend verdict      : ${integrity.verdict} (${integrity.totalInputTokens}in/${integrity.totalOutputTokens}out tokens, ${records.length} calls)`,
  )
  console.log(`  optimization cost    : $${round6(comparison.optimizationCost.totalCostUsd)}`)
  console.log(`  test cost            : $${round6(comparison.testCost.totalCostUsd)}`)
  console.log(`  total cost           : $${round6(comparison.totalCost.totalCostUsd)}`)
  console.log(`  elapsed              : ${elapsedSec}s`)
  console.log(
    `  best method          : ${best.name} (lift=${round(best.lift)}, CI.low=${round(best.liftCi.low)})`,
  )
  console.log(`  test result          : ${testResult}`)
  console.log(`  artifact: ${artifactPath}`)
}

main().catch((err) => {
  console.error('Optimization comparison failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
