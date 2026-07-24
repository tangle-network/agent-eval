# AppWorld Method Comparison

This example compares official GEPA and SkillOpt on AppWorld tasks.
Each method may inspect train and selection tasks, but only `compareOptimizationMethods()` evaluates the chosen prompts on final tasks.
AppWorld's own `world.evaluate()` supplies the scores, so this benchmark does not use a model to grade answers.

## Run the comparison

Install AppWorld and create its Python environment first.
Install Agent Eval's Python bridge and the official optimizers in a separate Python environment:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "skillopt @ git+https://github.com/microsoft/SkillOpt.git@61735e3922efc2b90c6d6cab561e62e98452ca90"
python -m pip install \
  "gepa[full] @ git+https://github.com/gepa-ai/gepa.git@f919db0a622e2e9f9204779b81fe00cc1b2d808f"
```

From this repository:

```sh
export APPWORLD_DIR=/path/to/appworld
export OPTIMIZER_PYTHON=/path/to/optimizer-venv/bin/python
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY="$YOUR_API_KEY"
export BENCH_MODEL=gpt-5.1
export GEPA_PRICE_IN_PER_M=0.4
export GEPA_PRICE_OUT_PER_M=1.6
export SKILLOPT_PRICE_IN_PER_M=0.4
export SKILLOPT_PRICE_OUT_PER_M=1.6

