from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
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
    "packages": {
        "agent-eval-rpc": "0.137.0",
        "dspy": "3.4.0",
        "deno": "2.9.7",
    },
    "python": {"implementation": "cpython", "version": "3.13.0"},
    "bridge": {"sourceSha256": "a" * 64},
    "sandbox": {
        "probeOutput": "2",
        "runtime": "deno-pyodide",
        "config": "none",
        "nodeModulesDir": "none",
    },
}


def test_read_json_enforces_the_caller_selected_input_limit(tmp_path: Path) -> None:
    input_path = tmp_path / "input.json"
    input_path.write_text(json.dumps({"value": "x" * 100}))

    with pytest.raises(ValueError, match="exceeds 20 bytes"):
        dspy_rlm_bridge._read_json(input_path, 20)

    assert dspy_rlm_bridge._read_json(input_path, 1_000) == {"value": "x" * 100}


def test_sandbox_attestation_derives_from_the_real_command() -> None:
    widened = dspy_rlm_bridge._sandbox_attestation(
        ["/bin/deno", "run", "--allow-net", "-A", "--node-modules-dir=auto", "/r.js"]
    )
    assert widened == {
        "config": "discovered",
        "nodeModulesDir": "auto",
        "permissions": {
            "allow-all": {"scoped": False},
            "allow-net": {"scoped": False},
        },
    }
    assert dspy_rlm_bridge._sandbox_attestation(DENO_COMMAND) == {
        "config": "none",
        "nodeModulesDir": "none",
        "permissions": {"allow-read": {"scoped": True, "paths": 2}},
    }


def test_analyze_accepts_all_canonical_node_tool_schemas(tmp_path: Path) -> None:
    input_path, _ = _write_analyze_input(tmp_path)
    input_value = json.loads(input_path.read_text())
    arguments = {
        "readSpanSource": ["trace_id", "span_id", "attribute", "offset", "limit", "source_index"],
        "getDatasetOverview": ["filters"],
        "queryTraces": ["filters", "limit", "offset"],
        "countTraces": ["filters"],
        "viewTrace": ["trace_id"],
        "viewSpans": ["trace_id", "span_ids"],
        "searchTrace": ["trace_id", "regex_pattern", "max_matches"],
        "searchSpan": ["trace_id", "span_id", "regex_pattern", "max_matches"],
    }
    required = {
        "readSpanSource": ["trace_id", "span_id", "attribute", "offset", "limit"],
        "getDatasetOverview": [],
        "queryTraces": ["limit"],
        "countTraces": [],
        "viewTrace": ["trace_id"],
        "viewSpans": ["trace_id", "span_ids"],
        "searchTrace": ["trace_id", "regex_pattern", "max_matches"],
        "searchSpan": ["trace_id", "span_id", "regex_pattern", "max_matches"],
    }
    input_value["toolSpecs"] = [
        {
            "name": name,
            "description": f"Node descriptor for {name}.",
            "parameters": {
                "type": "object",
                "properties": {argument: {"type": "string"} for argument in tool_arguments},
                "required": required[name],
                "additionalProperties": False,
            },
        }
        for name, tool_arguments in arguments.items()
    ]

    assert dspy_rlm_bridge._validate_analyze_input(input_value) is input_value


