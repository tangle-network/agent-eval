# Improve an agent over multi-turn conversations

This example improves a support-desk system prompt over conversations with a simulated customer.
Each campaign cell is one conversation run by `multishotRollout()`: the candidate prompt is the agent, the simulated user plays one customer, and a code check of the transcript decides whether the refund policy was applied.
`selfImprove()` gives GEPA train and selection customers, re-scores its selected prompt on six held-out customers under the same simulated user and seeds, and returns a gate decision.
`repeatReliability()` then reports pass^k (served correctly in all k repeats) beside mean success for each arm.

The agent, the simulated user and GEPA's reflection are paid model calls.
See [multi-turn optimization](../../docs/multi-turn-optimization.md) for the concepts and rules.

## Install

Install the workspace and the GEPA bridge as in [the GEPA example](../self-improve-optimizer/README.md#install), then export `OPTIMIZER_PYTHON`.

## Configure and run

| Variable | Default | Purpose |
|---|---|---|
| `LLM_BASE_URL` | required | OpenAI-compatible endpoint for every call, ending at the API prefix such as `/v1`. |
| `LLM_API_KEY` | required | Key for that endpoint. |
| `AGENT_MODEL` | required | Snapshot model id for the agent. The final comparison refuses a pair whose served models differ. |
| `USER_MODEL` | required | Snapshot model id for the simulated user. |
| `GEPA_MODEL` | `AGENT_MODEL` | Reflection model. |
| `GEPA_PRICE_IN_PER_M`, `GEPA_PRICE_OUT_PER_M` | required | Exact reflection rates, so reflection spend is never a guessed zero. |
| `PRICE_IN_PER_M`, `PRICE_OUT_PER_M` | package pricing | Agent and user rates for an unlisted model or endpoint-specific prices. |
| `MAX_TURNS` | `6` | Agent turns per conversation. |
| `REPEATS` | `3` | Seeded repeats per customer; pass^k uses this k. |
| `MAX_TOTAL_COST_USD` | `15` | Hard cap; every call reserves its worst case first. |

```sh
pnpm tsx examples/multi-turn-optimization/index.ts
```

The script prints the gate decision, held-out success for both arms, pass^k beside mean success, total cost and the selected prompt.
