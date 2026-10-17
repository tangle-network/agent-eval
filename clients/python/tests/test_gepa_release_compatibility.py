from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import distribution, version
from pathlib import Path
from typing import Any

import httpx
import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("AGENT_EVAL_EXPECT_GEPA_RELEASE") != "1",
    reason="runs in the dedicated published-GEPA environment",
)


@pytest.mark.parametrize(
    "budget,concurrency,minibatch,selection_count,components,raise_on_exception,winner",
    [
        (5, 1, 1, 1, False, True, "CANDIDATE_1"),
        (6, 1, 1, 1, False, True, "CANDIDATE_1"),
        (23, 3, 3, 2, False, True, "CANDIDATE_2"),
        (24, 3, 3, 2, False, True, "CANDIDATE_2"),
        (2, 1, 1, 1, False, True, "BASELINE"),
        (5, 1, 1, 1, True, True, "CANDIDATE_1"),
        (5, 1, 1, 1, False, False, "CANDIDATE_1"),
    ],
)
def test_bridge_returns_completed_population_at_callback_budget(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    budget: int,
    concurrency: int,
    minibatch: int,
    selection_count: int,
    components: bool,
    raise_on_exception: bool,
    winner: str,
) -> None:
    output, accepted, refused = _run_budgeted_bridge(
        monkeypatch,
        tmp_path,
        budget,
        concurrency,
        minibatch,
        selection_count,
        components=components,
        raise_on_exception=raise_on_exception,
    )
    assert output["bestCandidate"] == ({"system": winner} if components else winner)
    assert output["totalEvaluations"] == len(accepted) == budget
    assert refused
    population = json.loads(Path(output["candidatePopulation"]["path"]).read_text())
    selected = population["candidates"][population["bestIndex"]]
    assert selected["candidate"] == output["bestCandidate"]
    assert selected["aggregateScore"] == output["bestScore"]
    assert all(len(row["selectionScores"]) == selection_count for row in population["candidates"])
    assert output["upstreamReportedEvaluations"] <= len(accepted)
    if budget == 23:
        assert output["upstreamReportedEvaluations"] < len(accepted)


@pytest.mark.parametrize("refusal_status", [401, 500])
def test_bridge_does_not_recover_other_callback_failures(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    refusal_status: int,
) -> None:
    with pytest.raises(httpx.HTTPStatusError) as raised:
        _run_budgeted_bridge(monkeypatch, tmp_path, 5, 1, 1, 1, refusal_status=refusal_status)
    assert raised.value.response.status_code == refusal_status
    assert not (tmp_path / "output.json").exists()


def test_bridge_requires_completed_seed_selection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    with pytest.raises(RuntimeError, match="before a candidate completed selection"):
        _run_budgeted_bridge(monkeypatch, tmp_path, 1, 1, 1, 2)
    assert not (tmp_path / "output.json").exists()


def test_bridge_preserves_concurrent_callback_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    with pytest.raises(httpx.HTTPStatusError) as raised:
        _run_budgeted_bridge(monkeypatch, tmp_path, 9, 2, 2, 1, concurrent_failure=True)
    assert raised.value.response.status_code == 500
    assert not (tmp_path / "output.json").exists()


