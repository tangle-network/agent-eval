# `selfImprove()` quickstart

The closed-loop journey. You have a prompt, a set of scenarios, a judge, and an agent. You want the substrate to propose better prompts, gate them on statistical lift, and tell you which one to ship.

```sh
pnpm tsx examples/selfimprove-quickstart/index.ts
```

## What this example does

1. Defines a tiny scenario corpus (3 marketing-copy prompts).
2. Wires a synthetic `agent` that simulates an agent producing artifacts with deterministic noise (higher score when surface contains "tight" / "specific").
3. Wires a simple judge that scores artifacts on `clarity` and `concision`.
4. Wires a synthetic `SurfaceProposer` that proposes two surface variants per generation (so the example runs without LLM credits).
5. Calls `selfImprove()` with a 1-generation budget against in-memory campaign storage.
6. Prints the full decision packet.

The agent, judge, and proposer are all synthetic so the example runs offline. For real use:
- Replace `agent` with your actual agent + scenario interpreter.
- Replace `judge.score` with your real LLM-as-judge (or a `langchainJudge` from `/adapters/langchain`).
- Drop the custom `proposer` — selfImprove() defaults to `gepaDriver` (reflective LLM mutation), which needs an LLM endpoint configured via `opts.llm`.

## What you should see

```
═══ selfImprove() decision packet ═══

Gate decision:        ship
Raw lift:             +0.194
Generations explored: 1
Total cost:           $0.000

── Statistical lift (paired bootstrap, n=1) ──
delta:    +0.254
CI95:     [0.254, 0.254]
pValue:   1.0000
Cohen's d: 0.00
MDE @ 80% power: 2.802
required n at observed effect: 244

── Composite distribution (n=3 cells) ──
mean: 0.653, p50: 0.720, p95: 0.743, stddev: 0.114

── Cost-quality Pareto ──
2 candidates plotted; 1 on the frontier

── Per-judge mean scores ──
  rubric: 0.653 (n=3)

── Recommendations ──
[critical] ship — Ship — lift 0.254 (95% CI 0.254..0.254)
  Holdout lift exceeds threshold 0.02 with 95% bootstrap confidence (n=1, p=1.0000, d=0.00).

═══ end ═══
```

Note: with only 3 scenarios and a 50% holdout fraction, the paired lift is computed on a single observation — useful to see the shape of the packet, not statistically informative. Real corpora should be ≥ 20 scenarios with ≥ 3 reps for meaningful CI on the lift. The `requiredN` field tells you exactly how many you'd need.

## Files

- `index.ts` — the runnable script
