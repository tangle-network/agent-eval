/**
 * Improve one system prompt with official GEPA through `selfImprove()`.
 *
 * `selfImprove()` is the one-call improvement entry. It gives GEPA disjoint
 * train and selection partitions, re-scores GEPA's selected prompt on a
 * held-out split GEPA never received, and returns a release decision.
 *
 * Required:
 *   LLM_BASE_URL=<OpenAI-compatible endpoint>
 *   LLM_API_KEY=<key for that endpoint>
 *   GEPA_PRICE_IN_PER_M=0.4 GEPA_PRICE_OUT_PER_M=1.6   # exact endpoint rates
 *
 * Run: pnpm tsx examples/self-improve-optimizer/index.ts
 */

// IN-REPO: relative imports so the example typechecks against the workspace.
// COPY-PASTE INTO YOUR OWN PROJECT: change these to
//   import { selfImprove } from '@tangle-network/agent-eval/contract'
//   import {
//     createOpenAiCompatibleExecutionOwner,
//     gepaOptimizationMethod,
//   } from '@tangle-network/agent-eval/campaign'
// The public subpaths expose these names with the same shapes.
import { createOpenAiCompatibleExecutionOwner, gepaOptimizationMethod } from '../../src/campaign'
import { selfImprove } from '../../src/contract'
import { assertRealBackend, summarizeBackendIntegrity } from '../../src/integrity/backend-integrity'
import type { LlmClientOptions } from '../../src/llm-client'
import type { RunRecord } from '../../src/run-record'
import { positiveIntegerEnv, positiveNumberEnv } from '../_shared/env'
import {
  type Artifact,
  type ExtractScenario,
  extractionJudge,
  makeExtractionWorker,
} from '../_shared/extraction-task'
import { GEPA_REFLECTION_ENGINE_CONFIG } from '../_shared/gepa-reflection'
import { optimizerModelBudgetFromEnv } from '../_shared/optimizer-model-budget'

// ── Environment, validated before any paid call ─────────────────────────
const API_KEY = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
if (!API_KEY) {
  throw new Error('Set LLM_API_KEY, or TANGLE_API_KEY with TANGLE_ROUTER_URL.')
}
const BASE_URL = (process.env.LLM_BASE_URL || process.env.TANGLE_ROUTER_URL || '').trim()
if (!BASE_URL) {
  throw new Error('Set LLM_BASE_URL (or TANGLE_ROUTER_URL) to an OpenAI-compatible endpoint.')
}
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash'
const GEPA_MODEL = process.env.GEPA_MODEL || MODEL
const OPTIMIZER_PYTHON = process.env.OPTIMIZER_PYTHON?.trim() || 'python'
const CALL_TIMEOUT_MS = positiveIntegerEnv('CALL_TIMEOUT_MS', 30_000)
// Reasoning models spend thinking tokens against this cap; raise it for
// families that reason, or the worker returns truncated JSON.
const LLM_MAX_TOKENS = positiveIntegerEnv('LLM_MAX_TOKENS', 400)
// Keep this at or above the train partition size. One aggregate evaluation
// registers the whole train set, so a smaller budget scores -inf.
const GEPA_MAX_EVALUATIONS = positiveIntegerEnv('GEPA_MAX_EVALUATIONS', 12)
const GEPA_MAX_PROPOSER_COST_USD = positiveNumberEnv('GEPA_MAX_PROPOSER_COST_USD', 2)
const MAX_TOTAL_COST_USD = positiveNumberEnv('MAX_TOTAL_COST_USD', 10)
// Throws unless GEPA_PRICE_IN_PER_M and GEPA_PRICE_OUT_PER_M carry the exact
// endpoint rates, so reflection spend is never a guessed zero.
const gepaModelBudget = optimizerModelBudgetFromEnv('GEPA', GEPA_MAX_PROPOSER_COST_USD)

// ── Tiny inline case set ─────────────────────────────────────────────────
// One list feeds every partition: `selfImprove` reserves a held-out split for
// the gate, then carves a selection partition for GEPA from the rest.
function scenario(id: string, text: string, gold: ExtractScenario['gold']): ExtractScenario {
  return { id, kind: 'extraction', text, gold }
}

