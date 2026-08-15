# Let Another Package Search, And Keep The Scoring Here

## When to use this

Use this example when a package already knows how to search over text, and you want its search without giving up control of execution, cost, and the final measurement.

Use it also when you must show that the reported lift was not obtained by letting the optimizer see the final cases.

For the official GEPA and SkillOpt bindings, use [`compare-optimization-methods`](../compare-optimization-methods/) instead.
This example is the general adapter for anything else.

## How to run it

```sh
pnpm tsx examples/adapt-a-text-optimizer/index.ts
```

No API key is required.
The optimizer in this file is a local hill climb.

## What it does

1. `externalTextOptimizationMethod()` wraps a `run` callback with the package's identity and limits.
2. The callback receives the starting candidate, train cases, and selection cases.
3. Every candidate is scored through `context.evaluate()`, which uses the configured execution and judges.
4. `compareOptimizationMethods()` runs the method, then scores the selected surface on final cases.

The output is:

```text
method:        local-hill-climb
baseline:      0.000
winner:        1.000
final lift:    1.000
lift interval: [1.000, 1.000]
cost is a complete total: true
```

## The three case sets

| Set | Who sees it | What it decides |
|---|---|---|
| Train | The optimizer | Which candidates it writes |
| Selection | The optimizer | Which candidate it keeps |
| Final | Nobody until the search ends | The reported lift |

The `run` callback never receives final cases.
That separation is the whole reason the reported number means anything.

## Why it is built this way

`context.evaluate()` is the only scoring path.
Calls are counted before execution and stop at `maxEvaluations`, and an unknown case id is rejected.
An optimizer that scored candidates its own way could report any number it liked.

`maxOptimizerCostUsd` is required.
An adapter cannot be wired up without stating what the search may cost.

Every optimizer-owned paid call must go through `context.cost.runPaidCall()`.
Declare `costAccounting: { kind: 'no-paid-work' }` only when the optimizer really makes none, as here.

Read `totalCost.accountingComplete` before you treat the reported dollars as a complete total.
Read `pairwise` before you claim one method beat another.

The train and selection campaigns are separate campaigns from the final scoring campaign.
Settings meant for both go in `optimizationRunOptions`.

## Next

- A complete adapter against a real package: [`docs/campaign-proposers.md`](../../docs/campaign-proposers.md#adapt-a-third-party-text-optimizer).
- Recipes, budgets, resuming, and data separation: [`docs/campaign-proposers.md`](../../docs/campaign-proposers.md).