@pytest.mark.parametrize(
    ("function_name", "kwargs", "expected_args"),
    [
        (
            "readSpanSource",
            {
                "trace_id": "t1",
                "span_id": "s1",
                "attribute": "output.value",
                "offset": 1024,
                "limit": 64,
            },
            {
                "trace_id": "t1",
                "span_id": "s1",
                "attribute": "output.value",
                "offset": 1024,
                "limit": 64,
                "source_index": 0,
            },
        ),
        ("getDatasetOverview", {}, {}),
        ("queryTraces", {"limit": 5, "offset": 2}, {"limit": 5, "offset": 2}),
        ("countTraces", {"filters": {"has_errors": True}}, {"filters": {"has_errors": True}}),
        ("viewTrace", {"trace_id": "t1"}, {"trace_id": "t1"}),
        (
            "viewSpans",
            {"trace_id": "t1", "span_ids": ["s1", "s2"]},
            {"trace_id": "t1", "span_ids": ["s1", "s2"]},
        ),
        (
            "searchTrace",
            {"trace_id": "t1", "regex_pattern": "error"},
            {"trace_id": "t1", "regex_pattern": "error", "max_matches": 50},
        ),
        (
            "searchSpan",
            {"trace_id": "t1", "span_id": "s1", "regex_pattern": "error", "max_matches": 3},
            {
                "trace_id": "t1",
                "span_id": "s1",
                "regex_pattern": "error",
                "max_matches": 3,
            },
        ),
    ],
)
def test_fixed_trace_tools_send_authenticated_callback_payloads(
    monkeypatch: pytest.MonkeyPatch,
    function_name: str,
    kwargs: dict[str, Any],
    expected_args: dict[str, Any],
) -> None:
    observed: list[dict[str, Any]] = []

    def fake_post(url: str, **request: Any) -> httpx.Response:
        observed.append({"url": url, **request})
        return httpx.Response(
            200,
            json={"result": {"ok": True}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    function = getattr(dspy_rlm_bridge, function_name)
    with dspy_rlm_bridge._tool_callback("http://127.0.0.1:9000/call", "secret-token", 60.0):
        assert function(**kwargs) == {"ok": True}

    assert observed == [
        {
            "url": "http://127.0.0.1:9000/call",
            "headers": {"Authorization": "Bearer secret-token"},
            "json": {"name": function_name, "args": expected_args},
            "timeout": 60.0,
        }
    ]


def test_parse_findings_json_recovers_and_reports_defects() -> None:
    # a fenced or prose-wrapped array is recovered
    fenced = '```json\n[{"severity": "high", "claim": "c", "confidence": 0.5, "evidence": [{"uri": "trace://t/span/s"}]}]\n```'
    rows, rejected = dspy_rlm_bridge._parse_findings_json(fenced)
    assert len(rows) == 1 and rows[0]["claim"] == "c"
    assert rejected == []

    # non-JSON is a defect to report, never a silent empty result
    with pytest.raises(TypeError):
        dspy_rlm_bridge._parse_findings_json("no findings here")

    # a list crosses the string boundary as canonical JSON instead of a repr
    rows, rejected = dspy_rlm_bridge._parse_findings_json(
        [
            {
                "severity": "high",
                "claim": "c",
                "confidence": 0.5,
                "evidence": [{"uri": "trace://t/span/s"}],
            }
        ]
    )
    assert len(rows) == 1 and rejected == []

    # a malformed row is dropped while a valid sibling survives, and the
    # dropped row is reported with its index and field
    mixed = json.dumps(
        [
            {
                "severity": "high",
                "claim": "keep me",
                "confidence": 0.5,
                "evidence": [{"uri": "trace://t/span/s"}],
            },
            {"severity": "nope", "claim": "", "evidence": []},
        ]
    )
    rows, rejected = dspy_rlm_bridge._parse_findings_json(mixed)
    assert [row["claim"] for row in rows] == ["keep me"]
    assert [(row.index, row.path) for row in rejected] == [(1, "severity")]


def _write_analyze_input(tmp_path: Path) -> tuple[Path, Path]:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "operation": "analyze",
                "controlAdapter": "chat",
                "question": "Why did this run fail?",
                "instructions": "Find the earliest causal failure.",
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
                "limits": {
                    "maxIterations": 4,
                    "maxLlmCalls": 6,
                    "maxOutputChars": 8_000,
                },
                "toolSpecs": [
                    {
                        "name": "viewTrace",
                        "description": "Read one trace.",
                        "parameters": {
                            "type": "object",
                            "properties": {"trace_id": {"type": "string", "minLength": 1}},
                            "required": ["trace_id"],
                            "additionalProperties": False,
                        },
                    }
                ],
            }
        )
    )
    return input_path, output_path


def test_recover_control_fields_from_prose_and_fence() -> None:
    completion = (
        "I will read the trace first.\n"
        "```python\n"
        "overview = getDatasetOverview({})\n"
        "print(overview)\n"
        "```"
    )
    recovered = dspy_rlm_bridge._recover_control_fields(completion, ["reasoning", "code"])
    assert recovered is not None
    assert "getDatasetOverview" in recovered["code"]
    assert "read the trace" in recovered["reasoning"]


def test_recover_control_fields_from_json_object() -> None:
    completion = '{"reasoning": "checked the span", "code": "print(1)"}'
    recovered = dspy_rlm_bridge._recover_control_fields(completion, ["reasoning", "code"])
    assert recovered == {"reasoning": "checked the span", "code": "print(1)"}


def test_recover_control_fields_partial_markers_default_missing_field() -> None:
    completion = "[[ ## reasoning ## ]]\nI planned but did not write code yet."
    recovered = dspy_rlm_bridge._recover_control_fields(completion, ["reasoning", "code"])
    assert "planned" in recovered["reasoning"]
    assert recovered["code"] == ""


def test_recover_final_fields_omits_unrecoverable_findings() -> None:
    # An unrecoverable findings field is left absent so the caller reports it
    # by name. Defaulting it to "[]" made a lost field indistinguishable from a
    # model that found nothing citable, which is how paid work vanished.
    completion = "The best model was copied to the required location."
    recovered = dspy_rlm_bridge._recover_control_fields(completion, ["answer", "findings_json"])
    assert "best model" in recovered["answer"]
    assert "findings_json" not in recovered


def test_recover_never_returns_none_and_never_fabricates() -> None:
    recovered = dspy_rlm_bridge._recover_control_fields("", ["reasoning", "code"])
    assert recovered == {"reasoning": "(no stated reasoning)", "code": ""}


_VALID_FINDING = {
    "severity": "high",
    "claim": "Step 5 wrote an invalid configuration.",
    "subject": "incorrect-steps-5-5-unescaped-consequence-6",
    "confidence": 0.9,
    "evidence": [{"uri": "trace://trace-1/span/step-5"}],
}


