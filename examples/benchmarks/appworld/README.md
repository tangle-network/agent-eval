# AppWorld non-MCP REPL worker

The runnable benchmark worker behind `compareProposers([gepaReflectionEntry, gepaParetoEntry, memoryEntry, haloEntry, traceAnalystEntry])` on AppWorld. It drives AppWorld's stateful Python REPL directly: the LLM emits a fenced `python` block, the worker runs it with `world.execute(...)`, feeds the stdout back as the next observation, and loops until the agent calls `apis.supervisor.complete_task(...)` or `--max-steps` is hit. Scoring is whatever `world.evaluate()` reports.

It deliberately does NOT use AppWorld's `openai_agents_mcp_agent`, which wedges on MCP-connect and makes zero LLM calls. This is the direct path AppWorld's own `simplified_react_code_agent` takes, reimplemented standalone so the benchmark worker has no dependency on the demo's `appworld-agents` config machinery.

## What it produces

Under `--out-dir`:

| File | Shape | Consumed by |
|---|---|---|
| `result.json` | run summary + a `run_record` projection | the TS dispatch (piece 1) shapes this into a validated `RunRecord` |
| `traces.jsonl` | one `OtlpFlatLine` per span (root agent span plus one model and one tool span per step) | `OtlpFileTraceStore` reads these for trace analysis |

The `run_record` carries the fields produced by the Python worker.
The TypeScript adapter adds `promptHash`, `configHash`, and `commitSha`, then validates the complete `RunRecord`.

## Scoring

- **TGC** (Task Goal Completion) = `world.evaluate().success` → `1.0` / `0.0`. Maps to `outcome.raw.tgc`.
- **SGC** (Scenario Goal Completion) = passed-test fraction = `len(passes) / num_tests`. Used as `outcome.holdoutScore` and `outcome.raw.sgc`.

## Fail-loud discipline

- A genuine stall / transport error on an LLM call raises after `--call-timeout` seconds (the OpenAI client's hard per-request timeout, SDK retries off). The episode ends as a real failure: `completed=False`, the verbatim error in `last_error` + `run_record.failureMode`, and the root span carries `STATUS_CODE_ERROR`. No hang, no fabricated score.
- A **transient** `429` is absorbed with bounded exponential backoff up to `--rate-limit-budget` wall-clock seconds, then propagates as a real failure. This is distinct from a stall: a shared router rate-limits momentarily; that should not truncate a healthy episode, but it must not retry forever either.
- An **unpriced** model yields `costUsd = NaN` (a flaggable signal), never a silent `$0.00` that would corrupt the cost axis.

## Run it

```bash
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY="$YOUR_API_KEY"
cd /path/to/appworld
.venv/bin/python /path/to/examples/benchmarks/appworld/repl_agent.py \
    --task-id 50e1ac9_1 \
    --model gpt-4o-mini-2024-07-18 \
    --max-steps 25 --call-timeout 45 --rate-limit-budget 120 \
    --out-dir /tmp/appworld-run
```

Get dev task ids with `from appworld import load_task_ids; load_task_ids('dev')`.

## Test

```bash
cd /path/to/appworld
OPENAI_BASE_URL=x OPENAI_API_KEY=x .venv/bin/python -m pytest \
    /path/to/examples/benchmarks/appworld/test_repl_agent.py -q
```

The tests stub the OpenAI client and AppWorld at the two process boundaries; the REPL loop, code extraction, OTLP emission, RunRecord shaping, cost, and the fail-loud path run for real. Each test names the regression it defends (loop-stops-on-completion, OtlpFlatLine key set, RunRecord mandatory fields, fail-loud on stall, NaN-not-silent-zero for unpriced models).

## Built-in alternative

AppWorld also ships `simplified_react_code_agent`, which provides an independent comparison:

```bash
cd /path/to/appworld
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_API_KEY="$YOUR_API_KEY"
.venv/bin/appworld run auto --agent-name simplified_react_code_agent \
    --model-name gpt-4o-mini-2024-07-18 --dataset-name dev --task-id 50e1ac9_1
```

It writes `lm_calls.jsonl`, `usage.json`, and an evaluation tree under `experiments/outputs/`.
It does not emit the OpenTelemetry file consumed by this example.
