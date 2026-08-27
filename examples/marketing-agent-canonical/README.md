# Marketing agent self-improvement demo

Runnable product-agent example: a real multi-step marketing agent, real
OpenAI-compatible endpoint, real `gepaProposer` reflective mutation, and real
held-out gate.

## Layout

| File | What it owns |
|---|---|
| `scenarios.ts` | 15 marketing rewrite scenarios across 15 surface types (landing-hero, tweet, push-notification, ...). 4 reserved as held-out for the gate. |
| `agent.ts` | 5-step marketing agent (research → outline → draft → critique → final). Optimizes the **final-pass system prompt** via `gepaProposer`. |
| `judge.ts` | 6-dim marketing-quality judge calibrated to real copywriting practice. Treat these dimensions as the product quality bar for the demo. |
| `index.ts` | `runEval` baseline → `runImprovementLoop` w/ `gepaProposer` + `defaultProductionGate` → markdown report artifact. |

## Run it

```sh
# Stub mode (heuristic judge, deterministic agent: wiring check):
pnpm tsx examples/marketing-agent-canonical/index.ts

# Live mode against any OpenAI-compatible endpoint:
OPENAI_BASE_URL=https://router.tangle.tools/v1 \
OPENAI_API_KEY=<your key> \
MODEL_ID=anthropic/claude-sonnet-4.6 \
JUDGE_MODEL_ID=anthropic/claude-opus-4.7 \
pnpm tsx examples/marketing-agent-canonical/index.ts
```

`OPENAI_BASE_URL` defaults to Tangle Router; swap for OpenAI direct,
OpenRouter, or any compatible endpoint.

Output:

- Console: baseline composite, generation-by-generation progress, gate
  decision, holdout baseline vs winner.
- `.marketing-agent-runs/<timestamp>/marketing-agent-report.md` -
  per-scenario lift table, shipped prompt, original prompt.

## What to look at after a run

1. Did the gate ship? (`gateResult.decision === 'ship'`)
2. Is the holdout lift > 0.05? (the canonical `deltaThreshold`)
3. Compare at least three winner outputs with their baselines and check whether the change is genuinely better.
4. Diff the shipped prompt vs baseline. Does the mutation make
   editorial sense and generalize beyond the judge's literal wording?

If 1+2+3 all look good, the demo is ready to show.

If the judge looks like it's gaming itself (3 fails), tune the judge
dimensions: `voice_match` + `audience_specificity` are the noisiest;
make them more anchored ("0.0 = X, 0.5 = Y, 1.0 = Z").

## Swap for a real product

When the founder is ready, this becomes the template:

1. Replace `runMarketingAgent` with their agent (wrap their existing
   API or framework via a `Dispatch`: see
   [`examples/foreign-agent-quickstart`](../foreign-agent-quickstart/)).
2. Replace `MARKETING_SCENARIOS` with theirs (8-15 scenarios spanning
   their real product surfaces).
3. Replace `MARKETING_JUDGE_DIMENSIONS` with the product's quality bar.
4. Run the same `runImprovementLoop` configuration; capture the report.

Everything in `index.ts` after the imports stays the same. The
substrate doesn't care what's under the `Dispatch`.