def test_salvage_recovers_json_after_a_malformed_marker() -> None:
    text = "Every other step was correct.\n\n[[ ## findings_json ## ]\n" + json.dumps(
        [_VALID_FINDING]
    )
    salvaged = dspy_rlm_bridge._salvage_findings_json(text)
    assert salvaged is not None
    rows, method = salvaged
    assert rows == [_VALID_FINDING]
    assert method == "malformed-marker"


def test_salvage_finds_the_last_findings_shaped_array() -> None:
    text = "counts were [1, 2, 3] and the verdict is " + json.dumps([_VALID_FINDING]) + " done"
    salvaged = dspy_rlm_bridge._salvage_findings_json(text)
    assert salvaged is not None
    rows, method = salvaged
    assert rows == [_VALID_FINDING]
    assert method == "trailing-json-array"

    assert dspy_rlm_bridge._salvage_findings_json("no citable array here [1, 2]") is None
    assert dspy_rlm_bridge._salvage_findings_json("") is None


def test_a_list_valued_submission_survives_the_string_boundary() -> None:
    # #636: DSPy could hand the bridge a list. Forcing it through str() made a
    # Python repr, which is not JSON, and the array parsed to zero rows while
    # the run still reported success. The codec encodes it as canonical JSON.
    rows = [
        {
            "severity": "high",
            "claim": "the retry loop never backs off",
            "confidence": 0.9,
            "evidence": [{"uri": "trace://t1/span/s1"}],
        }
    ]
    accepted, rejected = dspy_rlm_bridge._parse_findings_json(rows)
    assert accepted == rows
    assert rejected == []

    # The repr of that same list is refused rather than silently emptied.
    with pytest.raises(TypeError):
        dspy_rlm_bridge._parse_findings_json(str(rows))


def test_the_generic_repair_prompt_does_not_ask_for_incorrect_steps() -> None:
    # #579: the generic path reused CodeTrace's "no incorrect steps means []"
    # rule, which erased valid factual findings from a generic analysis.
    assert "Return [] only when the answer contains no citable claim" in (
        dspy_rlm_bridge._FINDINGS_REPAIR_PROMPT
    )
    assert "incorrect steps" not in dspy_rlm_bridge._FINDINGS_REPAIR_PROMPT
    # CodeTrace keeps its own vocabulary.
    assert "incorrect steps" in dspy_rlm_bridge._CODETRACE_FINDINGS_REPAIR_PROMPT


def test_the_repair_turn_carries_the_exact_row_defects() -> None:
    prompts: list[str] = []

    def fake_lm(messages: list[dict[str, str]]) -> list[str]:
        prompts.append(messages[0]["content"])
        return [
            json.dumps(
                [
                    {
                        "severity": "high",
                        "claim": "repaired",
                        "confidence": 0.5,
                        "evidence": [{"uri": "trace://t/span/s"}],
                    }
                ]
            )
        ]

    _, rejected = dspy_rlm_bridge._parse_findings_json(
        json.dumps([{"severity": "nope", "claim": "", "evidence": []}])
    )
    accepted, still_rejected, error = dspy_rlm_bridge._repair_findings_turn(
        fake_lm,
        "the answer prose",
        dspy_rlm_bridge.describe_rejected_rows(rejected),
    )

    assert error is None
    assert [row["claim"] for row in accepted] == ["repaired"]
    assert still_rejected == []
    # Exactly one turn, and it was told which row and field were wrong.
    assert len(prompts) == 1
    assert "row 0 field 'severity'" in prompts[0]


def test_a_repair_failure_keeps_the_defects_and_the_answer() -> None:
    def failing_lm(messages: list[dict[str, str]]) -> list[str]:
        raise RuntimeError("provider refused")

    accepted, rejected, error = dspy_rlm_bridge._repair_findings_turn(
        failing_lm, "the answer prose", "row 0 field 'severity': bad"
    )
    assert accepted == []
    assert rejected == []
    assert error is not None and "provider refused" in error


def test_analyze_preserves_installed_dspy_execution_instructions(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    dspy = pytest.importorskip("dspy")
    interpreter = dspy.PythonInterpreter(deno_command=DENO_COMMAND)

    @contextmanager
    def probed_interpreter(_dspy: Any) -> Any:
        try:
            yield interpreter, DENO_COMMAND
        finally:
            interpreter.shutdown()

    class ConstructedWithoutInference(Exception):
        pass

    def stop_before_inference(program: Any, **_inputs: Any) -> Any:
        assert (
            dspy.PythonInterpreter.execution_instructions
            in program.generate_action.signature.instructions
        )
        assert program._interpreter_factory() is interpreter
        raise ConstructedWithoutInference

    monkeypatch.setattr(dspy_rlm_bridge, "_probed_interpreter", probed_interpreter)
    monkeypatch.setattr(dspy_rlm_bridge, "_runtime_identity", lambda _command: RUNTIME)
    monkeypatch.setattr(dspy.RLM, "forward", stop_before_inference)
    input_path, _ = _write_analyze_input(tmp_path)
    with pytest.raises(ConstructedWithoutInference):
        dspy_rlm_bridge._analyze(json.loads(input_path.read_text()))
