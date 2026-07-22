/**
 * GSM8K substrate proof — the empirical headline: do the optimization proposers move
 * a REAL untouched-test number on a HARD task (no ceiling), with a clean CI? Extraction
 * ceilings on a strong model (gepa 0.625→1.0, 0 findings); GSM8K with a
 * deliberately weak baseline (no chain-of-thought) leaves genuine headroom that
 * the optimizer recovers by evolving the system prompt (inject CoT + answer-format
 * discipline). DETERMINISTIC numeric judge (gsm8k/index.ts `evaluate`) → zero
 * LLM-judge variance, so the lift CI is defensible.
 *
 * Proposers compete head-to-head through `compareProposers`: gepa-reflection,
 * gepa-pareto, skill-opt — each returns its promoted surface, all scored on the
 * SAME untouched test split with paired-bootstrap lift CIs + pairwise ranking.
 * `assertRealBackend` aborts a stub run; the artifact records integrity honestly.
 *
 * This run does NOT wire `analyzeGeneration` — GSM8K failures are per-problem, so
 * findings carry little (the findings-value claim rides on the AppWorld-d3 runner).
 * Here the claim is: the substrate moves a real held-out lift on a hard task.
 *
 * Run (DeepSeek, rate-limit-free; deepseek-v4-pro is the explicit listed id):
 *   AGENT_EVAL_GSM8K_PATH=~/.cache/agent-eval/gsm8k.jsonl \
 *   LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=$DEEPSEEK_API_KEY \
 *   LLM_MODEL=deepseek-v4-pro PRICE_IN_PER_M=0.27 PRICE_OUT_PER_M=1.10 \
 *   pnpm tsx examples/benchmarks/gsm8k/compare-proposers.ts
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BuiltinProposerEntryConfig,
  compareProposers,
  type DispatchContext,
  gepaParetoEntry,
  gepaReflectionEntry,
  type JudgeConfig,
  type Scenario,
  skillOptEntry,
} from '../../../src/campaign'
import { CostLedger } from '../../../src/cost-ledger'
import {
  assertRealBackend,
  summarizeBackendIntegrity,
} from '../../../src/integrity/backend-integrity'
import {
  callLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from '../../../src/llm-client'
import type { RunRecord } from '../../../src/run-record'
import { evaluate, loadDataset } from './index'

const API_KEY = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
const BASE_URL = (
  process.env.LLM_BASE_URL ||
  process.env.TANGLE_ROUTER_URL ||
  'https://router.tangle.tools/v1'
).trim()
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-pro'
const PRICE_IN_PER_M = Number(process.env.PRICE_IN_PER_M || '0.27')
const PRICE_OUT_PER_M = Number(process.env.PRICE_OUT_PER_M || '1.10')
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS || '60000')
const TRAIN_N = Number(process.env.TRAIN_N || '8')
const SELECTION_N = Number(process.env.SELECTION_N || '8')
const TEST_N = Number(process.env.TEST_N || '20')
const POPULATION = Number(process.env.POPULATION || '2')
const GENERATIONS = Number(process.env.GENERATIONS || '2')
const EPOCHS = Number(process.env.EPOCHS || '2')
const SMOKE = process.env.SMOKE === '1'

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
      receipt: (res) => ({
        model: res.model || MODEL,
        inputTokens: res.usage.promptTokens,
        outputTokens: res.usage.completionTokens,
        actualCostUsd:
          res.costUsd ??
          (res.usage.promptTokens / 1_000_000) * PRICE_IN_PER_M +
            (res.usage.completionTokens / 1_000_000) * PRICE_OUT_PER_M,
      }),
      receiptFromError: costReceiptFromLlmError,
    })
    if (!paid.succeeded) throw paid.error
    const res = paid.value
    const costUsd = paid.receipt.costUsd
    records.push({
      runId: `${scenario.id}-${createHash('sha1').update(surface).digest('hex').slice(0, 8)}-${records.length}`,
      experimentId: 'gsm8k-substrate-proof',
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
  const runRoot = join(process.cwd(), '.evolve', 'substrate-proof', 'gsm8k', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })
  const startedAt = Date.now()

  console.log('GSM8K substrate proof — gepa-reflection vs gepa-pareto vs skill-opt')
  console.log(`  model=${MODEL}  base=${BASE_URL}`)
  console.log(
    `  train=${trainScenarios.length} selection=${selectionScenarios.length} test=${testScenarios.length} pop=${POPULATION} gens=${GENERATIONS} epochs=${EPOCHS}`,
  )

  // ── Baseline smoke on selection: confirm headroom without touching test. ──
  let baselineSmoke = 0
  const smokeLedger = new CostLedger()
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

  const config: BuiltinProposerEntryConfig<GsmScenario, Artifact> = {
    baselineSurface: BASELINE_SURFACE,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as GsmScenario, ctx),
    judges: [judge],
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

  const comparison = await compareProposers<GsmScenario, Artifact>({
    proposers: [
      gepaReflectionEntry(config, 'gepa-reflection'),
      gepaParetoEntry(config, 'gepa-pareto'),
      skillOptEntry(config, 'skill-opt'),
    ],
    baselineSurface: BASELINE_SURFACE,
    trainScenarios,
    selectionScenarios,
    testScenarios,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as GsmScenario, ctx),
    judges: [judge],
    runDir: join(runRoot, 'score'),
    seed: 42,
    resamples: 4000,
    confidence: 0.95,
    expectUsage: 'assert',
  })

  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })
  const best = comparison.best
  const totalCostUsd = records.reduce((a, r) => a + r.costUsd, 0)
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
  const honestVerdict =
    integrity.verdict === 'real' && best.liftCi.low > 0 ? 'lift-proven' : 'no-measurable-lift'

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
    },
    findingsAblation: null,
    cost: { totalUsd: round6(totalCostUsd) },
    stats: { resamples: 4000, confidence: 0.95, seed: 42 },
    provenance: {
      gitSha: process.env.GIT_SHA ?? 'local',
      publishedAt: new Date(startedAt).toISOString(),
      command: 'examples/benchmarks/gsm8k/compare-proposers.ts',
      llmCalls: records.length,
      elapsedSec,
    },
    honestVerdict,
  }

  const artifactPath = join(runRoot, 'proof.json')
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
  writeFileSync(
    join(process.cwd(), '.evolve', 'substrate-proof', 'gsm8k', 'latest.json'),
    JSON.stringify(artifact, null, 2),
  )

  console.log('── GSM8K SUBSTRATE PROOF (ranked by held-out lift) ─────────')
  for (const s of artifact.comparison.scores) {
    console.log(
      `  #${s.rank} ${s.name.padEnd(16)} lift=${s.lift >= 0 ? '+' : ''}${s.lift} CI[${s.liftCi.low}, ${s.liftCi.high}] base=${s.baselineComposite}→win=${s.winnerComposite} $${s.costUsd}`,
    )
  }
  console.log(
    `  backend=${integrity.verdict} (${records.length} calls, $${round6(totalCostUsd)}, ${elapsedSec}s)`,
  )
  console.log(`  BEST=${best.name} lift=${round(best.lift)} CI.low=${round(best.liftCi.low)}`)
  console.log(`  VERDICT=${honestVerdict}`)
  console.log(`  artifact: ${artifactPath}`)
}

main().catch((err) => {
  console.error('GSM8K-PROOF FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
