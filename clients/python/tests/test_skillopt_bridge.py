from __future__ import annotations

import json
import sys
import types
from copy import deepcopy
from pathlib import Path
from typing import Any

import httpx
import pytest

from agent_eval_rpc import skillopt_bridge, skillopt_compat_v020
from agent_eval_rpc.optimizer_bridge_common import (
    atomic_write_json,
    atomic_write_text,
    locked_run,
    package_provenance,
)

UPSTREAM = {"package": "skillopt", "version": "0.2.0"}
MODEL_BUDGET = {
    "maxCostUsd": 1,
    "maxRequests": 10,
    "maxRequestBytes": 100_000,
    "maxResponseBytes": 100_000,
    "maxOutputTokensPerRequest": 1_000,
    "pricing": {
        "inputUsdPerMillion": 1,
        "outputUsdPerMillion": 2,
    },
}


def test_bridge_runs_official_trainer_contract_without_final_cases(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(
        json.dumps(
            {
                "version": 2,
                "attemptId": "attempt-one",
                "resume": "never",
                "evaluationVersion": "test-v1",
                "seed": 42,
                "callbackUrl": "http://127.0.0.1:9999/evaluate",
                "callbackToken": "local-token",
                "objective": "Improve the skill.",
                "optimizerModel": "model",
                "trainer": {
                    "epochs": 1,
                    "batchSize": 1,
                },
                "modelBudget": MODEL_BUDGET,
                "seedCandidate": "baseline",
                "trainSet": [{"id": "train", "data": {"prompt": "train prompt"}}],
                "selectionSet": [{"id": "selection", "data": {"prompt": "selection prompt"}}],
                "maxEvaluations": 3,
                "hardScoreThreshold": 1,
                "maxCandidateChars": 100,
                "maxEvidenceChars": 10_000,
                "outputDir": str(tmp_path / "external"),
            }
        )
    )
    calls: dict[str, Any] = {"candidates": []}

    class FakeEnvAdapter:
        def setup(self, cfg: dict[str, Any]) -> None:
            self._cfg = cfg

    class FakeTrainer:
        def __init__(self, cfg: dict[str, Any], adapter: Any) -> None:
            calls["config"] = cfg
            self.cfg = cfg
            self.adapter = adapter

        def train(self) -> dict[str, Any]:
            self.adapter.setup(self.cfg)
            selection = self.adapter.build_eval_env(1, "valid_seen", 42)
            self.adapter.rollout(
                selection, "baseline", str(Path(self.cfg["out_root"]) / "baseline")
            )
            train = self.adapter.build_train_env(1, 43)
            self.adapter.rollout(train, "baseline", str(Path(self.cfg["out_root"]) / "train"))
            self.adapter.rollout(selection, "better", str(Path(self.cfg["out_root"]) / "selection"))
            Path(self.cfg["out_root"], "best_skill.md").write_text("better")
            return {
                "best_selection_hard": 1.0,
                "total_steps": 1,
                "token_summary": {
                    "_total": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                        "calls": 1,
                    }
                },
            }

    skillopt_module = types.ModuleType("skillopt")
    skillopt_module.__path__ = []  # type: ignore[attr-defined]
    engine_module = types.ModuleType("skillopt.engine")
    engine_module.__path__ = []  # type: ignore[attr-defined]
    trainer_module = types.ModuleType("skillopt.engine.trainer")
    trainer_module.ReflACTTrainer = FakeTrainer
    envs_module = types.ModuleType("skillopt.envs")
    envs_module.__path__ = []  # type: ignore[attr-defined]
    base_module = types.ModuleType("skillopt.envs.base")
    base_module.EnvAdapter = FakeEnvAdapter
    monkeypatch.setitem(sys.modules, "skillopt", skillopt_module)
    monkeypatch.setitem(sys.modules, "skillopt.engine", engine_module)
    monkeypatch.setitem(sys.modules, "skillopt.engine.trainer", trainer_module)
    monkeypatch.setitem(sys.modules, "skillopt.envs", envs_module)
    monkeypatch.setitem(sys.modules, "skillopt.envs.base", base_module)
    monkeypatch.setattr(skillopt_bridge, "package_provenance", lambda package: UPSTREAM)

    def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
        candidate = kwargs["json"]["candidate"]
        calls["candidates"].append(candidate)
        score = 1.0 if candidate == "better" else 0.0
        return httpx.Response(
            200,
            json={
                "score": score,
                "info": {
                    "dimensions": {"quality": score},
                    "notes": "measured",
                    "artifact": {"answer": candidate},
                },
            },
            request=httpx.Request("POST", args[0]),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(
        sys,
        "argv",
        ["skillopt-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    skillopt_bridge.main()

    assert calls["candidates"] == ["baseline", "baseline", "better"]
    assert calls["config"]["eval_test"] is False
    assert calls["config"]["model_backend"] == "openai_compatible"
    assert calls["config"]["optimizer_backend"] == "openai_compatible"
    assert calls["config"]["target_backend"] == "openai_compatible"
    assert calls["config"]["use_gate"] is True
    assert calls["config"]["gate_metric"] == "soft"
    assert calls["config"]["slow_update_gate_with_selection"] is True
    output = json.loads(output_path.read_text())
    assert output["bestCandidate"] == "better"
    assert output["bestScore"] == 1.0
    assert output["totalEvaluations"] == 3
    assert output["totalSteps"] == 1
    assert output["tokenUsage"] == {
        "inputTokens": 10,
        "outputTokens": 5,
        "totalTokens": 15,
        "calls": 1,
    }
    assert output["upstream"] == UPSTREAM
    assert output["resumed"] is False
    assert output["runId"].endswith("-attempt-one")
    conversations = list(
        (tmp_path / "external" / "runs").glob(
            "*/skillopt/selection/predictions/*/conversation.json"
        )
    )
    assert len(conversations) == 1
    conversation = json.loads(conversations[0].read_text())
    assert conversation[-1]["role"] == "system"
    assert '"quality":1.0' in conversation[-1]["content"]


def test_pinned_skillopt_exports_official_extension_points() -> None:
    from skillopt.engine.trainer import ReflACTTrainer
    from skillopt.envs.base import EnvAdapter

    assert callable(ReflACTTrainer)
    assert isinstance(EnvAdapter, type)


def test_adapter_enforces_the_evaluation_limit_under_concurrency(
    monkeypatch,
    tmp_path: Path,
) -> None:
    from skillopt.envs.base import EnvAdapter

    input_value = _valid_input(tmp_path)
    input_value["maxEvaluations"] = 2
    input_value["trainer"]["evaluationWorkers"] = 4
    adapter = skillopt_bridge._build_adapter(EnvAdapter, input_value)
    items = skillopt_bridge._bridge_items(
        [{"id": f"case-{index}", "data": {}} for index in range(4)]
    )
    posted: list[str] = []

    def fake_post(*args: Any, **kwargs: Any) -> httpx.Response:
        posted.append(kwargs["json"]["exampleId"])
        return httpx.Response(
            200,
            json={"score": 0.5, "info": {}},
            request=httpx.Request("POST", args[0]),
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    with pytest.raises(RuntimeError, match="evaluation limit reached"):
        adapter.rollout(items, "candidate", str(tmp_path / "rollout"))

    assert len(posted) == 2
    assert adapter.evaluation_count == 4


def test_bridge_reports_resume_only_after_official_trainer_restores_state(
    monkeypatch,
    tmp_path: Path,
) -> None:
    trainer_module = __import__(
        "skillopt.engine.trainer",
        fromlist=["trainer"],
    )
    runtime_loader = trainer_module._load_runtime_state
    history_loader = trainer_module._load_history
    upstream = package_provenance("skillopt")
    assert upstream["version"] == skillopt_compat_v020.SKILLOPT_VERSION

    input_value = _valid_input(tmp_path)
    input_value["attemptId"] = "restored-attempt"
    input_value["resume"] = "if-compatible"
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(json.dumps(input_value))
    output_root = Path(input_value["outputDir"])

    with locked_run(
        label="SkillOpt",
        schema="agent-eval.skillopt-run.v1",
        material=skillopt_bridge._manifest_material(input_value, upstream),
        resume=input_value["resume"],
        attempt_id=input_value["attemptId"],
        output_root=output_root,
        resume_supported=True,
        resume_scope="SkillOpt ReflACTTrainer",
    ) as run:
        work_dir = run.run_dir / "skillopt"
        skill_path = work_dir / "skills" / "skill_v0001.md"
        best_path = work_dir / "best_skill.md"
        skill_path.parent.mkdir(parents=True)
        atomic_write_text(skill_path, "restored skill")
        atomic_write_text(best_path, "restored skill")
        atomic_write_json(
            work_dir / "history.json",
            [
                {
                    "step": 1,
                    "epoch": 1,
                    "action": "accept",
                    "current_score": 0.75,
                    "best_score": 0.75,
                    "best_step": 1,
                }
            ],
        )
        atomic_write_json(
            work_dir / "runtime_state.json",
            {
                "last_completed_step": 1,
                "current_skill_path": str(skill_path),
                "current_score": 0.75,
                "current_origin": "step_0001",
                "best_skill_path": str(best_path),
                "best_score": 0.75,
                "best_step": 1,
                "best_origin": "step_0001",
            },
        )
        expected_run_id = run.run_dir.name

    monkeypatch.setattr(
        sys,
        "argv",
        ["skillopt-bridge", "--input", str(input_path), "--output", str(output_path)],
    )

    skillopt_bridge.main()

    output = json.loads(output_path.read_text())
    assert output["runId"] == expected_run_id
    assert output["resumed"] is True
    assert output["bestCandidate"] == "restored skill"
    assert output["bestScore"] == 0.75
    assert output["totalSteps"] == 1
    assert output["totalEvaluations"] == 0
    assert trainer_module._load_runtime_state is runtime_loader
    assert trainer_module._load_history is history_loader


def test_required_resume_fails_without_official_skillopt_state(
    monkeypatch,
    tmp_path: Path,
) -> None:
    input_value = _valid_input(tmp_path)
    input_value["resume"] = "required"
    input_path = tmp_path / "input.json"
    output_path = tmp_path / "output.json"
    input_path.write_text(json.dumps(input_value))
    output_root = Path(input_value["outputDir"])
    with locked_run(
        label="SkillOpt",
        schema="agent-eval.skillopt-run.v1",
        material=skillopt_bridge._manifest_material(input_value, UPSTREAM),
        resume="if-compatible",
        attempt_id=input_value["attemptId"],
        output_root=output_root,
        resume_supported=True,
        resume_scope="SkillOpt ReflACTTrainer",
    ):
        pass

    monkeypatch.setattr(skillopt_bridge, "package_provenance", lambda package: UPSTREAM)
    monkeypatch.setattr(
        sys,
        "argv",
        ["skillopt-bridge", "--input", str(input_path), "--output", str(output_path)],
    )
    with pytest.raises(RuntimeError, match="has no restorable official trainer state"):
        skillopt_bridge.main()


def test_skillopt_history_fallback_is_observed_through_official_loaders(
    tmp_path: Path,
) -> None:
    trainer_module = __import__(
        "skillopt.engine.trainer",
        fromlist=["trainer"],
    )
    work_dir = tmp_path / "skillopt"
    skill_path = work_dir / "skills" / "skill_v0001.md"
    skill_path.parent.mkdir(parents=True)
    atomic_write_text(skill_path, "history skill")
    atomic_write_text(work_dir / "best_skill.md", "history skill")
    atomic_write_json(
        work_dir / "history.json",
        [{"step": 1, "best_score": 0.5, "best_step": 1}],
    )

    tracker = skillopt_compat_v020.load_restore_tracker(trainer_module, work_dir)
    assert tracker is not None
    assert tracker.source == "history"
    with tracker:
        trainer_module._load_history(str(work_dir))
        trainer_module._load_runtime_state(str(work_dir))
    assert tracker.restored is True


def test_invalid_skillopt_state_is_not_treated_as_restorable(tmp_path: Path) -> None:
    trainer_module = __import__(
        "skillopt.engine.trainer",
        fromlist=["trainer"],
    )
    work_dir = tmp_path / "skillopt"
    work_dir.mkdir()
    atomic_write_json(
        work_dir / "runtime_state.json",
        {"last_completed_step": 1, "current_skill_path": 42},
    )

    assert skillopt_compat_v020.load_restore_tracker(trainer_module, work_dir) is None


def test_resume_rejects_unpinned_skillopt_version(monkeypatch, tmp_path: Path) -> None:
    trainer_module = __import__(
        "skillopt.engine.trainer",
        fromlist=["trainer"],
    )
    monkeypatch.setattr(
        skillopt_compat_v020.metadata,
        "version",
        lambda package: "0.2.1",
    )

    with pytest.raises(
        RuntimeError,
        match=r"requires exactly 0\.2\.0; found 0\.2\.1",
    ):
        skillopt_compat_v020.load_restore_tracker(trainer_module, tmp_path)


def test_resume_rejects_missing_private_skillopt_function(
    monkeypatch,
    tmp_path: Path,
) -> None:
    trainer_module = types.ModuleType("skillopt.engine.trainer")
    trainer_module._load_runtime_state = lambda out_root: None
    monkeypatch.setattr(
        skillopt_compat_v020.metadata,
        "version",
        lambda package: skillopt_compat_v020.SKILLOPT_VERSION,
    )

    with pytest.raises(
        RuntimeError,
        match=r"requires skillopt\.engine\.trainer\._load_history",
    ):
        skillopt_compat_v020.load_restore_tracker(trainer_module, tmp_path)


def test_resume_identity_binds_every_behavioral_input(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["resume"] = "if-compatible"
    output_root = tmp_path / "external"

    def prepare(value: dict[str, Any]) -> tuple[Path, bool]:
        with locked_run(
            label="SkillOpt",
            schema="agent-eval.skillopt-run.v1",
            material=skillopt_bridge._manifest_material(value, UPSTREAM),
            resume=value["resume"],
            attempt_id=value["attemptId"],
            output_root=output_root,
            resume_supported=True,
            resume_scope="SkillOpt ReflACTTrainer",
        ) as run:
            return run.run_dir, run.restore_requested

    base_path, restore_requested = prepare(input_value)
    assert restore_requested is False
    repeated_path, restore_requested = prepare(input_value)
    assert repeated_path == base_path
    assert restore_requested is True

    mutations = [
        lambda value: value.__setitem__("evaluationVersion", "test-v2"),
        lambda value: value.__setitem__("objective", "Different objective."),
        lambda value: value.__setitem__("background", "Different context."),
        lambda value: value.__setitem__("seed", 7),
        lambda value: value["trainer"].__setitem__("epochs", 2),
        lambda value: value.__setitem__("seedCandidate", "different seed"),
        lambda value: value["trainSet"].append({"id": "train-2", "data": {}}),
        lambda value: value["selectionSet"].append({"id": "selection-2", "data": {}}),
        lambda value: value.__setitem__("hardScoreThreshold", 0.5),
        lambda value: value.__setitem__("maxEvaluations", 4),
        lambda value: value.__setitem__("maxCandidateChars", 101),
        lambda value: value.__setitem__("maxEvidenceChars", 10_001),
        lambda value: value["modelBudget"].__setitem__("maxRequests", 11),
    ]
    for mutate in mutations:
        changed = deepcopy(input_value)
        mutate(changed)
        changed_path, changed_restore_requested = prepare(changed)
        assert changed_path != base_path
        assert changed_restore_requested is False


def test_token_usage_rejects_missing_invalid_and_inconsistent_totals() -> None:
    assert skillopt_bridge._token_usage(None) is None
    assert skillopt_bridge._token_usage({"_total": {"prompt_tokens": 1}}) is None
    assert (
        skillopt_bridge._token_usage(
            {
                "_total": {
                    "prompt_tokens": 2,
                    "completion_tokens": 3,
                    "total_tokens": 99,
                    "calls": 1,
                }
            }
        )
        is None
    )
    assert skillopt_bridge._token_usage(
        {
            "_total": {
                "prompt_tokens": 2,
                "completion_tokens": 3,
                "total_tokens": 5,
                "calls": 1,
            }
        }
    ) == {
        "inputTokens": 2,
        "outputTokens": 3,
        "totalTokens": 5,
        "calls": 1,
    }


def test_input_rejects_target_only_execution_backends(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["trainer"]["optimizerBackend"] = "codex_exec"
    with pytest.raises(ValueError, match="fixes model backends"):
        skillopt_bridge._validate_input(input_value)


def test_input_allows_token_limits_but_rejects_credentials(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["trainer"]["overrides"] = {
        "rewrite_max_completion_tokens": 2048,
        "qwen_chat_max_tokens": 1024,
    }
    skillopt_bridge._validate_input(input_value)

    input_value["trainer"]["overrides"]["nested"] = {"accessToken": "secret"}
    with pytest.raises(ValueError, match="must be supplied through the environment"):
        skillopt_bridge._validate_input(input_value)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("learningRateSchedule", "random", "learningRateSchedule"),
        ("learningRateControl", "random", "learningRateControl"),
        ("updateMode", "random", "updateMode"),
        ("failureOnly", "yes", "failureOnly"),
        ("reasoningEffort", " ", "reasoningEffort"),
    ],
)
def test_input_rejects_invalid_trainer_controls(
    field: str,
    value: Any,
    message: str,
    tmp_path: Path,
) -> None:
    input_value = _valid_input(tmp_path)
    input_value["trainer"][field] = value
    with pytest.raises(ValueError, match=message):
        skillopt_bridge._validate_input(input_value)


def test_input_rejects_minimum_edit_budget_above_edit_budget(tmp_path: Path) -> None:
    input_value = _valid_input(tmp_path)
    input_value["trainer"].update({"editBudget": 1, "minEditBudget": 2})
    with pytest.raises(ValueError, match="minEditBudget"):
        skillopt_bridge._validate_input(input_value)


def _valid_input(tmp_path: Path) -> dict[str, Any]:
    return {
        "version": 2,
        "attemptId": "test-attempt",
        "resume": "never",
        "evaluationVersion": "test-v1",
        "seed": 42,
        "callbackUrl": "http://127.0.0.1:9999/evaluate",
        "callbackToken": "local-token",
        "objective": "Improve.",
        "background": "",
        "optimizerModel": "model",
        "trainer": {
            "epochs": 1,
            "batchSize": 1,
        },
        "modelBudget": MODEL_BUDGET,
        "seedCandidate": "baseline",
        "trainSet": [{"id": "train", "data": {}}],
        "selectionSet": [{"id": "selection", "data": {}}],
        "maxEvaluations": 3,
        "hardScoreThreshold": 1,
        "maxCandidateChars": 100,
        "maxEvidenceChars": 10_000,
        "outputDir": str(tmp_path / "external"),
    }
