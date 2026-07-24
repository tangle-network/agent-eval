from __future__ import annotations

import json
import sys
import types
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from agent_eval_rpc import gepa_bridge, gepa_bridge_contract
from agent_eval_rpc.gepa_compat_0_1_4 import (
    GEPA_REVISION,
    GEPA_VERSION,
    load_restore_observer,
)
from agent_eval_rpc.gepa_model_proxy import _ProxyUsage
from agent_eval_rpc.optimizer_bridge_common import locked_run

UPSTREAM = {
    "package": "gepa",
    "version": "test",
    "sourceUrl": "https://github.com/gepa-ai/gepa.git",
    "revision": "test-revision",
    "sourceSha256": "c" * 64,
}
COMPATIBLE_RUN_ID = "1" * 64
RUNTIME_IDENTITY = {
    "python": {
        "implementation": "cpython",
        "version": "3.12.0",
    },
    "bridge": {
        "package": "agent-eval-rpc",
        "version": "test",
        "sourceUrl": "https://github.com/tangle-network/agent-eval.git",
        "revision": "test-revision",
        "sourceSha256": "b" * 64,
    },
    "optimizer": UPSTREAM,
    "engineModules": [],
}


@pytest.fixture(autouse=True)
def deterministic_runtime_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        gepa_bridge,
        "_runtime_identity",
        lambda engine_modules: deepcopy(RUNTIME_IDENTITY),
    )


def test_upstream_evaluation_limit_reserves_concurrent_overshoot() -> None:
    assert gepa_bridge._upstream_evaluation_limit(40, 0) == 40
    assert gepa_bridge._upstream_evaluation_limit(40, 7) == 33
    with pytest.raises(ValueError, match="must exceed"):
        gepa_bridge._upstream_evaluation_limit(4, 4)


