from __future__ import annotations

import json
import logging
import math
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from importlib.metadata import distribution, version
from pathlib import Path
from typing import Any

import pytest

REQUIRED_SKILLOPT_PROMPTS = {
    "analyst_error.md",
    "analyst_error_full_rewrite.md",
    "analyst_error_rewrite.md",
    "analyst_success.md",
    "analyst_success_full_rewrite.md",
    "analyst_success_rewrite.md",
    "lr_autonomous.md",
    "merge_failure.md",
    "merge_failure_full_rewrite.md",
    "merge_failure_rewrite.md",
    "merge_final.md",
    "merge_final_full_rewrite.md",
    "merge_final_rewrite.md",
    "merge_success.md",
    "merge_success_full_rewrite.md",
    "merge_success_rewrite.md",
    "meta_skill.md",
    "ranking.md",
    "ranking_rewrite.md",
    "rewrite_skill.md",
    "slow_update.md",
}


def _assert_installed_git_package(
    package: str,
    expected_version: str,
    source_url: str,
    commit: str,
) -> None:
    assert version(package) == expected_version
    direct_url = json.loads(distribution(package).read_text("direct_url.json") or "{}")
    assert direct_url == {
        "url": source_url,
        "vcs_info": {
            "commit_id": commit,
            "requested_revision": commit,
            "vcs": "git",
        },
    }


class _DeterministicReflectionModel:
    def __init__(self) -> None:
        self.prompts: list[Any] = []

    def __call__(self, prompt: Any) -> str:
        self.prompts.append(prompt)
        return "```\nALWAYS_RETURN_READY\n```"


def test_engine_module_registers_with_official_gepa_registry(
    monkeypatch,
    tmp_path: Path,
) -> None:
    from gepa.oa.registry import get_engine_cls

    from agent_eval_rpc.gepa_bridge import _import_engine_modules

    module_name = "agent_eval_custom_engine"
    (tmp_path / f"{module_name}.py").write_text(
        "\n".join(
            [
                "from gepa.optimize_anything import register_engine",
                "class CustomEngine:",
                "    pass",
                "register_engine('agent-eval-test-engine', CustomEngine)",
            ]
        )
    )
    monkeypatch.syspath_prepend(str(tmp_path))

    _import_engine_modules([module_name])

    registered = get_engine_cls("agent-eval-test-engine")
    assert registered.__module__ == module_name
    assert registered.__name__ == "CustomEngine"


def test_installed_gepa_performs_nonzero_optimize_anything_work(
    tmp_path: Path,
) -> None:
    from gepa.optimize_anything import OptimizeAnythingConfig, optimize_anything

    _assert_installed_git_package(
        "gepa",
        "0.1.4",
        "https://github.com/gepa-ai/gepa.git",
        "f919db0a622e2e9f9204779b81fe00cc1b2d808f",
    )
    model = _DeterministicReflectionModel()
    evaluations: list[tuple[str, str]] = []

    def evaluate(candidate: str, example: dict[str, str]) -> tuple[float, dict[str, str]]:
        evaluations.append((candidate, example["id"]))
        score = 1.0 if "ALWAYS_RETURN_READY" in candidate else 0.0
        return score, {"feedback": "The candidate must contain ALWAYS_RETURN_READY."}

    state_dir = tmp_path / "gepa-state"
    result = optimize_anything(
        "BASELINE",
        evaluator=evaluate,
        dataset=[{"id": "train"}],
        valset=[{"id": "selection"}],
        objective="Add the required response rule.",
        config=OptimizeAnythingConfig(
            engine="gepa",
            max_evals=4,
            max_concurrency=1,
            output_dir=tmp_path / "gepa-evaluations",
            run_dir=str(state_dir),
            stop_at_score=1.0,
            engine_config={
                "engine": {
                    "capture_stdio": False,
                    "max_workers": 1,
                    "parallel": False,
                    "raise_on_exception": True,
                    "seed": 7,
                },
                "reflection": {
                    "reflection_lm": model,
                    "reflection_minibatch_size": 1,
                    "skip_perfect_score": False,
                },
            },
        ),
    )

    assert result.best_candidate == "ALWAYS_RETURN_READY"
    assert result.best_score == 1.0
    assert result.total_evals == 4
    assert len(result.eval_log) == 4
    assert len(model.prompts) == 1
    assert "ALWAYS_RETURN_READY" in json.dumps(model.prompts[0])
    assert evaluations == [
        ("BASELINE", "selection"),
        ("BASELINE", "train"),
        ("ALWAYS_RETURN_READY", "train"),
        ("ALWAYS_RETURN_READY", "selection"),
    ]
    assert (state_dir / "gepa_state.bin").stat().st_size > 0
    assert (state_dir / "candidates.json").stat().st_size > 0


