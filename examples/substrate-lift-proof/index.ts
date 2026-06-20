/**
 * Substrate lift proof — the FIRST controlled-but-REAL demonstration that
 * `gepaDriver` + `runImprovementLoop` + `defaultProductionGate` produce a
 * measured held-out lift through a real LLM backend.
 *
 * The transaction-extraction corpus + deterministic judge + worker live in
 * `examples/_shared/extraction-task.ts` (shared with `compare-proposers-canonical`
 * so both measure the SAME task). This script runs the single-proposer gated
 * loop; `compare-proposers-canonical` runs the head-to-head of all proposers.
 *
 * Real backend: token-emitting via the Tangle router (or any OpenAI-compatible
 * endpoint). `assertRealBackend` over the per-call RunRecords must verdict
 * `real` or the proof aborts. Bounded by construction: 30s per-call timeout,
 * population 2 × 2 generations over 8 search scenarios.
 *
 * Run:
 *   TANGLE_API_KEY=$(cat /tmp/.tk) \
 *   TANGLE_ROUTER_URL=https://router.tangle.tools/v1 \
 *   pnpm tsx examples/substrate-lift-proof/index.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultProductionGate,
  emitLoopProvenance,
  fsCampaignStorage,
  gepaDriver,
  runImprovementLoop,
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

// ── Config ──────────────────────────────────────────────────────────────
const API_KEY = process.env.TANGLE_API_KEY?.trim()
const BASE_URL = process.env.TANGLE_ROUTER_URL?.trim() ?? 'https://router.tangle.tools/v1'
const WORKER_MODEL = process.env.PROOF_WORKER_MODEL ?? 'anthropic/claude-haiku-4-5'
const PROPOSER_MODEL = process.env.PROOF_PROPOSER_MODEL ?? 'anthropic/claude-haiku-4-5'
const CALL_TIMEOUT_MS = 30_000

if (!API_KEY) {
  console.error('FATAL: TANGLE_API_KEY is required (export TANGLE_API_KEY=$(cat /tmp/.tk)).')
  process.exit(1)
}

const llm: LlmClientOptions = {
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  maxRetries: 2,
  defaultTimeoutMs: CALL_TIMEOUT_MS,
}

// Haiku-4.5 public rate ($1/M in, $5/M out) so the artifact reports an honest
// spend when the proxy omits `_response_cost`.
const records: RunRecord[] = []
const worker = makeExtractionWorker({
  llm,
  model: WORKER_MODEL,
  records,
  priceInPerMTokens: 1,
  priceOutPerMTokens: 5,
  timeoutMs: CALL_TIMEOUT_MS,
  experimentId: 'substrate-lift-proof',
})

// ── Run the loop ────────────────────────────────────────────────────────────
async function main() {
  const runRoot = join(process.cwd(), '.evolve', 'substrate-lift-proof', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })

  const startedAt = Date.now()
  console.log('Substrate lift proof — GEPA proposer + defaultProductionGate, real router')
  console.log(`  worker=${WORKER_MODEL}  proposer=${PROPOSER_MODEL}  base=${BASE_URL}`)
  console.log(`  search=${SEARCH.length}  holdout=${HOLDOUT.length}`)
  console.log(`  baseline surface: ${JSON.stringify(BASELINE_SURFACE)}`)
  console.log()

  const proposer = gepaDriver({
    llm,
    model: PROPOSER_MODEL,
    target: PROPOSER_TARGET,
    mutationPrimitives: MUTATION_PRIMITIVES,
    temperature: 0.7,
    maxTokens: 2000,
  })

  const gate = defaultProductionGate<Artifact, ExtractScenario>({
    holdoutScenarios: HOLDOUT,
    deltaThreshold: 0.1,
    budgetUsd: 2,
  })

  const result = await runImprovementLoop<ExtractScenario, Artifact>({
    scenarios: SEARCH,
    holdoutScenarios: HOLDOUT,
    baselineSurface: BASELINE_SURFACE,
    dispatchWithSurface: (surface, scenario, ctx) => worker(String(surface), scenario, ctx),
    judges: [extractionJudge([...SEARCH, ...HOLDOUT])],
    proposer,
    populationSize: 2,
    maxGenerations: 2,
    promoteTopK: 1,
    gate,
    autoOnPromote: 'none',
    runDir: runRoot,
    maxConcurrency: 4,
    seed: 42,
  })

  // ── Backend integrity: the proof is worthless on a stub. ───────────────
  const integrity = summarizeBackendIntegrity(records)
  assertRealBackend(records, { allowMixed: false })

  // ── Provenance: emit the durable record + OTel spans, then re-derive the
  // held-out lift FROM the emitted record (not the in-memory return). ───────
  const { record: provenance, spans } = await emitLoopProvenance({
    runId: `substrate-lift-proof#${startedAt}`,
    runDir: runRoot,
    timestamp: new Date(startedAt).toISOString(),
    baselineSurface: BASELINE_SURFACE,
    winnerSurface: result.winnerSurface,
    winnerLabel: result.winnerLabel,
    winnerRationale: result.winnerRationale,
    diff: result.promotedDiff,
    generations: result.generations.map((g) => ({
      generationIndex: g.record.generationIndex,
      candidates: g.record.candidates,
      promoted: g.record.promoted,
      surfaces: g.surfaces.map((s) => ({ surfaceHash: s.surfaceHash, surface: s.surface })),
    })),
    gate: result.gateResult,
    baselineOnHoldout: result.baselineOnHoldout,
    winnerOnHoldout: result.winnerOnHoldout,
    workerRecords: records,
    totalCostUsd: records.reduce((a, r) => a + r.costUsd, 0),
    totalDurationMs: Date.now() - startedAt,
    storage: fsCampaignStorage(),
  })

  // ── Honest numbers ─────────────────────────────────────────────────────
  const baselineHeldOut = meanComposite(result.baselineOnHoldout)
  const candidateHeldOut = meanComposite(result.winnerOnHoldout)
  const delta = candidateHeldOut - baselineHeldOut
  const winnerSurface =
    typeof result.winnerSurface === 'string'
      ? result.winnerSurface
      : JSON.stringify(result.winnerSurface)
  const rewrote = winnerSurface !== BASELINE_SURFACE
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
  const totalCostUsd = records.reduce((a, r) => a + r.costUsd, 0)

  let honestVerdict: 'lift-proven' | 'no-lift-but-real' | 'blocked'
  if (delta > 0 && result.gateResult.decision === 'ship') honestVerdict = 'lift-proven'
  else honestVerdict = 'no-lift-but-real'

  const artifact = {
    task: 'structured-field-extraction (deterministic exact-match judge)',
    backend: { model: WORKER_MODEL, baseUrl: BASE_URL, verdict: integrity.verdict },
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
    winnerSurface,
    whatGepaRewrote: rewrote
      ? winnerSurface
      : '(no candidate beat baseline on search — winner = baseline)',
    baselineHeldOutComposite: round(baselineHeldOut),
    candidateHeldOutComposite: round(candidateHeldOut),
    pairedDelta: round(delta),
    gateDecision: result.gateResult.decision,
    gateDelta: round(result.gateResult.delta ?? delta),
    gateReasons: result.gateResult.reasons,
    contributingGates: result.gateResult.contributingGates?.map((g) => ({
      name: g.name,
      passed: g.passed,
    })),
    perHoldoutScenario: {
      baseline: perScenario(result.baselineOnHoldout),
      candidate: perScenario(result.winnerOnHoldout),
    },
    totalCostUsd: round6(totalCostUsd),
    llmCalls: records.length,
    elapsedSec,
    honestVerdict,
    provenance: {
      recordPath: join(runRoot, 'loop-provenance.json'),
      spansEmitted: spans.length,
      winnerRationale: provenance.winnerRationale ?? null,
      winnerLabel: provenance.winnerLabel ?? null,
      diffPresent: provenance.diff.length > 0,
      baselineContentHash: provenance.baselineContentHash,
      winnerContentHash: provenance.winnerContentHash,
      hashesDistinguishBaselineFromWinner:
        provenance.baselineContentHash !== provenance.winnerContentHash,
      backend: provenance.backend,
      heldOutLiftFromRecord: round(provenance.heldOutLift),
      recomputeMatchesLiveDelta: Math.abs(provenance.heldOutLift - delta) < 1e-9,
      candidatesWithRationale: provenance.candidates.filter((c) => c.rationale).length,
      candidateCount: provenance.candidates.length,
    },
  }

  const artifactPath = join(runRoot, 'lift-proof.json')
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2))
  const latestPath = join(process.cwd(), '.evolve', 'substrate-lift-proof', 'latest.json')
  writeFileSync(latestPath, JSON.stringify(artifact, null, 2))

  console.log('── RESULT ──────────────────────────────────────────────')
  console.log(
    `  backend verdict      : ${integrity.verdict} (${integrity.totalInputTokens}in/${integrity.totalOutputTokens}out tokens, ${records.length} calls)`,
  )
  console.log(`  baseline held-out    : ${round(baselineHeldOut)}`)
  console.log(`  candidate held-out   : ${round(candidateHeldOut)}`)
  console.log(`  paired delta         : ${round(delta)}`)
  console.log(
    `  gate decision        : ${result.gateResult.decision} (delta=${round(result.gateResult.delta ?? delta)})`,
  )
  console.log(`  cost                 : $${round6(totalCostUsd)}`)
  console.log(`  elapsed              : ${elapsedSec}s`)
  console.log(`  HONEST VERDICT       : ${honestVerdict}`)
  console.log(`  artifact: ${artifactPath}`)
}

function meanComposite(campaign: {
  cells: Array<{ judgeScores: Record<string, { composite: number }>; error?: string }>
}): number {
  const xs: number[] = []
  for (const cell of campaign.cells) {
    if (cell.error) continue
    const cs = Object.values(cell.judgeScores).map((s) => s.composite)
    if (cs.length) xs.push(cs.reduce((a, b) => a + b, 0) / cs.length)
  }
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function perScenario(campaign: {
  cells: Array<{ scenarioId: string; judgeScores: Record<string, { composite: number }> }>
}): Record<string, number> {
  const out: Record<string, number> = {}
  for (const cell of campaign.cells) {
    const cs = Object.values(cell.judgeScores).map((s) => s.composite)
    if (cs.length) out[cell.scenarioId] = round(cs.reduce((a, b) => a + b, 0) / cs.length)
  }
  return out
}

const round = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000

main().catch((err) => {
  console.error('PROOF FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
