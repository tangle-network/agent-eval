/**
 * Compare three prompt optimization methods on GSM8K with separate train,
 * selection, and test data. Candidate generation uses a model endpoint; final
 * scoring uses deterministic numeric answer matching.
 *
 * Run with an OpenAI-compatible endpoint:
 *   AGENT_EVAL_GSM8K_PATH=~/.cache/agent-eval/gsm8k.jsonl \
 *   LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=$DEEPSEEK_API_KEY \
 *   LLM_MODEL=deepseek-chat \
 *   pnpm tsx examples/benchmarks/gsm8k/compare-optimization-methods.ts
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BuiltinOptimizationMethodConfig,
  compareOptimizationMethods,
  type DispatchContext,
  gepaParetoMethod,
  gepaReflectionMethod,
  type JudgeConfig,
  type Scenario,
  skillOptMethod,
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
import { evaluate, loadDataset } from './index'

const API_KEY = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
const BASE_URL = (
  process.env.LLM_BASE_URL ||
  process.env.TANGLE_ROUTER_URL ||
  'https://router.tangle.tools/v1'
).trim()
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-pro'
const PRICE_IN_PER_M = optionalNonNegativeNumberEnv('PRICE_IN_PER_M')
const PRICE_OUT_PER_M = optionalNonNegativeNumberEnv('PRICE_OUT_PER_M')
const CALL_TIMEOUT_MS = positiveIntegerEnv('CALL_TIMEOUT_MS', 60_000)
const TRAIN_N = positiveIntegerEnv('TRAIN_N', 8)
const SELECTION_N = positiveIntegerEnv('SELECTION_N', 8)
const TEST_N = positiveIntegerEnv('TEST_N', 20)
const POPULATION = positiveIntegerEnv('POPULATION', 2)
const GENERATIONS = positiveIntegerEnv('GENERATIONS', 2)
const EPOCHS = positiveIntegerEnv('EPOCHS', 2)
const OPTIMIZATION_CONCURRENCY = positiveIntegerEnv('OPTIMIZATION_CONCURRENCY', 1)
const MAX_SMOKE_COST_USD = positiveNumberEnv('MAX_SMOKE_COST_USD', 2)
const MAX_OPTIMIZATION_COST_USD = positiveNumberEnv('MAX_OPTIMIZATION_COST_USD', 10)
const MAX_TEST_COST_USD = positiveNumberEnv('MAX_TEST_COST_USD', 5)
const SMOKE = process.env.SMOKE === '1'

if ((PRICE_IN_PER_M === undefined) !== (PRICE_OUT_PER_M === undefined)) {
  throw new Error('PRICE_IN_PER_M and PRICE_OUT_PER_M must be set together')
}
const CUSTOM_TOKEN_PRICING =
  PRICE_IN_PER_M === undefined || PRICE_OUT_PER_M === undefined
    ? undefined
    : { inputUsdPerMillion: PRICE_IN_PER_M, outputUsdPerMillion: PRICE_OUT_PER_M }

if (!API_KEY) {
  console.error('FATAL: set LLM_API_KEY (+ LLM_BASE_URL + LLM_MODEL) or TANGLE_API_KEY.')
  process.exit(1)
}

// The DELIBERATELY WEAK baseline — no chain-of-thought, terse answer. On
// multi-step GSM8K this scores well below ceiling, leaving real headroom for the
// optimizer to recover by adding reasoning scaffold + answer-format discipline.
const BASELINE_SURFACE =
  'You answer math questions. Reply with ONLY the final number — no working, no explanation, no units.'

const DRIVER_TARGET =
  'a system prompt that maximizes correct final answers on grade-school math word problems ' +
  '(GSM8K), scored by exact numeric match of the final answer'

const MUTATION_PRIMITIVES = [
  'instruct the model to reason step by step before answering',
  'require the final answer on its own line after the marker ####',
  'tell the model to recheck its arithmetic before finalizing',
  'instruct it to define variables and show intermediate sums',
]

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
      maxTokens: 1024,
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
      seed: 42,
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

// Deterministic exact-match judge — reuses the GSM8K adapter's `evaluate`.
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

  console.log('GSM8K: gepa-reflection vs gepa-pareto vs skill-opt')
  console.log(`  model=${MODEL}  base=${BASE_URL}`)
  console.log(
    `  train=${trainScenarios.length} selection=${selectionScenarios.length} test=${testScenarios.length} pop=${POPULATION} gens=${GENERATIONS} epochs=${EPOCHS}`,
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
    `  baseline selection accuracy = ${round(baselineSmoke)} ${baselineSmoke >= 0.85 ? '⚠ CEILING RISK (weaken the baseline)' : '(headroom OK)'}`,
  )
  if (SMOKE) {
    console.log('SMOKE=1 → baseline-only, stopping before the optimizer run.')
    return
  }

  const config: BuiltinOptimizationMethodConfig<GsmScenario, Artifact> = {
    llm,
    model: MODEL,
    target: DRIVER_TARGET,
    mutationPrimitives: MUTATION_PRIMITIVES,
    populationSize: POPULATION,
    maxGenerations: GENERATIONS,
    maxEpochs: EPOCHS,
  }

  const comparison = await compareOptimizationMethods<GsmScenario, Artifact>({
    methods: [
      gepaReflectionMethod(config, 'gepa-reflection'),
      gepaParetoMethod(config, 'gepa-pareto'),
      skillOptMethod(config, 'skill-opt'),
    ],
    baselineSurface: BASELINE_SURFACE,
    trainScenarios,
    selectionScenarios,
    testScenarios,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as GsmScenario, ctx),
    judges: [judge],
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
      testScenarioIds: comparison.testScenarioIds,
    },
    model: { worker: MODEL, proposer: MODEL, provider: 'deepseek', baseUrl: BASE_URL },
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
        findingsFed: false,
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
    },
    findingsAblation: null,
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
      command: 'examples/benchmarks/gsm8k/compare-optimization-methods.ts',
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
