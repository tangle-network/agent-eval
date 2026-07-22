/**
 * Compare three optimization methods on shared train, selection, and test
 * data. Candidate generation uses an OpenAI-compatible model endpoint; final
 * scoring uses deterministic exact matching.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BuiltinProposerEntryConfig,
  compareProposers,
  gepaParetoEntry,
  gepaReflectionEntry,
  skillOptEntry,
} from '../../src/campaign'
import { assertRealBackend, summarizeBackendIntegrity } from '../../src/integrity/backend-integrity'
import type { LlmClientOptions } from '../../src/llm-client'
import type { RunRecord } from '../../src/run-record'
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
const PRICE_IN_PER_M = Number(process.env.PRICE_IN_PER_M || '1')
const PRICE_OUT_PER_M = Number(process.env.PRICE_OUT_PER_M || '5')
const CALL_TIMEOUT_MS = 30_000
const POPULATION = Number(process.env.POPULATION || '2')
const GENERATIONS = Number(process.env.GENERATIONS || '2')
const EPOCHS = Number(process.env.EPOCHS || '3')
const SELECTION_N = 3
const TRAIN = SEARCH.slice(0, -SELECTION_N)
const SELECTION = SEARCH.slice(-SELECTION_N)
const TEST = HOLDOUT

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
  experimentId: 'compare-proposers-canonical',
})

const round = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000

async function main() {
  const runRoot = join(process.cwd(), '.evolve', 'compare-proposers-canonical', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })
  const startedAt = Date.now()

  console.log('compareProposers: gepa-reflection vs gepa-pareto vs skill-opt')
  console.log(`  model=${MODEL}  base=${BASE_URL}`)
  console.log(
    `  train=${TRAIN.length} selection=${SELECTION.length} test=${TEST.length}  pop=${POPULATION} gens=${GENERATIONS} epochs=${EPOCHS}`,
  )
  console.log()

  // Shared corpus + transport for all three optimizer entries.
  const config: BuiltinProposerEntryConfig<ExtractScenario, Artifact> = {
    baselineSurface: BASELINE_SURFACE,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as ExtractScenario, ctx),
    judges: [extractionJudge([...SEARCH, ...HOLDOUT])],
    llm,
    model: MODEL,
    target: PROPOSER_TARGET,
    mutationPrimitives: MUTATION_PRIMITIVES,
    runDir: join(runRoot, 'optimizers'),
    seed: 42,
    populationSize: POPULATION,
    maxGenerations: GENERATIONS,
    maxEpochs: EPOCHS,
  }

  const comparison = await compareProposers<ExtractScenario, Artifact>({
    proposers: [
      gepaReflectionEntry(config, 'gepa-reflection'),
      gepaParetoEntry(config, 'gepa-pareto'),
      skillOptEntry(config, 'skill-opt'),
    ],
    baselineSurface: BASELINE_SURFACE,
    trainScenarios: TRAIN,
    selectionScenarios: SELECTION,
    testScenarios: TEST,
    dispatchWithSurface: (surface, scenario, ctx) =>
      worker(String(surface), scenario as ExtractScenario, ctx),
    judges: [extractionJudge([...TRAIN, ...SELECTION, ...TEST])],
    runDir: join(runRoot, 'score'),
    seed: 42,
    resamples: 4000,
    confidence: 0.95,
    expectUsage: 'assert',
  })

  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })

  const best = comparison.best
  const testResult = best.liftCi.low > 0 ? 'positive' : 'inconclusive'
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
    testResult,
    publishedAt: new Date(startedAt).toISOString(),
  }

  const artifactPath = join(runRoot, 'lift-proposers.json')
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
  writeFileSync(
    join(process.cwd(), '.evolve', 'compare-proposers-canonical', 'latest.json'),
    JSON.stringify(artifact, null, 2),
  )

  console.log('Comparison results, ranked by test lift')
  for (const s of artifact.scores) {
    console.log(
      `  #${s.rank} ${s.name.padEnd(16)} lift=${s.lift >= 0 ? '+' : ''}${s.lift}  ` +
        `CI[${s.liftCi.low}, ${s.liftCi.high}]  baseline=${s.baselineComposite} winner=${s.winnerComposite}  $${s.costUsd}`,
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
  console.log(`  total cost           : $${round6(totalCostUsd)}`)
  console.log(`  elapsed              : ${elapsedSec}s`)
  console.log(
    `  best method          : ${best.name} (lift=${round(best.lift)}, CI.low=${round(best.liftCi.low)})`,
  )
  console.log(`  test result          : ${testResult}`)
  console.log(`  artifact: ${artifactPath}`)
}

main().catch((err) => {
  console.error('compareProposers failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
