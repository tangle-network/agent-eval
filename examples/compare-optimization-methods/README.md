# Compare Official GEPA And SkillOpt

This example runs official GEPA, official SkillOpt, or both against the same transaction-extraction task.
Each method receives five train cases and three selection cases.
Agent Eval evaluates selected prompts on six separate final cases after optimization finishes.

The worker calls an OpenAI-compatible endpoint.
The field-level judge is deterministic.

## Install

Install the Node dependencies from the repository root:

```sh
pnpm install
```

Install the Python bridge and the official optimizer packages:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "skillopt @ git+https://github.com/microsoft/SkillOpt.git@61735e3922efc2b90c6d6cab561e62e98452ca90"
python -m pip install \
  "gepa[full] @ git+https://github.com/gepa-ai/gepa.git@f919db0a622e2e9f9204779b81fe00cc1b2d808f"
```

From this repository, the locked equivalent is:

```sh
cd clients/python
uv sync --frozen --group skillopt-source --group gepa-source
cd ../..
export OPTIMIZER_PYTHON="$PWD/clients/python/.venv/bin/python"
```

## Run GEPA

```sh
export LLM_BASE_URL=https://router.tangle.tools/v1
export LLM_API_KEY="$TANGLE_API_KEY"
export LLM_MODEL=deepseek-v4-flash
export GEPA_PRICE_IN_PER_M=0.4
export GEPA_PRICE_OUT_PER_M=1.6

OPTIMIZERS=gepa pnpm tsx examples/compare-optimization-methods/index.ts
```

Any OpenAI-compatible endpoint works; point `LLM_BASE_URL` at it and name a model it serves.

Replace the example rates with the current exact endpoint rates.
GEPA uses `LLM_MODEL` by default.
Set `GEPA_MODEL` when reflection should use another model.
Optimizer reflection calls run through a default execution owner built from `LLM_BASE_URL` and `LLM_API_KEY`.
Set `OPTIMIZER_EXECUTION_OWNER_MODULE` to replace it with your own execution package.

### Choose a GEPA recipe

`GEPA_RECIPE` selects how GEPA composes engine runs.
The default, `engine`, is one budgeted run of the standard `gepa` engine.

```sh
GEPA_RECIPE=omni OPTIMIZERS=gepa pnpm tsx examples/compare-optimization-methods/index.ts
```

| Kind | What runs |
|---|---|
| `engine` | One budgeted engine run. |
| `sequential` | Engines in order; the best result across stages is kept. |
| `adaptive-sequential` | Switch engines after a plateau, under one shared evaluation budget. |
| `best-of` | Independent engines; the highest selection score wins. |
| `vote` | Independent engines; GEPA's vote composition selects. |
| `omni` | Best-of exploration, then one continuation from its winner. |

The example splits `GEPA_MAX_EVALUATIONS` and `GEPA_MAX_PROPOSER_COST_USD` evenly across stages, so every recipe runs at the same total budget.
Every stage uses the standard `gepa` engine, which keeps the provider key outside Python.
The composed kinds require the tested GEPA source revision from the install step above; the published wheel supports `engine` only.
[`docs/campaign-proposers.md`](../../docs/campaign-proposers.md) documents recipes, other engines, budgets, and resuming.

## Run SkillOpt

```sh
export LLM_BASE_URL=https://router.tangle.tools/v1
export LLM_API_KEY="$TANGLE_API_KEY"
export LLM_MODEL=deepseek-v4-flash
export SKILLOPT_PRICE_IN_PER_M=0.4
export SKILLOPT_PRICE_OUT_PER_M=1.6

