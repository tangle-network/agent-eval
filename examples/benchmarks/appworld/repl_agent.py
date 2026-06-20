#!/usr/bin/env python3
"""Standalone non-MCP AppWorld REPL worker for the compareProposers benchmark.

The wedged `openai_agents_mcp_agent` makes zero LLM calls on MCP-connect. This
worker takes the DIRECT path: it drives AppWorld's stateful REPL itself. One
loop iteration is: the LLM emits a ```python block -> world.execute(code) ->
the stdout is fed back as the next observation -> repeat until the agent calls
apis.supervisor.complete_task(...) or max_steps is hit. Scoring is whatever
world.evaluate() reports (TGC = task success, SGC = per-test pass fraction).

Output artifacts (under --out-dir):
  result.json   -- the run summary (task, steps, score, cost, RunRecord-shaped)
  traces.jsonl  -- one OtlpFlatLine per span (the shape src/trace-analyst/
                   otlp-flatten.ts emits and store-otlp.ts ingests). The agent
                   span is the root; one llm span + one tool span per step.

Fail-loud discipline: a stalled LLM call raises after --call-timeout seconds
(no silent hang, no fabricated score). A run that never completes the task is
recorded as a real failure (success=False), not skipped.

Usage:
  export OPENAI_BASE_URL=https://router.tangle.tools/v1 OPENAI_API_KEY=$(cat /tmp/.tk)
  python repl_agent.py --task-id 50e1ac9_1 --model gpt-4o-mini-2024-07-18 \
      --max-steps 25 --call-timeout 60 --out-dir /tmp/appworld-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from typing import Any

from openai import OpenAI, RateLimitError

from appworld import AppWorld

# Per-1M-token USD pricing for the router models we benchmark. Mirrors the
# numbers in the demo's experiments/configs/_generator/models/openai.py so the
# RunRecord costUsd is real, not a fabricated zero.
PRICE_PER_M: dict[str, dict[str, float]] = {
    "gpt-4o-mini-2024-07-18": {"input": 0.15, "output": 0.60},
    "gpt-4o-2024-05-13": {"input": 5.0, "output": 15.0},
    "deepseek-v4-pro": {"input": 0.27, "output": 1.10},
    "deepseek-v4-flash": {"input": 0.07, "output": 0.30},
    "deepseek-chat": {"input": 0.27, "output": 1.10},
    "deepseek-reasoner": {"input": 0.55, "output": 2.19},
    "gpt-5-mini": {"input": 0.25, "output": 2.0},
    "gpt-5": {"input": 1.25, "output": 10.0},
    "gpt-5-2025-08-07": {"input": 1.25, "output": 10.0},
    "gpt-5-codex": {"input": 1.25, "output": 10.0},
    "gpt-5.1": {"input": 1.25, "output": 10.0},
    "gpt-5.1-2025-11-13": {"input": 1.25, "output": 10.0},
    "gpt-5-pro": {"input": 15.0, "output": 120.0},
    "moonshotai/kimi-k2": {"input": 0.60, "output": 2.50},
    "moonshotai/kimi-k2-0905": {"input": 0.60, "output": 2.50},
    "moonshotai/kimi-k2-thinking": {"input": 0.60, "output": 2.50},
}

SYSTEM_PROMPT = """You are a coding agent solving a task for a user by writing Python.

You operate in a stateful Python REPL. Variables and imports persist across your
turns. The environment exposes a global `apis` object whose attributes are apps
(e.g. apis.supervisor, apis.amazon, apis.spotify). Each app exposes endpoints you
call as Python functions, e.g. apis.supervisor.show_active_task(), and
apis.api_docs.show_api_descriptions(app_name='amazon').

