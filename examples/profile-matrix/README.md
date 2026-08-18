# Run the same cases across several profiles

## When to use it

Use `runProfileMatrix()` when the question is "which profile does these cases best".
A profile is one complete agent configuration: model, prompt, tools, harness.
The matrix runs every case against every profile and returns one validated `RunRecord` per cell.

Use `runCampaign()` instead when one configuration runs one case grid.
Use `compareOptimizationMethods()` instead when two search methods compete at equal budget.
[`docs/eval-surface-map.md`](../../docs/eval-surface-map.md) maps all of the `run*` functions.

## How to run it

```sh
pnpm tsx examples/profile-matrix/index.ts
```

The run prints one `expectUsage` warning per cell first.
That warning is the stub detector working: this offline dispatch makes no paid call, so no cell carries a cost receipt.
Then it prints:

```
support-terse-96a08efb92e36141: mean composite 0.00 over 3 records
support-cited-ea975227cc9c0cc6: mean composite 1.00 over 3 records
records: 6
```

## Why it is built this way

The matrix exists to stop one specific silent failure: a leaderboard computed from a stubbed backend.
A dispatch that calls a model must report usage through `ctx.cost.runPaidCall`.
A dispatch that reports zero tokens is indistinguishable from a stub, so the default `integrity: 'assert'` fails the whole matrix instead of returning a clean 0/N table.

This example sets `integrity: 'off'` because the dispatch is honestly offline.
That setting is for offline and replay analysis only.
Keep the default in every live run.

`result.records` feeds directly into `analyzeRuns()`, `HeldOutGate`, and scorecards.
Every record carries the profile hash, the commit SHA, and the judge scores, so a later reader can trace any number back to the exact configuration that produced it.
