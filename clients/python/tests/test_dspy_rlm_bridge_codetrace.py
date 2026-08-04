from __future__ import annotations

import json
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from agent_eval_rpc import dspy_rlm_bridge

DENO_COMMAND = [
    "/venv/bin/deno",
    "run",
    "--no-config",
    "--node-modules-dir=none",
    "--allow-read=/venv/dspy/runner.js,/cache/deno",
    "/venv/dspy/runner.js",
]
RUNTIME = {
    "engine": "dspy-rlm",
    "packages": {"agent-eval-rpc": "0.139.0", "dspy": "3.2.1", "deno": "2.7.14"},
    "python": {"implementation": "cpython", "version": "3.13.0"},
    "bridge": {"sourceSha256": "a" * 64},
    "sandbox": {"probeOutput": "2", "runtime": "deno-pyodide"},
}
CODETRACE_INSTRUCTIONS = (
    "Analyze exactly one coding-agent trajectory.\n"
    "Set the finding's subject to incorrect-steps-<first_step>-<last_step>"
    "-<escape_status>-consequence-<consequence_step>.\n"
    "Cite the block's first step and its last step."
)
STEP_CONTENT = {
    1: "step 1 action: read the repository layout and locate the failing test",
    2: "step 2 action: delete the configuration file before reading its contents",
    3: "step 3 action: rewrite the loader against the now-missing configuration",
    4: "step 4 action: run the test suite, which fails on the missing configuration",
}
# The whole-trace projection truncates attributes harder than viewSpans; the
# tests keep the two projections different to prove excerpts never come from
# the discovery-grade read.
VIEW_TRACE_CONTENT = {
    step: content[:24] + "[trace-analyst truncated: view]"
    for step, content in STEP_CONTENT.items()
}
VERIFICATION_SPAN = {
    "span_id": "benchmark-verification-0a1b2c3d4e5f6071",
    "name": "final verification",
    "kind": "EVALUATOR",
    "status": "OK",
    "attributes": {
        "benchmark.evidence.role": "final-verification",
        "content": "verification failed: 3 tests failing",
    },
}


def _projected_spans(content_by_step: dict[int, str]) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = [
        {
            "span_id": f"step-{step}",
            "name": f"step {step}",
            "kind": "LLM",
            "status": "OK",
            "attributes": {"content": content_by_step[step]},
        }
        for step in sorted(content_by_step)
    ]
    spans.append(
        {
            "span_id": "obs-1",
            "name": "tool observation",
            "kind": "TOOL",
            "status": "OK",
            "attributes": {"content": "rm config.toml"},
        }
    )
    spans.append(VERIFICATION_SPAN)
    return spans


def _install_callback_fake(monkeypatch: pytest.MonkeyPatch, calls: dict[str, Any]) -> None:
    calls["http"] = []

    def fake_post(url: str, **request: Any) -> httpx.Response:
        payload = request["json"]
        calls["http"].append(payload)
        name = payload["name"]
        if name == "getDatasetOverview":
            result: Any = {"total_traces": 1, "sample_trace_ids": ["traj-1"]}
        elif name == "viewTrace":
            result = {"trace_id": "traj-1", "spans": _projected_spans(VIEW_TRACE_CONTENT)}
        elif name == "viewSpans":
            requested = payload["args"]["span_ids"]
            spans = [
                span
                for span in _projected_spans(STEP_CONTENT)
                if span["span_id"] in requested
            ]
            found = {span["span_id"] for span in spans}
            result = {
                "trace_id": "traj-1",
                "spans": spans,
                "missing_span_ids": [sid for sid in requested if sid not in found],
                "omitted_span_ids": [],
                "has_more": False,
                "truncated_attribute_count": 0,
            }
        else:
            raise AssertionError(f"unexpected trace tool {name}")
        return httpx.Response(200, json={"result": result}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)


def _fake_dspy(calls: dict[str, Any], *, blocks: Any, answer: str = "Steps 2-3 are incorrect.") -> Any:
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

    class FakeTool:
        def __init__(self, function: Any, *, name: str, desc: str, args: dict[str, Any]) -> None:
            self.func = function
            self.name = name
            self.desc = desc
            self.args = args

    class FakeRlm:
        def __init__(self, signature: Any, **kwargs: Any) -> None:
            calls["signature"] = signature
            calls["rlm"] = kwargs

        def __call__(self, **kwargs: Any) -> Any:
            calls["program_input"] = kwargs
            calls["lm_instance"].history.extend([{"call": 1}, {"call": 2}, {"call": 3}])
            return SimpleNamespace(
                answer=answer,
                blocks=blocks,
                findings_json="[]",
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
        Tool=FakeTool,
        RLM=FakeRlm,
        Signature=lambda fields, instructions: {"fields": fields, "instructions": instructions},
        InputField=lambda **kwargs: {"kind": "input", **kwargs},
        OutputField=lambda **kwargs: {"kind": "output", **kwargs},
        context=fake_context,
    )


