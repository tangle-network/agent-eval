# Improve A Prompt Automatically

This example defines an agent, scenarios, a judge, a starting prompt, and a candidate generator once.
It then calls `defineAgentEval().improve()` to search for a better prompt and evaluate the winner on scenarios that were not used to generate candidates.

Run it from the repository root:

```sh
pnpm tsx examples/selfimprove-quickstart/index.ts
```

No API key is required.
The agent, judge, and candidate generator are deterministic local functions.

## What It Demonstrates

1. Define eight representative tasks.
2. Run the starting prompt on a training split.
3. Generate two candidate prompts.
4. Score every candidate with the same judge.
5. Evaluate the selected candidate on four held-back tasks.
6. Return the selected prompt, measured score change, cost, and release decision.

The stable part of the output is:

```text
Release decision:     ship
Raw lift:             +0.361
Generations explored: 1
Total cost:           $0.000
```

This is a wiring example, not statistical evidence.
Only four tasks are held back, so do not use its release decision as a production threshold.

## Adapt It

- Replace `agent` with the product call you want to improve.
- Replace `judge.score` with a deterministic check or a calibrated model-based judge.
- Replace the synthetic candidate generator with your own `SurfaceProposer`, or remove it and configure the built-in model-based proposer through `llm`.
- Increase the task corpus and repetitions until the score can distinguish known-good from known-bad behavior.

The complete implementation is [`index.ts`](./index.ts).
