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
    assert (tmp_path / "state" / "gepa_state.bin").stat().st_size > 0
