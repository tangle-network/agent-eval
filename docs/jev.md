# Jev decisions

Jev is an optional bounded-decision provider, not an agent runtime. The integration exports `runJevDecision`, `jevJudge`, and `jevAnalyst` from `@tangle-network/agent-eval/analyst`. No new dependency, credential lookup, retry loop, or chat emulation is installed.

## Connect through Tangle Router

Install the official `@typesafe-ai/sdk` in the application that owns credentials. Configure its `TypeSafeClient` with the Router origin (without `/v1`) and an owner-scoped Tangle key. Bind the SDK once:

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { jevJudge } from '@tangle-network/agent-eval/analyst'

const client = new TypeSafeClient({ baseURL: routerOrigin, apiKey: scopedKey, retry: { maxRetries: 0 } })
const evaluate = async (request, { signal, callId }) => client.systemOne(request, {
  signal, retry: { maxRetries: 0 }, headers: { 'X-Tangle-Decision-Id': callId },
})
const judge = jevJudge('task-completion', {
  model: 'jev-1.13.0', judgeVersion: 'task-completion/v1', evaluate,
  questions: { complete: { type: 'score', instructions: 'How completely does the artifact satisfy the supplied task?', criteria: ['Missing', 'Partial', 'Complete'] } },
  renderState: ({ artifact, scenario }) => ({ artifact, scenario }),
})
```

Pass an existing CostLedger when comparing candidates. A capped ledger requires `maximumCharge` backed by an enforced Router cap or bounded token usage and pricing. Rates supplied in `pricing` are estimates, never provider receipts. Use `receipt`/`receiptFromError` when the transport exposes authoritative billing evidence. Unknown usage remains unknown. A bad answer is rejected only after recording the paid call.

Judge models must be pinned. Bump `judgeVersion` when the rubric, renderer, transport, calibration, or normalization changes. Score distributions are normalized to the campaign's [0,1] scale; choices have no implicit numeric grade. A Noul is a model judgment, not an authorization decision or a substitute for deterministic verification.

## Trace analysis

`jevAnalyst` returns the existing Analyst contract. Supply the inputKind, a bounded `project(input, context)` that returns authorized state and real evidence references, and `interpret(response, evidence)` that returns existing AnalystFinding values. Findings must name the registered analyst and cite supplied evidence. Registry cancellation/deadlines and CostLedger accounting are preserved, including empty findings and failed analyses. Register it alongside deterministic checks and the existing deep analysts, not as their replacement.

## Optimization and runtime

Use the existing campaign/improvement machinery to tune questions, prompt choices, or context selection. Keep final assessment independent from selection feedback. Runtime control belongs in awaited inference callbacks; RuntimeHooks remain observers. For an agent graph, adapt this analyst through the existing analyst registry/lens seam; do not introduce a second scheduler.

Do not silently strip mandatory instructions or tool-call/result pairs. Optional assistance should have an explicit fallback; cancelled calls must not fall through to more inference. Persist a decision before dependent side effects and reuse it on resume. A correlation id does not establish provider-side idempotency.

## Checks

`pnpm exec vitest run tests/jev.test.ts` covers native answers, score expectations, usage capture on invalid output, cancellation, pinned identity, and request mutation. Live quality, latency, price receipts, and calibration still require a configured Router/TypeSafe deployment and independent labeled cases.

Protocol reference: https://docs.typesafe.ai/api
