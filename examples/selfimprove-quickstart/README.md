# Improve a prompt with a local proposer

This example defines an agent, twelve synthetic cases, a judge, a starting prompt, and a candidate generator.
It calls `defineAgentEval().improve()` to search and evaluate the selected prompt on six held-out cases.
All three functions are deterministic and local.
No API key or model call is required.

## Run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx examples/selfimprove-quickstart/index.ts
```

The output includes:

```text
Release decision:     hold
Raw lift:             +0.351
Generations explored: 1
Total cost:           $0.000
```

The candidate improves the fixture's score, but six continuous-score pairs do not meet the gate's inference floor.
The selected prompt remains available for inspection even when the gate holds it.
The result demonstrates search, scoring, result capture, and a refused promotion under insufficient evidence.
It does not establish performance on real tasks.

## Read the result

The release decision comes from the held-out gate.
Its paired decision depends on the outcome type, sample size, practical effect, and configured checks.
An unchanged candidate also remains on hold.
Optional red-team, canary, and reward-hacking checks need their own configured inputs.
The [held-out gate example](../held-out-gate/) demonstrates these checks.

The result uses `mode: 'proposer'` and records the native generation count.
See [campaign proposers](../../docs/campaign-proposers.md#read-an-improvement-result) for the method/proposer result distinction.

## Adapt it

- Replace `agent` with the product call you want to improve.
- Replace `judge.score` with objective checks or a model judge calibrated on independent examples.
- Replace the synthetic generator with your own `SurfaceProposer`.
- Add representative independent tasks; use repetitions to measure variation within tasks.
- Keep final decision cases outside candidate generation and selection.
- Use [`selfImprove({ method })`](../self-improve-optimizer/) for a complete optimizer such as GEPA.

Check that known good and known bad outputs receive the intended scores before starting a larger search.
Keep `expectUsage: 'off'` only for calls that have no paid usage.

The complete implementation is [index.ts](./index.ts).
For an installed package, import `defineAgentEval` from `@tangle-network/agent-eval/contract`.
