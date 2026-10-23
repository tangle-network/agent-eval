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

## DomainMatch

`prepareSystemOneDomainMatch` builds a frozen three-question classification for products that need
relevance, a caller-owned category, and an exact source segment. `assessSystemOneDomainMatch`
revalidates the retained answer and returns `match`, `no_match`, or `uncertain` without another
model call. It does not choose a domain taxonomy, threshold, credential, endpoint, or effect.

```ts
const prepared = prepareSystemOneDomainMatch({
  version: 'health-v1',
  model: selectedModel,
  intent: 'Find personal health correspondence, not general wellness marketing.',
  categories: { lab_result: 'A medical laboratory result', appointment: 'An appointment' },
  evidence: [{ id: 'email-1', text: emailText }],
  coverage: 'complete',
  thresholds: {
    matchAtLeast: 0.8,
    noMatchAtLeast: 0.8,
    categoryAtLeast: 0.7,
    sourceAtLeast: 0.7,
    minimumMargin: 0.2,
  },
})
const observation = await evaluate(prepared.request, { signal, idempotencyKey })
const decision = assessSystemOneDomainMatch(prepared, observation.value)
```

A positive match requires the match, category, and source questions to pass their thresholds and
margins. Missing evidence stays unresolved; partial evidence can support a match but cannot refute
one. The report retains native probabilities and an exact host-supplied evidence segment. Those
probabilities are not calibrated domain confidence, and a result never authorizes storage, hiding,
sending, deletion, or another effect. Re-assessing the same prepared input and retained answer is
an offline replay, not new inference.

## Rationale and evidence limits

The native request and answer types in [`systemone-protocol.ts`](../src/systemone-protocol.ts)
declare no free-form rationale, generated evidence URI, or extracted text-span field.
Instructions asking for an explanation do not establish a supported output contract.
Do not issue a second explanation call to fill this gap.

The same request can include another named `choice` question whose criteria keys are
caller-supplied evidence IDs, including an explicit unresolved option. DomainMatch already
uses this pattern for source selection. The answer selects from that finite set; it does
not establish that the selected source caused or justifies another answer. Retain the
immutable ID-to-source mapping with the invocation's evidence so the selection remains
inspectable on replay. Grounding and calibration require independent checks.

Native response extensions may survive parsing into the evaluator's returned raw value.
That does not promise the provider generates them or that downstream records retain them.
The declared protocol and each consumer's persistence schema determine what survives.

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
the pair with `auditProbabilityPolicy` against independent outcomes.

Score each question type with its proper scoring rule from `/meta-eval`, on `probabilities` and
`noul`, never on `confidence`:

| Question | Rule |
| --- | --- |
| `noul` | `brierScore` (binary) |
| `choice` | `multiclassBrierScore` (sum form, range 0 to 2) |
| `score` | `rankedProbabilityScore` (levels in order, range 0 to 1) |

Top-label ECE comes from `calibrationFromPairs` on (top probability, top answer correct) pairs, with
`range: { lo: 0, hi: 1 }` and `binning: 'equal-frequency'` for equal-mass bins.
When items share a source (one task, one pull request), interval estimates resample whole sources:
`clusterBootstrapMean` takes per-item values or per-item paired differences with their cluster id.

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

## Decision points

`decisionPoint` from `/systemone` adds durable routing to the evaluator. A point
serves many `layers`; each invocation names its current layer and consumer.
The same layer can use many points. Questions use typed choices; policies map
every option to `act` (with a route), `escalate`, or `record`, with probability
and margin thresholds per question. These are recommendations; the consumer
performs and records the actual action. An escalation in any question takes
precedence over `act`, which takes precedence over `record`.

Use this for judgment over unstructured state only when a wrong recommendation
is cheap and reversible and uncertainty can reach an agent or a human. It never
grants authority to delete, deploy, merge, retire, lift a stand-down, or override
an acceptance check. Code continues to read objective facts directly. Sample or
trigger these calls instead of evaluating every event. Existing DomainMatch
continues to supply its domain-specific request and assessment; this primitive
uses the same native evaluator and answer validation, not another model adapter.

A policy may drive a route only with independent labeled evidence: positive
`gold_n`, finite Cohen κ meeting `DECISION_POINT_MIN_KAPPA` (owned in
[`decision-point.ts`](../src/decision-point.ts)) and `evidenceRefs`.
`decisionQuestionDigest({ id, version, model, servedModel, name, question })` binds that
evidence to the authored question, option order and model. Changed served model
identity, absent/stale calibration, ties and below-threshold answers escalate.
κ measures label agreement; the joined outcome curve measures probability
reliability. Do not describe one as proof of the other.

Supply `ledger: openFindingsLedger({ path })` from `/analyst` and the existing
`SystemOneEvaluatorOptions` as `evaluator`. `decide` accepts `runId`,
`invocationId`, `layer`, `consumer`, `state`, `scope`, `at`, and `evidenceRefs`,
plus the existing evaluation context for cancellation, spending and receipts.
Inspect the typed `succeeded` result before reading its `value`.

The findings ledger is the sole persistence owner. Every invocation first
appends a 1.1.0 intent with a unique owner token. Competing callers cannot both
infer. Completed calls record state/input/definition digests, the policy and
calibration identity, requested/served model, probabilities, recommendation and
receipt. Failed or cancelled evaluations record escalation with accounting when
available. A persistence failure returns a typed error and withholds action.
Exact `(point id, runId, invocationId)` replay reuses the original result, across
restart; changed inputs or definitions conflict. The input includes its original
`at`, so callers retain it. An intent without a result remains explicit and
escalates; deliberate recovery uses a new invocation id instead of silently
repeating a possibly paid call. The journal's normal lock/dead-owner rules apply.

Decision records persist each named choice and its probabilities, so an explicit
evidence-ID question uses the same ledger and replay path. They do not automatically
retain arbitrary native response extensions or convert a selected ID into an `EvidenceRef`.
The record's `reason` (for example, `uncalibrated`) is a computed policy reason, not a
model-authored rationale; the receipt records accounting. Each additional question still
needs its own policy and calibration, and an uncalibrated question escalates the invocation.

Call `observe({ runId, invocationId, labels, at, evidenceRefs })` later to join
independently observed option labels to a decision. This is the answer's truth,
not whether a downstream workflow happened to succeed. Retain the original
observation timestamp for exact replay. Conflicting labels refuse append.
`reliability()` reads the same ledger and returns total decisions, labeled and
missing outcomes, and per-question sample counts, empirical curves and threshold
accuracy. A curve needs two labels; otherwise it is `null`. Threshold tables are
development evidence for an explicit policy revision and fresh confirmation,
not automatic tuning or activation. Failed calls remain in the denominator.

Decision findings retain their measured layer and scope. The existing `/analyst`
`promote` is the only owner for generalizing claims; it does not authorize
routing and does not lift event/turn findings directly into run-level claims.

The data model permits many-to-many associations. The only intentional
one-to-one rules are one primary measure per hypothesis (to prevent choosing
a winner after seeing outcomes), with any number of secondary measures, and
one implementation per code concept (to prevent divergent owners).

Decision-point construction validates the complete calibration object, including nonempty structured evidence references, before any inference. Malformed configuration throws; well-formed evidence below the calibration bar still escalates. `observe()` returns a typed `invalid` result for uncloneable, noncanonical or malformed observation data without appending an outcome. A provider identity with surrounding whitespace is rejected as a failed evaluation; its durable escalation replays and remains readable by reliability reporting.

The existing behavioral analyst optionally applies bounded [trace questions](behavioral-trace-questions.md) through decision points; exact repeated tool calls stay computed.
