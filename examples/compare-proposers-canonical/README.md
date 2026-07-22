# Compare Optimization Methods

This example compares `gepa-reflection`, `gepa-pareto`, and `skill-opt` on the same transaction-field extraction task.

It uses three separate scenario sets:

| Set | Used for |
|---|---|
| Train | Candidate generation and failure analysis |
| Selection | Candidate acceptance and early stopping |
| Test | Final lift intervals and method ranking |

All optimization finishes before the first test scenario runs.
The worker calls an OpenAI-compatible model endpoint, while the output judge uses deterministic exact matching.
The run stops if the endpoint reports no model usage.

The task, worker, and judge are shared with the other extraction examples through [`../_shared/extraction-task.ts`](../_shared/extraction-task.ts).

## Run

With DeepSeek:

```bash
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY="$DEEPSEEK_API_KEY" \
LLM_MODEL=deepseek-chat \
PRICE_IN_PER_M=0.27 \
PRICE_OUT_PER_M=1.10 \
pnpm tsx examples/compare-proposers-canonical/index.ts
```

With the Tangle router:

```bash
TANGLE_API_KEY="$TANGLE_API_KEY" \
pnpm tsx examples/compare-proposers-canonical/index.ts
```

Optional settings:

| Variable | Default | Meaning |
|---|---:|---|
| `POPULATION` | `2` | GEPA candidates per generation |
| `GENERATIONS` | `2` | GEPA generations |
| `EPOCHS` | `3` | SkillOpt rounds |
| `PRICE_IN_PER_M` | `1` | Input-token price per million |
| `PRICE_OUT_PER_M` | `5` | Output-token price per million |

The JSON result is written to `.evolve/compare-proposers-canonical/<timestamp>/lift-proposers.json`.

## Historical Result

[`lift-proposers.json`](./lift-proposers.json) records a June 2026 run, but it predates the three-set API.
SkillOpt used the same six scenarios for candidate acceptance and final ranking, so this artifact confirms that the model calls and scoring path ran but cannot support a comparison between methods.

| Method | Reused-set lift | 95% interval | Baseline to winner | Optimization cost |
|---|---:|---:|---:|---:|
| `gepa-reflection` | +0.417 | [0.208, 0.583] | 0.583 to 1.000 | $0.0028 |
| `skill-opt` | +0.417 | [0.208, 0.583] | 0.583 to 1.000 | $0.0035 |
| `gepa-pareto` | +0.375 | [0.208, 0.583] | 0.583 to 0.958 | $0.0028 |

The run made 176 model calls, used 16,779 input tokens and 7,175 output tokens, cost $0.012, and took 131 seconds.
Run the current example before citing a method ranking.

## Automation

`ci.yml` runs deterministic tests with a local model stub on every pull request.
`empirical-gate.yml` runs this example weekly or on demand when model credentials are available, then uploads the JSON result without blocking a release.
