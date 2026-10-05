# External agent quickstart

Run an evaluation and an improvement loop in your own Node.js process.
No Tangle account, sandbox, runtime, or framework migration is required.
The first run is an offline wiring exercise; `--openai` explicitly opts into paid model calls.

Use `defineAgentEval()` from the [main README](../README.md#quickstart) for the higher-level API.
This guide exposes `dispatch`, `runCampaign()`, and `runImprovementLoop()` when you want to own the wiring.

## Install

With Node.js 20.19 or newer, start in an empty directory:

```sh
npm init -y
npm install @tangle-network/agent-eval
npm install --save-dev tsx
```

## Run a campaign and an improvement loop

Save this entire block as `eval.mts`. It includes a deterministic agent, a rubric,
a candidate proposer, and a reference adapter for the raw OpenAI-compatible chat API.
The adapter reuses the package's maintained transport and receipt helpers rather than introducing another SDK or runtime.

<!-- external-quickstart:program -->
```ts
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  maximumChargeForLlmRequest,
} from '@tangle-network/agent-eval'
import {
  createChatClient,
  defaultProductionGate,
  type DispatchContext,
  inMemoryCampaignStorage,
  type JudgeConfig,
  type MutableSurface,
  type Scenario,
  type SurfaceProposer,
} from '@tangle-network/agent-eval/contract'
import { runCampaign, runImprovementLoop } from '@tangle-network/agent-eval/campaign'
import { type DeploymentOutcome, InMemoryOutcomeStore } from '@tangle-network/agent-eval/rl'

interface SupportCase extends Scenario { ticket: string }
interface SupportAnswer { text: string }

// Replace this function with the SAME agent call your application uses.
// Its input/output need not know anything about agent-eval.
async function existingAgent(input: {
  instructions: string
  ticket: string
  signal: AbortSignal
}) {
  input.signal.throwIfAborted()
  return {
    message: input.instructions.includes('cite the ticket id')
      ? `Ticket ${input.ticket}: on it.`
      : 'On it.',
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name} before using --openai`)
  return value
}