class _LocalChatHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]]
    response_content: str | None = None
    failures_remaining: int = 0
    finish_reason: str = "stop"

    def do_POST(self) -> None:
        content_length = int(self.headers["Content-Length"])
        request = json.loads(self.rfile.read(content_length))
        self.requests.append(
            {
                "authorization": self.headers.get("Authorization"),
                "body": request,
                "path": self.path,
            }
        )
        handler_type = type(self)
        if handler_type.failures_remaining > 0:
            handler_type.failures_remaining -= 1
            response = json.dumps(
                {
                    "error": {
                        "code": "rate_limit",
                        "message": "retry this request",
                        "type": "rate_limit_error",
                    }
                }
            ).encode()
            self.send_response(429)
            self.send_header("Content-Length", str(len(response)))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(response)
            return

        content = self.response_content
        if content is None:
            content = json.dumps(
                {
                    "batch_size": 1,
                    "failure_summary": [
                        {
                            "count": 1,
                            "description": "The required response rule is absent.",
                            "failure_type": "missing_rule",
                        }
                    ],
                    "patch": {
                        "edits": [
                            {
                                "content": "\n\n## Required Rule\nALWAYS_RETURN_READY\n",
                                "op": "append",
                            }
                        ],
                        "reasoning": "Add the missing response rule.",
                    },
                }
            )
        response = json.dumps(
            {
                "choices": [
                    {
                        "finish_reason": self.finish_reason,
                        "index": 0,
                        "message": {
                            "content": content,
                            "role": "assistant",
                        },
                    }
                ],
                "created": 0,
                "id": "chatcmpl-local",
                "model": "local-model",
                "object": "chat.completion",
                "usage": {
                    "completion_tokens": 13,
                    "prompt_tokens": 11,
                    "total_tokens": 24,
                },
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: Any) -> None:
        del format, args


@contextmanager
def _local_chat_server(
    response_content: str | None = None,
    *,
    failures: int = 0,
    finish_reason: str = "stop",
) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    requests: list[dict[str, Any]] = []
    handler = type(
        "RecordingLocalChatHandler",
        (_LocalChatHandler,),
        {
            "failures_remaining": failures,
            "finish_reason": finish_reason,
            "requests": requests,
            "response_content": response_content,
        },
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()


class _SkillOptCallbackHandler(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]]
    token: str

    def do_POST(self) -> None:
        content_length = int(self.headers["Content-Length"])
        request = json.loads(self.rfile.read(content_length))
        self.requests.append(
            {
                "authorization": self.headers.get("Authorization"),
                "body": request,
                "path": self.path,
            }
        )
        candidate = request["candidate"]
        score = 1.0 if "ALWAYS_RETURN_READY" in candidate else 0.0
        response = json.dumps(
            {
                "score": score,
                "info": {
                    "artifact": {"answer": "READY" if score else "NOT READY"},
                    "dimensions": {"correctness": score},
                    "notes": "" if score else "The required response rule is absent.",
                },
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(response)))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: Any) -> None:
        del format, args