OPTIMIZERS=skillopt pnpm tsx examples/compare-optimization-methods/index.ts
```

Set `SKILLOPT_PRICE_IN_PER_M` and `SKILLOPT_PRICE_OUT_PER_M` to the current exact rates for your endpoint before running SkillOpt.
The example passes SkillOpt's `openai_compatible` traffic through Agent Eval's local proxy and then through the execution owner.
By default that owner is this repository's example owner, `examples/_shared/openai-compatible-owner.ts`, built from `LLM_BASE_URL` and `LLM_API_KEY`. Agent Eval owns no model transport; on agent-runtime the production owner is `profileOptimizerModelCall`.
An `OPTIMIZER_EXECUTION_OWNER_MODULE` override must export `createOptimizerExecutionOwner(model)` and return `{ call, callRef }`.
Discovery uses this module boundary to execute the model through Runtime with one exact AgentProfile.
Set `SKILLOPT_MODEL` to use a different optimizer model.

## Compare Both

```sh
OPTIMIZERS=gepa,skillopt \
LLM_BASE_URL=https://router.tangle.tools/v1 \
LLM_API_KEY="$TANGLE_API_KEY" \
LLM_MODEL=deepseek-v4-flash \
GEPA_PRICE_IN_PER_M=0.4 \
GEPA_PRICE_OUT_PER_M=1.6 \
SKILLOPT_PRICE_IN_PER_M=0.4 \
SKILLOPT_PRICE_OUT_PER_M=1.6 \
pnpm tsx examples/compare-optimization-methods/index.ts
```

The execution owner controls the optimizer endpoint and credentials; Agent Eval's proxy never receives them.
Replace all four example rates with the exact rates charged by that endpoint.

## Controls

| Variable | Default | Meaning |
|---|---:|---|
| `OPTIMIZERS` | `gepa,skillopt` | Comma-separated methods to run. |
| `LLM_MODEL` | `deepseek-v4-flash` | Worker model; must be served by `LLM_BASE_URL`. |
| `LLM_MAX_TOKENS` | `400` | Output cap per worker call; raise it for reasoning models. |
| `OPTIMIZER_PYTHON` | `python` | Python executable containing the bridge and selected optimizers. |
| `OPTIMIZER_EXECUTION_OWNER_MODULE` | built-in OpenAI-compatible owner | Module exporting `createOptimizerExecutionOwner(model)`; use Runtime for Discovery. |
| `GEPA_MODEL` | `LLM_MODEL` | Endpoint model used by GEPA reflection. |
| `GEPA_MAX_EVALUATIONS` | SkillOpt core plan size | Maximum GEPA candidate-case calls. Must match SkillOpt when both run. |
| `GEPA_MAX_PROPOSER_COST_USD` | `5` | Maximum GEPA model spend inside one engine stage. |
| `GEPA_PRICE_IN_PER_M` | required | Exact GEPA input rate per million tokens. |
| `GEPA_PRICE_OUT_PER_M` | required | Exact GEPA output rate per million tokens. |
| `GEPA_MAX_MODEL_COST_USD` | `MAX_OPTIMIZER_MODEL_COST_USD` | GEPA model spend limit. |
| `GEPA_MAX_MODEL_REQUESTS` | `100` | Shared GEPA model request limit. |
| `SKILLOPT_MODEL` | `LLM_MODEL` | Model used by SkillOpt reflection and editing. |
| `SKILLOPT_EPOCHS` | `2` | SkillOpt training epochs. |
| `SKILLOPT_BATCH_SIZE` | `2` | SkillOpt train cases per step. |
| `SKILLOPT_MAX_EVALUATIONS` | core plan size | Maximum SkillOpt candidate-case calls. |
| `SKILLOPT_PRICE_IN_PER_M` | required | Exact optimizer-model input rate per million tokens. |
| `SKILLOPT_PRICE_OUT_PER_M` | required | Exact optimizer-model output rate per million tokens. |
| `SKILLOPT_MAX_MODEL_COST_USD` | `MAX_OPTIMIZER_MODEL_COST_USD` | SkillOpt optimizer-model spend limit. |
| `SKILLOPT_MAX_MODEL_REQUESTS` | `100` | SkillOpt optimizer-model request limit. |
| `MAX_OPTIMIZER_MODEL_COST_USD` | `5` | Equal optimizer-model spend limit per method. |
| `MAX_TOTAL_COST_USD` | `20` | Shared limit for all optimization and final-case spend. |
| `OPTIMIZATION_CONCURRENCY` | `1` | Methods allowed to optimize concurrently. |
| `BILLING_NOTE` | inferred | Billing context saved with the result. |
| `PRICE_SOURCE` | inferred | Source of the token prices saved with the result. |

The result is written to `.evolve/compare-optimization-methods/<timestamp>/comparison.json` and mirrored to `.evolve/compare-optimization-methods/latest.json`.
It includes every method's selected surface, final-case scores, paired lift interval, duration, cost status, run limits, token prices, upstream package revision, run identity, token usage, and source model configuration.
Optimizer model spend uses provider-reported billed cost when present.
Otherwise it is estimated from complete token usage and the configured token rates.
`accountingComplete` means every call was priced; it does not mean the total was reconciled to an invoice.
The run fails when the endpoint omits usage instead of publishing an incomplete comparison.
Set `BILLING_NOTE` and `PRICE_SOURCE` when declared token prices estimate subscription usage rather than actual billed dollars.
