# Score One Change On The Same Cases

## When to use this

Use this example when you changed a prompt, a skill, or a configuration value, and you must know whether the change helped.
It is the smallest complete path through the package: cases in, scores out.
Start here before any optimizer.

## How to run it

```sh
pnpm tsx examples/evaluate-a-change/index.ts
```

No API key is required.
The agent and the judge are local functions.

## What it does

1. `defineAgentEval()` receives three cases, an agent, one judge, and a starting surface.
2. `evaluate()` runs every case on the starting surface and scores each result.
3. A second `evaluate({ surface })` call runs the same cases on the changed surface.
4. Each call returns the score distribution under `aggregates.byJudge`.

The output is:

```text
baseline:  { 'ticket-id': { mean: 0, stdev: 0, ci95: [ 0, 0 ], n: 3 } }
candidate: { 'ticket-id': { mean: 1, stdev: 0, ci95: [ 1, 1 ], n: 3 } }
```

## Why it is built this way

The surface is the only value that changes between the two calls.
The cases, the agent, and the judge stay identical, so the score difference measures the change and nothing else.

`expectUsage: 'off'` is set because this agent makes no paid model calls.
The default is `'assert'`, which fails a run whose cells report no cost receipt.
Keep the default whenever real model calls happen: it is the check that stops an unmeasured run from reading as a free one.

## Next

- Give the same object a candidate generator and a release rule: [`selfimprove-quickstart`](../selfimprove-quickstart/).
- Inspect the per-case grid before you spend: [`plan-before-you-spend`](../plan-before-you-spend/).