@contextmanager
def _skillopt_callback_server(
    token: str,
) -> Iterator[tuple[str, list[dict[str, Any]]]]:
    requests: list[dict[str, Any]] = []
    handler = type(
        "RecordingSkillOptCallbackHandler",
        (_SkillOptCallbackHandler,),
        {"requests": requests, "token": token},
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/evaluate", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()


def test_agent_eval_uses_official_gepa_lm_behavior(caplog) -> None:
    from gepa.lm import LM

    from agent_eval_rpc.gepa_bridge import _official_reflection_model, _ProxyUsage

    usage = _ProxyUsage()
    with _local_chat_server(
        "TRUNCATED",
        failures=1,
        finish_reason="length",
    ) as (base_url, requests):
        model = _official_reflection_model(
            config={
                "apiKey": "local-test-key",
                "baseUrl": base_url,
                "model": "local-model",
                "budget": {
                    "maxCostUsd": 1,
                    "maxRequests": 10,
                    "maxRequestBytes": 100_000,
                    "maxResponseBytes": 100_000,
                    "maxOutputTokensPerRequest": 64,
                    "requestTimeoutMs": 5_000,
                    "pricing": {
                        "inputUsdPerMillion": 1.0,
                        "outputUsdPerMillion": 2.0,
                    },
                },
            },
            options={"num_retries": 1, "temperature": 0.2},
            shared_usage=usage,
        )

        assert isinstance(model, LM)
        with caplog.at_level(logging.WARNING, logger="gepa.lm"):
            assert model("first") == "TRUNCATED"
            assert model.batch_complete(
                [
                    [{"role": "user", "content": "second"}],
                    [{"role": "user", "content": "third"}],
                ],
                max_workers=2,
            ) == ["TRUNCATED", "TRUNCATED"]

    assert len(requests) == 4
    assert all(request["path"] == "/v1/chat/completions" for request in requests)
    assert all(request["body"]["model"] == "local-model" for request in requests)
    assert all(request["body"]["max_tokens"] == 64 for request in requests)
    assert all(request["body"]["temperature"] == 0.2 for request in requests)
    assert sum("LM response was truncated" in record.message for record in caplog.records) == 3
    snapshot = usage.snapshot()
    assert math.isclose(snapshot.pop("costUsd"), 0.000111, abs_tol=1e-12)
    assert snapshot == {
        "calls": 4,
        "inputTokens": 33,
        "outputTokens": 39,
        "totalTokens": 72,
    }
    usage.close()


def test_agent_eval_gepa_proxy_drives_the_official_engine(
    tmp_path: Path,
) -> None:
    from gepa.lm import LM
    from gepa.optimize_anything import OptimizeAnythingConfig, optimize_anything

    from agent_eval_rpc.gepa_bridge import _engine_config, _ProxyUsage

    evaluations: list[tuple[str, str]] = []

    def evaluate(candidate: str, example: dict[str, str]) -> tuple[float, dict[str, str]]:
        evaluations.append((candidate, example["id"]))
        score = 1.0 if "ALWAYS_RETURN_READY" in candidate else 0.0
        return score, {"feedback": "The candidate must contain ALWAYS_RETURN_READY."}

    usage = _ProxyUsage()
    with _local_chat_server("```\nALWAYS_RETURN_READY\n```") as (
        base_url,
        model_requests,
    ):
        config = _engine_config(
            OptimizeAnythingConfig,
            {
                "engine": "gepa",
                "engineConfig": {
                    "engine": {
                        "capture_stdio": False,
                        "max_workers": 1,
                        "parallel": False,
                        "raise_on_exception": True,
                        "seed": 7,
                    },
                    "reflection": {
                        "reflection_minibatch_size": 1,
                        "skip_perfect_score": False,
                    },
                },
                "maxEvaluations": 4,
                "maxProposerCostUsd": 1.0,
            },
            tmp_path / "proxied-gepa",
            model_proxy={
                "apiKey": "local-test-key",
                "baseUrl": base_url,
                "model": "local-model",
                "budget": {
                    "maxCostUsd": 1,
                    "maxRequests": 10,
                    "maxRequestBytes": 100_000,
                    "maxResponseBytes": 100_000,
                    "maxOutputTokensPerRequest": 256,
                    "requestTimeoutMs": 5_000,
                    "pricing": {
                        "inputUsdPerMillion": 1.0,
                        "outputUsdPerMillion": 2.0,
                    },
                },
            },
            proxy_usage=usage,
        )
        assert isinstance(config.engine_config["reflection"]["reflection_lm"], LM)
        result = optimize_anything(
            "BASELINE",
            evaluator=evaluate,
            dataset=[{"id": "train"}],
            valset=[{"id": "selection"}],
            objective="Add the required response rule.",
            config=config,
        )

    assert result.best_candidate == "ALWAYS_RETURN_READY"
    assert result.best_score == 1.0
    assert result.total_evals == 4
    assert len(model_requests) == 1
    assert model_requests[0]["authorization"] == "Bearer local-test-key"
    assert model_requests[0]["path"] == "/v1/chat/completions"
    assert model_requests[0]["body"]["model"] == "local-model"
    assert model_requests[0]["body"]["max_tokens"] == 256
    assert usage.snapshot() == {
        "calls": 1,
        "costUsd": 0.000037,
        "inputTokens": 11,
        "outputTokens": 13,
        "totalTokens": 24,
    }
    assert result.metadata["adapter_cost"] == 0.000037
    assert evaluations == [
        ("BASELINE", "selection"),
        ("BASELINE", "train"),
        ("ALWAYS_RETURN_READY", "train"),
        ("ALWAYS_RETURN_READY", "selection"),
    ]
    usage.close()


def test_agent_eval_gepa_bridge_resumes_state_from_a_real_prior_run(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import httpx

    from agent_eval_rpc import gepa_bridge
    from agent_eval_rpc.gepa_compat_0_1_4 import load_restore_observer

    _assert_installed_git_package(
        "gepa",
        "0.1.4",
        "https://github.com/gepa-ai/gepa.git",
        "f919db0a622e2e9f9204779b81fe00cc1b2d808f",
    )

    def callback_post(url: str, **kwargs: Any) -> httpx.Response:
        candidate = kwargs["json"]["candidate"]
        score = 1.0 if "ALWAYS_RETURN_READY" in candidate else 0.0
        return httpx.Response(
            200,
            json={
                "score": score,
                "info": {"feedback": "The candidate must contain ALWAYS_RETURN_READY."},
            },
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx, "post", callback_post)
    output_root = tmp_path / "bridge-output"
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"

    with _local_chat_server("```\nALWAYS_RETURN_READY\n```") as (
        base_url,
        model_requests,
    ):
        compatible_run_id = "a" * 64
        input_value = {
            "engineModules": [],
            "attemptId": "first-run",
            "compatibleRunId": compatible_run_id,
            "runId": compatible_run_id,
            "runtimeIdentity": gepa_bridge._runtime_identity([]),
            "resume": "if-compatible",
            "evaluationId": "resume-test",
            "seed": 7,
            "callbackUrl": "http://127.0.0.1:9/evaluate",
            "callbackToken": "local-callback-token",
            "recipe": {
                "kind": "engine",
                "run": {
                    "engine": "gepa",
                    "engineConfig": {
                        "engine": {
                            "capture_stdio": False,
                            "max_workers": 1,
                            "parallel": False,
                            "raise_on_exception": True,
                            "seed": 7,
                        },
                        "reflection": {
                            "reflection_minibatch_size": 1,
                            "skip_perfect_score": False,
                        },
                    },
                    "maxEvaluations": 4,
                    "maxProposerCostUsd": 1.0,
                },
            },
            "objective": "Add the required response rule.",
            "seedCandidate": "BASELINE",
            "trainSet": [{"id": "train", "data": {"prompt": "Return READY."}}],
            "selectionSet": [{"id": "selection", "data": {"prompt": "Return READY."}}],
            "maxCandidateChars": 1_000,
            "maxEvidenceChars": 10_000,
            "modelProxy": {
                "apiKey": "local-model-token",
                "baseUrl": base_url,
                "model": "local-model",
                "budget": {
                    "maxCostUsd": 1,
                    "maxRequests": 10,
                    "maxRequestBytes": 100_000,
                    "maxResponseBytes": 100_000,
                    "maxOutputTokensPerRequest": 256,
                    "requestTimeoutMs": 5_000,
                    "pricing": {
                        "inputUsdPerMillion": 1.0,
                        "outputUsdPerMillion": 2.0,
                    },
                },
            },
            "outputDir": str(output_root),
        }

        def run_bridge(attempt_id: str) -> dict[str, Any]:
            input_value["attemptId"] = attempt_id
            input_path.write_text(json.dumps(input_value))
            monkeypatch.setattr(
                sys,
                "argv",
                [
                    "gepa-bridge",
                    "--input",
                    str(input_path),
                    "--output",
                    str(output_path),
                ],
            )
            gepa_bridge.main()
            return json.loads(output_path.read_text())

        first = run_bridge("first-run")
        first_run_dir = output_root / "runs" / first["runId"]
        with pytest.raises(RuntimeError, match="supports only version 0.1.4"):
            load_restore_observer(
                first_run_dir,
                {
                    "package": "gepa",
                    "revision": "different-revision",
                    "version": "0.1.4",
                },
            )
        second = run_bridge("second-run")

    assert first["resumed"] is False
    assert first["bestCandidate"] == "ALWAYS_RETURN_READY"
    assert second["resumed"] is True
    assert second["runId"] == first["runId"]
    assert second["bestCandidate"] == "ALWAYS_RETURN_READY"
    assert second["bestScore"] == 1.0
    assert len(model_requests) == 1
    state_path = first_run_dir / "engine" / "state" / "gepa_state.bin"
    assert state_path.stat().st_size > 0


def test_installed_skillopt_runs_reflact_with_packaged_prompts(
    tmp_path: Path,
) -> None:
    from agent_eval_rpc import skillopt_bridge

    _assert_installed_git_package(
        "skillopt",
        "0.2.0",
        "https://github.com/microsoft/SkillOpt.git",
        "61735e3922efc2b90c6d6cab561e62e98452ca90",
    )
    prompt_root = resources.files("skillopt.prompts")
    installed_prompts = {
        entry.name
        for entry in prompt_root.iterdir()
        if entry.is_file() and entry.name.endswith(".md")
    }
    assert installed_prompts == REQUIRED_SKILLOPT_PROMPTS
    assert all((prompt_root / name).read_text().strip() for name in installed_prompts)

    callback_token = "callback-token"
    input_path = tmp_path / "skillopt-input.json"
    output_path = tmp_path / "skillopt-output.json"
    output_dir = tmp_path / "skillopt-output"
    with (
        _local_chat_server() as (base_url, model_requests),
        _skillopt_callback_server(callback_token) as (callback_url, callback_requests),
    ):
        compatible_run_id = "b" * 64
        attempt_id = "official-compatibility"
        input_path.write_text(
            json.dumps(
                {
                    "attemptId": attempt_id,
                    "compatibleRunId": compatible_run_id,
                    "runId": f"{compatible_run_id}-{attempt_id}",
                    "runtimeIdentity": skillopt_bridge._runtime_identity(),
                    "resume": "never",
                    "evaluationId": "official-compatibility",
                    "seed": 7,
                    "callbackUrl": callback_url,
                    "callbackToken": callback_token,
                    "objective": "Add the required response rule.",
                    "optimizerModel": "local-model",
                    "trainer": {
                        "epochs": 1,
                        "batchSize": 1,
                        "accumulation": 1,
                        "editBudget": 1,
                        "minEditBudget": 1,
                        "analystWorkers": 1,
                        "minibatchSize": 1,
                        "maxAnalystRounds": 1,
                        "evaluationWorkers": 1,
                    },
                    "modelBudget": {
                        "maxCostUsd": 1,
                        "maxRequests": 10,
                        "maxRequestBytes": 100_000,
                        "maxResponseBytes": 100_000,
                        "maxOutputTokensPerRequest": 256,
                        "pricing": {
                            "inputUsdPerMillion": 1,
                            "outputUsdPerMillion": 2,
                        },
                    },
                    "seedCandidate": "# Base Skill\nAnswer normally.\n",
                    "trainSet": [{"id": "train", "data": {"prompt": "Return READY."}}],
                    "selectionSet": [{"id": "selection", "data": {"prompt": "Return READY."}}],
                    "maxEvaluations": 3,
                    "hardScoreThreshold": 1,
                    "maxCandidateChars": 10_000,
                    "maxEvidenceChars": 100_000,
                    "outputDir": str(output_dir),
                }
            )
        )
        env = {
            **os.environ,
            "OPENAI_COMPATIBLE_API_KEY": "local-test-key",
            "OPENAI_COMPATIBLE_BASE_URL": base_url,
            "OPENAI_COMPATIBLE_MAX_TOKENS": "256",
            "OPENAI_COMPATIBLE_MODEL": "local-model",
            "OPTIMIZER_OPENAI_COMPATIBLE_API_KEY": "local-test-key",
            "OPTIMIZER_OPENAI_COMPATIBLE_BASE_URL": base_url,
            "OPTIMIZER_OPENAI_COMPATIBLE_MAX_TOKENS": "256",
            "OPTIMIZER_OPENAI_COMPATIBLE_MODEL": "local-model",
            "TARGET_OPENAI_COMPATIBLE_API_KEY": "local-test-key",
            "TARGET_OPENAI_COMPATIBLE_BASE_URL": base_url,
            "TARGET_OPENAI_COMPATIBLE_MAX_TOKENS": "256",
            "TARGET_OPENAI_COMPATIBLE_MODEL": "local-model",
        }
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "agent_eval_rpc.skillopt_bridge",
                "--input",
                str(input_path),
                "--output",
                str(output_path),
            ],
            check=False,
            capture_output=True,
            env=env,
            text=True,
            timeout=60,
        )
    assert completed.returncode == 0, completed.stderr
    output = json.loads(output_path.read_text())

    assert len(model_requests) == 1
    request = model_requests[0]
    assert request["path"] == "/v1/chat/completions"
    assert request["authorization"] == "Bearer local-test-key"
    assert request["body"]["model"] == "local-model"
    assert request["body"]["max_tokens"] == 256
    assert "expert failure-analysis agent" in request["body"]["messages"][0]["content"]
    assert [request["body"]["exampleId"] for request in callback_requests] == [
        "selection",
        "train",
        "selection",
    ]
    assert all(
        request["authorization"] == f"Bearer {callback_token}" for request in callback_requests
    )
    assert "ALWAYS_RETURN_READY" not in callback_requests[0]["body"]["candidate"]
    assert "ALWAYS_RETURN_READY" in callback_requests[2]["body"]["candidate"]
    assert output["bestCandidate"].endswith("ALWAYS_RETURN_READY\n")
    assert output["bestScore"] == 1.0
    assert output["totalEvaluations"] == 3
    assert output["totalSteps"] == 1
    assert output["tokenUsage"] == {
        "calls": 1,
        "inputTokens": 11,
        "outputTokens": 13,
        "totalTokens": 24,
    }
    assert output["upstream"]["package"] == "skillopt"
    run_dirs = [path for path in (output_dir / "runs").iterdir() if path.is_dir()]
    assert len(run_dirs) == 1
    work_dir = run_dirs[0] / "skillopt"
    assert "ALWAYS_RETURN_READY" in (work_dir / "best_skill.md").read_text()
    assert (work_dir / "history.json").stat().st_size > 0
    assert (work_dir / "runtime_state.json").stat().st_size > 0
