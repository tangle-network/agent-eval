# Register The Rules, Then Execute Only Those Rules

## When to use this

Use this example when the result must convince someone who does not trust you.
An experiment that chooses its threshold after seeing the numbers proves nothing.
This front door removes that possibility: the rules are data, the data is hashed, and the execution surface accepts no rule that is not in the hash.

Use it before you spend on an A/B comparison, not after.

## How to run it

```sh
pnpm tsx examples/sealed-experiment/index.ts
```

No API key is required.

## What it does

1. `ExperimentSpec` states the arms, the outcome, the admission funnel, the estimand, the interval, and the decision table.
2. `sealExperiment()` hashes the whole rule tree and returns a digest.
3. `verifySealedExperiment()` proves the tree still matches its digest.
4. `openSealedExperiment()` returns the executors bound to that seal.
5. `admit()` runs the funnel, `estimate()` computes the contrast, `interval()` brackets it, and `decide()` reads the registered table.

The output is:

```text
seal digest:   514cf827e89aad8dfea580f15e03fb90c4572f7fc07be8fec2d6fd265f600878
seal verifies: true
population: support cases the baseline failed
input: 8
stage                entering  excluded  remaining
-------------------  --------  --------  ---------
has-a-known-outcome  8         1         7
baseline-failed-it   7         1         6
surviving: 6  (input 8 = surviving 6 + excluded 2)
risk difference: 0.8333333333333334
95% interval:   [ 0.6666666666666666, 1 ]
verdict:        citation-helps
```

## Why it is built this way

`estimate()`, `interval()`, and `decide()` take a registered name plus evidence.
None of them takes an alpha, a threshold, a metric, or a stopping rule.
A rule that is not in the seal cannot run, and a rule that is in the seal cannot run differently.

The funnel is the denominator chain.
Every stage reports how many rows entered, how many it removed, and how many remain, and the total must reconcile.
A result whose denominator changed between stages is visible in the table rather than lost.

The outcome field `passed` is a boolean.
It reads as 1 or 0, so the paired mean difference is the risk difference and no caller has to re-encode the rows.

The interval resamples pair differences, not raw pass flags.
The registered quantity is a contrast, so its uncertainty must be the uncertainty of that contrast.

## Next

- Read the doctrine and the refusals: [`docs/experiment.md`](../../docs/experiment.md).
- Certify a result that has no answer key: [`verify-without-an-answer-key`](../verify-without-an-answer-key/).