function tokenRate(name: string): number {
  const value = Number(requiredEnv(name))
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a nonnegative rate`)
  return value
}

// Reference adapter: raw OpenAI-compatible API, no Tangle execution service.
function openAiDispatch() {
  const model = requiredEnv('LLM_MODEL')
  const pricing = {
    inputUsdPerMillion: tokenRate('LLM_INPUT_USD_PER_MILLION'),
    outputUsdPerMillion: tokenRate('LLM_OUTPUT_USD_PER_MILLION'),
  }
  const chat = createChatClient({
    transport: 'openai-compatible',
    baseUrl: requiredEnv('LLM_BASE_URL'),
    apiKey: requiredEnv('LLM_API_KEY'),
    defaultModel: model,
  })
  return async (
    surface: MutableSurface,
    scenario: SupportCase,
    ctx: DispatchContext,
  ): Promise<SupportAnswer> => {
    const request = {
      model,
      messages: [
        { role: 'system' as const, content: String(surface) },
        { role: 'user' as const, content: `Please acknowledge ticket ${scenario.ticket}.` },
      ],
      maxTokens: 256,
    }
    const paid = await ctx.cost.runPaidCall({
      actor: 'external-support-agent',
      model,
      maximumCharge: maximumChargeForLlmRequest(request, {
        customTokenPricing: pricing,
        maximumAttempts: chat.maximumAttempts,
      }),
      execute: (signal, callId) => chat.chat(request, { signal, idempotencyKey: callId }),
      receipt: (result) => costReceiptFromLlm(result, pricing),
      receiptFromError: (error) => costReceiptFromLlmError(error, pricing),
    })
    if (!paid.succeeded) throw paid.error
    if (!paid.value.content.trim()) throw new Error('The agent returned an empty answer')
    return { text: paid.value.content }
  }
}

const useOpenAi = process.argv.includes('--openai')
const dispatchWithSurface = useOpenAi
  ? openAiDispatch()
  : async (surface: MutableSurface, scenario: SupportCase, ctx: DispatchContext) => {
      const result = await existingAgent({
        instructions: String(surface),
        ticket: scenario.ticket,
        signal: ctx.signal,
      })
      return { text: result.message }
    }

// A deterministic rubric is a judge. Use llmJudge() for semantic criteria.
const judge: JudgeConfig<SupportAnswer, SupportCase> = {
  name: 'ticket-id',
  judgeVersion: 'ticket-id-v1',
  dimensions: [{ key: 'present', description: 'The answer cites the supplied ticket id' }],
  score: ({ artifact, scenario }) => {
    const present = artifact.text.includes(scenario.ticket) ? 1 : 0
    return { dimensions: { present }, composite: present, notes: '' }
  },
}
const scenarios: SupportCase[] = ['refund', 'shipping'].map((ticket) => ({
  id: `train-${ticket}`, kind: 'support', ticket,
}))
const holdoutScenarios: SupportCase[] = ['cancel', 'billing'].map((ticket) => ({
  id: `holdout-${ticket}`, kind: 'support', ticket,
}))
const baselineSurface = 'Answer politely.'
const proposer: SurfaceProposer = {
  kind: 'cite-ticket',
  async propose({ currentSurface }) {
    return [{
      surface: `${String(currentSurface)} Always cite the ticket id.`,
      label: 'cite-ticket',
      rationale: 'The rubric requires the supplied ticket id in the answer.',
    }]
  },
}
const runRoot = resolve('eval-quickstart', randomUUID())
const common = {
  judges: [judge],
  storage: inMemoryCampaignStorage(),
  seed: 7,
  reps: 1,
  maxConcurrency: 2,
  dispatchTimeoutMs: 30_000,
  abortOnCellError: true,
  expectUsage: useOpenAi ? 'assert' as const : 'off' as const,
  // Each top-level call has its own $1 ceiling; the loop shares its ceiling
  // across search and holdout. The script has $2 of total ledger budget at the declared rates.
  costCeiling: useOpenAi ? 1 : undefined,
}
const baseline = await runCampaign({
  ...common,
  scenarios,
  dispatch: async function dispatch(scenario, ctx) {
    return dispatchWithSurface(baselineSurface, scenario, ctx)
  },
  dispatchRef: useOpenAi ? 'external-openai-baseline-v1' : 'external-fixture-baseline-v1',
  runDir: join(runRoot, 'baseline'),
})
const improvement = await runImprovementLoop({
  ...common,
  scenarios,
  holdoutScenarios,
  baselineSurface,
  dispatchWithSurface,
  dispatchRef: useOpenAi ? 'external-openai-v1' : 'external-fixture-v1',
  proposer,
  populationSize: 1,
  maxGenerations: 1,
  gate: defaultProductionGate<SupportAnswer, SupportCase>({ holdoutScenarios, deltaThreshold: 0 }),
  autoOnPromote: 'none',
  runDir: join(runRoot, 'improvement'),
})

// Synthetic storage example, NOT a measured production outcome or judge score.
const outcomes = new InMemoryOutcomeStore()
const observation: DeploymentOutcome = {
  runId: 'synthetic-deployment-run',
  capturedAt: Date.now(),
  metrics: { resolved: 1 },
  source: 'quickstart-fixture',
}
await outcomes.append(observation)
console.log('baseline:', baseline.aggregates.byJudge['ticket-id']?.mean)
console.log('candidate on holdout:', improvement.winnerOnHoldout.aggregates.byJudge['ticket-id']?.mean)
console.log('decision:', improvement.gateResult.decision)
console.log('outcome rows:', (await outcomes.forRun(observation.runId)).length)
```

```sh
npx tsx eval.mts
```

The offline fixture is constructed to score zero for the baseline and one for the candidate.
It uses only two holdout cases, so a higher score is not sufficient evidence to ship.
Inspect `improvement.gateResult`, not just the candidate's mean.
The candidate generator makes one known edit; this demonstrates the loop, not learned optimization or general agent quality.
`autoOnPromote: 'none'` reports the decision without changing your agent or opening a PR.

## Connect a real agent

Replace `existingAgent()` with your production SDK call, graph invocation, service, or local model.
Keep the adaptation in `dispatchWithSurface`: translate the surface and scenario into the agent's input,
forward cancellation, and return the artifact your judge scores.
Do not pass hidden answer keys or grading instructions into the agent request.
Keep execution failures as thrown errors rather than successful empty strings or task-score zeroes.

For the included OpenAI-compatible adapter, explicitly configure your endpoint, credentials,
a currently deployed model id, and its current per-million-token rates. For OpenAI directly,
the base URL is `https://api.openai.com/v1`. Then opt in:

```sh
# Set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL,
# LLM_INPUT_USD_PER_MILLION and LLM_OUTPUT_USD_PER_MILLION in your shell.
npx tsx eval.mts --openai
```

This mode makes paid calls. It does not fall back to the fixture when a provider fails.
The maintained transport reports model identity, usage, retries, and failure receipts;
`ctx.cost.runPaidCall()` reserves for bounded output and the declared maximum attempts before dispatch.
Unknown usage is not invented, and `expectUsage: 'assert'` rejects missing dispatch evidence.
Set rates for your actual endpoint; local estimates are not provider invoices. Add cache-read/write
rates to `pricing` when applicable. Increase `maxTokens` and the explicit budget together when your model needs more output headroom.

For an existing multi-call agent, meter every paid call at the point where its receipt is available.
Do not set `expectUsage: 'off'` merely to make an uninstrumented paid agent appear to work.
For semantic scoring, use `llmJudge()` from `/contract` with a separate `ChatClient`;
see [judge verdicts](./verdicts.md). Judge failures must remain failures, not low task scores.

## Keep the useful boundaries

The same production execution function should serve your application and evaluation.
Candidate generation may use training cases, but final comparisons need separate cases;
real deployments also need representative data, calibrated judges, sufficient independent observations,
and an explicit approval policy. The tiny fixture is not release evidence.

`inMemoryCampaignStorage()` keeps campaign data in this process, and `InMemoryOutcomeStore` does the same
for downstream observations. Use `fsCampaignStorage()` and `FileSystemOutcomeStore` from the public barrels
when evidence must survive a restart. With durable campaign storage, include model, prompt, tools, and
configuration revisions in `dispatchRef` so different execution behavior cannot reuse a stale cache.

For real deployment feedback, use the actual production `RunRecord.runId` in `DeploymentOutcome.runId`
and record independently observed metrics. Do not relabel an evaluation score as a deployment outcome.
See [outcome validity](./outcome-validity.md), [campaign controls](./eval-surface-map.md), and
[evaluation integrity](./evaluation-integrity.md) for the next stage.
