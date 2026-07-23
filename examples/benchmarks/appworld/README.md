# AppWorld Method Comparison

This example compares prompt optimization methods on AppWorld tasks.
Each method may inspect train and selection tasks, but only `compareOptimizationMethods` evaluates the chosen prompts on the test tasks.
AppWorld's own `world.evaluate()` supplies the scores, so this benchmark does not use a model to grade answers.

## Run the comparison

Install AppWorld and create its Python environment first.
From this repository:

```bash
export APPWORLD_DIR=/path/to/appworld
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY="$YOUR_API_KEY"
export BENCH_MODEL=gpt-5.1
export BENCH_REFLECT_MODEL=gpt-5.1

TRAIN_N=4 \
SELECTION_N=4 \
TEST_N=6 \
MAX_GEN=2 \
pnpm tsx examples/benchmarks/appworld/run-bench.ts
```

The default methods are GEPA reflection, GEPA Pareto, and memory curation.
Memory curation runs the built-in trace analyst on that method's train episodes, then deduplicates and stores the resulting lessons in the candidate prompt.
Set `WITH_HALO=1` or `WITH_ANALYST=1` to include the optional trace-analysis methods when their dependencies are installed.
Use `BENCH_METHODS=gepa-reflection,memory-curation` to run a subset.
Each trace-analysis method reads only the traces produced by its own train runs, including when methods run in parallel.

Common settings:

| Variable | Default | Purpose |
|---|---:|---|
| `BENCH_MODEL` | `gpt-5.1` | Model that performs AppWorld tasks |
| `BENCH_REFLECT_MODEL` | `BENCH_MODEL` | Model that proposes prompt changes |
| `TRAIN_N` | `3` | Train tasks per method |
| `SELECTION_N` | `3` | Tasks used to select one prompt per method |
| `TEST_N` | `5` | Final comparison tasks |
| `MAX_GEN` | `1` | Optimization rounds |
| `POP` | `2` | Candidates per round |
| `REPS` | `5` | Repeated episodes per task |
| `MAX_STEPS` | `30` | Model calls per episode; `0` disables this limit |
| `MAX_WALL` | `900` | Seconds per episode |
| `MAXCONC` | `3` | Concurrent task episodes inside a method |
| `OPTIMIZATION_CONCURRENCY` | `1` | Methods optimized at the same time |
| `CALL_TIMEOUT` | `120` | Seconds per model request |
| `MAX_TOKENS` | `6000` | Maximum output tokens per model request |
| `RATE_LIMIT_BUDGET` | `240` | Seconds spent retrying rate limits per request |
| `OUT_DIR` | `/tmp/appworld-bench` | Output directory |

The defaults are sized to check that the workflow runs.
They are not enough to claim one method is better.
Choose `TEST_N` from the smallest lift your product needs to detect, and confirm a selected method on new tasks before deployment.

The command writes these files under `OUT_DIR`, which defaults to `/tmp/appworld-bench`:

| File | Contents |
|---|---|
| `comparison.json` | Scores, uncertainty intervals, timing, and cost status for every method |
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
This example does not set a dollar limit because the external Python process cannot provide a trustworthy maximum charge before it runs.
Use a provider account limit when a hard dollar maximum is required.

Known model prices are estimates from `PRICE_PER_M` in `repl_agent.py`.
For an unknown model, `result.json` contains `"cost_usd": null`, the TypeScript cost record sets `costUnknown: true`, and the comparison marks cost accounting incomplete.
Unknown cost never participates in a tie as zero dollars.

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
