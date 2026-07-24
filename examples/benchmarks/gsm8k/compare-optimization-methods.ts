/**
 * Compare official GEPA and SkillOpt on GSM8K with separate train,
 * selection, and final data. Candidate generation uses a model endpoint; final
 * scoring uses deterministic numeric answer matching.
 *
 * Run with an OpenAI-compatible endpoint:
 *   AGENT_EVAL_GSM8K_PATH=~/.cache/agent-eval/gsm8k.jsonl \
 *   LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=$DEEPSEEK_API_KEY \
 *   LLM_MODEL=deepseek-v4-pro \
 *   pnpm tsx examples/benchmarks/gsm8k/compare-optimization-methods.ts
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareOptimizationMethods,
  type DispatchContext,
  gepaOptimizationMethod,
  type JudgeConfig,
  type OptimizationMethod,
  type Scenario,
  skillOptOptimizationMethod,
} from '../../../src/campaign'
import { CostLedger } from '../../../src/cost-ledger'
import {
  assertRealBackend,
  summarizeBackendIntegrity,
} from '../../../src/integrity/backend-integrity'
import {
  callLlm,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from '../../../src/llm-client'
import type { RunRecord } from '../../../src/run-record'
import {
  optionalNonNegativeNumberEnv,
  positiveIntegerEnv,
  positiveNumberEnv,
} from '../../_shared/env'
import { assertMatchedMethodLimits } from '../../_shared/matched-method-limits'
import { optimizerModelBudgetFromEnv } from '../../_shared/optimizer-model-budget'
import { evaluate, loadDataset } from './index'

const API_KEY = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
const BASE_URL = (
  process.env.LLM_BASE_URL ||
  process.env.TANGLE_ROUTER_URL ||
  'https://router.tangle.tools/v1'
).trim()
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-pro'
const PRICE_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_IN_PER_M')
const PRICE_CACHED_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_CACHED_IN_PER_M')
const PRICE_CACHE_WRITE_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_CACHE_WRITE_IN_PER_M')
const PRICE_OUT_PER_M = optionalNonNegativeNumberEnv('PRICE_OUT_PER_M')
const CALL_TIMEOUT_MS = positiveIntegerEnv('CALL_TIMEOUT_MS', 60_000)
const TRAIN_N = positiveIntegerEnv('TRAIN_N', 8)
const SELECTION_N = positiveIntegerEnv('SELECTION_N', 8)
const TEST_N = positiveIntegerEnv('TEST_N', 20)
const OPTIMIZER_PYTHON = process.env.OPTIMIZER_PYTHON?.trim() || 'python'
const OPTIMIZER_API_KEY = (process.env.OPTIMIZER_API_KEY || API_KEY)?.trim()
const OPTIMIZER_BASE_URL = (process.env.OPTIMIZER_BASE_URL || BASE_URL).trim()
const GEPA_MODEL = process.env.GEPA_MODEL || MODEL
const GEPA_MAX_PROPOSER_COST_USD = positiveNumberEnv('GEPA_MAX_PROPOSER_COST_USD', 10)
const SKILLOPT_MODEL = process.env.SKILLOPT_MODEL || MODEL
const SKILLOPT_EPOCHS = positiveIntegerEnv('SKILLOPT_EPOCHS', 2)
const SKILLOPT_BATCH_SIZE = positiveIntegerEnv('SKILLOPT_BATCH_SIZE', 4)
const SKILLOPT_CORE_EVALUATIONS =
  SELECTION_N +
  SKILLOPT_EPOCHS * Math.ceil(TRAIN_N / SKILLOPT_BATCH_SIZE) * (SKILLOPT_BATCH_SIZE + SELECTION_N)
const SKILLOPT_MAX_EVALUATIONS = positiveIntegerEnv(
  'SKILLOPT_MAX_EVALUATIONS',
  SKILLOPT_CORE_EVALUATIONS,
)
const GEPA_MAX_EVALUATIONS = positiveIntegerEnv('GEPA_MAX_EVALUATIONS', SKILLOPT_CORE_EVALUATIONS)
const OPTIMIZATION_CONCURRENCY = positiveIntegerEnv('OPTIMIZATION_CONCURRENCY', 1)
const TASK_CONCURRENCY = positiveIntegerEnv('TASK_CONCURRENCY', 2)
const REPS = positiveIntegerEnv('REPS', 1)
const MAX_SMOKE_COST_USD = positiveNumberEnv('MAX_SMOKE_COST_USD', 2)
const MAX_OPTIMIZATION_COST_USD = positiveNumberEnv('MAX_OPTIMIZATION_COST_USD', 10)
const MAX_TEST_COST_USD = positiveNumberEnv('MAX_TEST_COST_USD', 5)
const SMOKE = process.env.SMOKE === '1'
const SEED = 42
const RESAMPLES = 4_000
const CONFIDENCE = 0.95
const WORKER_MAX_TOKENS = 1_024

if ((PRICE_IN_PER_M === undefined) !== (PRICE_OUT_PER_M === undefined)) {
  throw new Error('PRICE_IN_PER_M and PRICE_OUT_PER_M must be set together')
}
if (
  PRICE_IN_PER_M === undefined &&
  (PRICE_CACHED_IN_PER_M !== undefined || PRICE_CACHE_WRITE_IN_PER_M !== undefined)
) {
  throw new Error('Cache token rates require PRICE_IN_PER_M and PRICE_OUT_PER_M')
}
const CUSTOM_TOKEN_PRICING =
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

if (!API_KEY) {
  console.error('FATAL: set LLM_API_KEY (+ LLM_BASE_URL + LLM_MODEL) or TANGLE_API_KEY.')
  process.exit(1)
}
if (!OPTIMIZER_API_KEY) {
  throw new Error('Set OPTIMIZER_API_KEY or LLM_API_KEY for GEPA and SkillOpt.')
}
const optimizerApiKey = OPTIMIZER_API_KEY
if (SKILLOPT_MAX_EVALUATIONS < SKILLOPT_CORE_EVALUATIONS) {
  throw new Error(`SKILLOPT_MAX_EVALUATIONS must be at least ${SKILLOPT_CORE_EVALUATIONS}`)
}
assertMatchedMethodLimits(
  ['gepa', 'skillopt'],
  { gepa: GEPA_MAX_EVALUATIONS, skillopt: SKILLOPT_MAX_EVALUATIONS },
  'Candidate-task evaluation limits',
)

// This intentionally weak baseline leaves room for instruction optimization.
const BASELINE_SURFACE =
  'You answer math questions. Reply with only the final number, without working or units.'

const DRIVER_TARGET =
  'a system prompt that maximizes correct final answers on grade-school math word problems ' +
  '(GSM8K), scored by exact numeric match of the final answer'

interface GsmScenario extends Scenario {
  question: string
  answer: string
}
interface Artifact {
  text: string
}

const llm: LlmClientOptions = {
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  maxRetries: 2,
  defaultTimeoutMs: CALL_TIMEOUT_MS,
  ...(CUSTOM_TOKEN_PRICING ? { customTokenPricing: CUSTOM_TOKEN_PRICING } : {}),
}

const records: RunRecord[] = []

function makeWorker() {
  return async function dispatchWithSurface(
    surface: string,
    scenario: GsmScenario,
    ctx: DispatchContext,
  ): Promise<Artifact> {
    const request: LlmCallRequest = {
      model: MODEL,
      messages: [
        { role: 'system', content: surface },
        { role: 'user', content: scenario.question },
      ],
      temperature: 0,
      maxTokens: WORKER_MAX_TOKENS,
      timeoutMs: CALL_TIMEOUT_MS,
    }
    const paid = await ctx.cost.runPaidCall({
      actor: 'worker',
      model: MODEL,
      maximumCharge: maximumChargeForLlmRequest(request, llm),
      execute: (signal, callId) => callLlm(request, { ...llm, signal, idempotencyKey: callId }),
      receipt: costReceiptFromLlm,
      receiptFromError: costReceiptFromLlmError,
    })
    if (!paid.succeeded) throw paid.error
    const res = paid.value
    const costUsd = paid.receipt.costUsd
    records.push({
      runId: `${scenario.id}-${createHash('sha1').update(surface).digest('hex').slice(0, 8)}-${records.length}`,
      experimentId: 'gsm8k-proposer-comparison',
      candidateId: createHash('sha1').update(surface).digest('hex').slice(0, 12),
      seed: SEED,
      model: res.model || MODEL,
      promptHash: createHash('sha256').update(surface).digest('hex'),
      configHash: 'gsm8k-cot',
      commitSha: process.env.GIT_SHA ?? 'local',
      wallMs: res.durationMs,
      costUsd,
      tokenUsage: { input: res.usage.promptTokens, output: res.usage.completionTokens },
      outcome: { raw: {} },
      splitTag: (scenario.tags?.[0] as RunRecord['splitTag']) ?? 'search',
      scenarioId: scenario.id,
    })
    return { text: res.content }
  }
}

// The GSM8K adapter supplies deterministic numeric answer matching.
const judge: JudgeConfig<Artifact, GsmScenario> = {
  name: 'gsm8k-exact-match',
  dimensions: [{ key: 'correct', description: 'final numeric answer matches gold' }],
  async score({ artifact, scenario }) {
    const ev = await evaluate(
      { id: scenario.id, payload: { question: scenario.question, answer: scenario.answer } },
      artifact.text,
    )
    return { dimensions: { correct: ev.score }, composite: ev.score, notes: JSON.stringify(ev.raw) }
  },
}

const round = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000

async function main() {
  // Load + slice (sorted by id for a deterministic, auditable corpus).
  const toScenario = (
    it: { id: string; payload: { question: string; answer: string } },
    tag: string,
  ): GsmScenario => ({
    id: it.id,
    kind: 'gsm8k',
    tags: [tag],
    question: it.payload.question,
    answer: it.payload.answer,
  })
  const search = (await loadDataset('search')).sort((a, b) => a.id.localeCompare(b.id))
  const holdout = (await loadDataset('holdout')).sort((a, b) => a.id.localeCompare(b.id))
  const trainScenarios = search.slice(0, TRAIN_N).map((it) => toScenario(it, 'train'))
  const selectionScenarios = search
    .slice(TRAIN_N, TRAIN_N + SELECTION_N)
    .map((it) => toScenario(it, 'selection'))
  const testScenarios = holdout.slice(0, TEST_N).map((it) => toScenario(it, 'test'))
  if (
    trainScenarios.length < TRAIN_N ||
    selectionScenarios.length < SELECTION_N ||
    testScenarios.length < TEST_N
  ) {
    throw new Error(
      `GSM8K corpus too small: train ${trainScenarios.length}/${TRAIN_N}, selection ${selectionScenarios.length}/${SELECTION_N}, test ${testScenarios.length}/${TEST_N}. Stage more rows.`,
    )
  }

  const worker = makeWorker()
  const outputRoot = join(process.cwd(), '.evolve', 'benchmarks', 'gsm8k-proposer-comparison')
  const runRoot = join(outputRoot, String(Date.now()))
  mkdirSync(runRoot, { recursive: true })
  const startedAt = Date.now()

  console.log('GSM8K: official GEPA and SkillOpt')
  console.log(`  model=${MODEL}  base=${BASE_URL}`)
  console.log(
    `  train=${trainScenarios.length} selection=${selectionScenarios.length} final=${testScenarios.length}`,
  )

  // ── Baseline smoke on selection: confirm headroom without touching test. ──
  let baselineSmoke = 0
  const smokeLedger = new CostLedger(MAX_SMOKE_COST_USD)
  const smokeCost: DispatchContext['cost'] = {
    runPaidCall: (input) =>
      smokeLedger.runPaidCall({ ...input, channel: input.channel ?? 'agent', phase: 'smoke' }),
  }
  for (const sc of selectionScenarios) {
    const art = await worker(BASELINE_SURFACE, sc, {
      cellId: `smoke-${sc.id}`,
      cost: smokeCost,
    } as unknown as DispatchContext)
    baselineSmoke += (
      await judge.score({ artifact: art, scenario: sc } as Parameters<typeof judge.score>[0])
    ).composite
  }
  baselineSmoke /= selectionScenarios.length
  console.log(
    `  baseline selection accuracy = ${round(baselineSmoke)} ${baselineSmoke >= 0.85 ? '(low headroom)' : '(headroom available)'}`,
  )
  if (SMOKE) {
    console.log('SMOKE=1: baseline only, stopping before optimization.')
    return
  }

  const gepaModelBudget = optimizerModelBudgetFromEnv(
    'GEPA',
    MAX_OPTIMIZATION_COST_USD,
    CUSTOM_TOKEN_PRICING,
  )
  const skillOptModelBudget = optimizerModelBudgetFromEnv(
    'SKILLOPT',
    MAX_OPTIMIZATION_COST_USD,
    CUSTOM_TOKEN_PRICING,
  )
  const runner = {
    command: OPTIMIZER_PYTHON,
  }
  const methods: OptimizationMethod<GsmScenario, Artifact>[] = [
    gepaOptimizationMethod<GsmScenario, Artifact>({
      name: 'gepa',
      objective: DRIVER_TARGET,
      background: 'The candidate is the complete system prompt for the math worker.',
      evaluationId: 'gsm8k-exact-match',
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
        budget: gepaModelBudget,
      },
      describeScenario: (scenario) => ({
        question: scenario.question,
        expectedAnswer: scenario.answer,
      }),
      describeArtifact: (artifact) => ({ answer: artifact.text }),
      runner,
    }),
    skillOptOptimizationMethod<GsmScenario, Artifact>({
      name: 'skillopt',
      objective: DRIVER_TARGET,
      background: 'The candidate is the complete system prompt for the math worker.',
      evaluationId: 'gsm8k-exact-match',
      trainer: {
        epochs: SKILLOPT_EPOCHS,
        batchSize: SKILLOPT_BATCH_SIZE,
      },
      optimizer: {
        model: SKILLOPT_MODEL,
        baseUrl: OPTIMIZER_BASE_URL,
        apiKey: optimizerApiKey,
        budget: skillOptModelBudget,
      },
      maxEvaluations: SKILLOPT_MAX_EVALUATIONS,
      describeScenario: (scenario) => ({
        question: scenario.question,
        expectedAnswer: scenario.answer,
      }),
      describeArtifact: (artifact) => ({ answer: artifact.text }),
      runner,
    }),
  ]

  const comparison = await compareOptimizationMethods<GsmScenario, Artifact>({
    methods,
    baselineSurface: BASELINE_SURFACE,
    trainScenarios,
    selectionScenarios,
    testScenarios,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as GsmScenario, ctx),
    judges: [judge],
    runDir: join(runRoot, 'comparison'),
    seed: SEED,
    reps: REPS,
    resamples: RESAMPLES,
    confidence: CONFIDENCE,
    optimizationConcurrency: OPTIMIZATION_CONCURRENCY,
    maxConcurrency: TASK_CONCURRENCY,
    optimizationRunOptions: {
      costCeiling: MAX_OPTIMIZATION_COST_USD,
      dispatchTimeoutMs: CALL_TIMEOUT_MS,
      maxConcurrency: TASK_CONCURRENCY,
      expectUsage: 'assert',
    },
    costCeiling: MAX_TEST_COST_USD,
    dispatchTimeoutMs: CALL_TIMEOUT_MS,
    expectUsage: 'assert',
  })

  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })
  const best = comparison.best
  const baselineSmokeCostUsd = smokeLedger.summary().totalCostUsd
  const totalCostUsd = baselineSmokeCostUsd + comparison.totalCost.totalCostUsd
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
  const testResult =
    integrity.verdict === 'real' && best.liftCi.low > 0
      ? 'interval-above-zero'
      : 'interval-includes-zero-or-backend-invalid'

  const artifact = {
    task: {
      corpus: 'gsm8k',
      judge: 'deterministic-exact-match',
      trainN: trainScenarios.length,
      selectionN: selectionScenarios.length,
      testN: testScenarios.length,
      trainScenarioIds: trainScenarios.map(({ id }) => id),
      selectionScenarioIds: selectionScenarios.map(({ id }) => id),
      testScenarioIds: comparison.testScenarioIds,
    },
    models: {
      worker: { model: MODEL, baseUrl: BASE_URL },
      optimizers: {
        python: OPTIMIZER_PYTHON,
        baseUrl: OPTIMIZER_BASE_URL,
        gepa: { model: GEPA_MODEL, budget: gepaModelBudget },
        skillopt: { model: SKILLOPT_MODEL, budget: skillOptModelBudget },
      },
    },
    limits: {
      candidateTaskEvaluations: {
        gepa: GEPA_MAX_EVALUATIONS,
        skillopt: SKILLOPT_MAX_EVALUATIONS,
      },
      gepaMaxProposerCostUsd: GEPA_MAX_PROPOSER_COST_USD,
      skillOptTrainer: {
        epochs: SKILLOPT_EPOCHS,
        batchSize: SKILLOPT_BATCH_SIZE,
        coreEvaluations: SKILLOPT_CORE_EVALUATIONS,
      },
      smokeCostUsd: MAX_SMOKE_COST_USD,
      workerAndJudgeOptimizationCostUsd: MAX_OPTIMIZATION_COST_USD,
      finalCostUsd: MAX_TEST_COST_USD,
      worker: {
        requestTimeoutMs: CALL_TIMEOUT_MS,
        maxOutputTokens: WORKER_MAX_TOKENS,
        maxRetries: llm.maxRetries,
        temperature: 0,
        customTokenPricing: CUSTOM_TOKEN_PRICING ?? null,
      },
      repetitionsPerFinalCase: REPS,
      taskConcurrency: TASK_CONCURRENCY,
      optimizationConcurrency: OPTIMIZATION_CONCURRENCY,
    },
    costContext: {
      worker:
        'Provider-reported cost is used when present; otherwise configured token rates estimate cost.',
      optimizers:
        'Provider-reported cost is used when present; otherwise each optimizer budget rate estimates cost.',
      accountingComplete:
        'Every observed call was priced; this does not mean the amount was reconciled to an invoice.',
    },
    backendIntegrity: {
      verdict: integrity.verdict,
      realRecords: integrity.realRecords,
      stubRecords: integrity.stubRecords,
      inputTokens: integrity.totalInputTokens,
      outputTokens: integrity.totalOutputTokens,
      diagnosis: integrity.diagnosis,
    },
    baselineSelectionAccuracy: round(baselineSmoke),
    comparison: {
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
        durationMs: s.durationMs ?? null,
        provenance: s.provenance ?? null,
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
    },
    cost: {
      baselineSmoke: round6(baselineSmokeCostUsd),
      optimization: comparison.optimizationCost,
      test: comparison.testCost,
      comparisonTotal: comparison.totalCost,
      total: round6(totalCostUsd),
    },
    stats: {
      resamples: comparison.resamples,
      reps: comparison.reps,
      confidence: comparison.confidence,
      intervalConfidence: comparison.intervalConfidence,
      comparisonCount: comparison.comparisonCount,
      seed: comparison.seed,
    },
    provenance: {
      gitSha: process.env.GIT_SHA ?? 'local',
      publishedAt: new Date(startedAt).toISOString(),
      command: process.argv,
      workerLlmCalls: records.length,
      elapsedSec,
    },
    testResult,
  }

  const artifactPath = join(runRoot, 'comparison.json')
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
  writeFileSync(join(outputRoot, 'latest.json'), JSON.stringify(artifact, null, 2))

  console.log('GSM8K comparison results, ranked by test lift')
  for (const s of artifact.comparison.scores) {
    console.log(
      `  #${s.rank} ${s.name.padEnd(16)} lift=${s.lift >= 0 ? '+' : ''}${s.lift} CI[${s.liftCi.low}, ${s.liftCi.high}] baseline=${s.baselineComposite} winner=${s.winnerComposite} $${s.optimizationCost.totalCostUsd}`,
    )
  }
  console.log(
    `  backend=${integrity.verdict} (${records.length} calls, $${round6(totalCostUsd)}, ${elapsedSec}s)`,
  )
  console.log(
    `  cost: smoke=$${round6(baselineSmokeCostUsd)} optimization=$${round6(comparison.optimizationCost.totalCostUsd)} test=$${round6(comparison.testCost.totalCostUsd)}`,
  )
  console.log(`  best=${best.name} lift=${round(best.lift)} CI.low=${round(best.liftCi.low)}`)
  console.log(`  testResult=${testResult}`)
  console.log(`  artifact: ${artifactPath}`)
}

main().catch((err) => {
  console.error('GSM8K comparison failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
