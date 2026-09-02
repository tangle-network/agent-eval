# Improve One Prompt With Official GEPA

This example calls `selfImprove()` with a `gepaOptimizationMethod()` method.
One call runs the complete path: GEPA searches on train and selection partitions, Agent Eval re-scores the selected prompt on a held-out split GEPA never received, and the promotion gate returns a release decision.

## When To Use It

Use this path when one surface must get better and you want the search, the held-out re-score, and the release decision in one call.
Use [`compare-optimization-methods`](../compare-optimization-methods/) instead when two or more optimizers must be benchmarked against each other at equal budget.
Use [`selfimprove-quickstart`](../selfimprove-quickstart/) when your own code generates the candidates.

## Install

Install the Node dependencies from the repository root:

```sh
pnpm install
```

Install the Python bridge and the published GEPA package:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "gepa==0.1.4" \
  "litellm>=1.83.0,<1.92" \
  "tqdm>=4.66.1" \
  "cloudpickle>=3.0.0" \
  "datasets>=2.14.6" \
  "wandb"
```

Do not install `gepa[full]`; its MLflow server dependency is unpatched.

From this repository, the locked equivalent is:

```sh
cd clients/python
uv sync --frozen --group gepa-release
cd ../..
export OPTIMIZER_PYTHON="$PWD/clients/python/.venv/bin/python"
```

## Run

```sh
LLM_BASE_URL=https://router.tangle.tools/v1 \
LLM_API_KEY="$TANGLE_API_KEY" \
GEPA_PRICE_IN_PER_M=0.4 \
GEPA_PRICE_OUT_PER_M=1.6 \
pnpm tsx examples/self-improve-optimizer/index.ts
```

Any OpenAI-compatible endpoint works; set `LLM_MODEL` to a model that endpoint serves.
Replace the two rates with the exact rates charged by your endpoint.
The script validates every required variable before it makes a paid call.

## Why It Is Built This Way

- The ten cases live inline in `index.ts`; `selfImprove()` derives every partition from that one list, so GEPA can never see the held-out cases.
- The example execution owner (`_shared/openai-compatible-owner.ts`) supplies the metered model call GEPA reflection runs through; the provider key never reaches Agent Eval or the Python child, and each reflection call is metered against the declared budget.
- The judge is deterministic field matching, so a score change traces to prompt content, not judge noise.
- `budget.generations` stays unset because the external method owns its rounds.
- `assertRealBackend` fails the run when any cell lacks a real backend receipt.

## Cost

A default run makes roughly 20 to 40 worker calls and up to 12 GEPA candidate evaluations plus reflection calls.
With a flash-tier model at the example rates, expect $0.10 to $0.50.
Hard limits: `MAX_TOTAL_COST_USD` (default 10) caps the whole run and `GEPA_MAX_PROPOSER_COST_USD` (default 2) caps reflection spend.

## Read The Result

The script prints the gate decision, the held-out baseline and winner composites, the lift, the total spend, and the baseline-to-winner diff.
Four held-out cases are wiring-scale, not statistical evidence: a `need_more_work` decision at this size is the gate refusing to claim significance, not a failure.
Grow the case list and set `budget.reps` above 1 before treating the decision as a production threshold.

## Controls

| Variable | Default | Meaning |
|---|---:|---|
| `LLM_API_KEY` | required | Key for the worker and optimizer endpoint. |
| `LLM_BASE_URL` | required | OpenAI-compatible endpoint. |
| `LLM_MODEL` | `deepseek-v4-flash` | Worker model. |
| `LLM_MAX_TOKENS` | `400` | Output cap per worker call; raise it for reasoning models. |
| `GEPA_MODEL` | `LLM_MODEL` | Reflection model. |
| `GEPA_PRICE_IN_PER_M` | required | Exact input rate per million tokens. |
| `GEPA_PRICE_OUT_PER_M` | required | Exact output rate per million tokens. |
| `GEPA_MAX_EVALUATIONS` | `12` | Maximum GEPA candidate-case calls. Keep it at or above the train partition size. |
| `GEPA_MAX_PROPOSER_COST_USD` | `2` | Maximum reflection spend. |
| `MAX_TOTAL_COST_USD` | `10` | Hard cap across the whole run. |
| `OPTIMIZER_PYTHON` | `python` | Python executable containing the bridge and GEPA. |
| `CALL_TIMEOUT_MS` | `30000` | Per-call timeout. |

The complete implementation is [`index.ts`](./index.ts).
