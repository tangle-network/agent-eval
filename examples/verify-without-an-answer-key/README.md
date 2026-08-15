# Certify A Result That Has No Answer Key

## When to use this

Use this example when the work has no held-out test suite.
An unsolved problem has none by definition, and a novel result cannot be graded against a key that does not exist.

Use it also when you must state how strong a certificate is.
"Certified" is not one bit: a proof kernel and an LLM judge can both return `{ valid: true, score: 1 }`, and they mean very different things.

## How to run it

```sh
pnpm tsx examples/verify-without-an-answer-key/index.ts
```

No API key is required.
The checker in this file is a stand-in, not a proof assistant.

## What it does

1. `VERIFICATION_STRATEGIES` reports each family member with its determinism class and its documented failure mode.
2. `defineEquivalenceCheck()` registers a blind two-arm design over one claim.
3. `runEquivalenceCheck()` runs an injected checker over the two committed statements.
4. Two arms that agree produce a `proved` obligation. Two arms that disagree produce a refutation and a separating witness.

The output is:

```text
test          deterministic  assumes an answer key; certifies nothing outside suite coverage, and a stubbed integration reports green
proof-kernel  deterministic  the formalization gap: the kernel certifies the formal statement, never that it matches the informal claim
agreement     probabilistic  the shared blind spot: derivers with common corpora or priors agree for the same wrong reason
agreeing arms:  proved
checker:        example-alpha-equivalence
divergent arms: refuted-with-separating-witness
witness:        the two statements disagree outside bound-variable names
```

## Why it is built this way

This package ships the taxonomy, the record types, and the refusals.
It ships no checker.
A checker is an injected boundary that returns a typed outcome, so you bind your own proof assistant, invariant harness, replication runner, or judge.
The binding carries its own identity and its own determinism claim, which is what makes a certificate re-runnable by someone else.

Both blindness flags must be `true`.
An arm that saw the other arm's statement, or saw the outcome, derived nothing independently.
The module refuses to record such a check rather than store an invalid one that looks valid.

A refutation is a successful check.
It reports the formalization gap — the specific way a proof kernel can certify a wrong result — with the witness that shows where the two statements part.

## Next

- Read the full family, the port shape, and the worked pilot: [`docs/verification-strategies.md`](../../docs/verification-strategies.md).
- See where every verifier lands its result: [`docs/verdicts.md`](../../docs/verdicts.md).
