# Score One Change On The Same Cases

## When to use this

Use this example when you changed a prompt, a skill, or a configuration value, and you must know whether the change helped.
It is the smallest complete path through the package: cases in, scores out.
Start here before any optimizer.

## How to run it

```sh
pnpm install
pnpm build
pnpm exec tsx examples/evaluate-a-change/index.ts
```

Run these commands from the repository root.
No API key is required.
The agent and the judge are local functions.

## What it does

1. `defineAgentEval()` receives three cases, an agent, one judge, and a starting surface.
2. `evaluate()` runs every case on the starting surface and scores each result.
3. A second `evaluate({ surface })` call runs the same cases on the changed surface.
4. Each call returns the score distribution under `aggregates.byJudge`.

The output is:

```text
baseline: 0
candidate: 1
```

The example prints each mean.
The returned aggregates also contain counts, intervals, and score distributions.

## Why it is built this way

The surface is the only value that changes between the two calls.
The cases, agent, and judge stay fixed in this deterministic fixture.
The changed surface accounts for its score difference.
Comparisons of real agents also need to account for execution variability and missing evidence.

`expectUsage: 'off'` is set because this agent makes no paid model calls.
Set `expectUsage: 'assert'` when connecting a paid agent so missing dispatch receipts become execution failures.
Keep the default whenever real model calls happen: it is the check that stops an unmeasured run from reading as a free one.

## Next

- Give the same object a candidate generator and a release rule: [`selfimprove-quickstart`](../selfimprove-quickstart/).
- Inspect the per-case grid before you spend: [`plan-before-you-spend`](../plan-before-you-spend/).
