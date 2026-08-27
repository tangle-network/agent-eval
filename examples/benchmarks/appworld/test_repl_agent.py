"""Deterministic tests for the AppWorld REPL worker.

The router (OpenAI client) and AppWorld are stubbed at the process boundary —
the only two external systems the worker touches. Everything in between (the
REPL loop, code extraction, OTLP span emission, RunRecord shaping, cost,
fail-loud on a stalled call) runs for real. Run inside the demo venv where
`appworld` + `openai` import:

  cd /tmp/halo-repo/demo/appworld
  OPENAI_BASE_URL=x OPENAI_API_KEY=x .venv/bin/python -m pytest \
      /path/to/examples/benchmarks/appworld/test_repl_agent.py -q
"""

from __future__ import annotations

import json
import math
import os
import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

sys.path.insert(0, os.path.dirname(__file__))
try:
    import appworld  # noqa: F401
except ModuleNotFoundError:
    appworld_stub = ModuleType("appworld")
    appworld_stub.AppWorld = object  # type: ignore[attr-defined]
    sys.modules["appworld"] = appworld_stub
import repl_agent  # noqa: E402

# ── Stubs at the two process boundaries ──────────────────────────────────


class _StubUsage:
    def __init__(self, p: int, c: int) -> None:
        self.prompt_tokens = p
        self.completion_tokens = c


class _StubChoice:
    def __init__(self, content: str) -> None:
        self.message = SimpleNamespace(content=content)


class _StubResp:
    def __init__(self, content: str, p: int, c: int) -> None:
        self.choices = [_StubChoice(content)]
        self.usage = _StubUsage(p, c)


class _StubCompletions:
    def __init__(self, scripted: list[Any]) -> None:
        self._scripted = scripted
        self._i = 0

    def create(self, **_: Any) -> Any:
        item = self._scripted[min(self._i, len(self._scripted) - 1)]
        self._i += 1
        if isinstance(item, Exception):
            raise item
        content, p, c = item
        return _StubResp(content, p, c)


class _StubClient:
    def __init__(self, scripted: list[Any]) -> None:
        self.chat = SimpleNamespace(completions=_StubCompletions(scripted))


class _StubTask:
    supervisor = "Glenn Burton"
    instruction = "Count my songs and answer."
    app_descriptions = {"spotify": "music app", "supervisor": "the user"}


class _StubWorld:
    """A minimal stateful REPL. `complete()` flips task_completed; the eval
    tracker reports success iff complete() was called with the right answer."""

    completed_flag = False

    def __init__(self, task_id: str, experiment_name: str) -> None:
        self.task_id = task_id
        self.task = _StubTask()
        self._executed: list[str] = []

    def __enter__(self) -> "_StubWorld":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def execute(self, code: str) -> str:
        self._executed.append(code)
        if "complete_task" in code:
            type(self).completed_flag = True
            return "Task marked complete.\n"
        return "some stdout\n"

    def task_completed(self) -> bool:
        return type(self).completed_flag

    def evaluate(self, suppress_errors: bool = True) -> Any:
        ok = type(self).completed_flag
        return SimpleNamespace(
            to_dict=lambda: {
                "success": ok,
                "difficulty": 2,
                "num_tests": 2,
                "passes": ([{"requirement": "a"}, {"requirement": "b"}] if ok else [{"requirement": "a"}]),
                "failures": ([] if ok else [{"requirement": "b"}]),
            }
        )


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_BASE_URL", "https://router.tangle.tools/v1")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    _StubWorld.completed_flag = False


def _patch(monkeypatch: pytest.MonkeyPatch, scripted: list[Any]) -> None:
    monkeypatch.setattr(repl_agent, "OpenAI", lambda **_: _StubClient(scripted))
    monkeypatch.setattr(repl_agent, "AppWorld", _StubWorld)


# ── Tests ────────────────────────────────────────────────────────────────