const scenarios: ExtractScenario[] = [
  scenario('coffee', 'Blue Bottle Coffee charged $6.75 on 2024-07-01 for a flat white.', {
    merchant: 'Blue Bottle Coffee',
    amount: '6.75',
    date: '2024-07-01',
    category: 'dining',
  }),
  scenario('metro', 'Metro card top-up of 20 dollars at MTA on July 3rd 2024.', {
    merchant: 'MTA',
    amount: '20',
    date: '2024-07-03',
    category: 'transport',
  }),
  scenario('grocer', 'Picked up $31.40 of produce at Safeway on 07/05/2024.', {
    merchant: 'Safeway',
    amount: '31.40',
    date: '2024-07-05',
    category: 'groceries',
  }),
  scenario('power', 'PG&E billed me $92.13 for electricity on 2024-06-28.', {
    merchant: 'PG&E',
    amount: '92.13',
    date: '2024-06-28',
    category: 'utilities',
  }),
  scenario('cinema', 'Two tickets at Regal Cinemas, $32, on the 6th of July 2024.', {
    merchant: 'Regal Cinemas',
    amount: '32',
    date: '2024-07-06',
    category: 'entertainment',
  }),
  scenario('pizza', "Domino's order came to 24.99 on 2024-07-08.", {
    merchant: "Domino's",
    amount: '24.99',
    date: '2024-07-08',
    category: 'dining',
  }),
  scenario('rideshare', 'Uber ride to the office, $14.25, June 30 2024.', {
    merchant: 'Uber',
    amount: '14.25',
    date: '2024-06-30',
    category: 'transport',
  }),
  scenario('water', 'City Water Dept drafted $38.60 on 07/02/2024.', {
    merchant: 'City Water Dept',
    amount: '38.60',
    date: '2024-07-02',
    category: 'utilities',
  }),
  scenario('stream', 'Hulu subscription renewed at 17.99 on 2024-07-04.', {
    merchant: 'Hulu',
    amount: '17.99',
    date: '2024-07-04',
    category: 'entertainment',
  }),
  scenario('market', 'Spent $58.20 at Kroger on July 7, 2024 for the week.', {
    merchant: 'Kroger',
    amount: '58.20',
    date: '2024-07-07',
    category: 'groceries',
  }),
]

// The weak baseline names no schema, date format, or taxonomy, so the
// exact-match judge leaves GEPA real room to improve.
const BASELINE_SURFACE = 'Extract the transaction info from the message as JSON.'

// ── Agent, judge, and the GEPA method ────────────────────────────────────
const records: RunRecord[] = []
const llm: LlmClientOptions = {
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  maximumAttempts: 2,
  defaultTimeoutMs: CALL_TIMEOUT_MS,
}
const worker = makeExtractionWorker({
  llm,
  model: MODEL,
  records,
  timeoutMs: CALL_TIMEOUT_MS,
  maxTokens: LLM_MAX_TOKENS,
  experimentId: 'self-improve-optimizer',
})

// The default execution owner wraps one OpenAI-compatible endpoint as the
// metered model call every official optimizer requires. Agent Eval's loopback
// proxy meters each reflection call against `budget`, and the provider key
// never reaches the Python child.
const optimizerCall = createOpenAiCompatibleExecutionOwner({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: GEPA_MODEL,
  pricing: gepaModelBudget.pricing,
  timeoutMs: CALL_TIMEOUT_MS,
})

const gepa = gepaOptimizationMethod<ExtractScenario, Artifact>({
  name: 'gepa',
  objective:
    'Improve the system prompt so the agent extracts merchant, amount, date, and category ' +
    'into strict JSON: amount as a bare number, date as ISO YYYY-MM-DD, category from ' +
    '{groceries, dining, transport, utilities, entertainment}.',
  evaluationId: 'self-improve-optimizer-extraction',
  recipe: {
    kind: 'engine',
    run: {
      engine: 'gepa',
      maxEvaluations: GEPA_MAX_EVALUATIONS,
      maxProposerCostUsd: GEPA_MAX_PROPOSER_COST_USD,
      engineConfig: GEPA_REFLECTION_ENGINE_CONFIG,
    },
  },
  optimizer: {
    model: GEPA_MODEL,
    call: optimizerCall,
    // Stable public identity for this execution path; it enters
    // resumable-run compatibility, so keep it constant across runs.
    callRef: `openai-compatible:${BASE_URL}`,
    budget: gepaModelBudget,
  },
  describeScenario: (s) => ({ input: s.text, expected: s.gold }),
  describeArtifact: (a) => ({ output: a.text, parsed: a.parsed }),
  runner: { command: OPTIMIZER_PYTHON },
})

// ── One call: search, held-out re-score, release decision ───────────────
async function main() {
  const result = await selfImprove<ExtractScenario, Artifact>({
    agent: (surface, s, ctx) => worker(String(surface), s, ctx),
    scenarios,
    judge: extractionJudge(scenarios),
    baselineSurface: BASELINE_SURFACE,
    method: gepa,
    // `generations` stays unset: the external method owns its rounds.
    budget: { dollars: MAX_TOTAL_COST_USD, maxConcurrency: 2, holdoutFraction: 0.4 },
    dispatchTimeoutMs: CALL_TIMEOUT_MS,
  })

  assertRealBackend(records, { allowMixed: false })
  const integrity = summarizeBackendIntegrity(records)

  console.log(
    `Backend:       ${MODEL} via ${BASE_URL} (${integrity.verdict}, ${records.length} calls)`,
  )
  console.log(`Gate decision: ${result.gateDecision}`)
  console.log(`Baseline:      ${result.baseline.compositeMean.toFixed(3)} (held-out composite)`)
  console.log(`Winner:        ${result.winner.compositeMean.toFixed(3)} (held-out composite)`)
  console.log(`Lift:          ${result.lift === undefined ? 'not measured' : signed(result.lift)}`)
  console.log(`Total cost:    $${result.totalCostUsd.toFixed(4)}`)
  if (result.optimization) {
    const cost = result.optimization.cost
    console.log(
      `Method:        ${result.optimization.name}; optimizer spend ` +
        `$${cost.totalCostUsd.toFixed(4)} (accounting complete: ${cost.accountingComplete})`,
    )
  }
  console.log()
  console.log('Baseline -> winner diff:')
  console.log(result.diff || '(the winner is the baseline)')
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(3)}`
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
