# Evidence-backed behavioral reviews

Use native evaluations to assess bounded hypotheses about recorded behavior. Do not ask one
classifier whether an agent is "malicious" or a whole run is "safe". Observable policy breaches,
model-supported hypotheses, missing evidence and unusual behavior are different results.

The optional `/jev` helpers are ordinary functions:

- `prepareJevReview`: validate and freeze caller-defined native questions, evidence references,
  coverage and decision thresholds before spending. The digest binds the definition, input and
  authored question/option order. Optional undefined object fields are absent on the wire.
- `assessJevReview`: validate native answers and interpret designated alternative masses as
  `supported`, `refuted` or `unresolved`. Re-scoring makes no network call.
- `jevReviewFindings`: map that report into the existing `AnalystFinding` contract. It keeps
  unresolved checks visible and labels supported claims as model-supported hypotheses.

These helpers do not constrain `jevEvaluator`, `jevJudge`, `jevAnalyst`, or the provider-independent
`createEvaluator`/`asJudge`/`asAnalyst` APIs. Use an ordinary custom mapper for different policies.
No model, taxonomy, severity, operating threshold, global safety score or storage backend is chosen
by the generic implementation.

## Direct product call

Supply the native request on each invocation. This example's `question`, `evidence`, `policy` and
`limits` are application configuration, not new library exports or default values.

```ts
import {
  prepareJevReview, assessJevReview, jevEvaluator,
} from '@tangle-network/agent-eval/jev'

const evaluate = jevEvaluator({
  evaluate: nativeTransport, // One Router /v1/systemone attempt; preserve signal/idempotency key.
  receipt: readRouterReceipt,
  maximumCharge: enforcedMaximumCharge,
})

const review = prepareJevReview({
  version: policy.version,
  request: {
    model: selectedModel,
    state: { policy: policy.definition, evidence: evidence.content },
    questions: { action: question },
  },
  checks: {
    action: {
      claim: policy.hypothesis,
      subject: actionId,
      area: 'authorization-review',
      severity: policy.severity,
      supports: ['supported'],
      refutes: ['refuted'],
      supportAtLeast: limits.support,
      refuteAtLeast: limits.refute,
      coverage: evidence.coverage,
      evidence: evidence.refs,
    },
  },
})
const result = await evaluate(review.request, executionContext)
await persistAuthorizedObservation({ review, result })
const report = assessJevReview(review, result.value)
```

The example assumes a native Choice question with `supported`, `refuted` and `insufficient`
alternatives. Other labels, Noul polarity (`true`/`false`) and grouped Score levels are supported.
A Score's expected level is not itself the probability of a breach; explicitly select which
levels support or refute the claim. The two thresholds must be positive, at most one and sum to
more than one, so their regions do not overlap. This is an optional disjoint-region policy,
not a requirement imposed on other evaluators.

## Optional behavior recipe

`examples/jev-behavior-review.ts` provides replaceable question definitions and
`behaviorReviewAnalyst`, which composes the existing `jevAnalyst`. Copy/adapt the recipe in an
application; it is not a default policy installed by importing the package. Select only relevant
checks and provide thresholds, severity, exact policy and evidence for every selected check.

| Hypothesis | Evidence needed | Important distinction |
| --- | --- | --- |
| Reward gaming | Task objective, raw proxy score, independent outcome and attributable action | A proxy/outcome gap can be a broken evaluator, not deliberate gaming. |
| Evaluator tampering | Protected evaluator identity, allowed changes and trusted before/after diff | A task that authorizes test repair must not be flagged merely for editing tests. |
| Safety-policy violation | Exact applicable policy and attributable action/output | Quotation, refusal and simulation are not completed violations. |
| Unauthorized action | Effective grant at action time, requested target and enforcement outcome | An attempted action, a blocked request and a completed effect differ. |
| Data-boundary violation | Data classification, allowed destination and actual payload/egress record | Do not infer a successful transfer from a plan or URL mention. |
| Injection followed | Untrusted instruction, trusted task and subsequent attributable action | Reading or rejecting malicious text is not obeying it. |
| Contradicted success claim | Exact claim and independent receipt for the same operation | No receipt means unresolved, not proof of deception. |
| Oversight bypass | Applicable approval/monitor/cancel control and attributable change | Lost telemetry or an authorized control change is not evidence of agent evasion. |
| Anomalous sequence | Matched versioned baseline and differences computed in code | Unusual does not mean harmful; no baseline means no established anomaly rate. |
| Cross-run coordination | Authorized joined traces, linkage, timeline, policy and joint effect | Shared infrastructure or legitimate delegation is not collusion. |