TRAIN_N=4 \
SELECTION_N=4 \
TEST_N=6 \
pnpm tsx examples/benchmarks/appworld/run-bench.ts
```

Replace the four example rates with the current exact endpoint rates for each optimizer model.
The default methods are official GEPA and official SkillOpt.
Use `BENCH_METHODS=gepa` or `BENCH_METHODS=skillopt` to run one method.
Each optimizer receives AppWorld scores and the bounded execution trace from its own train and selection episodes.
Final task IDs and traces are not passed to either optimizer.

Common settings:

| Variable | Default | Purpose |
|---|---:|---|
| `BENCH_MODEL` | `gpt-5.1` | Model that performs AppWorld tasks |
| `OPTIMIZER_PYTHON` | `python` | Python executable containing both optimizer packages |
| `GEPA_MODEL` | `BENCH_MODEL` | Endpoint model used by GEPA |
| `GEPA_MAX_EVALUATIONS` | SkillOpt core plan size | Maximum GEPA candidate-task calls |
| `GEPA_MAX_PROPOSER_COST_USD` | `5` | GEPA model spend limit for one engine stage |
| `GEPA_PRICE_IN_PER_M` | required | Exact GEPA input rate per million tokens |
| `GEPA_PRICE_OUT_PER_M` | required | Exact GEPA output rate per million tokens |
| `GEPA_MAX_MODEL_COST_USD` | `50` | Shared GEPA model spend limit |
| `SKILLOPT_MODEL` | `BENCH_MODEL` | Model used by SkillOpt |
| `SKILLOPT_EPOCHS` | `1` | SkillOpt training epochs |
| `SKILLOPT_BATCH_SIZE` | `2` | SkillOpt train tasks per step |
| `SKILLOPT_MAX_EVALUATIONS` | core plan size | Maximum SkillOpt candidate-task calls |
| `SKILLOPT_PRICE_IN_PER_M` | required | Exact optimizer-model input rate per million tokens |
| `SKILLOPT_PRICE_OUT_PER_M` | required | Exact optimizer-model output rate per million tokens |
| `SKILLOPT_MAX_MODEL_COST_USD` | `50` | SkillOpt optimizer-model spend limit |
| `TRAIN_N` | `3` | Train tasks per method |
| `SELECTION_N` | `3` | Tasks used to select one prompt per method |
| `TEST_N` | `5` | Final comparison tasks |
| `REPS` | `5` | Repeated episodes per task |
| `MAX_STEPS` | `30` | Model calls per episode; `0` disables this limit |
| `MAX_WALL` | `900` | Seconds per episode |
| `MAXCONC` | `3` | Concurrent task episodes inside a method |
| `OPTIMIZATION_CONCURRENCY` | `1` | Methods optimized at the same time |
| `CALL_TIMEOUT` | `120` | Seconds per model request |
| `MAX_TOKENS` | `6000` | Maximum output tokens per model request |
| `RATE_LIMIT_BUDGET` | `240` | Seconds spent retrying rate limits per request |
| `MAX_OPTIMIZATION_COST_USD` | `50` | Worker and judge spend limit for each method |
| `MAX_TEST_COST_USD` | `25` | Shared worker and judge spend limit for final tasks |
| `OUT_DIR` | `/tmp/appworld-bench` | Output directory |

The defaults are sized to check the workflow.
They are not enough to claim one method is better.
When both methods run, their candidate-task limits must match or the command fails before spending money.
Choose `TEST_N` from the smallest lift your product needs to detect, and confirm a selected method on new tasks before deployment.

The command writes these files under `OUT_DIR`, which defaults to `/tmp/appworld-bench`:

| File | Contents |
|---|---|
| `comparison.json` | Data partitions, models, all limits and rates, actual calls, scores, intervals, timing, and cost status |
| `report.md` | Human-readable comparison table |
| `cell-*/result.json` | One AppWorld episode result |
| `cell-*/traces.jsonl` | One root span plus model and tool spans for each step |

## How an episode works

`repl_agent.py` runs one task in AppWorld's stateful Python environment.
The model emits one fenced Python block, the worker executes it with `world.execute(...)`, and the output becomes the next observation.
The episode ends when the model calls `apis.supervisor.complete_task(...)`, reaches `--max-steps`, exceeds `--max-wall-seconds`, or encounters an unrecoverable error.

The score is the mean of:

- Task goal completion (`tgc`): `1` when the complete task succeeds, otherwise `0`.
- Scenario goal completion (`sgc`): the fraction of AppWorld checks that pass.

The comparison averages repeated runs within each task, then resamples whole tasks to estimate uncertainty.

## Cost and failures

The worker retries rate limits only within `--rate-limit-budget` and applies `--call-timeout` to every model request.
An exhausted retry budget, timeout, or transport error produces a failed episode with the original error and an error status on the root span.

`MAX_STEPS` and `MAX_WALL` limit work before launch.
GEPA and SkillOpt calls pass through a local proxy that enforces model requests, bytes, output tokens, and dollars before forwarding them.
The comparison uses provider-reported cost when present and otherwise estimates optimizer cost from complete token usage and the configured rates.
It fails when usage is missing.

Known model prices are estimates from `PRICE_PER_M` in `repl_agent.py`.
For an unknown model, `result.json` contains `"cost_usd": null`, the TypeScript cost record sets `costUnknown: true`, and the comparison marks cost accounting incomplete.
Unknown cost never participates in a tie as zero dollars.
`accountingComplete: true` means every observed call was priced.
It does not mean the estimate was reconciled to a provider invoice.

## Run one episode

```bash
cd "$APPWORLD_DIR"
.venv/bin/python /path/to/agent-eval/examples/benchmarks/appworld/repl_agent.py \
  --task-id 50e1ac9_1 \
  --model gpt-4o-mini-2024-07-18 \
  --max-steps 25 \
  --call-timeout 45 \
  --rate-limit-budget 120 \
  --out-dir /tmp/appworld-run
```

List development task IDs with `load_task_ids('dev')` from the AppWorld Python package.

## Test the worker

```bash
cd "$APPWORLD_DIR"
OPENAI_BASE_URL=x OPENAI_API_KEY=x .venv/bin/python -m pytest \
  /path/to/agent-eval/examples/benchmarks/appworld/test_repl_agent.py -q
```

The tests replace only the OpenAI client and AppWorld process boundaries.
They execute the loop, code extraction, span output, run-record projection, cost handling, and failure handling.

AppWorld's `simplified_react_code_agent` is an independent worker implementation for cross-checking episode behavior.
It does not emit the trace file consumed by this example.
