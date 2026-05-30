/**
 * Substrate lift proof — the FIRST controlled-but-REAL demonstration that
 * `gepaDriver` + `runImprovementLoop` + `defaultProductionGate` produce a
 * measured held-out lift through a real LLM backend.
 *
 * Why this exists: the substrate's own honesty docs mark `gepaDriver` as
 * `real-unproven` (#101/#106) — its unit tests drive a FAKE fetch, so it has
 * never been shown to actually move a held-out number through a real router.
 * This script closes that gap with the substrate's own primitives and an
 * OBJECTIVE judge, so the lift is unambiguous (no LLM-judge variance).
 *
 * Task: structured field extraction. Each scenario is a short transaction
 * sentence; the worker must emit `{merchant, amount, date, category}`. A
 * DETERMINISTIC checker scores per-field exact-match → composite in [0,1].
 * The baseline prompt is deliberately weak (under-specified format), so the
 * search split scores low and gepaDriver has real failures to reflect on.
 *
 * Real backend: token-emitting via the Tangle router. `assertRealBackend`
 * over the per-call RunRecords must verdict `real` or the proof aborts.
 *
 * Bounded by construction: every `callLlm` carries a 30s per-call timeout +
 * bounded retries; population 2 × 2 generations over 8 search scenarios. The
 * whole run completes in minutes — no unbounded LLM wait (the agent-builder
 * forge-improve hang lesson).
 *
 * Run:
 *   TANGLE_API_KEY=$(cat /tmp/.tk) \
 *   TANGLE_ROUTER_URL=https://router.tangle.tools/v1 \
 *   pnpm tsx examples/substrate-lift-proof/index.ts
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultProductionGate,
  gepaDriver,
  type JudgeConfig,
  type JudgeScore,
  runImprovementLoop,
  type Scenario,
} from '../../src/campaign'
import { assertRealBackend, summarizeBackendIntegrity } from '../../src/integrity/backend-integrity'
import { callLlm, type LlmClientOptions } from '../../src/llm-client'
import type { RunRecord } from '../../src/run-record'

// ── Config ──────────────────────────────────────────────────────────────
const API_KEY = process.env.TANGLE_API_KEY?.trim()
const BASE_URL = process.env.TANGLE_ROUTER_URL?.trim() ?? 'https://router.tangle.tools/v1'
const WORKER_MODEL = process.env.PROOF_WORKER_MODEL ?? 'anthropic/claude-haiku-4-5'
const DRIVER_MODEL = process.env.PROOF_DRIVER_MODEL ?? 'anthropic/claude-haiku-4-5'
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

// ── Dataset: transaction → {merchant, amount, date, category} ────────────
// Gold labels are known, so the checker is fully deterministic. `date` must
// be ISO `YYYY-MM-DD`; `category` is from a fixed taxonomy; `amount` is a
// bare number string. The weak baseline omits all of these constraints.
interface ExtractScenario extends Scenario {
  text: string
  gold: { merchant: string; amount: string; date: string; category: string }
}

const CATEGORIES = ['groceries', 'dining', 'transport', 'utilities', 'entertainment'] as const

function sc(
  id: string,
  text: string,
  gold: ExtractScenario['gold'],
  tag: 'search' | 'holdout',
): ExtractScenario {
  return { id, kind: 'extraction', tags: [tag], text, gold }
}

const SEARCH: ExtractScenario[] = [
  sc(
    's1',
    'On March 3rd 2024 I spent $42.50 at Whole Foods Market on weekly groceries.',
    { merchant: 'Whole Foods Market', amount: '42.50', date: '2024-03-03', category: 'groceries' },
    'search',
  ),
  sc(
    's2',
    'Paid Uber $18.20 for a ride downtown on Jan 7, 2024.',
    { merchant: 'Uber', amount: '18.20', date: '2024-01-07', category: 'transport' },
    'search',
  ),
  sc(
    's3',
    'Dinner at Olive Garden cost 67 dollars on 2024-02-14.',
    { merchant: 'Olive Garden', amount: '67', date: '2024-02-14', category: 'dining' },
    'search',
  ),
  sc(
    's4',
    'My electric bill from ConEdison was $130.99, billed on 12/01/2023.',
    { merchant: 'ConEdison', amount: '130.99', date: '2023-12-01', category: 'utilities' },
    'search',
  ),
  sc(
    's5',
    'Bought movie tickets at AMC Theatres for $24 on the 5th of April 2024.',
    { merchant: 'AMC Theatres', amount: '24', date: '2024-04-05', category: 'entertainment' },
    'search',
  ),
  sc(
    's6',
    "Trader Joe's receipt: $55.10, dated Feb 28 2024, mostly produce.",
    { merchant: "Trader Joe's", amount: '55.10', date: '2024-02-28', category: 'groceries' },
    'search',
  ),
  sc(
    's7',
    'Lyft charged me 9.75 on 2024-03-19 for an airport drop-off.',
    { merchant: 'Lyft', amount: '9.75', date: '2024-03-19', category: 'transport' },
    'search',
  ),
  sc(
    's8',
    'Netflix monthly subscription of $15.49 hit my card on January 22 2024.',
    { merchant: 'Netflix', amount: '15.49', date: '2024-01-22', category: 'entertainment' },
    'search',
  ),
]

const HOLDOUT: ExtractScenario[] = [
  sc(
    'h1',
    'Spent $88.00 at Costco Wholesale on 2024-05-02 stocking up on groceries.',
    { merchant: 'Costco Wholesale', amount: '88.00', date: '2024-05-02', category: 'groceries' },
    'holdout',
  ),
  sc(
    'h2',
    'Chipotle lunch was 12.40 dollars on May 9th, 2024.',
    { merchant: 'Chipotle', amount: '12.40', date: '2024-05-09', category: 'dining' },
    'holdout',
  ),
  sc(
    'h3',
    'Water utility payment to City Water Dept: $44.20 on 04/15/2024.',
    { merchant: 'City Water Dept', amount: '44.20', date: '2024-04-15', category: 'utilities' },
    'holdout',
  ),
  sc(
    'h4',
    'Took a taxi with Yellow Cab for $21.00 on the 11th of June 2024.',
    { merchant: 'Yellow Cab', amount: '21.00', date: '2024-06-11', category: 'transport' },
    'holdout',
  ),
  sc(
    'h5',
    'Spotify Premium billed 10.99 on 2024-05-30.',
    { merchant: 'Spotify', amount: '10.99', date: '2024-05-30', category: 'entertainment' },
    'holdout',
  ),
  sc(
    'h6',
    'Dinner at The Cheesecake Factory: $54.75, dated June 1 2024.',
    { merchant: 'The Cheesecake Factory', amount: '54.75', date: '2024-06-01', category: 'dining' },
    'holdout',
  ),
]

// ── Deterministic judge ───────────────────────────────────────────────────
// Composite = fraction of the 4 fields that exactly match gold after light
// normalization. Objective: no LLM, no variance — a real prompt improvement
// moves this and nothing else can.
function norm(s: unknown): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}
function normAmount(s: unknown): string {
  const m = /-?\d+(\.\d+)?/.exec(String(s ?? ''))
  if (!m) return ''
  const n = Number(m[0])
  return Number.isFinite(n) ? String(n) : ''
}

interface Artifact {
  text: string
  parsed: Record<string, unknown> | null
}

function extractionJudge(dataset: ExtractScenario[]): JudgeConfig<Artifact, ExtractScenario> {
  const byId = new Map(dataset.map((s) => [s.id, s]))
  return {
    name: 'field-exact-match',
    dimensions: [
      { key: 'merchant', description: 'merchant name exact match' },
      { key: 'amount', description: 'amount numeric match' },
      { key: 'date', description: 'date ISO YYYY-MM-DD match' },
      { key: 'category', description: 'category taxonomy match' },
    ],
    score({ artifact, scenario }): JudgeScore {
      const gold = (byId.get(scenario.id) ?? scenario).gold
      const p = artifact.parsed ?? {}
      const dims = {
        merchant: norm(p.merchant) === norm(gold.merchant) ? 1 : 0,
        amount: normAmount(p.amount) === normAmount(gold.amount) ? 1 : 0,
        date: norm(p.date) === norm(gold.date) ? 1 : 0,
        category: norm(p.category) === norm(gold.category) ? 1 : 0,
      }
      const composite = (dims.merchant + dims.amount + dims.date + dims.category) / 4
      return {
        dimensions: dims,
        composite,
        notes: artifact.parsed ? 'parsed' : `unparseable: ${artifact.text.slice(0, 80)}`,
      }
    },
  }
}

// ── Real worker: run the extraction with a given prompt surface ────────────
// Every call is recorded as a RunRecord so `assertRealBackend` can verdict
// the whole proof against actual token usage.
const records: RunRecord[] = []

async function runWorker(
  surface: string,
  scenario: ExtractScenario,
  observeCost: (usd: number) => void,
): Promise<Artifact> {
  const messages = [
    { role: 'system' as const, content: surface },
    { role: 'user' as const, content: scenario.text },
  ]
  const res = await callLlm(
    {
      model: WORKER_MODEL,
      messages,
      jsonMode: true,
      temperature: 0,
      maxTokens: 400,
      timeoutMs: CALL_TIMEOUT_MS,
    },
    llm,
  )
  // The Tangle proxy does not propagate `_response_cost` for haiku, so
  // `res.costUsd` is null. Derive a real cost from token usage at the public
  // haiku-4.5 rate ($1/M input, $5/M output) so the artifact reports an
  // honest spend instead of a misleading $0. Prefer the proxy number when present.
  const costUsd =
    res.costUsd ??
    (res.usage.promptTokens / 1_000_000) * 1 + (res.usage.completionTokens / 1_000_000) * 5
  observeCost(costUsd)
  records.push({
    runId: `${scenario.id}-${createHash('sha1').update(surface).digest('hex').slice(0, 8)}-${records.length}`,
    experimentId: 'substrate-lift-proof',
    candidateId: createHash('sha1').update(surface).digest('hex').slice(0, 12),
    seed: 42,
    model: res.model || WORKER_MODEL,
    promptHash: createHash('sha256').update(surface).digest('hex'),
    configHash: 'extraction-json',
    commitSha: process.env.GIT_SHA ?? 'local',
    wallMs: res.durationMs,
    costUsd,
    tokenUsage: { input: res.usage.promptTokens, output: res.usage.completionTokens },
    outcome: { raw: {} },
    splitTag: (scenario.tags?.[0] as RunRecord['splitTag']) ?? 'search',
    scenarioId: scenario.id,
  })
  return { text: res.content, parsed: parseJsonLoose(res.content) }
}

/** Tolerant JSON extraction: strip a ```json fence if present, else grab the
 *  first balanced object. The harness must parse what the model emits — a
 *  fence-wrapped or prose-prefixed object is still a successful extraction;
 *  the field-level checker still penalizes wrong keys / casing / formats, so
 *  this loosening does not inflate the score, it only stops a uniform parse
 *  failure from collapsing the gradient gepaDriver reflects on. */
