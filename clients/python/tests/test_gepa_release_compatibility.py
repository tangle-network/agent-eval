from __future__ import annotations

import json
import os
from importlib.metadata import distribution, version
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("AGENT_EVAL_EXPECT_GEPA_RELEASE") != "1",
    reason="runs in the dedicated published-GEPA environment",
)


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
        model_proxy=None,
        proxy_usage=None,
    )

    assert config.engine.max_metric_calls == 4
    assert config.engine.max_reflection_cost is None