def test_completes_and_scores_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Regression: the loop must stop when world.task_completed() flips, and the
    success path must record TGC=1.0 / SGC=1.0 from world.evaluate()."""
    scripted = [
        ("Let me look.\n```python\nprint(apis.spotify.songs())\n```", 100, 20),
        ("Now finish.\n```python\napis.supervisor.complete_task(answer='42')\n```", 80, 15),
        ("extra unused turn", 1, 1),
    ]
    _patch(monkeypatch, scripted)
    res = repl_agent.run_task(
        task_id="t1",
        model="gpt-4o-mini-2024-07-18",
        experiment_name="unit",
        max_steps=10,
        call_timeout=5.0,
        rate_limit_budget=1.0,
        max_tokens=1500,
        out_dir=str(tmp_path),
    )
    assert res["completed"] is True
    assert res["n_llm_calls"] == 2  # stopped after complete_task, not all 10 steps
    assert res["tgc"] == 1.0
    assert res["sgc"] == 1.0
    assert res["num_tests"] == 2
    assert res["called_apis"] is True
    assert res["token_usage"] == {"input": 180, "output": 35}
    # Cost is real, not a fabricated zero: 180 in + 35 out @ gpt-4o-mini pricing.
    expected = (180 * 0.15 + 35 * 0.60) / 1e6
    assert math.isclose(res["cost_usd"], expected, rel_tol=1e-9)


def test_otlp_lines_match_pinned_shape(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Regression: every emitted span must carry the exact OtlpFlatLine keys
    (src/trace-analyst/otlp-flatten.ts) or the analyst's index drops it."""
    scripted = [
        ("```python\nprint(1)\n```", 50, 10),
        ("```python\napis.supervisor.complete_task()\n```", 40, 8),
    ]
    _patch(monkeypatch, scripted)
    res = repl_agent.run_task(
        task_id="t2",
        model="gpt-4o-mini-2024-07-18",
        experiment_name="unit",
        max_steps=10,
        call_timeout=5.0,
        rate_limit_budget=1.0,
        max_tokens=1500,
        out_dir=str(tmp_path),
    )
    lines = [json.loads(l) for l in open(res["traces_path"]).read().splitlines()]
    assert len(lines) == res["n_spans"] >= 3  # root + 2 llm + 2 tool
    required = {
        "trace_id",
        "span_id",
        "parent_span_id",
        "name",
        "kind",
        "start_time",
        "end_time",
        "status",
        "resource",
        "attributes",
    }
    for ln in lines:
        assert required.issubset(ln.keys()), f"missing keys: {required - ln.keys()}"
        assert ln["status"]["code"] in {
            "STATUS_CODE_OK",
            "STATUS_CODE_ERROR",
            "STATUS_CODE_UNSET",
        }
        assert isinstance(ln["resource"]["attributes"], dict)
    roots = [ln for ln in lines if ln["parent_span_id"] == ""]
    assert len(roots) == 1  # exactly one root agent span
    root = roots[0]
    assert root["attributes"]["span.kind"] == "agent"
    assert root["attributes"]["appworld.tgc"] == 1.0
    # Every non-root span parents to the root and carries an OpenInference-mappable kind.
    kinds = {ln["attributes"]["span.kind"] for ln in lines}
    assert kinds == {"agent", "llm", "tool"}
    for ln in lines:
        if ln["parent_span_id"]:
            assert ln["parent_span_id"] == root["span_id"]


def test_run_record_has_mandatory_fields(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Regression: the RunRecord projection must carry every field
    validateRunRecord (src/run-record.ts) requires, else the TS side throws."""
    scripted = [("```python\napis.supervisor.complete_task(answer='x')\n```", 30, 5)]
    _patch(monkeypatch, scripted)
    res = repl_agent.run_task(
        task_id="t3",
        model="gpt-4o-mini-2024-07-18",
        experiment_name="unit",
        max_steps=5,
        call_timeout=5.0,
        rate_limit_budget=1.0,
        max_tokens=1500,
        out_dir=str(tmp_path),
    )
    rr = res["run_record"]
    for key in (
        "runId",
        "experimentId",
        "candidateId",
        "seed",
        "model",
        "wallMs",
        "costUsd",
        "tokenUsage",
        "outcome",
        "splitTag",
    ):
        assert key in rr, f"RunRecord missing mandatory field {key}"
    assert rr["splitTag"] == "holdout"
    assert "input" in rr["tokenUsage"] and "output" in rr["tokenUsage"]
    assert "holdoutScore" in rr["outcome"]
    assert isinstance(rr["outcome"]["raw"], dict)
    # Model carries a snapshot date (modelHasSnapshot in run-record.ts rejects bare aliases).
    assert "2024-07-18" in rr["model"]


def test_stalled_llm_fails_loud(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Regression: a transport error / stall on the LLM must NOT silently pass.
    It ends the episode as a real failure with the verbatim error recorded —
    no fabricated score, no hang."""
    scripted = [
        ("```python\nprint(1)\n```", 50, 10),
        RuntimeError("connection reset by peer"),  # a non-rate-limit stall
    ]
    _patch(monkeypatch, scripted)
    res = repl_agent.run_task(
        task_id="t4",
        model="gpt-4o-mini-2024-07-18",
        experiment_name="unit",
        max_steps=10,
        call_timeout=5.0,
        rate_limit_budget=1.0,
        max_tokens=1500,
        out_dir=str(tmp_path),
    )
    assert res["completed"] is False
    assert res["last_error"] is not None
    assert "connection reset by peer" in res["last_error"]
    # The failure is recorded on the run_record AND the root span carries ERROR status.
    assert res["run_record"]["failureMode"]
    root = next(
        json.loads(l)
        for l in open(res["traces_path"]).read().splitlines()
        if json.loads(l)["parent_span_id"] == ""
    )
    assert root["status"]["code"] == "STATUS_CODE_ERROR"


def test_unpriced_model_is_explicitly_uncaptured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    scripted = [("```python\napis.supervisor.complete_task()\n```", 10, 2)]
    _patch(monkeypatch, scripted)
    res = repl_agent.run_task(
        task_id="t5",
        model="some-unpriced-model-2025-01-01",
        experiment_name="unit",
        max_steps=3,
        call_timeout=5.0,
        rate_limit_budget=1.0,
        max_tokens=1500,
        out_dir=str(tmp_path),
    )
    assert res["cost_usd"] is None
    assert res["run_record"]["costUsd"] == 0
    assert res["run_record"]["costProvenance"] == {"kind": "uncaptured", "usd": None}
    with open(tmp_path / "result.json", encoding="utf-8") as handle:
        persisted = json.load(handle)
    assert persisted["cost_usd"] is None
    assert persisted["token_usage"] == {"input": 10, "output": 2}
