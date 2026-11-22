# Run an agent through a simulated launch quarter

This example plays `launchQuarterScenario`: a 91-day product launch reviewed once a week, with a budget and five channels whose results land days or weeks after the spend.
It first runs six scripted policies on the same seeds, then, when you give it an endpoint, puts one model through one episode.

The scripted table is the check that the scenario measures what it claims.
The patient policy has to beat the impulsive one, the set-and-hold one and both floors by more than seed-to-seed noise; if it does not, the script exits before any model is called.

See [simulated worlds with a clock](../../docs/world.md) for the concepts.

## Run the scripted policies

Offline; no key needed.

```sh
pnpm tsx examples/world-launch-quarter/index.ts
```

It prints one row per policy (mean end value, standard deviation, minimum and maximum across seeds, attempted unapproved spends, premature decisions) and one line per contrast.

## Run a model

| Variable | Default | Purpose |
|---|---|---|
| `LLM_BASE_URL` | none | OpenAI-compatible endpoint, up to its API prefix. Setting it turns the agent run on. |
| `LLM_API_KEY` | required with the endpoint | Key for that endpoint. |
| `AGENT_MODEL` | required with the endpoint | Model id. |
| `SYSTEM_PROMPT_FILE` | a short generic prompt | The system prompt of the agent you are testing. |
| `AGENT_SEED` | `1` | Seed of the agent's episode. |
| `SEEDS` | `10` | Seeds per scripted policy. |
| `OUT_DIR` | none | Writes `comparison.json`, `episode.json` and `transcript.jsonl`. |

The agent's 13 reviews are paid model calls: up to 16 calls per review.

The script prints the agent's end value beside each scripted row on the same seed, the calls the world refused, its premature decisions, and its five costliest decisions in expectation.
One episode is one draw from a noisy world: compare it with the scripted rows on that seed, and run more seeds before comparing two models.