function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const candidate = fenced ? fenced[1]! : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate
  try {
    const json = JSON.parse(slice)
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ── The deliberately WEAK baseline prompt ──────────────────────────────────
// Under-specified: no schema, no field names, no date format, no taxonomy.
// The model guesses key names / date formats and the exact-match checker
// penalizes the drift — leaving real room for the driver to improve.
const BASELINE_SURFACE = 'Extract the transaction info from the message as JSON.'

// ── Run the loop ────────────────────────────────────────────────────────────
async function main() {
  const runRoot = join(process.cwd(), '.evolve', 'substrate-lift-proof', String(Date.now()))
  mkdirSync(runRoot, { recursive: true })

  const startedAt = Date.now()
  console.log('Substrate lift proof — gepaDriver + defaultProductionGate, real router')
  console.log(`  worker=${WORKER_MODEL}  driver=${DRIVER_MODEL}  base=${BASE_URL}`)
  console.log(`  search=${SEARCH.length}  holdout=${HOLDOUT.length}`)
  console.log(`  baseline surface: ${JSON.stringify(BASELINE_SURFACE)}`)
  console.log()

  const driver = gepaDriver({
    llm,
    model: DRIVER_MODEL,
    target:
      'a system prompt that makes the model extract transaction fields into strict JSON with keys ' +
      'merchant, amount, date, category — amount as a bare number, date as ISO YYYY-MM-DD, ' +
      `category from {${CATEGORIES.join(', ')}}`,
    mutationPrimitives: [
      'specify the exact JSON keys the output must contain',
      'pin the date format to ISO YYYY-MM-DD',
      'pin amount to a bare decimal number with no currency symbol',
      `constrain category to the fixed taxonomy: ${CATEGORIES.join(', ')}`,
    ],
    temperature: 0.7,
    maxTokens: 2000,
  })

  const gate = defaultProductionGate<Artifact, ExtractScenario>({
    holdoutScenarios: HOLDOUT,
    // A meaningful but reachable bar: a real prompt fix on this task lifts the
    // mean composite well past this on held-out. Set below the typical lift so
    // a genuine improvement promotes, above noise so a null result holds.
    deltaThreshold: 0.1,
    budgetUsd: 2,
  })

  const result = await runImprovementLoop<ExtractScenario, Artifact>({
    scenarios: SEARCH,
    holdoutScenarios: HOLDOUT,
    baselineSurface: BASELINE_SURFACE,
    dispatchWithSurface: (surface, scenario, ctx) =>
      runWorker(String(surface), scenario, (usd) => ctx.cost.observe(usd, 'judge')),
    judges: [extractionJudge([...SEARCH, ...HOLDOUT])],
    driver,
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
  console.log(`  gate reasons         : ${result.gateResult.reasons.join('; ')}`)
  console.log(`  cost                 : $${round6(totalCostUsd)}`)
  console.log(`  elapsed              : ${elapsedSec}s`)
  console.log(`  HONEST VERDICT       : ${honestVerdict}`)
  console.log()
  console.log(`  winner surface:\n${indent(winnerSurface)}`)
  console.log()
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
const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')

main().catch((err) => {
  console.error('PROOF FAILED:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
