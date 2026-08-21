# One verdict vocabulary

Every verification path in this package lands in one type: `DefaultVerdict` (`src/verdict.ts`).
`valid` answers "did it pass", `score` answers "how well" in [0, 1], `scores` carries the per-dimension breakdown, and `certification` says WHO certified.

A certification is the epistemics a bare `valid` + `score` pair cannot carry.
A kernel-checked proof and an LLM judge can produce the same `{ valid: true, score: 1 }`; the certification is what tells them apart:

- `strategy` — which verification-strategy member vouches (the 10-member family with per-member failure modes: [docs/verification-strategies.md](./verification-strategies.md));
- `checker` — the exact identity that ran, with version and content pins, so the check is re-runnable;
- `assumptions` — every step the certificate rests on that the checker did NOT verify, named one by one;
- `evidenceDigest` — sha-256 of the evidence artifact (`certificationEvidenceDigest`).

An absent certification is itself a statement: scored, but nothing vouches.
No producer fakes one — a closed gate, an unexecuted proof, or an unattested checker yields an uncertified verdict, never an invented certificate.

## Producers

Every verifier below returns a `DefaultVerdict` (usually a richer extension of it) with a produced certification.

| Verifier | Verdict type | Strategy | Certifies | Assumptions it names |
| --- | --- | --- | --- | --- |
| `MultiLayerVerifier.run` (`src/multi-layer-verifier.ts`) | `VerificationReport` | `composite` | ordered layer pipeline blend | each skipped / errored / timed-out layer |
| `verifyCompletion` (`src/completion-verifier.ts`) | `CompletionVerdict` | the checker's own (`judge` for the LLM checker, `schema` for token recall) | task completion over produced state | lexical structural stage + the checker's attestation |
| `evaluateTraceContract` (`src/trace-contracts.ts`) | `ContractVerdict` | `invariant` | LTLf rules over a span sequence | array ordering without timestamps; custom predicate functions |
| `evaluateOracles` (`src/oracle.ts`) | `OracleReport` | `test` | declarative expected-outcome assertions | — (the oracle set is its own answer key) |
| `replayVerify` (`src/trajectory-replay/verify.ts`) | `ReplayVerdict` | `replication` | recorded failure reproduced (and fix vanished) under re-execution | unadjudicated prefix steps; truncated prefix; returncode-only signature |
| `verifyFindings` (`src/trajectory-replay/findings.ts`) | `VerifyFindingsRun` | `replication` | a batch of analyst findings under executed replay | not-replayable findings leave the denominator |
| `gradeRepairRow` (`src/trace-repair/grade.ts`) | `RepairRowResult` | `test` | a proposed repair against the row's held-out suite (pins: suite + policy digests) | vacuous reproduction gate; prefix divergence |
| `runEquivalenceCheck` + `equivalenceVerdict` (`src/verification-strategy.ts`, `src/verdict.ts`) | `DefaultVerdict` | the spec's member (`proof-kernel` in the pilot) | two blind formal statements are equivalent | arms self-declare blindness |

Two producers certify conditionally, on purpose:

- `gradeRepairRow` certifies only a `measured` outcome — a funnel gate that closed before the suite ran has nothing to vouch for.
- `verifyFindings` certifies only when at least one proof executed — a batch where nothing was replayable measured nothing.

## Reading a score out of a judge

A model judge emits one grade per dimension. Discrete grades tie: two candidates that both score `8` carry no ranking signal between them, and a best-of-N selection then picks arbitrarily.

`llmJudge({ scoring })` chooses how the number is read:

| `scoring` | What it reads | Requires |
|---|---|---|
| `{ method: 'sampled' }` (default) | the grade the model emitted | nothing |
| `{ method: 'expectation', whenUnavailable }` | the expected grade over the integer grades the model considered at the score token | `scale: 'ten'` and a provider that returns log probabilities |

Expectation scoring asks the provider for `logprobs` with `top_logprobs`, finds the token that carried each dimension's grade, and averages the integer grades in that token's probability window, weighted by probability. Two answers that both sample `8` separate by how much mass sat on `7` versus `9`.

It needs one integer in one token, which is why `scale: 'ten'` is required: a `[0,1]` float is several tokens, and no single position carries its distribution. A grade that did not land in exactly one token — a two-token `10` — is refused rather than approximated.

`whenUnavailable` decides what happens when the provider returns no log probabilities, or the grade spans tokens:

- `'fail'` throws, and the campaign records a failed cell.
- `'sampled'` reads the emitted grade instead.

`JudgeScore.scoringMethod` reports what actually produced the number, so a declared expectation run that fell back reads `'sampled'` and stays auditable. `JudgeScore.distribution` carries the probability mass per grade, and is present only for an expectation score. Panels are unchanged: `ensembleJudge` consumes the composite either way.

Whether a given endpoint returns `logprobs.content` is a property of that provider and model, not of this package. `LlmCallResult.logprobs` is `null` when the provider returned none — never an inferred distribution. See `evidence/records/judge-logprob-wire-support.json` for the current verification state of that wire behavior.

## Consuming a certification

Read `certification.strategy`, then weigh the member's documented failure mode — `VERIFICATION_STRATEGIES[strategy].failureMode` carries it at runtime.
"Certified" is never one bit: a `judge` certificate is Goodhart-gameable, a `test` certificate covers only its suite, a `composite` certificate can hide which member carried the score.
The assumptions list is the honest remainder; an empty list is the producer's explicit claim that nothing was left unverified, not a default.

Related docs: [verification-strategies.md](./verification-strategies.md) (the family and the equivalence protocol), [trace-repair-grader.md](./trace-repair-grader.md), [trajectory-replay.md](./trajectory-replay.md).
