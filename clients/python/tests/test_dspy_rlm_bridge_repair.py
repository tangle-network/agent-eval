from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pydantic
import pytest

from agent_eval_rpc import dspy_rlm_bridge

DENO_COMMAND = ["/venv/bin/deno", "run", "/venv/dspy/runner.js"]
RUNTIME = {
    "engine": "dspy-rlm",
    "packages": {"agent-eval-rpc": "0.140.0", "dspy": "3.2.1", "deno": "2.7.14"},
    "python": {"implementation": "cpython", "version": "3.13.0"},
    "bridge": {"sourceSha256": "b" * 64},
    "sandbox": {"probeOutput": "2", "runtime": "deno-pyodide"},
}
REPAIR_INSTRUCTIONS = (
    "TASK tb-repair-typed-v1\n"
    "Return the single step whose action you would replace, and the action to run instead."
)
TRAJECTORY = [
    {"step_id": 1, "action": "ls -la", "observation": "<returncode>0</returncode>"},
    {"step_id": 2, "action": "python solve.py", "observation": "<returncode>1</returncode>"},
]
VALID_REPAIR = {
    "k": 2,
    "failure_claim": "solve.py writes the answer to the wrong path",
    "intervention_kind": "shell",
    "action": "python solve.py --out /app/answer.txt",
}


def _fake_dspy(
    calls: dict[str, Any],
    *,
    repairs: Any,
    answer: str = "Step 2 wrote the wrong path.",
) -> Any:
    class FakePythonInterpreter:
        def __init__(self, *, deno_command: list[str]) -> None:
            calls["interpreter"] = self

        def execute(self, code: str) -> str:
            return "2\n"

        def shutdown(self) -> None:
            calls["interpreter_shutdown"] = True

    class FakeLm:
        def __init__(self, model: str, **kwargs: Any) -> None:
            self.history: list[dict[str, Any]] = []
            calls["lm_instance"] = self

    class FakeRlm:
        def __init__(self, signature: Any, **kwargs: Any) -> None:
            calls["signature"] = signature
            calls["rlm"] = kwargs

        def __call__(self, **kwargs: Any) -> Any:
            calls["program_input"] = kwargs
            calls["lm_instance"].history.append({"call": 1})
            return SimpleNamespace(
                answer=answer,
                repairs=repairs,
                trajectory=[{"iteration": 1}],
            )

    @contextmanager
    def fake_context(*, lm: Any, adapter: Any = None) -> Any:
        yield

    class FakeChatAdapter:
        def __init__(self, **kwargs: Any) -> None:
            calls["chat_adapter_kwargs"] = kwargs

    return SimpleNamespace(
        ChatAdapter=FakeChatAdapter,
        TwoStepAdapter=lambda lm: None,
        LM=FakeLm,
        PythonInterpreter=FakePythonInterpreter,
        Tool=lambda function, **kwargs: SimpleNamespace(func=function, **kwargs),
        RLM=FakeRlm,
        Signature=lambda fields, instructions: {"fields": fields, "instructions": instructions},
        InputField=lambda **kwargs: {"kind": "input", **kwargs},
        OutputField=lambda **kwargs: {"kind": "output", **kwargs},
        context=fake_context,
    )


def _write_repair_input(
    tmp_path: Path,
    *,
    instructions: str = REPAIR_INSTRUCTIONS,
    task_inputs: dict[str, Any] | None = None,
) -> tuple[Path, Path]:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    payload: dict[str, Any] = {
        "operation": "analyze",
        "controlAdapter": "tolerant",
        "question": "Which step would you replace?",
        "instructions": instructions,
        "modelProxy": {
            "baseUrl": "http://127.0.0.1:8123/v1",
            "apiKey": "proxy-key",
            "model": "analysis-model",
            "maxOutputTokens": 700,
        },
        "toolCallback": {
            "url": "http://127.0.0.1:8124/call",
            "token": "callback-token",
            "timeoutMs": 60_000,
        },
        "limits": {"maxIterations": 4, "maxLlmCalls": 6, "maxOutputChars": 8_000},
        "toolSpecs": [],
    }
    if task_inputs is not None:
        payload["taskInputs"] = task_inputs
    input_path.write_text(json.dumps(payload))
    return input_path, output_path