def test_bridge_calls_gepa_and_writes_a_cost_report(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "engineModules": [],
                "attemptId": "attempt-one",
                "compatibleRunId": COMPATIBLE_RUN_ID,
                "runId": f"{COMPATIBLE_RUN_ID}-attempt-one",
                "runtimeIdentity": RUNTIME_IDENTITY,
                "resume": "never",
                "trustedResumeState": False,
                "evaluationId": "test-evaluation",
                "seed": 42,
                "callbackUrl": "http://127.0.0.1:9999/evaluate",
                "callbackToken": "local-token",
                "recipe": {
                    "kind": "engine",
                    "run": {
                        "engine": "best_of_n",
                        "maxEvaluations": 3,
                        "maxProposerCostUsd": 1.5,
                        "engineConfig": {"num_candidates": 2},
                    },
                },
                "objective": "Return a better candidate.",
                "seedCandidate": "baseline",
                "trainSet": [{"id": "train", "data": {"prompt": "visible"}}],
                "selectionSet": [{"id": "selection", "data": {"prompt": "also-visible"}}],
                "maxCandidateChars": 100,
                "maxEvidenceChars": 1_000,
                "outputDir": str(tmp_path / "external"),
            }
        )
    )
    calls: dict[str, Any] = {}

    class FakeConfig:
        def __init__(self, **kwargs: Any) -> None:
            calls["config"] = kwargs
            self.kwargs = kwargs

    def fake_optimize(seed_candidate: str, **kwargs: Any) -> SimpleNamespace:
        calls["seedCandidate"] = seed_candidate
        calls["arguments"] = kwargs
        score, info = kwargs["evaluator"]("better", kwargs["dataset"][0])
        assert score == 0.75
        assert info == {"source": "agent-eval"}
        return SimpleNamespace(
            best_candidate="better",
            best_score=score,
            total_evals=1,
            metadata={"adapter_cost": 0.12},
        )

    gepa_module = types.ModuleType("gepa")
    gepa_module.__path__ = []  # type: ignore[attr-defined]
    optimize_module = types.ModuleType("gepa.optimize_anything")
    optimize_module.OptimizeAnythingConfig = FakeConfig
    optimize_module.optimize_anything = fake_optimize
    monkeypatch.setitem(sys.modules, "gepa", gepa_module)
    monkeypatch.setitem(sys.modules, "gepa.optimize_anything", optimize_module)

    def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
        calls["callback"] = {"args": args, "kwargs": kwargs}
        return httpx.Response(
            200,
            json={"score": 0.75, "info": {"source": "agent-eval"}},
            request=httpx.Request("POST", args[0]),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(
        sys,
        "argv",
        ["gepa-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    gepa_bridge.main()

    assert calls["seedCandidate"] == "baseline"
    assert calls["arguments"]["dataset"] == [{"id": "train", "data": {"prompt": "visible"}}]
    assert calls["arguments"]["valset"] == [{"id": "selection", "data": {"prompt": "also-visible"}}]
    config = calls["config"]
    output_dir = config.pop("output_dir")
    state_dir = config.pop("run_dir")
    assert config == {
        "engine": "best_of_n",
        "max_evals": 3,
        "max_concurrency": 1,
        "max_token_cost": 1.5,
        "engine_config": {"num_candidates": 2},
    }
    assert output_dir.parts[-2:] == ("engine", "evaluations")
    assert Path(state_dir).parts[-2:] == ("engine", "state")
    callback = calls["callback"]
    assert callback["args"] == ("http://127.0.0.1:9999/evaluate",)
    assert callback["kwargs"]["headers"] == {"Authorization": "Bearer local-token"}
    assert callback["kwargs"]["json"] == {"candidate": "better", "exampleId": "train"}
    output = json.loads(output_path.read_text())
    assert output.pop("runId") == f"{COMPATIBLE_RUN_ID}-attempt-one"
    assert output.pop("resumed") is False
    assert output == {
        "bestCandidate": "better",
        "bestScore": 0.75,
        "totalEvaluations": 1,
        "upstreamReportedEvaluations": 1,
        "recipeKind": "engine",
        "proposerCostAccounting": "reported",
        "proposerCostUsd": 0.12,
        "upstream": UPSTREAM,
    }
    assert json.loads((tmp_path / "external" / "upstream.json").read_text()) == UPSTREAM

    mismatched_input = json.loads(input_path.read_text())
    mismatched_input["runtimeIdentity"]["bridge"]["sourceSha256"] = "d" * 64
    input_path.write_text(json.dumps(mismatched_input))
    with pytest.raises(RuntimeError, match="runtime changed after source inspection"):
        gepa_bridge.main()


def test_bridge_calls_gepa_omni_recipe_without_reimplementing_its_search(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "engineModules": [],
                "attemptId": "attempt-two",
                "compatibleRunId": COMPATIBLE_RUN_ID,
                "runId": f"{COMPATIBLE_RUN_ID}-attempt-two",
                "runtimeIdentity": RUNTIME_IDENTITY,
                "resume": "never",
                "trustedResumeState": False,
                "evaluationId": "test-evaluation",
                "seed": 42,
                "callbackUrl": "http://127.0.0.1:9999/evaluate",
                "callbackToken": "local-token",
                "recipe": {
                    "kind": "omni",
                    "explore": [
                        _run("gepa", 2, 1.0),
                        _run("autoresearch", 3, 2.0),
                        _run("meta_harness", 4, 3.0),
                    ],
                    "continueWith": _run("gepa", 5, 4.0),
                },
                "objective": "Return a better candidate.",
                "seedCandidate": "baseline",
                "trainSet": [{"id": "train", "data": {"prompt": "visible"}}],
                "selectionSet": [{"id": "selection", "data": {"prompt": "also-visible"}}],
                "maxCandidateChars": 100,
                "maxEvidenceChars": 1_000,
                "outputDir": str(tmp_path / "external"),
            }
        )
    )
    calls: dict[str, Any] = {"configs": []}

    class FakeConfig:
        def __init__(self, **kwargs: Any) -> None:
            calls["configs"].append(kwargs)
            self.kwargs = kwargs

    def fake_best_of(seed_candidate: str, **kwargs: Any) -> SimpleNamespace:
        calls["explore"] = {"seedCandidate": seed_candidate, "arguments": kwargs}
        results = [
            SimpleNamespace(
                best_candidate=f"candidate-{index}",
                best_score=float(index),
                total_evals=index,
                metadata={"adapter_cost": index / 10},
            )
            for index in (1, 2, 3)
        ]
        return SimpleNamespace(
            best_candidate="explore-winner",
            best_score=3.0,
            total_evals=3,
            metadata={"all_results": results},
        )

    def fake_optimize(seed_candidate: str, **kwargs: Any) -> SimpleNamespace:
        calls["continue"] = {"seedCandidate": seed_candidate, "arguments": kwargs}
        return SimpleNamespace(
            best_candidate="continued-winner",
            best_score=4.0,
            total_evals=4,
            metadata={"adapter_cost": 0.4},
        )

    gepa_module = types.ModuleType("gepa")
    gepa_module.__path__ = []  # type: ignore[attr-defined]
    optimize_module = types.ModuleType("gepa.optimize_anything")
    optimize_module.OptimizeAnythingConfig = FakeConfig
    optimize_module.optimize_anything = fake_optimize
    optimize_module.optimize_best_of = fake_best_of
    optimize_module.optimize_vote = fake_best_of
    monkeypatch.setitem(sys.modules, "gepa", gepa_module)
    monkeypatch.setitem(sys.modules, "gepa.optimize_anything", optimize_module)
    monkeypatch.setattr(
        sys,
        "argv",
        ["gepa-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    gepa_bridge.main()

    assert calls["explore"]["seedCandidate"] == "baseline"
    assert calls["continue"]["seedCandidate"] == "explore-winner"
    assert [config.kwargs for config in calls["explore"]["arguments"]["configs"]] == calls[
        "configs"
    ][:3]
    assert calls["continue"]["arguments"]["dataset"] == [
        {"id": "train", "data": {"prompt": "visible"}}
    ]
    assert calls["continue"]["arguments"]["valset"] == [
        {"id": "selection", "data": {"prompt": "also-visible"}}
    ]
    assert "test_set" not in calls["explore"]["arguments"]
    output = json.loads(output_path.read_text())
    assert output.pop("runId") == f"{COMPATIBLE_RUN_ID}-attempt-two"
    assert output.pop("resumed") is False
    assert output == {
        "bestCandidate": "continued-winner",
        "bestScore": 4.0,
        "totalEvaluations": 0,
        "upstreamReportedEvaluations": 10,
        "recipeKind": "omni",
        "proposerCostAccounting": "reported",
        "proposerCostUsd": 1.0,
        "upstream": UPSTREAM,
    }


def test_bridge_runs_source_pinned_gepa_omni_recipe_without_a_model(
    monkeypatch,
    tmp_path: Path,
) -> None:
    from gepa.optimize_anything import OptimizeAnythingConfig

    assert OptimizeAnythingConfig is not None
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "engineModules": [],
                "attemptId": "attempt-three",
                "compatibleRunId": COMPATIBLE_RUN_ID,
                "runId": f"{COMPATIBLE_RUN_ID}-attempt-three",
                "runtimeIdentity": RUNTIME_IDENTITY,
                "resume": "if-compatible",
                "trustedResumeState": True,
                "evaluationId": "test-evaluation",
                "seed": 42,
                "callbackUrl": "http://127.0.0.1:9/evaluate",
                "callbackToken": "unused",
                "recipe": {
                    "kind": "omni",
                    "explore": [
                        _run("best_of_n", 1, 1.0, {"max_n": 0}),
                        _run("best_of_n", 1, 1.0, {"max_n": 0}),
                    ],
                    "continueWith": _run("best_of_n", 1, 1.0, {"max_n": 0}),
                },
                "objective": "Return the seed candidate.",
                "seedCandidate": "baseline",
                "trainSet": [{"id": "train", "data": {}}],
                "selectionSet": [{"id": "selection", "data": {}}],
                "maxCandidateChars": 100,
                "maxEvidenceChars": 1_000,
                "outputDir": str(tmp_path / "external"),
            }
        )
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["gepa-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    gepa_bridge.main()

    output = json.loads(output_path.read_text())
    assert output["bestCandidate"] == "baseline"
    assert output["recipeKind"] == "omni"
    assert output["totalEvaluations"] == 0
    assert output["resumed"] is False

    input_value = json.loads(input_path.read_text())
    input_value["attemptId"] = "attempt-four"
    input_value["runId"] = f"{COMPATIBLE_RUN_ID}-attempt-four"
    input_path.write_text(json.dumps(input_value))
    second_output_path = tmp_path / "output-fresh.json"
    monkeypatch.setattr(
        sys,
        "argv",
        ["gepa-bridge", "--input", str(input_path), "--output", str(second_output_path)],
    )
    gepa_bridge.main()

    fresh_output = json.loads(second_output_path.read_text())
    assert fresh_output["runId"] != output["runId"]
    assert fresh_output["resumed"] is False
    assert fresh_output["bestCandidate"] == "baseline"


def test_bridge_dispatches_best_of_and_vote_to_distinct_official_functions(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []

    def result(label: str) -> SimpleNamespace:
        child = SimpleNamespace(
            best_candidate=label,
            best_score=1.0,
            total_evals=1,
            metadata={"adapter_cost": 0.1},
        )
        return SimpleNamespace(
            best_candidate=label,
            best_score=1.0,
            total_evals=1,
            metadata={"all_results": [child]},
        )

    def best_of(*args: Any, **kwargs: Any) -> SimpleNamespace:
        calls.append("best-of")
        return result("best")

    def vote(*args: Any, **kwargs: Any) -> SimpleNamespace:
        calls.append("vote")
        return result("voted")

    gepa_module = types.ModuleType("gepa")
    gepa_module.__path__ = []  # type: ignore[attr-defined]
    optimize_module = types.ModuleType("gepa.optimize_anything")
    optimize_module.optimize_best_of = best_of
    optimize_module.optimize_vote = vote
    monkeypatch.setitem(sys.modules, "gepa", gepa_module)
    monkeypatch.setitem(sys.modules, "gepa.optimize_anything", optimize_module)

    common = {
        "seed_candidate": "baseline",
        "evaluator": lambda *_args: (0.0, {}),
        "train_set": [],
        "selection_set": [],
        "objective": "Improve.",
        "background": "",
        "output_dir": tmp_path,
        "config_class": lambda **kwargs: SimpleNamespace(**kwargs),
        "optimize_anything_fn": lambda *_args, **_kwargs: result("unexpected"),
        "model_proxy": None,
        "proxy_usage": None,
    }
    best, _ = gepa_bridge._run_recipe(
        recipe={
            "kind": "best-of",
            "runs": [_run("best_of_n", 1, 1.0), _run("best_of_n", 1, 1.0)],
        },
        **common,
    )
    voted, _ = gepa_bridge._run_recipe(
        recipe={
            "kind": "vote",
            "runs": [_run("best_of_n", 1, 1.0), _run("best_of_n", 1, 1.0)],
        },
        **common,
    )

    assert calls == ["best-of", "vote"]
    assert best.best_candidate == "best"
    assert voted.best_candidate == "voted"


def test_bridge_uses_the_global_stage_winner_and_adaptive_cumulative_cost() -> None:
    result = SimpleNamespace(
        best_candidate="last-stage",
        best_score=0.2,
        total_evals=8,
        metadata={
            "best_stage_candidate": "global-winner",
            "best_stage_score": 0.9,
            "adapter_cost": 1.25,
            "all_results": [
                SimpleNamespace(metadata={"adapter_cost": 0.5}),
                SimpleNamespace(metadata={"adapter_cost": 0.75}),
            ],
        },
    )

    assert gepa_bridge._selected_candidate(result, "adaptive-sequential") == "global-winner"
    assert gepa_bridge._selected_score(result, "adaptive-sequential") == 0.9
    assert gepa_bridge._reported_proposer_cost([result]) == 1.25


def test_component_candidates_require_gepa_engines_and_preserve_surface_shape(
    tmp_path: Path,
) -> None:
    input_value = _valid_input(tmp_path)
    input_value["seedCandidate"] = {"system": "baseline", "tools": "baseline"}
    input_value["recipe"] = {
        "kind": "engine",
        "run": _run("best_of_n", 1, 1.0),
    }
    with pytest.raises(ValueError, match="component candidates require the 'gepa' engine"):
        gepa_bridge._validate_input(input_value)

    input_value["recipe"]["run"]["engine"] = "gepa"
    gepa_bridge._validate_input(input_value)
    gepa_bridge._validate_selected_candidate(
        {"system": "better", "tools": "better"},
        input_value["seedCandidate"],
        100,
    )
    with pytest.raises(RuntimeError, match="changed the candidate surface shape"):
        gepa_bridge._validate_selected_candidate("flattened", input_value["seedCandidate"], 100)


def test_input_requires_evaluation_identity(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    del input_value["evaluationId"]

    with pytest.raises(ValueError, match="evaluationId"):
        gepa_bridge._validate_input(input_value)


def test_proxied_gepa_accepts_official_retry_configuration(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["recipe"] = {
        "kind": "engine",
        "run": _run(
            "gepa",
            1,
            1.0,
            {
                "reflection": {
                    "reflection_lm_kwargs": {
                        "num_retries": 3,
                        "drop_params": True,
                    }
                }
            },
        ),
    }
    input_value["modelProxy"] = {
        "baseUrl": "http://127.0.0.1:1234/v1",
        "apiKey": "local-token",
        "model": "test-model",
        "budget": {
            "maxCostUsd": 1,
            "maxRequests": 10,
            "maxRequestBytes": 100_000,
            "maxResponseBytes": 100_000,
            "maxOutputTokensPerRequest": 100,
            "requestTimeoutMs": 1_000,
            "pricing": {
                "inputUsdPerMillion": 1,
                "outputUsdPerMillion": 2,
            },
        },
    }

    gepa_bridge._validate_input(input_value)
    input_value["engineModules"] = ["example_engines.register"]
    with pytest.raises(
        ValueError,
        match="modelProxy cannot be combined with engineModules",
    ):
        gepa_bridge._validate_input(input_value)


def test_engine_modules_are_validated_and_imported(monkeypatch, tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["engineModules"] = ["example_engines.register"]
    gepa_bridge._validate_input(input_value)

    imported: list[str] = []
    monkeypatch.setattr(
        gepa_bridge_contract.importlib,
        "import_module",
        lambda module: imported.append(module),
    )
    gepa_bridge._import_engine_modules(input_value["engineModules"])
    assert imported == ["example_engines.register"]

    for modules in [
        ["example_engines.register", "example_engines.register"],
        ["_private"],
        ["example-engines"],
    ]:
        input_value["engineModules"] = modules
        with pytest.raises(ValueError, match="engineModules"):
            gepa_bridge._validate_input(input_value)


def test_proxied_gepa_rejects_proxy_transport_overrides(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["recipe"] = {
        "kind": "engine",
        "run": _run(
            "gepa",
            1,
            1.0,
            {"reflection": {"reflection_lm_kwargs": {"api_base": "https://example.com"}}},
        ),
    }
    input_value["modelProxy"] = {
        "baseUrl": "http://127.0.0.1:1234/v1",
        "apiKey": "local-token",
        "model": "test-model",
        "budget": {
            "maxCostUsd": 1,
            "maxRequests": 10,
            "maxRequestBytes": 100_000,
            "maxResponseBytes": 100_000,
            "maxOutputTokensPerRequest": 100,
            "requestTimeoutMs": 1_000,
            "pricing": {
                "inputUsdPerMillion": 1,
                "outputUsdPerMillion": 2,
            },
        },
    }

    with pytest.raises(ValueError, match="transport settings belong in modelProxy"):
        gepa_bridge._validate_input(input_value)


def test_proxied_gepa_identity_excludes_local_credentials(
    tmp_path: Path,
) -> None:
    input_value = _valid_input(tmp_path)
    input_value["recipe"] = {
        "kind": "engine",
        "run": _run("gepa", 1, 1.0),
    }
    input_value["modelProxy"] = {
        "baseUrl": "http://127.0.0.1:1234/v1",
        "apiKey": "ephemeral-local-token",
        "model": "test-model",
        "budget": {
            "maxCostUsd": 1,
            "maxRequests": 10,
            "maxRequestBytes": 100_000,
            "maxResponseBytes": 100_000,
            "maxOutputTokensPerRequest": 100,
            "pricing": {
                "inputUsdPerMillion": 1,
                "outputUsdPerMillion": 2,
            },
        },
    }

    gepa_bridge._validate_input(input_value)
    assert input_value["runtimeIdentity"] == RUNTIME_IDENTITY
    assert "ephemeral-local-token" not in json.dumps(input_value["runtimeIdentity"])

    changed = deepcopy(input_value)
    changed["modelProxy"]["budget"]["maxRequests"] = 11
    changed["compatibleRunId"] = "2" * 64
    changed["runId"] = f"{changed['compatibleRunId']}-{changed['attemptId']}"
    assert changed["compatibleRunId"] != input_value["compatibleRunId"]


def test_resume_support_is_limited_to_one_core_gepa_engine() -> None:
    assert gepa_bridge._supports_resume({"kind": "engine", "run": _run("gepa", 1, 1.0)})
    unsupported = [
        {"kind": "engine", "run": _run("best_of_n", 1, 1.0)},
        {"kind": "engine", "run": _run("autoresearch", 1, 1.0)},
        {"kind": "engine", "run": _run("meta_harness", 1, 1.0)},
        {"kind": "sequential", "runs": [_run("gepa", 1, 1.0)]},
        {
            "kind": "best-of",
            "runs": [_run("gepa", 1, 1.0), _run("gepa", 1, 1.0)],
        },
        {
            "kind": "omni",
            "explore": [_run("gepa", 1, 1.0), _run("gepa", 1, 1.0)],
            "continueWith": _run("gepa", 1, 1.0),
        },
    ]
    assert all(not gepa_bridge._supports_resume(recipe) for recipe in unsupported)


def test_gepa_pickle_resume_requires_explicit_trust(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    state_path = run_dir / "engine" / "state" / "gepa_state.bin"
    state_path.parent.mkdir(parents=True)
    state_path.write_bytes(b"must not be deserialized")

    with pytest.raises(RuntimeError, match="uses Python pickle"):
        load_restore_observer(
            run_dir,
            {"version": GEPA_VERSION, "revision": GEPA_REVISION},
            trusted=False,
        )


def test_gepa_pickle_resume_rejects_shared_writable_state(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    state_path = run_dir / "engine" / "state" / "gepa_state.bin"
    state_path.parent.mkdir(parents=True)
    state_path.write_bytes(b"must not be deserialized")
    state_path.chmod(0o666)

    with pytest.raises(RuntimeError, match="writable by another user"):
        load_restore_observer(
            run_dir,
            {"version": GEPA_VERSION, "revision": GEPA_REVISION},
            trusted=True,
        )


def test_gepa_proxy_counts_failed_attempt_before_success_separately() -> None:
    usage = _ProxyUsage()
    request = httpx.Request("POST", "http://127.0.0.1/v1/chat/completions")
    usage.observe_request(request)
    usage.observe_response(httpx.Response(503, request=request))
    usage.observe_request(request)
    usage.observe_response(httpx.Response(200, request=request))
    usage.models.append(SimpleNamespace(total_tokens_in=11, total_tokens_out=7, total_cost=0.01))

    assert usage.snapshot() == {
        "inputTokens": 11,
        "outputTokens": 7,
        "totalTokens": 18,
        "calls": 1,
        "requestAttempts": 2,
        "costUsd": 0.01,
    }


def test_required_resume_fails_for_an_unsupported_gepa_engine(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["resume"] = "required"
    with pytest.raises(RuntimeError, match="official upstream state restoration is not available"):
        with locked_run(
            label="GEPA",
            compatible_run_id=input_value["compatibleRunId"],
            run_id=input_value["runId"],
            runtime_identity=input_value["runtimeIdentity"],
            resume=input_value["resume"],
            attempt_id=input_value["attemptId"],
            output_root=Path(input_value["outputDir"]),
            resume_supported=gepa_bridge._supports_resume(input_value["recipe"]),
            resume_scope=gepa_bridge._resume_scope(input_value["recipe"]),
        ):
            pass


def test_if_compatible_gepa_archives_unrestorable_state_and_starts_fresh(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_value = _valid_input(tmp_path)
    input_value["attemptId"] = "fresh-attempt"
    input_value["resume"] = "if-compatible"
    input_value["trustedResumeState"] = True
    input_value["runId"] = input_value["compatibleRunId"]
    input_value["runtimeIdentity"]["optimizer"]["version"] = GEPA_VERSION
    input_value["runtimeIdentity"]["optimizer"]["revision"] = GEPA_REVISION
    monkeypatch.setattr(
        gepa_bridge,
        "_runtime_identity",
        lambda _engine_modules: deepcopy(input_value["runtimeIdentity"]),
    )
    input_value["recipe"] = {
        "kind": "engine",
        "run": _run(
            "gepa",
            1,
            1.0,
            {"engine": {"frontier_type": "instance"}},
        ),
    }
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(json.dumps(input_value))
    output_root = Path(input_value["outputDir"])

    with locked_run(
        label="GEPA",
        compatible_run_id=input_value["compatibleRunId"],
        run_id=input_value["runId"],
        runtime_identity=input_value["runtimeIdentity"],
        resume=input_value["resume"],
        attempt_id=input_value["attemptId"],
        output_root=output_root,
        resume_supported=True,
        resume_scope="engine 'gepa'",
    ) as run:
        corrupt_path = run.run_dir / "engine" / "state" / "gepa_state.bin"
        corrupt_path.parent.mkdir(parents=True)
        corrupt_path.write_bytes(b"not a GEPA state")
        for private_path in [run.run_dir, run.run_dir / "engine", corrupt_path.parent]:
            private_path.chmod(0o700)
        corrupt_path.chmod(0o600)
        expected_run_dir = run.run_dir

    def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
        return httpx.Response(
            200,
            json={"score": 0.25, "info": {}},
            request=httpx.Request("POST", args[0]),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(
        sys,
        "argv",
        ["gepa-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    gepa_bridge.main()

    output = json.loads(output_path.read_text())
    assert output["resumed"] is False
    assert output["bestCandidate"] == "baseline"
    archived = list(expected_run_dir.glob("engine.unrestorable-*"))
    assert len(archived) == 1
    assert (archived[0] / "state" / "gepa_state.bin").read_bytes() == b"not a GEPA state"


def test_resume_uses_explicit_identity_for_every_behavioral_change(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["recipe"]["run"]["engine"] = "gepa"
    input_value["resume"] = "if-compatible"
    input_value["runId"] = input_value["compatibleRunId"]
    output_root = tmp_path / "external"

    def prepare(value: dict[str, Any]) -> tuple[Path, bool]:
        with locked_run(
            label="GEPA",
            compatible_run_id=value["compatibleRunId"],
            run_id=value["runId"],
            runtime_identity=value["runtimeIdentity"],
            resume=value["resume"],
            attempt_id=value["attemptId"],
            output_root=output_root,
            resume_supported=gepa_bridge._supports_resume(value["recipe"]),
            resume_scope=gepa_bridge._resume_scope(value["recipe"]),
        ) as run:
            return run.run_dir, run.restore_requested

    base_path, restore_requested = prepare(input_value)
    assert restore_requested is False
    repeated_path, restore_requested = prepare(input_value)
    assert repeated_path == base_path
    assert restore_requested is True

    mutations = [
        lambda value: value.__setitem__("evaluationId", "changed-evaluation"),
        lambda value: value.__setitem__("seed", 7),
        lambda value: value["recipe"]["run"].__setitem__("maxEvaluations", 2),
        lambda value: value.__setitem__("objective", "A different objective."),
        lambda value: value.__setitem__("background", "Different context."),
        lambda value: value.__setitem__("seedCandidate", "different seed"),
        lambda value: value["trainSet"].append({"id": "train-2", "data": {}}),
        lambda value: value["selectionSet"].append({"id": "selection-2", "data": {}}),
        lambda value: value.__setitem__("maxCandidateChars", 101),
        lambda value: value.__setitem__("maxEvidenceChars", 1_001),
    ]
    for index, mutate in enumerate(mutations, start=2):
        changed = deepcopy(input_value)
        mutate(changed)
        changed["compatibleRunId"] = f"{index:064x}"
        changed["runId"] = changed["compatibleRunId"]
        changed_path, changed_restore_requested = prepare(changed)
        assert changed_path != base_path
        assert changed_restore_requested is False

    changed_runtime = deepcopy(input_value)
    changed_runtime["runtimeIdentity"]["optimizer"]["revision"] = "different-revision"
    changed_runtime["compatibleRunId"] = "e" * 64
    changed_runtime["runId"] = changed_runtime["compatibleRunId"]
    changed_path, changed_restore_requested = prepare(changed_runtime)
    assert changed_path != base_path
    assert changed_restore_requested is False

    required = deepcopy(input_value)
    required["resume"] = "required"
    required["objective"] = "Missing compatible run."
    required["compatibleRunId"] = "f" * 64
    required["runId"] = required["compatibleRunId"]
    with pytest.raises(RuntimeError, match="compatible run .* does not exist"):
        prepare(required)


def test_locked_run_rejects_a_mismatched_run_id(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    with pytest.raises(RuntimeError, match="run ID does not match"):
        with locked_run(
            label="GEPA",
            compatible_run_id=input_value["compatibleRunId"],
            run_id="mismatched-run-id",
            runtime_identity=input_value["runtimeIdentity"],
            resume=input_value["resume"],
            attempt_id=input_value["attemptId"],
            output_root=Path(input_value["outputDir"]),
            resume_supported=gepa_bridge._supports_resume(input_value["recipe"]),
            resume_scope=gepa_bridge._resume_scope(input_value["recipe"]),
        ):
            pass


def _run(
    engine: str,
    max_evaluations: int,
    max_proposer_cost_usd: float,
    engine_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "engine": engine,
        "maxEvaluations": max_evaluations,
        "maxProposerCostUsd": max_proposer_cost_usd,
        "engineConfig": engine_config or {},
    }


def _valid_input(tmp_path: Path) -> dict[str, Any]:
    return {
        "engineModules": [],
        "attemptId": "test-attempt",
        "compatibleRunId": COMPATIBLE_RUN_ID,
        "runId": f"{COMPATIBLE_RUN_ID}-test-attempt",
        "runtimeIdentity": RUNTIME_IDENTITY,
        "resume": "never",
        "trustedResumeState": False,
        "evaluationId": "test-evaluation",
        "seed": 42,
        "callbackUrl": "http://127.0.0.1:9999/evaluate",
        "callbackToken": "local-token",
        "recipe": {
            "kind": "engine",
            "run": _run("best_of_n", 1, 1.0),
        },
        "objective": "Improve.",
        "background": "",
        "seedCandidate": "baseline",
        "trainSet": [{"id": "train", "data": {}}],
        "selectionSet": [{"id": "selection", "data": {}}],
        "maxCandidateChars": 100,
        "maxEvidenceChars": 1_000,
        "outputDir": str(tmp_path / "external"),
    }
