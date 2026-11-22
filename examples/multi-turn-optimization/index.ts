/**
 * Improve an agent over multi-turn conversations with a simulated user.
 *
 * `multishotRollout()` runs one conversation per cell: the candidate system
 * prompt is the agent, a simulated customer is the user, and a code check of
 * the transcript is the objective score. `selfImprove()` gives GEPA train and
 * selection personas, re-scores its selected prompt on held-out personas
 * under the same simulated user and seeds, and returns a release decision.
 * `repeatReliability()` then reports how often each held-out customer is
 * served correctly in every one of k repeats, beside mean success.
 *
 * Required:
 *   LLM_BASE_URL=<OpenAI-compatible endpoint>
 *   LLM_API_KEY=<key for that endpoint>
 *   AGENT_MODEL=<snapshot model id>  USER_MODEL=<snapshot model id>
 *   GEPA_PRICE_IN_PER_M=0.4 GEPA_PRICE_OUT_PER_M=1.6   # exact endpoint rates
 *
 * Run: pnpm tsx examples/multi-turn-optimization/index.ts
 */

// IN-REPO: relative imports so the example typechecks against the workspace.
// COPY-PASTE INTO YOUR OWN PROJECT: import from
//   '@tangle-network/agent-eval/multishot', '/campaign' and '/contract'.
import type { ChatClient } from '../../src/analyst/chat-client'
import { gepaOptimizationMethod, repeatReliability } from '../../src/campaign'
import { selfImprove } from '../../src/contract'
import type { MaximumCharge } from '../../src/cost-ledger'
import {
  type ConversationArtifact,
  type ConversationScenario,
  conversationGate,
  conversationJudge,
  describeConversation,
  type MultishotTransport,
  multishotRollout,
} from '../../src/multishot'
import { positiveIntegerEnv, positiveNumberEnv, stringEnv, tokenPricingFromEnv } from '../_shared/env'
import { GEPA_REFLECTION_ENGINE_CONFIG } from '../_shared/gepa-reflection'
import {
  openAiCompatibleChatClient,
  openAiCompatibleExecutionOwner,
} from '../_shared/openai-compatible-owner'
import { optimizerModelBudgetFromEnv } from '../_shared/optimizer-model-budget'

// ── Environment, validated before any paid call ─────────────────────────
const API_KEY = stringEnv('LLM_API_KEY', '')
const BASE_URL = stringEnv('LLM_BASE_URL', '')
// Snapshot ids: the final comparison refuses a pair whose served models differ.
const AGENT_MODEL = stringEnv('AGENT_MODEL', '')
const USER_MODEL = stringEnv('USER_MODEL', '')
const GEPA_MODEL = process.env.GEPA_MODEL?.trim() || AGENT_MODEL
const OPTIMIZER_PYTHON = process.env.OPTIMIZER_PYTHON?.trim() || 'python'
const CALL_TIMEOUT_MS = positiveIntegerEnv('CALL_TIMEOUT_MS', 60_000)
const MAX_TURNS = positiveIntegerEnv('MAX_TURNS', 6)
const REPEATS = positiveIntegerEnv('REPEATS', 3)
const GEPA_MAX_EVALUATIONS = positiveIntegerEnv('GEPA_MAX_EVALUATIONS', 24)
const GEPA_MAX_PROPOSER_COST_USD = positiveNumberEnv('GEPA_MAX_PROPOSER_COST_USD', 2)
const MAX_TOTAL_COST_USD = positiveNumberEnv('MAX_TOTAL_COST_USD', 15)
const pricing = tokenPricingFromEnv()
const gepaModelBudget = optimizerModelBudgetFromEnv('GEPA', GEPA_MAX_PROPOSER_COST_USD)

// ── Customers: the simulated user plays one per scenario ─────────────────
interface Customer {
  id: string
  name: string
  orderId: string
  item: string
  daysSinceDelivery: number
  problem: string
}
type RefundScenario = ConversationScenario<Customer>

const customers: Customer[] = [
  ['ana', 'A-1042', 'blender', 4, 'it arrived with a cracked jar'],
  ['ben', 'B-2210', 'rain jacket', 41, 'the zip broke after a month'],
  ['caro', 'C-3317', 'desk lamp', 12, 'it flickers and then dies'],
  ['dev', 'D-4471', 'running shoes', 3, 'they are a size too small'],
  ['eli', 'E-5528', 'coffee grinder', 55, 'the motor burned out'],
  ['fay', 'F-6630', 'backpack', 20, 'a strap tore on the first day'],
  ['gus', 'G-7714', 'headphones', 33, 'the left side is silent'],
  ['hana', 'H-8806', 'kettle', 9, 'it leaks from the base'],
  ['ivo', 'I-9912', 'yoga mat', 2, 'it smells of chemicals'],
  ['jun', 'J-1188', 'phone case', 47, 'it no longer fits after an update'],
  ['kim', 'K-2299', 'wall clock', 16, 'it loses ten minutes a day'],
  ['lea', 'L-3381', 'water bottle', 38, 'the lid cracked'],
].map(([id, orderId, item, daysSinceDelivery, problem]) => ({
  id: String(id),
  name: String(id)[0]!.toUpperCase() + String(id).slice(1),
  orderId: String(orderId),
  item: String(item),
  daysSinceDelivery: Number(daysSinceDelivery),
  problem: String(problem),
}))
const scenarios: RefundScenario[] = customers.map((persona) => ({
  id: persona.id,
  kind: 'refund-desk',
  persona,
}))
const HELD_OUT = scenarios.slice(6)