def _run_bridge(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    repairs: Any,
    instructions: str = REPAIR_INSTRUCTIONS,
    task_inputs: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], Path]:
    calls: dict[str, Any] = {}
    fake = _fake_dspy(calls, repairs=repairs)
    monkeypatch.setattr(dspy_rlm_bridge, "_load_dspy", lambda: fake)
    monkeypatch.setattr(
        dspy_rlm_bridge,
        "_build_deno_command",
        lambda _dspy, _import_map: DENO_COMMAND,
    )
    monkeypatch.setattr(dspy_rlm_bridge, "_runtime_identity", lambda _command: RUNTIME)
    inputs = task_inputs
    if inputs is None:
        inputs = {"trajectory": TRAJECTORY, "taskStatement": "Solve the task."}
    input_path, output_path = _write_repair_input(
        tmp_path,
        instructions=instructions,
        task_inputs=inputs,
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["dspy-rlm-bridge", "--input", str(input_path), "--output", str(output_path)],
    )
    dspy_rlm_bridge.main()
    return calls, output_path


def test_repair_token_selects_the_typed_repair_signature() -> None:
    assert dspy_rlm_bridge._task_kind(REPAIR_INSTRUCTIONS) == "repair"
    assert dspy_rlm_bridge._task_kind("plain analyst instructions") == "generic"
    assert (
        dspy_rlm_bridge._task_kind("Set the subject to incorrect-steps-2-3-unescaped")
        == "codetrace"
    )


def test_instructions_naming_two_contracts_stop_the_run() -> None:
    with pytest.raises(ValueError, match="one analysis answers one output contract"):
        dspy_rlm_bridge._task_kind(
            f"{REPAIR_INSTRUCTIONS}\nAlso set the subject to incorrect-steps-1-2-escaped"
        )


def test_repair_proposal_enforces_the_scaffold_action_budget() -> None:
    oversized = dict(VALID_REPAIR, action="x" * (dspy_rlm_bridge._REPAIR_ACTION_MAX_BYTES + 1))
    with pytest.raises(pydantic.ValidationError, match="scaffold action budget"):
        dspy_rlm_bridge.RepairProposal.model_validate(oversized)

    at_cap = dict(VALID_REPAIR, action="x" * dspy_rlm_bridge._REPAIR_ACTION_MAX_BYTES)
    assert dspy_rlm_bridge.RepairProposal.model_validate(at_cap).k == 2


def test_repair_proposal_rejects_an_unknown_intervention_kind() -> None:
    with pytest.raises(pydantic.ValidationError):
        dspy_rlm_bridge.RepairProposal.model_validate(dict(VALID_REPAIR, intervention_kind="patch"))