def _run_budgeted_bridge(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    budget: int,
    concurrency: int,
    minibatch: int,
    selection_count: int,
    *,
    components: bool = False,
    raise_on_exception: bool = True,
    refusal_status: int = 429,
    concurrent_failure: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    from gepa.core.state import GEPAState

    from agent_eval_rpc import gepa_bridge
    from test_gepa_bridge import RUNTIME_IDENTITY, _valid_input

    class Model:
        calls = 0
        total_cost = 0.0

        def __call__(self, _prompt: Any) -> str:
            self.calls += 1
            return f"```\nCANDIDATE_{self.calls}\n```"

    accepted: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    lock = threading.Lock()
    budget_refused = threading.Event()
    if concurrent_failure:
        from gepa.adapters.optimize_anything_adapter import optimize_anything_adapter as adapter

        from agent_eval_rpc.gepa_compat_0_1_4 import GepaEvaluationBudgetExhausted

        completed = adapter.as_completed

        def observe_completed(futures):
            for future in completed(futures):
                if isinstance(future.exception(), GepaEvaluationBudgetExhausted):
                    budget_refused.set()
                yield future

        monkeypatch.setattr(adapter, "as_completed", observe_completed)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with lock:
                if len(accepted) == budget:
                    refused.append(request)
                    status, body = refusal_status, {"error": "evaluation limit reached"}
                else:
                    accepted.append(request)
                    candidate = request["candidate"]
                    text = candidate["system"] if isinstance(candidate, dict) else candidate
                    score = 0.0 if text == "BASELINE" else int(text.split("_")[1]) / 10
                    status, body = 200, {"score": score, "info": {"feedback": "Improve again."}}
                    if concurrent_failure and len(accepted) == budget:
                        status, body = 500, {"error": "real concurrent evaluation failure"}
            if concurrent_failure and status == 500:
                # Emit the real error only once GEPA has chosen the budget
                # future. Its executor must still settle this request.
                assert budget_refused.wait(timeout=5)
            content = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(content)

        def log_message(self, *_args: Any) -> None:
            pass

    # The search and callback transport are real; only reflection and package
    # identity are local fixtures, with no provider calls or trusted pickle reads.
    original_config = gepa_bridge._engine_config

    def engine_config(*args: Any, **kwargs: Any) -> Any:
        config = original_config(*args, **kwargs)
        config.reflection.reflection_lm = Model()
        return config

    def reject_pickle_load(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("budget recovery must not load a pickle")

    monkeypatch.setattr(GEPAState, "load", reject_pickle_load)
    monkeypatch.setattr(gepa_bridge, "_engine_config", engine_config)
    monkeypatch.setattr(gepa_bridge, "_runtime_identity", lambda _: RUNTIME_IDENTITY)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    for name in ["ALL_PROXY", "all_proxy"]:
        monkeypatch.delenv(name, raising=False)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        value = _valid_input(tmp_path)
        value.update(
            callbackUrl=f"http://127.0.0.1:{server.server_port}/evaluate",
            seedCandidate={"system": "BASELINE"} if components else "BASELINE",
            trainSet=[{"id": f"train-{i}", "data": {}} for i in range(4)],
            selectionSet=[{"id": f"selection-{i}", "data": {}} for i in range(selection_count)],
            maxPopulationCandidates=10,
            recipe={"kind": "engine", "run": {
                "engine": "gepa", "maxEvaluations": budget, "maxConcurrency": concurrency,
                "engineConfig": {
                    "engine": {"capture_stdio": False, "parallel": concurrency > 1,
                               "raise_on_exception": raise_on_exception},
                    "reflection": {"reflection_minibatch_size": minibatch,
                                   "skip_perfect_score": False},
                },
            }},
        )
        input_path, output_path = tmp_path / "input.json", tmp_path / "output.json"
        input_path.write_text(json.dumps(value))
        monkeypatch.setattr(sys, "argv", ["gepa-bridge", "--input", str(input_path),
                                         "--output", str(output_path)])
        gepa_bridge.main()
        return json.loads(output_path.read_text()), accepted, refused
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()


def test_published_gepa_performs_nonzero_optimize_anything_work(tmp_path: Path) -> None:
    from gepa.optimize_anything import EngineConfig, GEPAConfig, ReflectionConfig, optimize_anything

    from agent_eval_rpc.gepa_api import load_gepa_api
    from agent_eval_rpc.gepa_bridge import _candidate_population_artifact

    assert version("gepa") == "0.1.4"
    direct_url = distribution("gepa").read_text("direct_url.json")
    assert direct_url is None or "vcs_info" not in json.loads(direct_url)
    assert load_gepa_api().config_shape == "launcher"

    class DeterministicModel:
        def __init__(self) -> None:
            self.calls = 0

        @property
        def total_cost(self) -> float:
            return 0.0

        def __call__(self, _prompt: object) -> str:
            self.calls += 1
            return "```\nALWAYS_RETURN_READY\n```"

    model = DeterministicModel()
    evaluations: list[tuple[str, str]] = []

    def evaluate(candidate: str, example: dict[str, str]) -> tuple[float, dict[str, str]]:
        evaluations.append((candidate, example["id"]))
        score = 1.0 if "ALWAYS_RETURN_READY" in candidate else 0.0
        return score, {"feedback": "Add ALWAYS_RETURN_READY."}

    result = optimize_anything(
        "BASELINE",
        evaluator=evaluate,
        dataset=[{"id": "train"}],
        valset=[{"id": "selection"}],
        objective="Add the required response rule.",
        config=GEPAConfig(
            engine=EngineConfig(
                capture_stdio=False,
                max_metric_calls=4,
                max_reflection_cost=1,
                max_workers=1,
                parallel=False,
                raise_on_exception=True,
                run_dir=str(tmp_path / "state"),
                seed=7,
            ),
            reflection=ReflectionConfig(
                reflection_lm=model,
                reflection_minibatch_size=1,
                skip_perfect_score=False,
            ),
        ),
    )

    assert result.best_candidate == "ALWAYS_RETURN_READY"
    assert result.val_aggregate_scores[result.best_idx] == 1.0
    assert result.total_metric_calls == 4
    assert model.calls == 1
    assert evaluations == [
        ("BASELINE", "selection"),
        ("BASELINE", "train"),
        ("ALWAYS_RETURN_READY", "train"),
        ("ALWAYS_RETURN_READY", "selection"),
    ]
    population = _candidate_population_artifact(
        result=result,
        seed_candidate="BASELINE",
        run_id="published-gepa",
        max_candidates=4,
        max_candidate_chars=100,
        selection_scenario_ids=["selection"],
    )
    assert population is not None
    assert [candidate["candidate"] for candidate in population["candidates"]] == [
        "BASELINE",
        "ALWAYS_RETURN_READY",
    ]
    assert {candidate["candidate"] for candidate in population["candidates"]} == {
        candidate for candidate, _scenario_id in evaluations
    }
    assert population["candidates"][1]["parentIndices"] == [0]
    assert population["candidates"][1]["aggregateScore"] == 1.0
    assert population["bestIndex"] == 1
    assert (tmp_path / "state" / "gepa_state.bin").stat().st_size > 0


def test_published_gepa_component_candidates_match_callback_surfaces(tmp_path: Path) -> None:
    from gepa.optimize_anything import EngineConfig, GEPAConfig, ReflectionConfig, optimize_anything

    from agent_eval_rpc.gepa_bridge import _candidate_population_artifact

    class UnusedModel:
        @property
        def total_cost(self) -> float:
            return 0.0

        def __call__(self, _prompt: object) -> str:
            raise AssertionError("the one-evaluation run must not call reflection")

    seed = {"system": "BASELINE", "tools": "none"}
    observed: list[dict[str, str]] = []

    def evaluate(
        candidate: dict[str, str], example: dict[str, str]
    ) -> tuple[float, dict[str, str]]:
        assert example["id"] == "selection"
        observed.append(candidate)
        return 0.5, {"feedback": "No change required."}

    result = optimize_anything(
        seed,
        evaluator=evaluate,
        dataset=[{"id": "train"}],
        valset=[{"id": "selection"}],
        objective="Keep both components.",
        config=GEPAConfig(
            engine=EngineConfig(
                capture_stdio=False,
                max_metric_calls=1,
                max_reflection_cost=1,
                max_workers=1,
                parallel=False,
                raise_on_exception=True,
                run_dir=str(tmp_path / "component-state"),
                seed=7,
            ),
            reflection=ReflectionConfig(
                reflection_lm=UnusedModel(),
                reflection_minibatch_size=1,
                skip_perfect_score=False,
            ),
        ),
    )
    population = _candidate_population_artifact(
        result=result,
        seed_candidate=seed,
        run_id="published-components",
        max_candidates=2,
        max_candidate_chars=1_000,
        selection_scenario_ids=["selection"],
    )

    assert population is not None
    assert observed == [seed]
    assert population["candidates"][0]["candidate"] == observed[0]


def test_published_gepa_accepts_evaluation_limit_without_guessed_usd_cap(
    tmp_path: Path,
) -> None:
    from agent_eval_rpc.gepa_api import load_gepa_api
    from agent_eval_rpc.gepa_bridge import _engine_config

    config = _engine_config(
        load_gepa_api(),
        {
            "engine": "gepa",
            "engineConfig": {},
            "maxEvaluations": 4,
        },
        tmp_path / "uncapped-cost",
        seed=7,
        model_proxy=None,
        proxy_usage=None,
    )

    assert config.engine.max_metric_calls == 4
    assert config.engine.max_reflection_cost is None