How to act each turn:
- Emit exactly ONE fenced ```python code block. It is executed; its stdout (and
  any error traceback) is returned to you as the next Output.
- Explore before acting: use apis.api_docs.show_api_descriptions(...) and
  apis.api_docs.show_api_doc(app_name=..., api_name=...) to learn endpoints and
  required arguments. Print values you need to inspect.
- Credentials: the supervisor's accounts are reachable. Use
  apis.supervisor.show_account_passwords() to retrieve passwords when an app
  login is required, and the supervisor's profile via
  apis.supervisor.show_profile() for the user's email/phone/name.
- When the task is fully done, call apis.supervisor.complete_task() (pass
  answer=... if the task asks a question). This ends the episode.

Keep code blocks small and verify each step from the printed Output before moving on."""

FIRST_USER_TEMPLATE = """Task instruction from {supervisor}:
{instruction}

Available apps:
{app_descriptions}

Begin. First inspect the relevant app docs, then act. Emit one ```python block."""

CODE_BLOCK_RE = re.compile(r"```python\n(.*?)```", re.DOTALL)
PARTIAL_BLOCK_RE = re.compile(r"```python\n(.*)", re.DOTALL)


def extract_code(text: str) -> str:
    """Pull the first complete ```python block; fall back to an unterminated
    trailing block (the model ran out of tokens mid-block)."""
    m = CODE_BLOCK_RE.search(text)
    if m:
        return m.group(1).strip()
    m = PARTIAL_BLOCK_RE.search(text)
    if m:
        return m.group(1).strip()
    return ""


def price(model: str, in_tok: int, out_tok: int) -> float:
    p = PRICE_PER_M.get(model)
    if p is None:
        # No fabricated zero: an unpriced model is recorded as a real NaN-free
        # signal the TS side can flag, not silently as $0.00.
        return float("nan")
    return in_tok * p["input"] / 1e6 + out_tok * p["output"] / 1e6


def otlp_line(
    *,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None,
    name: str,
    kind: str,
    start_ns: int,
    end_ns: int,
    status_code: str,
    status_message: str | None,
    resource_attrs: dict[str, Any],
    attrs: dict[str, Any],
) -> dict[str, Any]:
    """Build one line in the OtlpFlatLine shape from src/trace-analyst/
    otlp-flatten.ts (trace_id/span_id/parent_span_id/name/kind/start_time/
    end_time/status/resource/attributes). store-otlp.ts indexes these directly."""
    # Roots use "" (not null) for parent_span_id and carry an instrumentation
    # `scope`: both are standard OTLP fields that the halo-engine SpanRecord
    # schema requires (parent_span_id: str, scope required). Our own
    # OtlpFileTraceStore normalizes "" → null (otlp-span.ts), so emitting the
    # halo-complete shape keeps ONE corpus both analysis engines read.
    line: dict[str, Any] = {
        "trace_id": trace_id,
        "span_id": span_id,
        "parent_span_id": parent_span_id or "",
        "trace_state": "",
        "name": name,
        "kind": kind,
        "start_time": _ns_to_iso(start_ns),
        "end_time": _ns_to_iso(end_ns),
        "status": {"code": status_code},
        "resource": {"attributes": resource_attrs},
        "scope": {"name": "appworld-repl-agent", "version": "1.0.0"},
        "attributes": attrs,
    }
    if status_message is not None:
        line["status"]["message"] = status_message
    return line


def _ns_to_iso(ns: int) -> str:
    import datetime

    return (
        datetime.datetime.fromtimestamp(ns / 1e9, tz=datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def chat_with_backoff(client: OpenAI, *, rate_limit_budget: float, **kwargs: Any) -> Any:
    """A shared router rate-limits transient 429s; absorb them with bounded
    exponential backoff so a healthy episode is not truncated by a momentary
    limit. A genuine stall is still caught by the client's hard per-request
    timeout (which raises a non-RateLimitError and propagates immediately). The
    429 budget is wall-clock bounded — once it's spent, the 429 propagates and
    the run records a real failure rather than retrying forever."""
    deadline = time.monotonic() + rate_limit_budget
    delay = 2.0
    while True:
        try:
            return client.chat.completions.create(**kwargs)
        except RateLimitError:
            if time.monotonic() + delay > deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 20.0)


def run_task(
    *,
    task_id: str,
    model: str,
    experiment_name: str,
    max_steps: int,
    call_timeout: float,
    rate_limit_budget: float,
    max_tokens: int,
    out_dir: str,
    system_prompt: str | None = None,
    max_wall_seconds: float = 900.0,
    temperature: float = 0.0,
    seed: int = 100,
) -> dict[str, Any]:
    # The agent instruction prompt is the OPTIMIZABLE SURFACE: surface
    # proposers mutate it and pass the candidate here. Default = the baseline
    # SYSTEM_PROMPT (the baseline arm).
    active_system_prompt = system_prompt if system_prompt is not None else SYSTEM_PROMPT
    base_url = os.environ.get("OPENAI_BASE_URL")
    api_key = os.environ.get("OPENAI_API_KEY")
    if not base_url or not api_key:
        raise RuntimeError(
            "OPENAI_BASE_URL and OPENAI_API_KEY must be set (point them at the Tangle router)."
        )
    # The OpenAI client honors a hard per-request timeout; a stalled router call
    # raises after call_timeout instead of hanging the whole benchmark. SDK
    # retries are disabled (max_retries=0) so the hard wall is the only timeout
    # the client owns; transient 429 backoff is handled explicitly below with a
    # bounded budget, distinct from a genuine stall (which must fail loud).
    client = OpenAI(base_url=base_url, api_key=api_key, timeout=call_timeout, max_retries=0)

    os.makedirs(out_dir, exist_ok=True)
    trace_id = uuid.uuid4().hex
    root_span_id = uuid.uuid4().hex[:16]
    resource_attrs = {
        "service.name": "appworld-repl-agent",
        "appworld.task_id": task_id,
        "appworld.experiment": experiment_name,
        "llm.model": model,
    }
    spans: list[dict[str, Any]] = []

    run_start_ns = time.time_ns()
    in_tok_total = 0
    out_tok_total = 0
    n_llm_calls = 0
    completed = False
    last_error: str | None = None

    with AppWorld(task_id=task_id, experiment_name=experiment_name) as world:
        messages: list[dict[str, str]] = [
            {"role": "system", "content": active_system_prompt},
            {
                "role": "user",
                "content": FIRST_USER_TEMPLATE.format(
                    supervisor=world.task.supervisor,
                    instruction=world.task.instruction,
                    app_descriptions=json.dumps(world.task.app_descriptions, indent=1),
                ),
            },
        ]

        # max_steps <= 0 means NO step cap (run until the agent calls
        # complete_task); the only safety net is the wall-clock budget, so a
        # non-terminating agent can't run forever. This is `maxTurns=0`.
        step = 0
        while True:
            step += 1
            if max_steps > 0 and step > max_steps:
                break
            if max_wall_seconds > 0 and (time.time_ns() - run_start_ns) / 1e9 > max_wall_seconds:
                last_error = f"wall_clock_exceeded after {max_wall_seconds}s ({step - 1} steps)"
                break
            # ── LLM span: ask the model for the next code block ──
            llm_start = time.time_ns()
            try:
                resp = chat_with_backoff(
                    client,
                    rate_limit_budget=rate_limit_budget,
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    seed=seed,
                    max_tokens=max_tokens,
                )
            except Exception as exc:  # fail loud: a stall/transport error is a real failure
                llm_end = time.time_ns()
                last_error = f"llm_call_failed: {type(exc).__name__}: {exc}"
                spans.append(
                    otlp_line(
                        trace_id=trace_id,
                        span_id=uuid.uuid4().hex[:16],
                        parent_span_id=root_span_id,
                        name=f"llm.step.{step}",
                        kind="SPAN_KIND_INTERNAL",
                        start_ns=llm_start,
                        end_ns=llm_end,
                        status_code="STATUS_CODE_ERROR",
                        status_message=last_error,
                        resource_attrs=resource_attrs,
                        attrs={"span.kind": "llm", "llm.model": model, "step": step},
                    )
                )
                break
            llm_end = time.time_ns()
            n_llm_calls += 1
            choice = resp.choices[0].message
            content = choice.content or ""
            usage = resp.usage
            in_tok = usage.prompt_tokens if usage else 0
            out_tok = usage.completion_tokens if usage else 0
            in_tok_total += in_tok
            out_tok_total += out_tok
            messages.append({"role": "assistant", "content": content})
            spans.append(
                otlp_line(
                    trace_id=trace_id,
                    span_id=uuid.uuid4().hex[:16],
                    parent_span_id=root_span_id,
                    name=f"llm.step.{step}",
                    kind="SPAN_KIND_INTERNAL",
                    start_ns=llm_start,
                    end_ns=llm_end,
                    status_code="STATUS_CODE_OK",
                    status_message=None,
                    resource_attrs=resource_attrs,
                    attrs={
                        "span.kind": "llm",
                        "llm.model": model,
                        "llm.input_tokens": in_tok,
                        "llm.output_tokens": out_tok,
                        "step": step,
                    },
                )
            )

            code = extract_code(content)
            if not code:
                # Nudge once; if the model still emits no code the loop ends on
                # max_steps with success=False (a real no-progress failure).
                messages.append(
                    {
                        "role": "user",
                        "content": "No ```python block found. Emit exactly one fenced python block.",
                    }
                )
                continue

            # ── tool span: execute the emitted code in the REPL ──
            tool_start = time.time_ns()
            output = world.execute(code)
            tool_end = time.time_ns()
            spans.append(
                otlp_line(
                    trace_id=trace_id,
                    span_id=uuid.uuid4().hex[:16],
                    parent_span_id=root_span_id,
                    name=f"tool.world_execute.{step}",
                    kind="SPAN_KIND_INTERNAL",
                    start_ns=tool_start,
                    end_ns=tool_end,
                    status_code="STATUS_CODE_OK",
                    status_message=None,
                    resource_attrs=resource_attrs,
                    attrs={
                        "span.kind": "tool",
                        "tool.name": "world.execute",
                        "tool.latency_ms": (tool_end - tool_start) / 1e6,
                        "step": step,
                    },
                )
            )
            obs = output if output.endswith("\n") else output + "\n"
            messages.append({"role": "user", "content": f"Output:\n```\n{obs}```"})

            if world.task_completed():
                completed = True
                break

        # ── evaluate IN THE SAME CONTEXT the agent acted in ──
        # Evaluating in a FRESH AppWorld(...) context resets the world, so the
        # evaluator never sees the agent's API calls / submitted answer — every
        # task then pins at tgc=0 / sgc=0.5 regardless of agent quality (a frozen
        # metric the optimizer can't move). Evaluate before the solve context
        # exits so world.evaluate() reads the real final state.
        tracker = world.evaluate(suppress_errors=True)
    # Read the wall clock AFTER the AppWorld context exits — inside it, AppWorld
    # runs a simulated/frozen task clock, which made run_end_ns < run_start_ns
    # (negative wall_ms). The tracker object survives the context for to_dict().
    run_end_ns = time.time_ns()
    eval_dict = tracker.to_dict()
    tgc = 1.0 if eval_dict.get("success") else 0.0
    num_tests = int(eval_dict.get("num_tests") or 0)
    n_passes = len(eval_dict.get("passes") or [])
    sgc = (n_passes / num_tests) if num_tests else 0.0

    # Root agent span wraps the whole episode.
    spans.insert(
        0,
        otlp_line(
            trace_id=trace_id,
            span_id=root_span_id,
            parent_span_id=None,
            name=f"appworld.task.{task_id}",
            kind="SPAN_KIND_INTERNAL",
            start_ns=run_start_ns,
            end_ns=run_end_ns,
            status_code="STATUS_CODE_OK" if completed else "STATUS_CODE_ERROR",
            status_message=None if completed else (last_error or "task_not_completed"),
            resource_attrs=resource_attrs,
            attrs={
                "span.kind": "agent",
                "appworld.completed": completed,
                "appworld.tgc": tgc,
                "appworld.sgc": sgc,
                "appworld.num_tests": num_tests,
                "appworld.llm_calls": n_llm_calls,
            },
        ),
    )

    cost = price(model, in_tok_total, out_tok_total)
    wall_ms = (run_end_ns - run_start_ns) / 1e6

    # RunRecord-shaped projection (src/run-record.ts). The TS side does the
    # final validateRunRecord(); this is the source row it shapes from.
    run_record = {
        "runId": str(uuid.uuid4()),
        "experimentId": experiment_name,
        "candidateId": f"baseline::{model}",
        "seed": 100,
        "model": model,
        "wallMs": wall_ms,
        "costUsd": cost,
        "tokenUsage": {"input": in_tok_total, "output": out_tok_total},
        "outcome": {
            "holdoutScore": sgc,
            "raw": {
                "tgc": tgc,
                "sgc": sgc,
                "num_tests": num_tests,
                "llm_calls": n_llm_calls,
                "completed": 1.0 if completed else 0.0,
            },
        },
        "splitTag": "holdout",
        "scenarioId": task_id,
    }
    if not completed:
        run_record["failureMode"] = last_error or "task_not_completed"

    result = {
        "task_id": task_id,
        "model": model,
        "experiment_name": experiment_name,
        "completed": completed,
        "called_apis": n_llm_calls > 0 and len(spans) > 1,
        "n_llm_calls": n_llm_calls,
        "n_steps_with_exec": sum(1 for s in spans if s["name"].startswith("tool.world_execute")),
        "tgc": tgc,
        "sgc": sgc,
        "num_tests": num_tests,
        "tokens": {"input": in_tok_total, "output": out_tok_total},
        "cost_usd": cost,
        "wall_ms": wall_ms,
        "last_error": last_error,
        "eval": eval_dict,
        "run_record": run_record,
    }

    traces_path = os.path.join(out_dir, "traces.jsonl")
    with open(traces_path, "w") as f:
        for s in spans:
            f.write(json.dumps(s) + "\n")
    result["traces_path"] = traces_path
    result["n_spans"] = len(spans)

    result_path = os.path.join(out_dir, "result.json")
    with open(result_path, "w") as f:
        json.dump(result, f, indent=2)

    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--task-id", default=None)  # required for a run; not for --print-baseline-prompt
    ap.add_argument("--model", default="gpt-4o-mini-2024-07-18")
    ap.add_argument("--experiment-name", default="repl_agent_smoke")
    ap.add_argument(
        "--max-steps",
        type=int,
        default=0,
        help="Hard step cap; 0 (default) = NO cap, run until the agent calls complete_task "
        "(maxTurns=0). The wall-clock budget is the only safety net.",
    )
    ap.add_argument(
        "--max-wall-seconds",
        type=float,
        default=900.0,
        help="Per-episode wall-clock safety net so an agent that never completes can't hang forever.",
    )
    ap.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Sampling temperature. >0 makes reps genuinely independent (the bench passes 0.7); "
        "0 is deterministic and lets the router cache identical reps (collapses multi-shot).",
    )
    ap.add_argument(
        "--seed",
        type=int,
        default=100,
        help="Sampling seed. The bench passes a UNIQUE seed per shot so the router can't return "
        "a cached completion for an identical prompt — each shot is a real independent sample.",
    )
    ap.add_argument("--call-timeout", type=float, default=60.0)
    ap.add_argument(
        "--rate-limit-budget",
        type=float,
        default=90.0,
        help="Wall-clock seconds to absorb transient 429s per LLM call before failing loud.",
    )
    ap.add_argument(
        "--max-tokens",
        type=int,
        default=1500,
        help="Per-call completion-token cap. Raise for reasoning models (e.g. 6000 for gpt-5-mini).",
    )
    ap.add_argument("--out-dir", default="/tmp/appworld-run")
    ap.add_argument(
        "--system-prompt-file",
        default=None,
        help="Path to the agent instruction prompt (the OPTIMIZABLE SURFACE). "
        "Omit to use the baseline SYSTEM_PROMPT (the baseline arm).",
    )
    ap.add_argument(
        "--print-baseline-prompt",
        action="store_true",
        help="Print the baseline SYSTEM_PROMPT verbatim and exit (the bench reads it as baselineSurface).",
    )
    args = ap.parse_args()

    if args.print_baseline_prompt:
        sys.stdout.write(SYSTEM_PROMPT)
        return

    if not args.task_id:
        ap.error("--task-id is required (unless --print-baseline-prompt)")

    system_prompt = None
    if args.system_prompt_file:
        with open(args.system_prompt_file, encoding="utf-8") as fh:
            system_prompt = fh.read()
        if not system_prompt.strip():
            raise RuntimeError(f"--system-prompt-file {args.system_prompt_file} is empty")

    result = run_task(
        task_id=args.task_id,
        model=args.model,
        experiment_name=args.experiment_name,
        max_steps=args.max_steps,
        call_timeout=args.call_timeout,
        rate_limit_budget=args.rate_limit_budget,
        max_tokens=args.max_tokens,
        out_dir=args.out_dir,
        system_prompt=system_prompt,
        max_wall_seconds=args.max_wall_seconds,
        temperature=args.temperature,
        seed=args.seed,
    )
    # Compact verdict line for the benchmark dispatcher to parse.
    print(
        json.dumps(
            {
                "task_id": result["task_id"],
                "completed": result["completed"],
                "called_apis": result["called_apis"],
                "n_llm_calls": result["n_llm_calls"],
                "tgc": result["tgc"],
                "sgc": result["sgc"],
                "num_tests": result["num_tests"],
                "cost_usd": result["cost_usd"],
                "wall_ms": round(result["wall_ms"]),
                "n_spans": result["n_spans"],
                "traces_path": result["traces_path"],
                "last_error": result["last_error"],
            }
        )
    )


if __name__ == "__main__":
    main()
