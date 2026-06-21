# `defineAgentEval()` quickstart

The closed-loop journey. You have a prompt, a set of scenarios, a judge, and an agent. You want the substrate to propose better prompts, gate them on statistical lift, and tell you which one to ship.

```sh
pnpm tsx examples/selfimprove-quickstart/index.ts
```

## What this example does

1. Defines a tiny scenario corpus (8 marketing-copy prompts).
2. Wires a synthetic `agent` that simulates an agent producing artifacts with deterministic noise (higher score when surface contains "tight" / "specific").
3. Wires a simple judge that scores artifacts on `clarity` and `concision`.
4. Wires a synthetic `SurfaceProposer` that proposes two surface variants per generation (so the example runs without LLM credits).
5. Defines the eval once with `defineAgentEval()`, then calls `.improve()` with a 1-generation budget against in-memory campaign storage.
6. Prints the full decision packet.

The agent, judge, and proposer are all synthetic so the example runs offline. For real use:
- Replace `agent` with your actual agent + scenario interpreter.
- Replace `judge.score` with your real LLM-as-judge (or a `langchainJudge` from `/adapters/langchain`).
- Drop the custom `proposer` — `.improve()` delegates to `selfImprove()`, whose default is `gepaProposer` (reflective LLM mutation). That path needs an LLM endpoint configured via `opts.llm`.

## What you should see

```
═══ selfImprove() decision packet ═══

Gate decision:        ship
Raw lift:             +0.361
Generations explored: 1
Total cost:           $0.000

── Statistical lift (paired bootstrap, n=4) ──
delta:    +0.359
CI95:     [0.311, 0.408]
pValue:   0.0013
Cohen's d: 8.58
MDE @ 80% power: 1.401
required n at observed effect: 122

── Composite distribution (n=8 cells) ──
mean: 0.696, p50: 0.685, p95: 0.921, stddev: 0.183

── Cost-quality Pareto ──
2 candidates plotted; 1 on the frontier

── Per-judge mean scores ──
  rubric: 0.696 (n=8)

── Recommendations ──
[critical] ship — Ship — lift 0.359 (95% CI 0.311..0.408)
  Holdout lift exceeds threshold 0.02 with 95% bootstrap confidence (n=4, p=0.0013, d=8.58).

═══ end ═══
```

Note: with only 8 scenarios and a 50% holdout fraction, the paired lift is computed on 4 observations — useful to see the shape of the packet, not statistically informative. Real corpora should be ≥ 20 scenarios with ≥ 3 reps for meaningful CI on the lift. The `requiredN` field tells you exactly how many you'd need.

## Files

- `index.ts` — the runnable script
