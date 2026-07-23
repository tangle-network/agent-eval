from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx

from agent_eval_rpc import gepa_bridge


def test_bridge_calls_gepa_and_writes_a_cost_report(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "version": 2,
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
    assert calls["config"] == {
        "engine": "best_of_n",
        "max_evals": 3,
        "max_token_cost": 1.5,
        "output_dir": tmp_path / "external" / "engine",
        "engine_config": {"num_candidates": 2},
    }
    callback = calls["callback"]
    assert callback["args"] == ("http://127.0.0.1:9999/evaluate",)
    assert callback["kwargs"]["headers"] == {"Authorization": "Bearer local-token"}
    assert callback["kwargs"]["json"] == {"candidate": "better", "exampleId": "train"}
    assert json.loads(output_path.read_text()) == {
        "bestCandidate": "better",
        "bestScore": 0.75,
        "totalEvaluations": 1,
        "recipeKind": "engine",
        "proposerCostAccounting": "reported",
        "proposerCostUsd": 0.12,
    }


def test_bridge_calls_gepa_omni_recipe_without_reimplementing_its_search(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "version": 2,
                "callbackUrl": "http://127.0.0.1:9999/evaluate",
                "callbackToken": "local-token",
                "recipe": {
                    "kind": "best-of-then-continue",
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
    assert json.loads(output_path.read_text()) == {
        "bestCandidate": "continued-winner",
        "bestScore": 4.0,
        "totalEvaluations": 10,
        "recipeKind": "best-of-then-continue",
        "proposerCostAccounting": "reported",
        "proposerCostUsd": 1.0,
    }


def test_bridge_runs_source_pinned_gepa_omni_recipe_without_a_model(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "version": 2,
                "callbackUrl": "http://127.0.0.1:9/evaluate",
                "callbackToken": "unused",
                "recipe": {
                    "kind": "best-of-then-continue",
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
    assert output["recipeKind"] == "best-of-then-continue"
    assert output["totalEvaluations"] == 0


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
