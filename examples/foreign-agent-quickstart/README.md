# Evaluate an existing agent

Your agent does not need Tangle's runtime or sandbox.
Adapt its input and output to the `agent` callback of `defineAgentEval()`.
The [complete example](./index.ts) wraps a local support-agent fixture and compares two prompts.

## Run the example

From the repository root, with Node.js 20.19 or newer and pnpm installed:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsx examples/foreign-agent-quickstart/index.ts
```

```text
baseline: 0.5
candidate: 1
```

The fixture runs offline and needs no credentials.
It checks two policy answers for a required fact and citation.
These checks demonstrate the adapter; they do not establish general answer quality or a release decision.

## Connect your agent

Replace `existingAgent()` with your SDK, service, workflow, or local model.
The adapter passes the candidate configuration, scenario input, and cancellation signal.
It returns the artifact that the judge scores:

```ts
agent: async (surface, scenario, ctx) => {
  const result = await existingAgent({
    instructions: String(surface),
    question: scenario.question,
    signal: ctx.signal,
  })
  return { text: result.message }
},
```

Keep answer keys in the judge's input, outside the agent request.
Replace the fixture's string checks with checks calibrated for your task.
Throw when execution cannot produce a valid artifact.
Eval records execution failures separately from measured task scores.

## Record paid calls

The offline fixture uses `expectUsage: 'off'` because it makes no paid calls.
Set `expectUsage: 'assert'` when connecting a paid agent.
`evaluate()` otherwise defaults to a warning for missing dispatch receipts; `selfImprove()` defaults to `'assert'`.
Wrap each model call with `ctx.cost.runPaidCall()` so usage and failures enter the run's ledger.

For an OpenAI-compatible endpoint, use the maintained `ChatClient` and receipt helpers.
This factory replaces the example's `agent` callback and uses its `SupportCase` and `SupportAnswer` types:

```ts
import {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type CustomTokenPricing,
  maximumChargeForLlmRequest,
} from '@tangle-network/agent-eval'
import type {
  ChatClient,
  DispatchContext,
  MutableSurface,
} from '@tangle-network/agent-eval/contract'

function paidAgent(chat: ChatClient, model: string, pricing: CustomTokenPricing) {
  return async (
    surface: MutableSurface,
    scenario: SupportCase,
    ctx: DispatchContext,
  ): Promise<SupportAnswer> => {
    const request = {
      model,
      messages: [
        { role: 'system' as const, content: String(surface) },
        { role: 'user' as const, content: scenario.question },
      ],
      maxTokens: 1000,
    }
    const paid = await ctx.cost.runPaidCall({
      actor: 'support-agent',
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
    return { text: paid.value.content }
  }
}
```

Configure the client as shown in the [main README](../../README.md#configure-model-calls).
Pass current endpoint rates to `paidAgent()` and set `agent: paidAgent(chat, model, pricing)`.
The maximum charge reserves for output limits and all declared transport attempts before a capped call starts.
An SDK adapter must return actual usage, preserve missing usage as unknown, and expose its maximum attempts.
For a multi-call agent, meter each call inside the agent where its receipt is available.

## Next steps

Use filesystem campaign storage when runs must survive process restarts.
Use [`selfImprove()`](../selfimprove-quickstart/) when you need candidate generation and a final comparison.
Use [`compareOptimizationMethods()`](../compare-optimization-methods/) when an official optimizer owns the complete search procedure.
For campaign scheduling and custom release rules, read [campaign proposers](../../docs/campaign-proposers.md).
