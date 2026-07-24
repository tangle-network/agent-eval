/**
 * Run official GEPA, official SkillOpt, or both on one extraction task.
 *
 * Required:
 *   LLM_API_KEY=$OPENAI_API_KEY
 *
 * Select methods:
 *   OPTIMIZERS=gepa
 *   OPTIMIZERS=skillopt
 *   OPTIMIZERS=gepa,skillopt
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  type OptimizationMethod,
  skillOptOptimizationMethod,
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
  makeExtractionWorker,
  PROPOSER_TARGET,
  SEARCH,
} from '../_shared/extraction-task'
import { assertMatchedMethodLimits } from '../_shared/matched-method-limits'
import { optimizerModelBudgetFromEnv } from '../_shared/optimizer-model-budget'

const API_KEY = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
const BASE_URL = (
  process.env.LLM_BASE_URL ||
  process.env.TANGLE_ROUTER_URL ||
  'https://api.openai.com/v1'
).trim()
const MODEL = process.env.LLM_MODEL || 'gpt-4.1-mini'
const OPTIMIZER_API_KEY = (process.env.OPTIMIZER_API_KEY || API_KEY)?.trim()
const OPTIMIZER_BASE_URL = (process.env.OPTIMIZER_BASE_URL || BASE_URL).trim()
const OPTIMIZER_PYTHON = process.env.OPTIMIZER_PYTHON?.trim() || 'python'
const GEPA_MODEL = process.env.GEPA_MODEL || MODEL
const SKILLOPT_MODEL = process.env.SKILLOPT_MODEL || MODEL
const PRICE_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_IN_PER_M')
const PRICE_CACHED_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_CACHED_IN_PER_M')
const PRICE_CACHE_WRITE_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_CACHE_WRITE_IN_PER_M')
const PRICE_OUT_PER_M = optionalNonNegativeNumberEnv('PRICE_OUT_PER_M')
const CALL_TIMEOUT_MS = positiveIntegerEnv('CALL_TIMEOUT_MS', 30_000)
const GEPA_MAX_PROPOSER_COST_USD = positiveNumberEnv('GEPA_MAX_PROPOSER_COST_USD', 5)
const SKILLOPT_EPOCHS = positiveIntegerEnv('SKILLOPT_EPOCHS', 2)
const SKILLOPT_BATCH_SIZE = positiveIntegerEnv('SKILLOPT_BATCH_SIZE', 2)
const OPTIMIZATION_CONCURRENCY = positiveIntegerEnv('OPTIMIZATION_CONCURRENCY', 1)
const MAX_RUN_COST_USD = positiveNumberEnv('MAX_RUN_COST_USD', 12)
const SELECTION_N = 3
const TRAIN = SEARCH.slice(0, -SELECTION_N)
const SELECTION = SEARCH.slice(-SELECTION_N)
const TEST = HOLDOUT
const SKILLOPT_CORE_EVALUATIONS =
  SELECTION.length +
  SKILLOPT_EPOCHS *
    Math.ceil(TRAIN.length / SKILLOPT_BATCH_SIZE) *
    (SKILLOPT_BATCH_SIZE + SELECTION.length)
const SKILLOPT_MAX_EVALUATIONS = positiveIntegerEnv(
  'SKILLOPT_MAX_EVALUATIONS',
  SKILLOPT_CORE_EVALUATIONS,
)
const GEPA_MAX_EVALUATIONS = positiveIntegerEnv('GEPA_MAX_EVALUATIONS', SKILLOPT_CORE_EVALUATIONS)

if (!API_KEY) {
  throw new Error('Set LLM_API_KEY, or TANGLE_API_KEY with TANGLE_ROUTER_URL, for the worker.')
}
if (!OPTIMIZER_API_KEY) {
  throw new Error('Set OPTIMIZER_API_KEY or LLM_API_KEY for GEPA and SkillOpt.')
}
const optimizerApiKey = OPTIMIZER_API_KEY
if ((PRICE_IN_PER_M === undefined) !== (PRICE_OUT_PER_M === undefined)) {
  throw new Error('PRICE_IN_PER_M and PRICE_OUT_PER_M must be set together')
}
if (
  PRICE_IN_PER_M === undefined &&
  (PRICE_CACHED_IN_PER_M !== undefined || PRICE_CACHE_WRITE_IN_PER_M !== undefined)
) {
  throw new Error('Cache token rates require PRICE_IN_PER_M and PRICE_OUT_PER_M')
}
if (SKILLOPT_MAX_EVALUATIONS < SKILLOPT_CORE_EVALUATIONS) {
  throw new Error(
    `SKILLOPT_MAX_EVALUATIONS must be at least ${SKILLOPT_CORE_EVALUATIONS} for this split and trainer plan`,
  )
}

const selectedNames = (process.env.OPTIMIZERS || 'gepa,skillopt')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
const unknownNames = selectedNames.filter((name) => name !== 'gepa' && name !== 'skillopt')
if (selectedNames.length === 0 || unknownNames.length > 0) {
  throw new Error(
    `OPTIMIZERS must contain gepa, skillopt, or both; received ${selectedNames.join(',') || 'nothing'}`,
  )
}
assertMatchedMethodLimits(
  selectedNames,
  { gepa: GEPA_MAX_EVALUATIONS, skillopt: SKILLOPT_MAX_EVALUATIONS },
  'Candidate-case evaluation limits',
)

const customTokenPricing =
  PRICE_IN_PER_M === undefined || PRICE_OUT_PER_M === undefined
    ? undefined
    : {
        inputUsdPerMillion: PRICE_IN_PER_M,
        ...(PRICE_CACHED_IN_PER_M === undefined
          ? {}
          : { cachedInputUsdPerMillion: PRICE_CACHED_IN_PER_M }),
        ...(PRICE_CACHE_WRITE_IN_PER_M === undefined
          ? {}
          : { cacheWriteUsdPerMillion: PRICE_CACHE_WRITE_IN_PER_M }),
        outputUsdPerMillion: PRICE_OUT_PER_M,
      }
const BILLING_NOTE =
  process.env.BILLING_NOTE?.trim() ||
  (customTokenPricing
    ? 'Declared token prices; provider billing was not independently reconciled.'
    : 'Provider-reported cost when available; package model pricing otherwise.')
const PRICE_SOURCE =
  process.env.PRICE_SOURCE?.trim() ||
  (customTokenPricing
    ? 'Caller-supplied PRICE_* environment variables.'
    : 'Provider usage cost or Agent Eval package model pricing.')
const gepaModelBudget = selectedNames.includes('gepa')
  ? optimizerModelBudgetFromEnv('GEPA', MAX_RUN_COST_USD, customTokenPricing)
  : undefined
const skillOptModelBudget = selectedNames.includes('skillopt')
  ? optimizerModelBudgetFromEnv('SKILLOPT', MAX_RUN_COST_USD, customTokenPricing)
  : undefined

const llm: LlmClientOptions = {
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  maxRetries: 2,
  defaultTimeoutMs: CALL_TIMEOUT_MS,
  ...(customTokenPricing ? { customTokenPricing } : {}),
}

const records: RunRecord[] = []
const worker = makeExtractionWorker({
  llm,
  model: MODEL,
  records,
  ...(customTokenPricing ? { customTokenPricing } : {}),
  timeoutMs: CALL_TIMEOUT_MS,
  experimentId: 'compare-official-optimization-methods',
})

const optimizerRunner = {
  command: OPTIMIZER_PYTHON,
}

function createMethods(): OptimizationMethod<ExtractScenario, Artifact>[] {
  const methods: OptimizationMethod<ExtractScenario, Artifact>[] = []
  if (selectedNames.includes('gepa')) {
    methods.push(
      gepaOptimizationMethod<ExtractScenario, Artifact>({
        name: 'gepa',
        objective: PROPOSER_TARGET,
        background:
          'The candidate is the complete system prompt for a transaction extraction agent.',
        evaluationId: 'transaction-extraction',
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: GEPA_MAX_EVALUATIONS,
            maxProposerCostUsd: GEPA_MAX_PROPOSER_COST_USD,
          },
        },
        optimizer: {
          model: GEPA_MODEL,
          baseUrl: OPTIMIZER_BASE_URL,
          apiKey: optimizerApiKey,
          budget: gepaModelBudget!,
        },
        describeScenario,
        describeArtifact,
        runner: optimizerRunner,
      }),
    )
  }
  if (selectedNames.includes('skillopt')) {
    methods.push(
      skillOptOptimizationMethod<ExtractScenario, Artifact>({
        name: 'skillopt',
        objective: PROPOSER_TARGET,
        background:
          'The candidate is the complete system prompt for a transaction extraction agent.',
        evaluationId: 'transaction-extraction',
        trainer: {
          epochs: SKILLOPT_EPOCHS,
          batchSize: SKILLOPT_BATCH_SIZE,
        },
        optimizer: {
          model: SKILLOPT_MODEL,
          baseUrl: OPTIMIZER_BASE_URL,
          apiKey: optimizerApiKey,
          budget: skillOptModelBudget!,
        },
        maxEvaluations: SKILLOPT_MAX_EVALUATIONS,
        describeScenario,
        describeArtifact,
        runner: optimizerRunner,
      }),
    )
  }
  return methods
}

function describeScenario(scenario: ExtractScenario) {
  return {
    input: scenario.text,
    expected: scenario.gold,
  }
}

function describeArtifact(artifact: Artifact) {
  return {
    output: artifact.text,
    parsed: artifact.parsed,
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

async function main() {
  const runRoot = join(process.cwd(), '.evolve', 'compare-optimization-methods', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })
  const startedAt = Date.now()
  const methods = createMethods()

  console.log(`Official optimization methods: ${methods.map((method) => method.name).join(', ')}`)
  console.log(`Worker model: ${MODEL}`)
  console.log(`Cases: train=${TRAIN.length} selection=${SELECTION.length} final=${TEST.length}`)

  const comparison = await compareOptimizationMethods<ExtractScenario, Artifact>({
    methods,
    baselineSurface: BASELINE_SURFACE,
    trainScenarios: TRAIN,
    selectionScenarios: SELECTION,
    testScenarios: TEST,
    dispatchWithSurface: (surface, scenario, ctx) => worker(String(surface), scenario, ctx),
    judges: [extractionJudge([...TRAIN, ...SELECTION, ...TEST])],
    runDir: join(runRoot, 'comparison'),
    seed: 42,
    resamples: 4000,
    confidence: 0.95,
    optimizationConcurrency: OPTIMIZATION_CONCURRENCY,
    optimizationRunOptions: {
      dispatchTimeoutMs: CALL_TIMEOUT_MS,
      expectUsage: 'assert',
    },
    costCeiling: MAX_RUN_COST_USD,
    dispatchTimeoutMs: CALL_TIMEOUT_MS,
    expectUsage: 'assert',
  })

  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
  const artifact = {
    task: 'transaction extraction with deterministic field scoring',
    backend: {
      model: MODEL,
      baseUrl: BASE_URL,
      verdict: integrity.verdict,
      calls: records.length,
      inputTokens: integrity.totalInputTokens,
      outputTokens: integrity.totalOutputTokens,
    },
    optimizer: {
      names: methods.map((method) => method.name),
      python: OPTIMIZER_PYTHON,
      baseUrl: OPTIMIZER_BASE_URL,
      gepaModel: selectedNames.includes('gepa') ? GEPA_MODEL : null,
      skillOptModel: selectedNames.includes('skillopt') ? SKILLOPT_MODEL : null,
    },
    accounting: {
      billingNote: BILLING_NOTE,
      priceSource: PRICE_SOURCE,
      worker: {
        providerReportedCostPreferred: true,
        fallback:
          customTokenPricing === undefined
            ? 'package-model-price-estimate'
            : 'configured-token-price-estimate',
        configuredTokenPricing: customTokenPricing ?? null,
      },
      optimizers: {
        gepa:
          gepaModelBudget === undefined
            ? null
            : {
                providerReportedCostPreferred: true,
                fallback: 'configured-token-price-estimate',
                configuredTokenPricing: gepaModelBudget.pricing,
              },
        skillopt:
          skillOptModelBudget === undefined
            ? null
            : {
                providerReportedCostPreferred: true,
                fallback: 'configured-token-price-estimate',
                configuredTokenPricing: skillOptModelBudget.pricing,
              },
      },
    },
    limits: {
      candidateCaseEvaluations: {
        gepa: selectedNames.includes('gepa') ? GEPA_MAX_EVALUATIONS : null,
        skillopt: selectedNames.includes('skillopt') ? SKILLOPT_MAX_EVALUATIONS : null,
      },
      allRunCostUsd: MAX_RUN_COST_USD,
      optimizerModels: {
        gepa: gepaModelBudget ?? null,
        skillopt: skillOptModelBudget ?? null,
      },
      optimizationConcurrency: OPTIMIZATION_CONCURRENCY,
      callTimeoutMs: CALL_TIMEOUT_MS,
    },
    dataset: { train: TRAIN.length, selection: SELECTION.length, final: TEST.length },
    scores: comparison.scores.map((score) => ({
      name: score.name,
      rank: score.rank,
      baselineComposite: round(score.baselineComposite),
      winnerComposite: round(score.winnerComposite),
      lift: round(score.lift),
      liftInterval: { low: round(score.liftCi.low), high: round(score.liftCi.high) },
      optimizationCost: {
        totalCostUsd: round6(score.optimizationCost.totalCostUsd),
        accountingComplete: score.optimizationCost.accountingComplete,
        incompleteReasons: score.optimizationCost.incompleteReasons,
      },
      durationMs: score.durationMs ?? null,
      provenance: score.provenance ?? null,
      winnerSurface: score.winnerSurface,
      scenarioScores: score.scenarioScores,
    })),
    pairwise: comparison.pairwise,
    statistics: {
      seed: comparison.seed,
      resamples: comparison.resamples,
      reps: comparison.reps,
      confidence: comparison.confidence,
      intervalConfidence: comparison.intervalConfidence,
      comparisonCount: comparison.comparisonCount,
    },
    cost: comparison.totalCost,
    elapsedSec,
    createdAt: new Date(startedAt).toISOString(),
  }

  const artifactPath = join(runRoot, 'comparison.json')
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
  writeFileSync(
    join(process.cwd(), '.evolve', 'compare-optimization-methods', 'latest.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )

  console.table(
    artifact.scores.map((score) => ({
      rank: score.rank,
      method: score.name,
      baseline: score.baselineComposite,
      winner: score.winnerComposite,
      lift: score.lift,
      low: score.liftInterval.low,
      high: score.liftInterval.high,
      optimizerCostUsd: score.optimizationCost.totalCostUsd,
      costComplete: score.optimizationCost.accountingComplete,
    })),
  )
  console.log(`Result: ${artifactPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
