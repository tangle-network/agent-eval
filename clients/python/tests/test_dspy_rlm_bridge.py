from __future__ import annotations

import hashlib
import json
import os
import stat
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
    "packages": {
        "agent-eval-rpc": "0.137.0",
        "dspy": "3.2.1",
        "deno": "2.7.14",
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


def test_inspect_reports_pinned_runtime_and_private_atomic_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(json.dumps({"operation": "inspect"}))
    calls: dict[str, Any] = {}
    monkeypatch.setattr(dspy_rlm_bridge, "_load_dspy", lambda: _fake_dspy(calls))
    monkeypatch.setattr(
        dspy_rlm_bridge,
        "_build_deno_command",
        lambda _dspy: DENO_COMMAND,
    )
    monkeypatch.setattr(
        dspy_rlm_bridge,
        "_package_version",
        lambda name: {
            "agent-eval-rpc": "0.137.0",
            "dspy": "3.2.1",
            "deno": "2.7.14",
        }[name],
    )
    monkeypatch.setattr(dspy_rlm_bridge.platform, "python_version", lambda: "3.13.0")
    monkeypatch.setattr(dspy_rlm_bridge, "sys_implementation_name", lambda: "cpython")
    monkeypatch.setattr(
        sys,
        "argv",
        ["dspy-rlm-bridge", "--input", str(input_path), "--output", str(output_path)],
    )
    previous_umask = os.umask(0)
    os.umask(previous_umask)

    dspy_rlm_bridge.main()

    output = json.loads(output_path.read_text())
    assert output == {
        "runtime": {
            "engine": "dspy-rlm",
            "packages": {
                "agent-eval-rpc": "0.137.0",
                "dspy": "3.2.1",
                "deno": "2.7.14",
            },
            "python": {"implementation": "cpython", "version": "3.13.0"},
            "bridge": {
                "sourceSha256": hashlib.sha256(
                    Path(dspy_rlm_bridge.__file__).read_bytes()
                ).hexdigest()
            },
            "sandbox": {
                "probeOutput": "2",
                "runtime": "deno-pyodide",
                "config": "none",
                "nodeModulesDir": "none",
            },
        }
    }
    assert calls["probe_code"] == "print(1+1)"
    assert calls["interpreter_shutdown"] is True
    assert stat.S_IMODE(output_path.stat().st_mode) == 0o600
    observed_umask = os.umask(previous_umask)
    os.umask(observed_umask)
    assert observed_umask == previous_umask


def test_analyze_uses_official_rlm_contract_and_enabled_node_tool_specs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: dict[str, Any] = {"http": []}
    fake_dspy = _fake_dspy(calls)
    monkeypatch.setattr(dspy_rlm_bridge, "_load_dspy", lambda: fake_dspy)
    monkeypatch.setattr(
        dspy_rlm_bridge,
        "_build_deno_command",
        lambda _dspy: DENO_COMMAND,
    )
    monkeypatch.setattr(dspy_rlm_bridge, "_runtime_identity", lambda _command: RUNTIME)
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-read")

    def fake_post(url: str, **kwargs: Any) -> httpx.Response:
        calls["http"].append({"url": url, **kwargs})
        return httpx.Response(
            200,
            json={"result": {"trace_id": "trace-1", "spans": []}},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    input_path, output_path = _write_analyze_input(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        ["dspy-rlm-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    dspy_rlm_bridge.main()

    assert calls["lm"] == {
        "model": "openai/analysis-model",
        "api_base": "http://127.0.0.1:8123/v1",
        "api_key": "proxy-key",
        "cache": False,
        "num_retries": 0,
        "max_tokens": 700,
    }
    assert calls["context_lm"] is calls["lm_instance"]
    assert calls["rlm"]["sub_lm"] is calls["lm_instance"]
    assert calls["rlm"]["max_iterations"] == 4
    assert calls["rlm"]["max_llm_calls"] == 6
    assert calls["rlm"]["max_output_chars"] == 8_000
    assert calls["rlm"]["interpreter"] is calls["interpreter"]
    assert [tool.name for tool in calls["rlm"]["tools"]] == ["viewTrace"]
    tool = calls["rlm"]["tools"][0]
    assert tool.desc == "Read one trace."
    assert tool.args == {"trace_id": {"type": "string", "minLength": 1}}
    assert calls["program_input"] == {
        "question": "Why did this run fail?",
        "analyst_instructions": "Find the earliest causal failure.",
    }
    assert calls["http"] == [
        {
            "url": "http://127.0.0.1:8124/call",
            "headers": {"Authorization": "Bearer callback-token"},
            "json": {"name": "viewTrace", "args": {"trace_id": "trace-1"}},
            "timeout": 60.0,
        }
    ]
    assert calls["order"][:3] == ["interpreter-init", "probe", "lm-init"]
    assert calls["interpreter_shutdown"] is True
    assert json.loads(output_path.read_text()) == {
        "answer": "The first failing operation is step 2.",
        "findings": [
            {
                "severity": "high",
                "claim": "Step 2 failed before recovery.",
                "subject": "step:2",
                "confidence": 0.95,
                "rationale": "The span has the first error.",
                "recommended_action": "Fix step 2.",
                "evidence": [
                    {
                        "uri": "trace://trace-1/span/step-2",
                        "excerpt": "status=ERROR",
                    }
                ],
            }
        ],
        "trajectory": [{"iteration": 1, "tool": "viewTrace"}],
        "modelCalls": 3,
        "runtime": RUNTIME,
    }


def test_analyze_accepts_all_canonical_node_tool_schemas(tmp_path: Path) -> None:
    input_path, _ = _write_analyze_input(tmp_path)
    input_value = json.loads(input_path.read_text())
    arguments = {
        "getDatasetOverview": ["filters"],
        "queryTraces": ["filters", "limit", "offset"],
        "countTraces": ["filters"],
        "viewTrace": ["trace_id"],
        "viewSpans": ["trace_id", "span_ids"],
        "searchTrace": ["trace_id", "regex_pattern", "max_matches"],
        "searchSpan": ["trace_id", "span_id", "regex_pattern", "max_matches"],
    }
    required = {
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


def test_deno_command_ignores_repo_configuration_and_node_modules(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bin_dir = tmp_path / "venv" / "bin"
    bin_dir.mkdir(parents=True)
    python = bin_dir / "python"
    deno = bin_dir / "deno"
    python.touch()
    deno.touch(mode=0o700)
    runner = tmp_path / "dspy" / "runner.js"
    runner.parent.mkdir()
    runner.touch()
    cache = tmp_path / "deno-cache"
    cache.mkdir()
    monkeypatch.setattr(dspy_rlm_bridge.sys, "executable", str(python))
    monkeypatch.setattr(dspy_rlm_bridge, "_dspy_runner_path", lambda _dspy: runner)
    monkeypatch.setattr(dspy_rlm_bridge, "_deno_cache_dir", lambda _deno: cache)

    command = dspy_rlm_bridge._build_deno_command(SimpleNamespace())

    assert command == [
        str(deno.resolve()),
        "run",
        "--no-config",
        "--node-modules-dir=none",
        f"--allow-read={runner},{cache}",
        str(runner),
    ]
    assert "--node-modules-dir=auto" not in command


def test_broken_sandbox_fails_before_lm_construction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: dict[str, Any] = {}
    fake_dspy = _fake_dspy(calls, probe_output="sandbox error")
    monkeypatch.setattr(dspy_rlm_bridge, "_load_dspy", lambda: fake_dspy)
    monkeypatch.setattr(
        dspy_rlm_bridge,
        "_build_deno_command",
        lambda _dspy: DENO_COMMAND,
    )
    input_path, output_path = _write_analyze_input(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        ["dspy-rlm-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    with pytest.raises(RuntimeError, match="before any model call"):
        dspy_rlm_bridge.main()

    assert "lm" not in calls
    assert calls["interpreter_shutdown"] is True
    assert not output_path.exists()


@pytest.mark.parametrize(
    ("function_name", "kwargs", "expected_args"),
    [
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
    with dspy_rlm_bridge._tool_callback("http://127.0.0.1:9000/call", "secret-token"):
        assert function(**kwargs) == {"ok": True}

    assert observed == [
        {
            "url": "http://127.0.0.1:9000/call",
            "headers": {"Authorization": "Bearer secret-token"},
            "json": {"name": function_name, "args": expected_args},
            "timeout": 60.0,
        }
    ]


@pytest.mark.parametrize(
    "findings_json",
    [
        "not json",
        json.dumps(
            [
                {
                    "severity": "high",
                    "claim": "Invalid extra field.",
                    "confidence": 0.8,
                    "evidence": [{"uri": "trace://t/span/s"}],
                    "extra": True,
                }
            ]
        ),
    ],
)
def test_analyze_rejects_malformed_findings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    findings_json: str,
) -> None:
    calls: dict[str, Any] = {}
    fake_dspy = _fake_dspy(calls, findings_json=findings_json, invoke_tool=False)
    monkeypatch.setattr(dspy_rlm_bridge, "_load_dspy", lambda: fake_dspy)
    monkeypatch.setattr(
        dspy_rlm_bridge,
        "_build_deno_command",
        lambda _dspy: DENO_COMMAND,
    )
    monkeypatch.setattr(dspy_rlm_bridge, "_runtime_identity", lambda _command: RUNTIME)
    input_path, output_path = _write_analyze_input(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        ["dspy-rlm-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    with pytest.raises(ValueError, match="findings"):
        dspy_rlm_bridge.main()

    assert not output_path.exists()


def _write_analyze_input(tmp_path: Path) -> tuple[Path, Path]:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "operation": "analyze",
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


def _fake_dspy(
    calls: dict[str, Any],
    *,
    findings_json: str | None = None,
    invoke_tool: bool = True,
    probe_output: str = "2\n",
) -> Any:
    valid_findings = json.dumps(
        [
            {
                "severity": "high",
                "claim": "Step 2 failed before recovery.",
                "subject": "step:2",
                "confidence": 0.95,
                "rationale": "The span has the first error.",
                "recommended_action": "Fix step 2.",
                "evidence": [
                    {
                        "uri": "trace://trace-1/span/step-2",
                        "excerpt": "status=ERROR",
                    }
                ],
            }
        ]
    )

    class FakePythonInterpreter:
        def __init__(self, *, deno_command: list[str]) -> None:
            calls.setdefault("order", []).append("interpreter-init")
            calls["interpreter"] = self
            calls["deno_command"] = deno_command

        def execute(self, code: str) -> str:
            calls["order"].append("probe")
            calls["probe_code"] = code
            return probe_output

        def shutdown(self) -> None:
            calls["interpreter_shutdown"] = True

    class FakeLm:
        def __init__(self, model: str, **kwargs: Any) -> None:
            calls.setdefault("order", []).append("lm-init")
            self.history: list[dict[str, Any]] = []
            calls["lm"] = {"model": model, **kwargs}
            calls["lm_instance"] = self

    class FakeTool:
        def __init__(
            self,
            function: Any,
            *,
            name: str,
            desc: str,
            args: dict[str, Any],
        ) -> None:
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
            lm = calls["lm_instance"]
            lm.history.extend([{"call": 1}, {"call": 2}, {"call": 3}])
            if invoke_tool:
                assert calls["rlm"]["tools"][0].func(trace_id="trace-1") == {
                    "trace_id": "trace-1",
                    "spans": [],
                }
            return SimpleNamespace(
                answer="The first failing operation is step 2.",
                findings_json=findings_json if findings_json is not None else valid_findings,
                trajectory=[{"iteration": 1, "tool": "viewTrace"}],
            )

    @contextmanager
    def fake_context(*, lm: Any) -> Any:
        calls["context_lm"] = lm
        yield

    return SimpleNamespace(
        LM=FakeLm,
        PythonInterpreter=FakePythonInterpreter,
        Tool=FakeTool,
        RLM=FakeRlm,
        Signature=lambda fields, instructions: {
            "fields": fields,
            "instructions": instructions,
        },
        InputField=lambda **kwargs: {"kind": "input", **kwargs},
        OutputField=lambda **kwargs: {"kind": "output", **kwargs},
        context=fake_context,
    )