def test_typed_repair_emits_wire_rows_and_leaves_findings_empty(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls, output_path = _run_bridge(monkeypatch, tmp_path, repairs=[dict(VALID_REPAIR)])

    assert set(calls["program_input"]) == {
        "question",
        "analyst_instructions",
        "trajectory",
        "taskStatement",
    }
    assert calls["program_input"]["trajectory"] == TRAJECTORY
    assert set(calls["signature"]["fields"]) == {
        "question",
        "analyst_instructions",
        "trajectory",
        "taskStatement",
        "answer",
        "repairs",
    }

    output = json.loads(output_path.read_text())
    assert output["findings"] == []
    repair = output["runtime"]["repair"]
    assert repair["signature"] == "tb-repair-typed-v1"
    assert repair["reported"] == 1
    assert repair["kept"] == 1
    assert repair["repair"] is None
    assert repair["rows"] == [
        {
            "k": 2,
            "failure_claim": "solve.py writes the answer to the wrong path",
            "intervention": {"kind": "shell", "action": "python solve.py --out /app/answer.txt"},
        }
    ]


def test_an_empty_repairs_list_is_an_honest_decline(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _calls, output_path = _run_bridge(monkeypatch, tmp_path, repairs=[])

    repair = json.loads(output_path.read_text())["runtime"]["repair"]
    assert repair["reported"] == 0
    assert repair["rows"] == []
    assert repair["dropped"] == []


def test_a_step_outside_the_trajectory_is_dropped_with_its_reason(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _calls, output_path = _run_bridge(
        monkeypatch,
        tmp_path,
        repairs=[dict(VALID_REPAIR, k=99)],
    )

    repair = json.loads(output_path.read_text())["runtime"]["repair"]
    assert repair["rows"] == []
    assert repair["dropped"] == [{"index": 0, "reason": "k 99 is not a recorded step_id"}]


def test_a_second_repair_is_dropped_by_the_one_repair_cap(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _calls, output_path = _run_bridge(
        monkeypatch,
        tmp_path,
        repairs=[dict(VALID_REPAIR), dict(VALID_REPAIR, k=1)],
    )

    repair = json.loads(output_path.read_text())["runtime"]["repair"]
    assert repair["kept"] == 1
    assert repair["dropped"] == [{"index": 1, "reason": "exceeds the 1-repair cap"}]


def test_a_typed_field_returned_as_text_earns_exactly_one_structured_reread(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _calls, output_path = _run_bridge(
        monkeypatch,
        tmp_path,
        repairs=json.dumps([VALID_REPAIR]),
    )

    repair = json.loads(output_path.read_text())["runtime"]["repair"]
    assert repair["repair"] == "parsed-repairs-from-string"
    assert repair["kept"] == 1


def test_a_typed_field_still_unreadable_after_the_reread_fails_loud(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    with pytest.raises(RuntimeError, match="not a JSON array after one repair attempt"):
        _run_bridge(monkeypatch, tmp_path, repairs="I could not find a repair.")


def test_a_malformed_row_is_dropped_and_the_rest_of_the_analysis_survives(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _calls, output_path = _run_bridge(
        monkeypatch,
        tmp_path,
        repairs=[{"k": 2, "failure_claim": "", "intervention_kind": "shell", "action": "ls"}],
    )

    repair = json.loads(output_path.read_text())["runtime"]["repair"]
    assert repair["reported"] == 1
    assert repair["rows"] == []
    assert len(repair["dropped"]) == 1
    assert repair["dropped"][0]["index"] == 0


def test_the_repair_task_refuses_to_run_without_the_trajectory(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="requires taskInputs.trajectory"):
        _run_bridge(
            monkeypatch,
            tmp_path,
            repairs=[dict(VALID_REPAIR)],
            task_inputs={"taskStatement": "Solve the task."},
        )


def test_task_inputs_are_optional_and_unknown_keys_are_still_refused(tmp_path: Path) -> None:
    base = {
        "operation": "analyze",
        "controlAdapter": "tolerant",
        "question": "q",
        "instructions": "i",
        "modelProxy": {
            "baseUrl": "http://127.0.0.1:8123/v1",
            "apiKey": "k",
            "model": "m",
            "maxOutputTokens": 8,
        },
        "toolCallback": {
            "url": "http://127.0.0.1:8124/call",
            "token": "t",
            "timeoutMs": 1_000,
        },
        "limits": {"maxIterations": 1, "maxLlmCalls": 1, "maxOutputChars": 10},
        "toolSpecs": [],
    }
    assert dspy_rlm_bridge._validate_analyze_input(dict(base)) == base
    assert dspy_rlm_bridge._validate_analyze_input({**base, "taskInputs": {"trajectory": []}})
    with pytest.raises(ValueError, match="analyze input must contain"):
        dspy_rlm_bridge._validate_analyze_input({**base, "surprise": 1})