// Policy the outcome check enforces: a refund within 30 days of delivery,
// store credit after it, always naming the customer's own order.
function outcome(
  conversation: { transcript: Array<{ role: string; content: string }> },
  scenario: RefundScenario,
) {
  const { orderId, daysSinceDelivery } = scenario.persona
  const agent = conversation.transcript
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('\n')
  const refunded = agent.includes(`REFUND ISSUED: ${orderId}`)
  const credited = agent.includes(`STORE CREDIT: ${orderId}`)
  const eligible = daysSinceDelivery <= 30
  if (eligible && refunded && !credited) return { passed: true, detail: 'refunded in window' }
  if (!eligible && credited && !refunded) return { passed: true, detail: 'credit after window' }
  return {
    passed: false,
    detail: `eligible=${eligible}, refund line=${refunded}, credit line=${credited}`,
  }
}

const BASELINE_SURFACE = 'You are the support desk of an online store. Help the customer.'

// ── The model-call owner: one endpoint as the transport every leg uses ──
const chat = openAiCompatibleChatClient({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: AGENT_MODEL,
  pricing,
  maximumAttempts: 2,
  timeoutMs: CALL_TIMEOUT_MS,
})

function transportFrom(client: ChatClient): MultishotTransport {
  return async (request) => {
    const response = await client.chat(
      {
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role as 'system' | 'user' | 'assistant',
          content: String(message.content ?? ''),
        })),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      },
      request.signal ? { signal: request.signal } : undefined,
    )
    return {
      message: { content: response.content },
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
      },
      ...(response.costUsd === null ? {} : { costUsd: response.costUsd }),
      ...(response.servedModel ? { model: response.servedModel } : {}),
    }
  }
}

// A capped run reserves each call's worst case first: every prompt character
// as a token, and the full output budget.
function maximumCharge(
  _leg: string,
  request: { model: string; messages: unknown; maxTokens?: number },
): MaximumCharge {
  const usage = {
    inputTokens: JSON.stringify(request.messages).length,
    outputTokens: request.maxTokens ?? 2500,
  }
  return pricing ? { customTokenPricing: pricing, ...usage } : { model: request.model, ...usage }
}

const conversation = multishotRollout<RefundScenario>({
  agent: { model: AGENT_MODEL, transport: transportFrom(chat), maxTokens: 800 },
  user: {
    model: USER_MODEL,
    transport: transportFrom(chat),
    rigor: 'demanding',
    agentDescription: "an online store's support desk",
    maxTokens: 300,
    pushback: (message) => /\b(no|not what|that does not|again|still)\b/i.test(message),
  },
  maxTurns: MAX_TURNS,
  outcome,
  maximumCharge,
  revision: 'refund-policy-30-days:v1',
})

const gepa = gepaOptimizationMethod<RefundScenario, ConversationArtifact>({
  name: 'gepa',
  objective:
    'Improve the support agent system prompt. Refunds are allowed within 30 days of ' +
    'delivery and are issued by writing the line `REFUND ISSUED: <order id>`; after 30 ' +
    'days the agent offers store credit by writing `STORE CREDIT: <order id>`. The agent ' +
    'must confirm the order id and delivery date with the customer before acting.',
  evaluationId: 'multi-turn-refund-desk',
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
    call: openAiCompatibleExecutionOwner({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: GEPA_MODEL,
      pricing: gepaModelBudget.pricing,
      timeoutMs: CALL_TIMEOUT_MS,
    }),
    callRef: `openai-compatible:${BASE_URL}`,
    budget: gepaModelBudget,
  },
  describeScenario: (scenario) => ({ customer: scenario.persona.name }),
  runner: { command: OPTIMIZER_PYTHON },
})

async function main() {
  const result = await selfImprove<RefundScenario, ConversationArtifact>({
    agent: conversation.agent,
    dispatchRef: conversation.dispatchRef,
    scenarios,
    judge: conversationJudge(),
    // Refuses a comparison whose arms met a different simulated user or seed.
    gate: conversationGate(),
    // The evidence GEPA's reflection reads: outcome, ending, transcript head and tail.
    describeArtifact: describeConversation,
    baselineSurface: BASELINE_SURFACE,
    method: gepa,
    budget: {
      dollars: MAX_TOTAL_COST_USD,
      maxConcurrency: 2,
      holdoutScenarios: HELD_OUT,
      reps: REPEATS,
    },
    dispatchTimeoutMs: CALL_TIMEOUT_MS * MAX_TURNS * 2,
  })

  console.log(`Gate decision: ${result.gateDecision}`)
  if (result.baseline === null || result.winner.compositeMean === null) {
    throw new Error('This example requires a measured final comparison')
  }
  console.log(`Baseline:      ${result.baseline.compositeMean.toFixed(3)} held-out success`)
  console.log(`Winner:        ${result.winner.compositeMean.toFixed(3)} held-out success`)
  for (const [arm, campaign] of [
    ['baseline', result.raw.baselineOnHoldout],
    ['winner', result.raw.winnerOnHoldout],
  ] as const) {
    const reliability = repeatReliability(campaign.cells, {
      k: REPEATS,
      success: (artifact) => artifact.outcome.passed,
    })
    console.log(
      `${arm.padEnd(9)} pass^${REPEATS} ${reliability.passAllK?.toFixed(3) ?? 'n/a'}, ` +
        `mean ${reliability.meanSuccess?.toFixed(3) ?? 'n/a'} over ${reliability.units} customers`,
    )
  }
  console.log(`Total cost:    $${result.totalCostUsd.toFixed(4)}`)
  console.log('\nSelected prompt:\n', String(result.winner.surface))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
