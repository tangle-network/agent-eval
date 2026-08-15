# Get Cited Findings Out Of A Run

## When to use this

Use this example when a batch of runs failed and you must know why, in a form you can act on.
An analyst reads recorded evidence and returns findings.
Each finding carries a claim, a severity, a confidence, and the exact evidence it rests on, so a reader can check it instead of trusting it.

Use `runExact()` when the caller, not the registry, must own every execution choice: which analysts run, in what order, and with what budget.

## How to run it

```sh
pnpm tsx examples/custom-trace-analyst/index.ts
```

No API key is required.
The analyst in this file is deterministic and calls no model.

## What it does

1. One analyst declares its id, version, cost class, and `executionConfig`.
2. `AnalystRegistry` registers it.
3. `runExact()` runs the declared list and returns findings, an execution plan, and a completion record.

The output is:

```text
run status: complete
analysts:   1
high   run_tests failed: exit 1, 3 failing specs  [span:s2]
high   run_tests failed: exit 1, 1 failing spec  [span:s4]
```

## Why it is built this way

Every option in `runExact()` must be present.
`null` disables a channel on purpose, so a missing budget cannot be read as an unlimited one.
The registry contributes no default, which is the difference between this call and `registry.run()`.

Exact runs are serial.
A caller that needs concurrent or recursive scheduling composes exact runs in its own runtime rather than adding a second scheduler here.

Every receipt says whether it is `complete` or `failed`.
A complete receipt must cover the whole plan.
A failed receipt may cover only the part that ran, and it keeps the completed summaries, findings, usage, and cost that were already valid.

`cost: { kind: 'deterministic' }` is a promise the registry enforces: a deterministic analyst must not call a model.
Declare `{ kind: 'llm' }` when it does, and the budget channel becomes meaningful.

## Related helpers

| Goal | Call |
|---|---|
| Write a research question once and bind it to any engine later | `defineTraceAnalyst()` |
| Wrap an existing analyze function over a trace store | `defineCustomAnalyst()` |
| Start from the built-in analysts | `buildDefaultAnalystRegistry()` |
| Measure an analyst against labeled issues and exact spans | `runAnalystBenchmark()` |

## Next

- Read the analyst model and the public benchmark it is calibrated against: [`docs/trace-analysis.md`](../../docs/trace-analysis.md).
- Grade a finding by executing the repair it proposes: [`docs/trace-repair-grader.md`](../../docs/trace-repair-grader.md).
