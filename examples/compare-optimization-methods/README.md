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
export LLM_API_KEY="$OPENAI_API_KEY"
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=gpt-4.1-mini
export GEPA_PRICE_IN_PER_M=0.4
export GEPA_PRICE_OUT_PER_M=1.6

OPTIMIZERS=gepa pnpm tsx examples/compare-optimization-methods/index.ts
```

Replace the example rates with the current exact endpoint rates.
GEPA uses `LLM_MODEL` by default.
Set `GEPA_MODEL` when reflection should use another model.

## Run SkillOpt

```sh
export LLM_API_KEY="$OPENAI_API_KEY"
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=gpt-4.1-mini
export SKILLOPT_PRICE_IN_PER_M=0.4
export SKILLOPT_PRICE_OUT_PER_M=1.6

OPTIMIZERS=skillopt pnpm tsx examples/compare-optimization-methods/index.ts
```

Set `SKILLOPT_PRICE_IN_PER_M` and `SKILLOPT_PRICE_OUT_PER_M` to the current exact rates for your endpoint before running SkillOpt.
The example passes SkillOpt's `openai_compatible` traffic through Agent Eval's local model proxy.
Set `SKILLOPT_MODEL` to use a different optimizer model.

## Compare Both

```sh
OPTIMIZERS=gepa,skillopt \
LLM_API_KEY="$OPENAI_API_KEY" \
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_MODEL=gpt-4.1-mini \
GEPA_PRICE_IN_PER_M=0.4 \
GEPA_PRICE_OUT_PER_M=1.6 \
SKILLOPT_PRICE_IN_PER_M=0.4 \
SKILLOPT_PRICE_OUT_PER_M=1.6 \
pnpm tsx examples/compare-optimization-methods/index.ts
```

Use `OPTIMIZER_API_KEY` and `OPTIMIZER_BASE_URL` when candidate generation should use a different endpoint from the worker.
Replace all four example rates with the exact rates charged by that endpoint.

## Controls

| Variable | Default | Meaning |
|---|---:|---|
| `OPTIMIZERS` | `gepa,skillopt` | Comma-separated methods to run. |
| `OPTIMIZER_PYTHON` | `python` | Python executable containing the bridge and selected optimizers. |
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
