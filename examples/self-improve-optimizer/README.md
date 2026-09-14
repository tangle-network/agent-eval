# Improve one prompt with GEPA

This example calls `selfImprove()` with `gepaOptimizationMethod()` to search a transaction-extraction prompt.
GEPA receives separate train and selection partitions.
Agent Eval evaluates its selected prompt on four final cases and returns a gate decision.
The field-matching judge is deterministic; worker and reflection calls use a paid model endpoint.

Use [the local quickstart](../selfimprove-quickstart/) to try the flow without credentials or paid calls.
Use [the method comparison](../compare-optimization-methods/) to compare multiple search procedures.

## Install

Run these commands from the repository root with Node, pnpm, Python, and uv installed:

```sh
pnpm install --frozen-lockfile
cd clients/python
uv sync --frozen --group gepa-release
cd ../..
export OPTIMIZER_PYTHON="$PWD/clients/python/.venv/bin/python"
```

This installs the bridge from the checkout and the locked GEPA dependencies.
The standard engine used here works with the published GEPA package.
See the [Python guide](../../clients/python/README.md) for other environments and supported versions.

## Configure and run

Export the endpoint, key, worker model, and reflection token rates before running the script.
Use a Chat Completions endpoint that accepts this example's request fields and returns model identity and complete token usage.
Its base URL should end at the API prefix, such as `/v1`.
Select a model your endpoint serves; the script's default is listed below.

| Variable | Default | Purpose |
|---|---|---|
| `LLM_BASE_URL` | required | Endpoint used by worker and reflection calls. |
| `LLM_API_KEY` | required | Key for that endpoint. |
| `LLM_MODEL` | `deepseek-v4-flash` | Worker model. |
| `GEPA_MODEL` | `LLM_MODEL` | Reflection model. |
| `PRICE_IN_PER_M`, `PRICE_OUT_PER_M` | package pricing | Worker input/output USD rates per million tokens; set both for an unlisted model or endpoint-specific prices. |
| `PRICE_CACHED_IN_PER_M`, `PRICE_CACHE_WRITE_IN_PER_M` | worker input rate | Optional worker cache-read and cache-write rates; require both worker input/output rates. |
| `GEPA_PRICE_IN_PER_M`, `GEPA_PRICE_OUT_PER_M` | required | Current reflection input/output USD rates per million tokens. |
| `LLM_MAX_TOKENS` | `400` | Output limit per worker call. |
| `CALL_TIMEOUT_MS` | `30000` | Worker and reflection owner timeout per call. |
| `GEPA_MAX_EVALUATIONS` | `12` | Maximum candidate-case evaluations during search. |
| `GEPA_MAX_PROPOSER_COST_USD` | `2` | Reflection spend limit for the GEPA stage. |
| `MAX_TOTAL_COST_USD` | `10` | Shared limit for search and final evaluation calls admitted through the ledger. |
| `OPTIMIZER_PYTHON` | `python` | Python executable containing the bridge and GEPA. |

```sh
pnpm exec tsx examples/self-improve-optimizer/index.ts
```

The script validates required environment values before search.
Provider compatibility, installed Python capabilities, and returned usage are checked on their execution paths.
For reasoning models, increase `LLM_MAX_TOKENS` enough to include reasoning and final JSON output.

The [shared budget helper](../_shared/optimizer-model-budget.ts) also accepts `GEPA_MAX_MODEL_REQUESTS` and `GEPA_MAX_MODEL_COST_USD`.
It exposes byte limits, token limits, timeouts, and separate cache rates.
The reflection model budget defaults to the stage spend limit.

## Understand the data and cost

Ten inline cases feed every partition: four final cases and six cases divided between train and selection.
`selfImprove()` does not pass final cases to the optimizer's callbacks.
Keep them out of callback closures, shared files, and external optimizer memory when adapting this code.
These APIs do not provide process or filesystem isolation.

The worker dispatch and reflection owner record model usage and cost receipts.
Provider-reported billed cost takes precedence when present; otherwise configured or package token prices produce estimates.
Worker pricing also reserves the maximum charge before a capped call starts.
An unlisted worker model therefore needs `PRICE_IN_PER_M` and `PRICE_OUT_PER_M`, even when its provider later reports billed cost.
Actual call counts and spend depend on optimizer behavior, retries, and token usage.
The limits above are ceilings, not expected costs.
The selected prompt is evaluated only after search finishes.

The script checks captured worker receipts with `assertRealBackend(records, { allowMixed: false })`.
That check establishes the identity of recorded worker execution; it does not validate a model's task quality.
The provider key stays in the example's execution owner rather than being passed to the metered Python optimizer.

## Read the result

The script prints the gate decision, final baseline and selected scores, lift, cost, and prompt diff.
Method results use `mode: 'method'`.
Search evidence lives in `raw.method` and optional `searchHistory`; method results have no native generation count.
A selected surface remains in `winner.surface` even when it is unchanged, worse on final cases, or held by the gate.

Four final cases demonstrate integration and cannot support a broad claim that GEPA improves future tasks.
A `hold` decision can reflect insufficient evidence; inspect gate contributions before diagnosing a failure.
Add representative independent cases and calibrate the judge before using this example for release decisions.
Use repetitions to estimate variation on those cases, without counting them as new tasks.

See [campaign proposers](../../docs/campaign-proposers.md) for method contracts, costs, and optional final-evidence controls.
The complete implementation is [index.ts](./index.ts).
For an installed package, import `selfImprove` from `/contract` and `gepaOptimizationMethod` from `/campaign` under `@tangle-network/agent-eval`.
