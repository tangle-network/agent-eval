# multi-shot-optimization

Optimize a full trajectory across a small variant population with a **held-out
promotion gate**: a variant only ships if it beats baseline on a separate
holdout set, not just the search set it was selected on.

## What it shows

- `runMultiShotOptimization` driving a genetic loop with custom `runner`,
  `scorer`, and `mutateAdapter`.
- The `gate` block separating *search* scenarios (used for selection) from
  *holdout* scenarios (used for paired-delta promotion).
- How to produce a canonical `RunRecord` from each trial so the gate can do
  paired statistics on the holdout split.

## Run

```sh
pnpm install
pnpm exec tsx examples/multi-shot-optimization/index.ts
```

Runtime: ~1s. No LLM calls — the runner is a deterministic stub so the loop
mechanics are visible without paying for inference.

## Expected output

```
{ searchBest: 'baseline.g1.0', promoted: 'baseline.g1.0', gate: 'promote' }
```

`promoted !== searchBest` would indicate the search winner failed the holdout
gate — the example deliberately makes them agree to illustrate a clean ship
decision.

## Adapt this to your agent

Replace the `runner` with your real agent invocation, the `scorer` with your
judge or verifier, and the `mutateAdapter` with `createCompositeMutator` or a
GEPA-flavored mutator that consumes `bottomTrials` as reflection input.
