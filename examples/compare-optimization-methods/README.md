# Compare GEPA and SkillOpt

This example runs GEPA, SkillOpt, or both on transaction extraction.
Each method receives the same five train cases, three selection cases, starting prompt, worker, and deterministic field-matching judge.
Agent Eval evaluates selected prompts on six separate final cases after every method finishes search.

Worker and optimizer calls use a paid Chat Completions endpoint.
Six final cases demonstrate the integration; they do not establish population-level optimizer superiority.
The example includes the unchanged starting prompt as a baseline, but no direct-edit or simple-search method control.

## Install

Run these commands from the repository root with Node, pnpm, Python, and uv installed:

```sh
pnpm install --frozen-lockfile
cd clients/python
uv sync --frozen --group skillopt-source --group gepa-source
cd ../..
export OPTIMIZER_PYTHON="$PWD/clients/python/.venv/bin/python"
```

The lock selects the source versions tested by this bridge.
See the [Python guide](../../clients/python/README.md) for supported environments and dependency maintenance.

## Configure the endpoint

Export the following variables before running the script.
Use an endpoint that accepts this example's request fields and returns model identity and complete token usage.

| Variable | Purpose |
|---|---|
| `LLM_BASE_URL` | Chat Completions API prefix, such as `https://your-endpoint.example/v1`. |
| `LLM_API_KEY` | Key for the endpoint. |
| `LLM_MODEL` | Worker model served by the endpoint; defaults to `deepseek-v4-flash`. |
| `PRICE_IN_PER_M`, `PRICE_OUT_PER_M` | Worker USD rates per million tokens; supply both together. |
| `GEPA_PRICE_IN_PER_M`, `GEPA_PRICE_OUT_PER_M` | Reflection rates when GEPA uses different prices; otherwise inherit `PRICE_*`. |
| `SKILLOPT_PRICE_IN_PER_M`, `SKILLOPT_PRICE_OUT_PER_M` | Reflection/editing rates when SkillOpt uses different prices; otherwise inherit `PRICE_*`. |

Use current rates for the actual endpoint and models.
Worker `PRICE_*` overrides are optional when the package already has suitable model pricing.
Each selected optimizer needs input and output rates, either its own or inherited worker rates.
Optional `PRICE_CACHED_IN_PER_M` and `PRICE_CACHE_WRITE_IN_PER_M` require the worker input/output pair.
The same cache suffixes are available under `GEPA_` and `SKILLOPT_`.

## Run

```sh
OPTIMIZERS=gepa pnpm exec tsx examples/compare-optimization-methods/index.ts
```

```sh
OPTIMIZERS=skillopt pnpm exec tsx examples/compare-optimization-methods/index.ts
```

```sh
OPTIMIZERS=gepa,skillopt pnpm exec tsx examples/compare-optimization-methods/index.ts
```

Both methods are selected by default.
The default execution owner reads `LLM_BASE_URL` and `LLM_API_KEY` and keeps provider credentials out of the Python optimizer process.
Set `GEPA_MODEL` or `SKILLOPT_MODEL` when optimizer calls should use a different model from `LLM_MODEL`.