def _write_codetrace_input(tmp_path: Path, *, instructions: str = CODETRACE_INSTRUCTIONS) -> tuple[Path, Path]:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    arguments = {
        "getDatasetOverview": ("filters", []),
        "viewTrace": ("trace_id", ["trace_id"]),
        "viewSpans": ("trace_id span_ids", ["trace_id", "span_ids"]),
        "searchTrace": ("trace_id regex_pattern max_matches", ["trace_id", "regex_pattern", "max_matches"]),
        "searchSpan": (
            "trace_id span_id regex_pattern max_matches",
            ["trace_id", "span_id", "regex_pattern", "max_matches"],
        ),
    }
    input_path.write_text(
        json.dumps(
            {
                "operation": "analyze",
                "controlAdapter": "tolerant",
                "question": "Which assistant steps are incorrect?",
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
                "toolSpecs": [
                    {
                        "name": name,
                        "description": f"Node descriptor for {name}.",
                        "parameters": {
                            "type": "object",
                            "properties": {argument: {"type": "string"} for argument in properties.split()},
                            "required": required,
                            "additionalProperties": False,
                        },
                    }
                    for name, (properties, required) in arguments.items()
                ],
            }
        )
    )
    return input_path, output_path


def _run_bridge(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    blocks: Any,
    instructions: str = CODETRACE_INSTRUCTIONS,
    answer: str = "Steps 2-3 are incorrect.",
) -> tuple[dict[str, Any], Path]:
    calls: dict[str, Any] = {}
    fake = _fake_dspy(calls, blocks=blocks, answer=answer)
    monkeypatch.setattr(dspy_rlm_bridge, "_load_dspy", lambda: fake)
    monkeypatch.setattr(
        dspy_rlm_bridge,
        "_build_deno_command",
        lambda _dspy, _import_map: DENO_COMMAND,
    )
    monkeypatch.setattr(dspy_rlm_bridge, "_runtime_identity", lambda _command: RUNTIME)
    _install_callback_fake(monkeypatch, calls)
    input_path, output_path = _write_codetrace_input(tmp_path, instructions=instructions)
    monkeypatch.setattr(
        sys,
        "argv",
        ["dspy-rlm-bridge", "--input", str(input_path), "--output", str(output_path)],
    )
    dspy_rlm_bridge.main()
    return calls, output_path


VALID_BLOCK = {
    "first_step": 2,
    "last_step": 3,
    "consequence_step": 4,
    "escape_status": "unescaped",
    "severity": "high",
    "claim": "Steps 2-3 corrupt the configuration the loader depends on.",
    "confidence": 0.9,
    "rationale": "Step 4's test run fails on the missing configuration.",
}


def test_codetrace_task_materializes_trajectory_and_emits_code_built_findings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls, output_path = _run_bridge(monkeypatch, tmp_path, blocks=[dict(VALID_BLOCK)])

    program_input = calls["program_input"]
    assert set(program_input) == {
        "question",
        "analyst_instructions",
        "trajectory",
        "final_verification",
    }
    assert [span["span_id"] for span in program_input["trajectory"]] == [
        "step-1",
        "step-2",
        "step-3",
        "step-4",
        "obs-1",
        VERIFICATION_SPAN["span_id"],
    ]
    assert program_input["final_verification"] == [VERIFICATION_SPAN]

    signature = calls["signature"]
    assert set(signature["fields"]) == {
        "question",
        "analyst_instructions",
        "trajectory",
        "final_verification",
        "answer",
        "blocks",
    }
    assert signature["fields"]["blocks"][0] == list[dspy_rlm_bridge.IncorrectBlock]
    assert "SUBMIT(answer=..., blocks=[...])" in signature["instructions"]

    output = json.loads(output_path.read_text())
    assert output["answer"] == "Steps 2-3 are incorrect."
    assert output["findings"] == [
        {
            "severity": "high",
            "claim": VALID_BLOCK["claim"],
            "subject": "incorrect-steps-2-3-unescaped-consequence-4",
            "confidence": 0.9,
            "rationale": VALID_BLOCK["rationale"],
            "evidence": [
                {"uri": "trace://traj-1/span/step-2", "excerpt": STEP_CONTENT[2]},
                {"uri": "trace://traj-1/span/step-3", "excerpt": STEP_CONTENT[3]},
            ],
        }
    ]
    assert output["modelCalls"] == 3
    assert output["runtime"]["typedBlocks"] == {
        "signature": "codetrace-typed-v1",
        "reported": 1,
        "kept": 1,
        "dropped": [],
        "repair": None,
        "environment": {
            "traceId": "traj-1",
            "fetch": "view-trace",
            "spanCount": 6,
            "stepCount": 4,
            "verificationSpanCount": 1,
        },
    }
    # Excerpts come from a surgical viewSpans read of the cited steps, never
    # from the truncated whole-trace projection.
    assert [entry["name"] for entry in calls["http"]] == [
        "getDatasetOverview",
        "viewTrace",
        "viewSpans",
    ]
    assert calls["http"][2]["args"] == {"trace_id": "traj-1", "span_ids": ["step-2", "step-3"]}


