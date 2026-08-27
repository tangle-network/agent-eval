# Compare Optimization Methods

This example compares GEPA reflection, GEPA with Pareto parents, and SkillOpt on one structured-extraction task.

| Data | Used for |
|---|---|
| Train | Generate candidates from failures. |
| Selection | Accept candidates and select one surface per method. |
| Test | Measure final lift and rank methods. |

Every method finishes before final test scoring starts.
The worker calls an OpenAI-compatible model endpoint.
The judge uses deterministic exact matching.
The run fails when a successful worker call reports no model usage.

## Run

With DeepSeek's OpenAI-compatible endpoint:

```bash
LLM_BASE_URL=https://api.deepseek.com/v1 \
LLM_API_KEY="$DEEPSEEK_API_KEY" \
LLM_MODEL=deepseek-chat \
pnpm tsx examples/compare-optimization-methods/index.ts
```

With the Tangle router defaults:

```bash
TANGLE_API_KEY="$TANGLE_API_KEY" \
pnpm tsx examples/compare-optimization-methods/index.ts
```

Set `PRICE_IN_PER_M` and `PRICE_OUT_PER_M` together when the endpoint omits billed cost and the package does not recognize the model ID.
Both values are USD per million tokens.
If neither provider cost nor known model pricing is available, the output marks cost accounting incomplete.

## Settings

| Variable | Default | Meaning |
|---|---:|---|
| `POPULATION` | `2` | GEPA candidates per generation |
| `GENERATIONS` | `2` | GEPA generations |
| `EPOCHS` | `3` | SkillOpt rounds |
| `OPTIMIZATION_CONCURRENCY` | `1` | Methods optimized concurrently |
| `CALL_TIMEOUT_MS` | `30000` | Deadline for each model-backed scenario |
| `MAX_OPTIMIZATION_COST_USD` | `5` | Separate spend limit for each method |
| `MAX_TEST_COST_USD` | `2` | Shared spend limit for final test scoring |
| `PRICE_IN_PER_M` | unset | Optional input-token price |
| `PRICE_OUT_PER_M` | unset | Optional output-token price |

The current result is written to `.evolve/compare-optimization-methods/<timestamp>/comparison.json` and mirrored to `.evolve/compare-optimization-methods/latest.json`.
It includes train, selection, and test counts; backend usage; per-method lift; simultaneous intervals; paired scenario scores; selected surfaces; cost completeness; token counts; and elapsed time.
Rank follows estimated lift.
Use the intervals and pairwise `favored` fields before claiming that one method is better than another.

## Historical Artifact

[`comparison.json`](./comparison.json) records a June 2026 run made before the three-set API existed.
SkillOpt used the same six scenarios for candidate acceptance and final ranking.
The artifact proves that the worker and scoring path ran, but it does not support a method ranking.

| Method | Reused-set lift | Interval | Baseline to winner | Optimization cost |
|---|---:|---:|---:|---:|
| `gepa-reflection` | +0.417 | [0.208, 0.583] | 0.583 to 1.000 | $0.0028 |
| `skill-opt` | +0.417 | [0.208, 0.583] | 0.583 to 1.000 | $0.0035 |
| `gepa-pareto` | +0.375 | [0.208, 0.583] | 0.583 to 0.958 | $0.0028 |

That run made 176 model calls, used 16,779 input tokens and 7,175 output tokens, reported $0.012, and took 131 seconds.
Run the current example before citing a method ranking.

## Automation

`ci.yml` runs deterministic tests on every pull request.
`empirical-gate.yml` runs this example weekly or on demand when credentials are available, then uploads `comparison.json` without blocking a release.