To supply your own execution owner, set `OPTIMIZER_EXECUTION_OWNER_MODULE` to an absolute path, file URL, or installed package specifier.
The module must export `createOptimizerExecutionOwner(model)` returning `{ call, callRef }`.
Avoid relative paths: dynamic imports resolve relative to the shared loader, not the repository root.
See [campaign proposers](../../docs/campaign-proposers.md#configure-gepa) for the execution callback contract.

## Choose a GEPA recipe

`GEPA_RECIPE` defaults to `engine`.
The other recipes compose standard GEPA engines and require the source dependencies installed above.

| Value | Behavior |
|---|---|
| `engine` | One bounded engine run. |
| `sequential` | Run stages in order and keep the best selection result. |
| `adaptive-sequential` | Switch after a plateau under one shared evaluation limit. |
| `best-of` | Run independent stages and keep the highest selection score. |
| `vote` | Use GEPA's vote composition across stages. |
| `omni` | Explore with best-of, then continue from its winner. |

```sh
GEPA_RECIPE=omni OPTIMIZERS=gepa pnpm exec tsx examples/compare-optimization-methods/index.ts
```

Composed recipes allocate evaluation and proposer limits across their stages.
Integer rounding can leave evaluation capacity unused: a two-stage recipe receives 16 evaluations per stage at the default ceiling of 33.
Equal configured ceilings do not imply equal realized evaluations, model calls, tokens, or spend.
The [implementation](./index.ts) records the selected recipe and limits with the result.

## Control work and spend

| Variable | Default | Purpose |
|---|---|---|
| `GEPA_MAX_EVALUATIONS` | SkillOpt core plan size, initially `33` | Maximum GEPA candidate-case evaluations. |
| `SKILLOPT_MAX_EVALUATIONS` | Core plan size, initially `33` | Maximum SkillOpt candidate-case evaluations. |
| `SKILLOPT_EPOCHS`, `SKILLOPT_BATCH_SIZE` | `2`, `2` | Trainer settings that determine the default evaluation plan. |
| `MAX_OPTIMIZER_MODEL_COST_USD` | `5` | Default optimizer model spend limit per method. |
| `GEPA_MAX_PROPOSER_COST_USD` | `5` | GEPA proposer ceiling, allocated across recipe stages. |
| `GEPA_MAX_MODEL_COST_USD`, `SKILLOPT_MAX_MODEL_COST_USD` | `MAX_OPTIMIZER_MODEL_COST_USD` | Model spend limits for each optimizer. |
| `GEPA_MAX_MODEL_REQUESTS`, `SKILLOPT_MAX_MODEL_REQUESTS` | `100` | Maximum model requests per optimizer. |
| `MAX_TOTAL_COST_USD` | `20` | Shared ledger ceiling for search and final evaluation across all methods. |
| `OPTIMIZATION_CONCURRENCY` | `1` | Methods allowed to search concurrently. |
| `LLM_MAX_TOKENS` | `400` | Worker output cap; allow extra headroom for reasoning models. |
| `CALL_TIMEOUT_MS` | `30000` | Worker timeout per call. |
| `OPTIMIZER_PYTHON` | `python` | Python executable containing the bridge and selected optimizers. |

When both methods run, the script requires matching candidate-case evaluation limits.
Model request and spend limits share defaults but can be overridden separately; record any differences.
The shared whole-run ceiling can still exhaust before a later method or final evaluation finishes.
Inspect actual usage and completion before describing a comparison as matched on resources.
The [budget helper](../_shared/optimizer-model-budget.ts) exposes additional request-byte, response-byte, token, and timeout controls.

## Inspect the artifacts

The script writes `.evolve/compare-optimization-methods/<timestamp>/comparison.json` and mirrors it to `.evolve/compare-optimization-methods/latest.json`.
Raw campaign artifacts remain under the timestamped directory.
The summary contains selected surfaces, final scores, lift intervals, cost status, configured limits, optimizer provenance, and available token usage.
Read `comparison.pairwise` and each method's decision before interpreting its rank as evidence of a difference.
A positive descriptive interval can still be ineligible for promotion.

Provider-reported billed cost takes precedence when present.
Otherwise complete usage and declared token rates produce an estimate.
`accountingComplete` means each call was priced; it does not establish reconciliation with an invoice.
Missing required usage fails the comparison.
Set `BILLING_NOTE` and `PRICE_SOURCE` to retain the origin and interpretation of supplied rates.

Keep final cases outside optimizer closures, shared files, and prior search memory when adapting the example.
For repeated or grouped tasks, declare the independent unit and use optional fresh-evidence controls described in [evaluation integrity](../../docs/evaluation-integrity.md).
