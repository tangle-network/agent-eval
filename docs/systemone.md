# System One evaluations: products, judges, and analysts

System One is a typed decision protocol: a request carries `state` and named questions (noul
yes/no, choice, or score rubric), and the answer is a probability for every allowed option.
TypeSafe published it with Jev; Cloudflare Workers AI (Clef, Clef-flash) and Perplexity's
Decisions API (pplx-decider) serve models on the same wire format. This package owns what a
valid result means. It names no endpoint, credential or model. Tangle Router owns the provider
routes behind `POST /v1/systemone`, with their prices, limits and served-model checks, so a
consumer changes models by changing one id.

Configure a transport once. Supply your own model, state, and questions on every
call. Interpret the answers in ordinary code; no campaign or agent is required.

```ts
import { systemOneEvaluator } from '@tangle-network/agent-eval/systemone'

const evaluate = systemOneEvaluator({
  evaluate: async (request, { signal, idempotencyKey }) => {
    const response = await fetch(`${routerOrigin}/v1/systemone`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${scopedRouterKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(request),
    })
    if (!response.ok) throw new Error(`System One request failed: ${response.status}`)
    return response.json()
  },
  pricing: reviewedTokenPricing, // An estimate, not a provider-observed charge.
})

const result = await evaluate({
  model: selectedModel, // a native_evaluation id from Router's /v1/models
  state: { requirements, evidence },
  questions: {
    supported: { type: 'noul', instructions: 'Does the evidence support the claim?' },
    next: {
      type: 'choice',
      instructions: 'Choose the next step using the evidence',
      criteria: {
        inspect: 'Evidence is missing or contradictory',
        finish: 'The requirements are satisfied',
      },
    },
  },
}, { signal, costLedger })

result.value.answers.next.choice // 'inspect' | 'finish'
result.value.answers.next.probabilities.inspect // number
result.receipt // Existing CostLedger receipt, separate from native answers.
```

The named configuration and evidence values belong to the application. TypeSafe's SDK
builders produce the same JSON and are optional. Structured criteria, null instructions and choice or noul
descriptions, and omitted optional fields are supported. `state` and each score
level must be text or JSON; TypeSafe rejects null there, so the parser does too. Providers
add their own limits: Clef requires non-null `instructions`, 1–64 questions with ids matching
`^[A-Za-z0-9_.-]{1,100}$`, and 2–255 choice options. Static TypeScript questions preserve
exact answer names and choice-label unions. Runtime JSON must be validated; its
labels cannot become compile-time literals automatically.

## Providers, rounding and confidence

The wire format is the same for every provider; how each reports its numbers is not. A
provider's raw result goes through `normalizeSystemOneResult(raw, request, profile)` and then
the strict `parseSystemOneResult`. The route owner supplies the profile.

| Recorded 2026-10-04 | Rounding | `confidence` as returned | Profile |
| --- | --- | --- | --- |
| TypeSafe `jev-1.13.0` | 2 decimals. Probabilities sum to 1; the score is not always their expectation (8.79 against 8.86). | `systemOneConfidence` (153 of 153 recorded answers within rounding) | `{ decimals: 2, confidence: 'canonical' }` |
| Cloudflare `clef`, `clef-flash` | 4 decimals, each probability rounded on its own. Wrapped in Workers AI's `{ result, success, errors, messages }`. | (Σp² − 1/n)/(1 − 1/n) | `{ decimals: 4, confidence: 'provider-defined' }` |

The recordings are `tests/fixtures/systemone/providers-2026-10-04.json`, checked by
`tests/systemone-providers.test.ts`. Without normalization, the strict parser refuses both
recorded TypeSafe score answers and both recorded Clef score answers.

- An answer that already passes the strict checks keeps its probabilities and score.
- An answer that fails them only within the declared rounding is repaired. A distribution whose
  sum is more than 1e-4 from 1 is divided by its sum. A score becomes the expectation of the
  distribution.
- Error beyond the rounding throws `SystemOneResponseError`; it is a provider defect. The
  bounds are n half-units for the sum and half a unit plus one unit per level index for the score.