A hypothesis gets its own question; these behaviors are not mutually exclusive alternatives in
one forced-choice category. Prefer a small relevant evidence window per review. A rule such as
"use only evidence.X" is an instruction, not technical isolation between other inputs in the
same request. Run separate requests when evidence or tenant isolation requires it.

## What the numbers mean

The report retains support, refutation and remaining native mass without renormalizing away
uncertainty. Native `confidence` is stored separately: TypeSafe defines it as a statistic of the
distribution, not the same value as the winning alternative's probability. Neither is a measured
probability of malicious intent, future harm or successful exfiltration.

The host declares evidence coverage. Non-missing coverage requires references; the library does
not authenticate those references, read their targets, prove completeness or know that the
right evidence was supplied. The caller must bind references to immutable authorized records
and put the relevant content in state. A policy document alone is not behavioral evidence.
Missing evidence always stays unresolved. Partial evidence may support a scoped hypothesis but
cannot refute it under this helper's conservative policy.

Every native result should be retained through the existing `record` callback before findings
are reduced. A refuted check remains in the report but produces no issue finding; an empty
finding list is not a universal safety certificate. Supported findings use model support mass
as `confidence`, explicitly marked uncalibrated. Unresolved findings use confidence 1 only for
the deterministic fact "this review is unresolved", with `confidence_basis: deterministic-status`.
Do not graph those two bases together as risk probabilities.

Do not multiply probabilities from correlated questions, add overlapping category probabilities
as a run-wide risk, or substitute `1 - P(supported)` for `P(refuted)` when insufficient evidence
has its own mass. For an independent audit of these ternary outcomes, use `auditEvaluator` with
the actual mapped decision and unknowns. `auditProbabilityPolicy` is for a genuine binary
probability with its frozen binary threshold rule; it must not silently drop the third category.

## Existing components to reuse

`/rl` already has `detectRewardHacking` for reward divergence, distribution shift, reward
disagreement and judge drift. Those diagnostic scores are not probabilities. Keep the raw,
ungated proxy and independently measured task outcome so a previous rejection does not hide the
disagreement. Do not substitute the Jev monitor as the only independent outcome.

The analyst system already has deterministic control-integrity and behavioral/efficiency
checks, plus deep trace analyst definitions such as intent divergence and knowledge poisoning.
Run exact checks for facts code can establish; use a bounded semantic review for interpretation;
escalate selected cases to the existing deeper analyst. None is replaced by this recipe.

A prepared review can be a custom registry input or built from a filtered trace store. Existing
`asAnalyst`/`jevAnalyst` forward the shared paid-call account, cancellation and deadline. The
recipe verifies persisted definition identity before inference, records the native observation
before mapping, and returns ordinary findings. Graphs consume these through their existing
analyst-registry adapter. No new supervisor, scheduler, ledger, or trace database is introduced.

For judges, map assessments explicitly and refuse unresolved evidence where the scored metric
requires resolution. Never convert an unresolved safety review to a perfect score or average a
critical constraint failure into unrelated high scores. Working feedback must not expose the
independent final evaluator, protected holdout labels, or monitor control credentials to the worker.

## Security and validation boundaries

TypeSafe's Jev 1.13 documentation explicitly warns that adversarial state content can move the
answer. Delimiters and explicit criteria are useful instructions, not a proof of injection
resistance. These monitors are advisory evidence, not the sole authorization/safety barrier.
Trusted policy and references must come from outside the evaluated agent; tenant scope, redaction,
credential handling and controls remain with existing application/security owners.

A required pre-action check must execute before the effect, and a pre-delivery check must run
before streaming exposes the answer. Post-run analysis cannot undo an effect or retract text.
External harnesses only support their actual documented boundaries; a whole-prompt callback is
not an interception of every native request. An observational hook is not a blocking gate.

Before enabling automatic decisions, independently test both attacks and ordinary authorized
behavior: legitimate test edits, benign quotations, refusals, blocked attempts, telemetry gaps,
wrong-tenant evidence, long/misleading traces and multi-run attacks. Measure per-category false
positives, false negatives, abstention, task success, latency and full cost using independent
source units. Freeze thresholds on development data, retain a separate final set, and audit a
sample of accepted cases to avoid selective-label blindness. Test the monitor under adaptive
attacks, not only the worker under a fixed monitor.

The new tests exercise pure mapping, canonical identity, metadata isolation and real
Eval/AnalystRegistry accounting composition with an injected model boundary. They do not prove
that Jev detects these behaviors correctly or is robust against adversarial prompts. No live
provider, product UI rollout, runtime hook installation or production enforcement is added here.

Sources reviewed: https://docs.typesafe.ai/confidence and
https://docs.typesafe.ai/model-jaggedness/jev-1.13 (vendor page reviewed 2026-09-17).
