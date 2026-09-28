# Evaluator construction: plan, execute, audit

Use existing Runtime execution and Eval measurements. A product integration should not implement another error-bound formula, check counter, or per-call intent/result protocol.

## Plan before spending

```ts
import { planEvaluatorAudit } from '@tangle-network/agent-eval/meta-eval'

const policy = {
  confidence: 0.95,
  maxFalseAcceptanceRate: 0.1,
  maxFalseRejectionRate: 0.1,
}
const requirements = planEvaluatorAudit({ policy })
// minimumIndependentUnits: 42 per class for this policy, even with zero errors.

const capacity = planEvaluatorAudit({ policy, controls })
if (!capacity.sufficient) {
  // Collect enough authorized, independent evidence before constructing a checker.
  // Each class reports its actual count and additionalIndependentUnits.
}
```

A control has `id`, `independentUnitId`, `expected: 'accept' | 'reject'`, and `exposure: 'fresh' | 'development'`. It has no observed judgment. Repeated variants share a source identity. Any development exposure excludes that entire source unit, exactly as in admission.

This is a best-case eligibility floor, not power, permission to spend, or an admission certificate. A zero error-probability limit has no finite sample solution. `auditEvaluator` and `auditProbabilityPolicy` still require actual independent evidence. Their existing report and digest contracts are unchanged.

The existing `evaluatorAdmissionPolicySchema` and `evaluatorAuditObservationSchema` are exported from `/meta-eval`. Derive consumer contracts and types from these instead of copying policy fields or decision enums.

## Retain external check calls

```ts
import { createRetainedDispatch } from '@tangle-network/agent-eval/campaign'

const checks = createRetainedDispatch({
  runDir,                      // one private, durable logical episode directory
  scope: frozenManifest,       // authority, code/decoder revision, environment and inputs
  limits: { development: 20, audit: 84 },
  parse: validateRuntimeResult,
})

const result = await checks.run({
  lane: 'audit',
  input: { evaluatorDigest, caseId, inputDigest },
  signal,
  dispatch: () => executeIsolatedCheck(),
})
```

The limits above illustrate disjoint allowances; choose them from the approved experiment budget and required roster. Development cannot consume the audit reserve. Counts include uncertain calls. They are not dollars and do not replace the existing spend ledger or provider-enforced ceilings.

`result.succeeded` means an external-call result was retained, not that the task or checker passed. The value may itself record an execution failure. A settled result replays with `replayed: true`; it is parsed and its digest checked on every read. A result retained before a settlement lock conflict is reconciled by dispatch ID on retry, without repeating the external call. Concurrent callers on one handle share an in-flight call. Independent processes use the existing `CampaignStorage.append` compare-and-swap.

A process crash, thrown dispatch, cancelled in-flight call, or result loss after intent leaves `outcome_unknown`. A new caller does not repeat it or refund its allowance. A corrupt/missing settled receipt, changed scope, changed limits, or torn history is an error, not a fresh run. Keep the same directory on retry; changing the directory is a new episode, so the existing product job/authority owner must prevent that from becoming a budget reset.

The filesystem adapter fsyncs through the existing storage primitive. An in-memory adapter remains in-memory and cannot establish reboot recovery. Caller-owned storage must provide the documented atomic append contract. Keep the directory and result files outside generated code's permissions; content hashes are integrity checks, not a substitute for tenant authorization or a trusted storage boundary.

`runEval` still owns scheduling, judges, concurrency and campaign reports. Wrap only the external dispatch that needs uncertain-result protection. The primitive does not introduce a scheduler, database, execution backend or inferred price. Reference and generated-checker execution use the same mechanism.

The caller binds every behavior-affecting dependency and decoder revision into scope, validates the complete JSON result, and captures request state before dispatch. Noncanonical or non-round-tripping result encodings are refused rather than silently coerced.

## Prove the persistence path

```sh
pnpm exec tsx scripts/prove-retained-dispatch.ts
```

This executes real child processes against filesystem storage, kills an owner after its external write, and checks contention, completed replay, unknown-outcome retention, settlement-lock recovery, independent audit allowance, scope changes, cancellation, receipt identity and corrupted evidence. The maintained test suite runs the same proof. It makes no model calls and is not a semantic evaluator-quality or customer-savings benchmark.

An integration still needs its real Runtime/Sandbox execution, independent audit authorities, approved fresh evidence, complete cost reconciliation, and controlled activation proof. This API does not manufacture any of them.