- With `confidence: 'provider-defined'`, the provider's value moves to `provider_confidence` and
  `confidence` becomes `systemOneConfidence(probabilities)`, so every route reports the same
  function of its probabilities: TypeSafe's published formulas
  (https://docs.typesafe.ai/confidence).
- Noul answers never change. `noul` is the probability of yes for every provider.

Probabilities are not made equivalent across models. A Clef 0.8 and a Jev 0.8 are different
statements, so a threshold belongs to one model: change `{ model, threshold }` together and audit
the pair with `auditProbabilityPolicy` against independent outcomes. `brierScore` and
`calibrationFromPairs` (with `range: { lo: 0, hi: 1 }`; `binning: 'equal-frequency'` for
equal-mass bins) in `/meta-eval` report calibration on the same pairs.

## Any classifier, not only System One

`createEvaluator`, `asJudge`, and `asAnalyst` are provider-independent exports from
`@tangle-network/agent-eval/evaluation` (also re-exported from `/systemone`).
`createEvaluator({ execute, receipt })` meters a typed asynchronous function.
It does not require a System One response, probability output, prompt, or provider SDK.

`systemOneEvaluator` adds native protocol validation and optional `acceptModel(requested,
served)` policy. It preserves the reported model instead of guessing alias rules.
Router independently enforces its supported model and pricing policy.

## Adapt the same observation, without another model call

`asJudge({ name, version, dimensions, evaluate, map, record? })` returns the existing
`JudgeConfig`. The evaluator receives `{ artifact, scenario }` and execution context.
`map(value, input)` returns the application's `JudgeScore` on its chosen scale.
`record(result, input)` can persist the full distribution and receipt before reduction.

`asAnalyst({ id, version, description, inputKind, cost, evaluate, map, record? })`
returns the existing `Analyst`. The evaluator receives the input, evaluation context,
and analyst context. `map(value, input, analystContext)` creates evidence-backed
findings. Use the existing `makeFinding` factory and real event/span/artifact references.
An empty finding list is valid; an inference failure is not a clean review.

The optional `systemOneJudge` and `systemOneAnalyst` conveniences accept static questions or a
question-producing function. State renderers may be async. Judge renderers receive
the evaluation context; analyst renderers and finding mappers receive the effective
cancellation/deadline signal. Rendering must honor that signal during external work.
Both conveniences accept a `record` callback for the complete observation.

For a numeric rubric, `systemOneJudge` defaults to `normalizedSystemOneScore`: equally spaced
score expectations on [0,1], noul values unchanged, and an optional weighted mean.
It emits no canned notes. Supply `map` for choice utilities, different scales, or
critical-failure policies. Dynamic questions and custom mappings require explicit
stable output `dimensions`; changing intermediate questions must not silently change
the metric being compared. Bump `version` when opaque renderers or mappings change.
Optional undefined fields from SDK builders hash like the JSON they send. Invalid
JSON evidence, including Map, Date, cycles, and non-finite numbers, is rejected rather
than silently changed before inference. Convert timestamps explicitly to strings.

## Execution and accounting

Use the caller's existing `costLedger`, signal, run tags, and phase. A capped ledger
requires a genuine transport-enforced maximum charge, not a guessed cost ceiling.
One injected call represents one paid attempt; do not hide retries at multiple layers.
An idempotency header is correlation, not proof of upstream inference deduplication.
Router charges the inference. Eval records attribution and must not charge it again.

The shared analyst adapter uses an explicit `AnalystContext.costLedger` first. If
none is supplied, an explicit `budgetUsd` creates an account for that invocation.
Otherwise the evaluator keeps its configured ledger, including its cumulative cap
across direct calls, judges, and analysts. An absent analyst budget never creates a
fresh unlimited account that overrides the configured one. This precedence is the
same for System One and other classifiers. A per-analysis budget replaces the default
account; it is not an additional child limit. Pass the shared run ledger explicitly
when the whole run must conserve one authority. Only trusted host code should choose
or replace that authority.

`evaluate(request, { callId, costLedger, signal })` may supply the existing ledger's
physical paid-call identity. It reaches both `receipt.callId` and the transport's
`idempotencyKey`. Omit it for a newly allocated identity. Duplicate pending or settled
calls in the same ledger are refused before another dispatch; they do not return a
cached result. Preserve a retained observation for replay, and allocate a different
physical-attempt identity only when a retry is explicitly authorized. This adds no
cross-credential workflow recovery or provider-side deduplication guarantee.

Usage settles before answer validation and mapping. Failed parsing or mapping never
undoes paid work. Persisted observations remain available even if cancellation prevents
their reduction to a decision. Unknown costs are not measured zero. `record` is a
persistence seam, not an automatic cache: callers own storage, authorization, replay
identity, and resume policy.

## Graphs, hooks, and optimization

Use the same evaluator in products, a graph analyst, an awaited local pre/post-call
function, or a rollout checkpoint. Runtime owns those execution boundaries; Eval does
not add a scheduler or import Runtime. Observation-only Runtime hooks are not blocking
controls, and one external sandbox prompt may include many native model requests.
A delivery check must run before delivery; it cannot retract streamed text or tool effects.

Reuse existing campaigns and optimization methods to measure questions, context
selection, rubric levels, and routing policies. Keep final assessment independent of
selection and retain exact input/model/policy identities. Do not treat reported model
confidence as demonstrated calibration or a classification as proof of root cause.

## Checks

Run `pnpm exec vitest run tests/systemone*.test.ts tests/evaluation-authority.test.ts`,
`pnpm typecheck`, `pnpm build`, and `pnpm verify:package`. These are contract and
execution checks, not live-provider quality or deployment evidence. The product-integrity
rubric lives in `examples/`, not the generic implementation, and is not a default policy.

Protocol: https://docs.typesafe.ai/api
Clef: https://developers.cloudflare.com/workers-ai/models/clef/
SDK (optional builders): https://github.com/typesafe-ai/typesafe-sdk-js
