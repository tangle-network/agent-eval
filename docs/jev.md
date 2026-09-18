# Jev: native judges and trace analysts

Import `jevJudge`, `jevAnalyst`, and `parseJevResult` from `@tangle-network/agent-eval/jev`.
They adapt TypeSafe's native System One protocol to the existing `JudgeConfig` and
`Analyst` contracts. No SDK dependency, chat emulation, new registry, or optimizer
is introduced. Existing campaigns and optimization methods can consume the judge.

## Connect the official SDK

The application owns credentials. Give the SDK a scoped Tangle Router credential
and the Router origin (without `/v1`), or an explicitly configured TypeSafe endpoint.
The Router deployment must support `POST /v1/systemone`.

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { jevJudge } from '@tangle-network/agent-eval/jev'

const client = new TypeSafeClient({
  baseURL: routerOrigin,
  apiKey: scopedRouterKey,
  retry: { maxRetries: 0 },
})

const judge = jevJudge<string>('requirements', {
  model: selectedPinnedJevModel,
  version: 'requirements-v1', // Include changes to renderer and transport policy.
  evaluate: (request, { signal, idempotencyKey }) => client.systemOne(request, {
    signal,
    retry: { maxRetries: 0 },
    headers: { 'Idempotency-Key': idempotencyKey },
  }),
  questions: {
    completion: {
      type: 'score',
      instructions: 'Assess the answer against the supplied requirements and evidence.',
      criteria: ['Requirements unmet', 'Partially met', 'All requirements met'],
    },
  },
  renderState: ({ artifact, scenario }) => ({ artifact, scenario }),
  // Supply reviewed rates or a provider/billing receipt mapper. Rates are estimates.
  pricing: reviewedTokenPricing,
  // Required with a capped ledger: a real upper bound enforced by the transport.
  maximumCharge: enforcedMaximumCharge,
})
```

An idempotency header carries correlation; it does not establish that an upstream
provider deduplicates inference. The injected call performs one physical attempt.
Retries must be admitted and accounted for by the owning execution layer, not hidden
inside several nested SDKs. Router billing is authoritative; the Eval ledger records
spend attribution and never charges the customer a second time.

Score criteria are ordered, equally spaced levels. Expectations and distributions
are normalized to `[0, 1]`. Noul values are used directly. Choice questions have no
numeric ordering and are refused by `jevJudge`; use them in `jevAnalyst` or a caller
policy instead. Weights select and weight declared dimensions using the existing
weighted-composite reducer.

Responses are runtime-validated: served model, exact answer names and types, usage,
probability distributions, rubric legends, and expected scores. Invalid responses
throw instead of becoming default scores. Paid work settles before answer validation,
so an unusable answer does not erase its cost. Missing usage remains a failed/unknown
receipt, not measured zero. Nothing here guarantees semantic correctness.

## Trace analysis

`jevAnalyst<TInput>` is an ordinary registry member. Supply `id`, `description`,
`inputKind`, `renderState(input, context)`, and `findings(result, input, context)` in
addition to the common evaluation options. The existing registry controls execution.
The adapter forwards cancellation, deadline, ledger, run identity, and usage reports,
including calls with no findings or malformed answers.

The renderer selects/redacts trace evidence. The adapter never silently truncates a
trace or retrieves unrelated tenant data. The findings callback should use the existing
`makeFinding` factory and actual span/event/artifact references. Label semantic
classifications as hypotheses; do not invent explanatory text that Jev did not produce.
Keep deterministic checks and deep trace investigation in the existing registry.

## Optimization and runtime

Use the existing campaign/optimization paths to compare question wording, criteria,
context renderers, and selection policies. Pin the model and version every opaque
configuration change. Keep final test cases independent of prompt/policy selection.
Validate judging quality against labeled outcomes, including confidently wrong cases.
Do not interpret a model's confidence as calibrated accuracy.

For live execution, use an awaited local inference boundary or existing graph analyst
composition. `RuntimeHooks` is observational, not a mandatory pre-inference barrier.
A sandbox prompt can contain multiple harness-native requests; this adapter does not
claim to intercept all of them. Optional analysis should not disable an otherwise
working agent. Authorization and irreversible actions remain deterministic controls.

## Validation

Focused regression tests: `pnpm exec vitest run tests/jev.test.ts`.
Package checks: `pnpm typecheck && pnpm build && pnpm run verify:package`.
Live provider quality, deployment credentials, and end-to-end billing must be verified
separately; injected-response tests are not proof of those properties.

Protocol reference: https://docs.typesafe.ai/api
SDK reference: https://github.com/typesafe-ai/typesafe-sdk-js