def test_codetrace_blocks_json_string_is_repaired_once_and_flagged(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls, output_path = _run_bridge(
        monkeypatch,
        tmp_path,
        blocks=f"```json\n{json.dumps([VALID_BLOCK])}\n```",
    )

    output = json.loads(output_path.read_text())
    assert len(output["findings"]) == 1
    assert output["findings"][0]["subject"] == "incorrect-steps-2-3-unescaped-consequence-4"
    assert output["runtime"]["typedBlocks"]["repair"] == "parsed-blocks-from-string"
    assert output["runtime"]["typedBlocks"]["kept"] == 1


def test_codetrace_unparseable_blocks_fail_loud_not_silent_empty(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    with pytest.raises(RuntimeError, match="not a JSON array after one repair"):
        _run_bridge(
            monkeypatch,
            tmp_path,
            blocks="The agent deleted the configuration at step 2.",
        )
    assert not (tmp_path / "output.json").exists()


def test_codetrace_invalid_blocks_dropped_with_diagnostics_others_kept(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    overwide = {**VALID_BLOCK, "first_step": 1, "last_step": 13, "consequence_step": 13}
    phantom = {**VALID_BLOCK, "first_step": 99, "last_step": 99, "consequence_step": 99}
    calls, output_path = _run_bridge(
        monkeypatch,
        tmp_path,
        blocks=[dict(VALID_BLOCK), overwide, phantom],
    )

    output = json.loads(output_path.read_text())
    assert [finding["subject"] for finding in output["findings"]] == [
        "incorrect-steps-2-3-unescaped-consequence-4"
    ]
    diagnostics = output["runtime"]["typedBlocks"]
    assert diagnostics["reported"] == 3
    assert diagnostics["kept"] == 1
    reasons = [entry["reason"] for entry in diagnostics["dropped"]]
    assert any("spans 13 steps" in reason for reason in reasons)
    assert any("step-99 does not exist" in reason for reason in reasons)


def test_codetrace_block_cap_keeps_first_sixteen(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    single = {
        **VALID_BLOCK,
        "first_step": 2,
        "last_step": 2,
        "consequence_step": 4,
    }
    calls, output_path = _run_bridge(monkeypatch, tmp_path, blocks=[dict(single)] * 17)

    output = json.loads(output_path.read_text())
    assert len(output["findings"]) == 16
    diagnostics = output["runtime"]["typedBlocks"]
    assert diagnostics["reported"] == 17
    assert diagnostics["kept"] == 16
    assert diagnostics["dropped"] == [{"index": 16, "reason": "exceeds the 16-block cap"}]


def test_generic_instructions_keep_the_generic_signature_and_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls, output_path = _run_bridge(
        monkeypatch,
        tmp_path,
        blocks=None,
        instructions="Find the earliest causal failure.",
    )

    assert set(calls["program_input"]) == {"question", "analyst_instructions"}
    assert set(calls["signature"]["fields"]) == {
        "question",
        "analyst_instructions",
        "answer",
        "findings_json",
    }
    output = json.loads(output_path.read_text())
    assert output["findings"] == []
    assert "typedBlocks" not in output["runtime"]
    # The generic path never fetches the environment.
    assert calls["http"] == []


def test_codetrace_contract_detection_matches_only_the_subject_grammar_token() -> None:
    assert dspy_rlm_bridge._uses_codetrace_contract(CODETRACE_INSTRUCTIONS) is True
    assert (
        dspy_rlm_bridge._uses_codetrace_contract(
            "Find the first unrecoverable critical failure and cite step-<n>."
        )
        is False
    )


def test_incorrect_block_model_enforces_cross_field_rules() -> None:
    with pytest.raises(Exception, match="precedes first_step"):
        dspy_rlm_bridge.IncorrectBlock.model_validate({**VALID_BLOCK, "last_step": 1})
    with pytest.raises(Exception, match="consequence_step 1 precedes"):
        dspy_rlm_bridge.IncorrectBlock.model_validate({**VALID_BLOCK, "consequence_step": 1})
    with pytest.raises(Exception, match="spans 13 steps"):
        dspy_rlm_bridge.IncorrectBlock.model_validate(
            {**VALID_BLOCK, "first_step": 1, "last_step": 13, "consequence_step": 13}
        )
