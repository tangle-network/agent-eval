"""Run Microsoft SkillOpt against an agent-eval callback."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import random
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx

from agent_eval_rpc.optimizer_bridge_common import (
    archive_unrestorable_state,
    atomic_write_json,
    atomic_write_text,
    locked_run,
    package_provenance,
    validate_json_size,
    validate_no_secrets,
    validate_optimizer_model_budget,
)
from agent_eval_rpc.skillopt_compat_v020 import load_restore_tracker


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    input_value = _read_json(Path(args.input))
    _validate_input(input_value)
    try:
        trainer_module = importlib.import_module("skillopt.engine.trainer")
        from skillopt.envs.base import EnvAdapter
    except ImportError as error:
        raise RuntimeError(
            "SkillOpt bridge requires the source revision documented in the agent-eval-rpc README."
        ) from error
    ReflACTTrainer = trainer_module.ReflACTTrainer

    output_root = Path(input_value["outputDir"])
    output_root.mkdir(parents=True, exist_ok=True)
    upstream = package_provenance("skillopt")
    with locked_run(
        label="SkillOpt",
        schema="agent-eval.skillopt-run.v1",
        material=_manifest_material(input_value, upstream),
        resume=input_value["resume"],
        attempt_id=input_value["attemptId"],
        output_root=output_root,
        resume_supported=True,
        resume_scope="SkillOpt ReflACTTrainer",
    ) as run:
        work_dir = run.run_dir / "skillopt"
        restore_tracker = None
        if run.restore_requested:
            restore_tracker = load_restore_tracker(trainer_module, work_dir)
            if restore_tracker is None:
                if input_value["resume"] == "required":
                    raise RuntimeError(
                        f"SkillOpt compatible run '{run.run_dir.name}' has no restorable "
                        "official trainer state"
                    )
                archive_unrestorable_state(work_dir, input_value["attemptId"])

        work_dir.mkdir(parents=True, exist_ok=True)
        seed_path = run.run_dir / "initial-skill.md"
        atomic_write_text(seed_path, input_value["seedCandidate"])
        adapter = _build_adapter(EnvAdapter, input_value)
        config = _trainer_config(input_value, work_dir, seed_path)
        if restore_tracker is None:
            summary = ReflACTTrainer(config, adapter).train()
            resumed = False
        else:
            with restore_tracker:
                summary = ReflACTTrainer(config, adapter).train()
            if not restore_tracker.restored:
                raise RuntimeError(
                    "SkillOpt did not restore the compatible official state during training"
                )
            resumed = True

        best_path = work_dir / "best_skill.md"
        if not best_path.exists():
            raise RuntimeError("SkillOpt did not produce best_skill.md")
        candidate = best_path.read_text()
        if not candidate.strip() or len(candidate) > input_value["maxCandidateChars"]:
            raise RuntimeError("SkillOpt produced an invalid candidate")
        best_score = summary.get("best_selection_hard")
        if (
            isinstance(best_score, bool)
            or not isinstance(best_score, (float, int))
            or not math.isfinite(best_score)
            or not 0 <= best_score <= 1
        ):
            raise RuntimeError("SkillOpt produced an invalid selection score")
        total_steps = summary.get("total_steps", 0)
        if isinstance(total_steps, bool) or not isinstance(total_steps, int) or total_steps < 0:
            raise RuntimeError("SkillOpt produced an invalid step count")
        run_id = run.run_dir.name

    atomic_write_json(output_root / "upstream.json", upstream)
    output = {
        "bestCandidate": candidate,
        "bestScore": float(best_score),
        "totalEvaluations": adapter.evaluation_count,
        "totalSteps": total_steps,
        "upstream": upstream,
        "runId": run_id,
        "resumed": resumed,
    }
    token_usage = _token_usage(summary.get("token_summary"))
    if token_usage is not None:
        output["tokenUsage"] = token_usage
    atomic_write_json(Path(args.output), output)


def _build_adapter(env_adapter_class: type, input_value: dict[str, Any]) -> Any:
    class TangleEnvAdapter(env_adapter_class):
        def __init__(self) -> None:
            trainer = input_value["trainer"]
            self.train_items = _bridge_items(input_value["trainSet"])
            self.selection_items = _bridge_items(input_value["selectionSet"])
            self.analyst_workers = trainer.get("analystWorkers", 4)
            self.failure_only = trainer.get("failureOnly", False)
            self.minibatch_size = trainer.get("minibatchSize", min(trainer["batchSize"], 8))
            self.edit_budget = trainer.get("editBudget", 4)
            self.evaluation_workers = trainer.get("evaluationWorkers", 1)
            self.evaluation_count = 0
            self._count_lock = threading.Lock()

        def build_train_env(self, batch_size: int, seed: int, **kwargs: Any) -> list[dict]:
            del kwargs
            rng = random.Random(seed)
            shuffled = list(self.train_items)
            rng.shuffle(shuffled)
            return [shuffled[index % len(shuffled)] for index in range(batch_size)]

        def build_eval_env(self, env_num: int, split: str, seed: int, **kwargs: Any) -> list[dict]:
            del split, seed, kwargs
            if env_num <= 0 or env_num >= len(self.selection_items):
                return list(self.selection_items)
            return list(self.selection_items[:env_num])

        def rollout(
            self,
            env_manager: list[dict],
            skill_content: str,
            out_dir: str,
            **kwargs: Any,
        ) -> list[dict]:
            del kwargs
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            if self.evaluation_workers == 1:
                return [self._evaluate(item, skill_content, Path(out_dir)) for item in env_manager]
            with ThreadPoolExecutor(max_workers=self.evaluation_workers) as pool:
                return list(
                    pool.map(
                        lambda item: self._evaluate(item, skill_content, Path(out_dir)),
                        env_manager,
                    )
                )

        def _evaluate(
            self, item: dict[str, Any], skill_content: str, out_dir: Path
        ) -> dict[str, Any]:
            with self._count_lock:
                self.evaluation_count += 1
                count = self.evaluation_count
            if count > input_value["maxEvaluations"]:
                raise RuntimeError("SkillOpt evaluation limit reached")
            response = httpx.post(
                input_value["callbackUrl"],
                headers={"Authorization": f"Bearer {input_value['callbackToken']}"},
                json={
                    "candidate": skill_content,
                    "exampleId": item["callbackId"],
                },
                timeout=300.0,
            )
            response.raise_for_status()
            payload = response.json()
            score = payload.get("score")
            if (
                isinstance(score, bool)
                or not isinstance(score, (float, int))
                or not math.isfinite(score)
                or not 0 <= score <= 1
            ):
                raise ValueError("agent-eval callback score must be in [0, 1]")
            info = payload.get("info")
            if not isinstance(info, dict):
                info = {}
            task = {
                "objective": input_value["objective"],
                "background": input_value.get("background", ""),
                "case": item["data"],
            }
            evidence = {
                "scenario": task,
                "score": float(score),
                "dimensions": info.get("dimensions", {}),
                "notes": info.get("notes", ""),
                "artifact": info.get("artifact"),
            }
            encoded_evidence = json.dumps(
                evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
            if len(encoded_evidence) > input_value["maxEvidenceChars"]:
                raise ValueError("SkillOpt evaluation evidence exceeds maxEvidenceChars")
            prediction_dir = out_dir / "predictions" / item["id"]
            prediction_dir.mkdir(parents=True, exist_ok=True)
            conversation = [
                {
                    "role": "user",
                    "content": json.dumps(task, ensure_ascii=False, sort_keys=True),
                },
                {
                    "role": "assistant",
                    "content": json.dumps(
                        info.get("artifact", "agent-eval execution completed"),
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                },
                {
                    "role": "system",
                    "content": encoded_evidence,
                },
            ]
            atomic_write_json(prediction_dir / "conversation.json", conversation)
            task_description = json.dumps(task, ensure_ascii=False, sort_keys=True)
            threshold = input_value["hardScoreThreshold"]
            notes = str(info.get("notes") or "")
            return {
                "id": item["id"],
                "hard": 1 if score >= threshold else 0,
                "soft": float(score),
                "scenario_id": item["callbackId"],
                "task_description": task_description,
                "task_type": "tangle",
                "fail_reason": notes if score < threshold else "",
                "target_user_prompt": task_description,
                "n_turns": len(conversation),
            }

        def get_task_types(self) -> list[str]:
            return ["tangle"]

    return TangleEnvAdapter()


def _bridge_items(examples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": hashlib.sha256(example["id"].encode()).hexdigest(),
            "callbackId": example["id"],
            "data": example["data"],
        }
        for example in examples
    ]


def _trainer_config(
    input_value: dict[str, Any],
    run_dir: Path,
    seed_path: Path,
) -> dict[str, Any]:
    trainer = input_value["trainer"]
    config = dict(trainer.get("overrides", {}))
    edit_budget = trainer.get("editBudget", 4)
    optimizer_model = input_value["optimizerModel"]
    config.update(
        {
            "model_backend": "openai_compatible",
            "optimizer_backend": "openai_compatible",
            "target_backend": "openai_compatible",
            "optimizer_model": optimizer_model,
            "target_model": optimizer_model,
            "reasoning_effort": trainer.get("reasoningEffort", "medium"),
            "out_root": str(run_dir),
            "skill_init": str(seed_path),
            "num_epochs": trainer["epochs"],
            "train_size": len(input_value["trainSet"]),
            "batch_size": trainer["batchSize"],
            "accumulation": trainer.get("accumulation", 1),
            "seed": input_value["seed"],
            "merge_batch_size": trainer.get("mergeBatchSize", 8),
            "max_analyst_rounds": trainer.get("maxAnalystRounds", 3),
            "edit_budget": edit_budget,
            "min_edit_budget": trainer.get("minEditBudget", min(edit_budget, 2)),
            "lr_scheduler": trainer.get("learningRateSchedule", "constant"),
            "lr_control_mode": trainer.get("learningRateControl", "fixed"),
            "skill_update_mode": trainer.get("updateMode", "patch"),
            "use_slow_update": trainer.get("useSlowUpdate", False),
            "slow_update_gate_with_selection": True,
            "use_meta_skill": trainer.get("useMetaSkill", False),
            "analyst_workers": trainer.get("analystWorkers", 4),
            "sel_env_num": len(input_value["selectionSet"]),
            "test_env_num": 0,
            "eval_test": False,
            "use_gate": True,
            "gate_metric": "soft",
            "use_semantic_density": False,
        }
    )
    return config


def _manifest_material(input_value: dict[str, Any], upstream: dict[str, str]) -> dict[str, Any]:
    return {
        "upstream": upstream,
        "evaluationVersion": input_value["evaluationVersion"],
        "objective": input_value["objective"],
        "background": input_value.get("background", ""),
        "seed": input_value["seed"],
        "trainer": input_value["trainer"],
        "optimizerModel": input_value["optimizerModel"],
        "modelBudget": input_value["modelBudget"],
        "seedCandidate": input_value["seedCandidate"],
        "trainSet": input_value["trainSet"],
        "selectionSet": input_value["selectionSet"],
        "hardScoreThreshold": input_value["hardScoreThreshold"],
        "maxEvaluations": input_value["maxEvaluations"],
        "maxCandidateChars": input_value["maxCandidateChars"],
        "maxEvidenceChars": input_value["maxEvidenceChars"],
    }


def _token_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    total = value.get("_total")
    if not isinstance(total, dict):
        return None
    fields = {
        "inputTokens": total.get("prompt_tokens"),
        "outputTokens": total.get("completion_tokens"),
        "totalTokens": total.get("total_tokens"),
        "calls": total.get("calls"),
    }
    if any(
        isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in fields.values()
    ):
        return None
    if fields["totalTokens"] != fields["inputTokens"] + fields["outputTokens"]:
        return None
    return fields


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError("SkillOpt bridge input must be a JSON object")
    return payload


def _validate_input(value: dict[str, Any]) -> None:
    if value.get("version") != 2:
        raise ValueError("SkillOpt bridge input requires version 2")
    for key in [
        "callbackUrl",
        "callbackToken",
        "objective",
        "evaluationVersion",
        "attemptId",
        "optimizerModel",
        "seedCandidate",
        "outputDir",
    ]:
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise ValueError(f"SkillOpt bridge input requires non-empty string {key}")
    if value.get("resume") not in {"never", "if-compatible", "required"}:
        raise ValueError("SkillOpt bridge input resume must be never, if-compatible, or required")
    seed = value.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("SkillOpt bridge input seed must be an integer")
    for key in ["maxEvaluations", "maxCandidateChars", "maxEvidenceChars"]:
        _positive_int(value.get(key), key)
    validate_optimizer_model_budget(
        value.get("modelBudget"),
        "SkillOpt bridge modelBudget",
    )
    threshold = value.get("hardScoreThreshold")
    if (
        isinstance(threshold, bool)
        or not isinstance(threshold, (float, int))
        or not math.isfinite(threshold)
        or not 0 <= threshold <= 1
    ):
        raise ValueError("SkillOpt bridge hardScoreThreshold must be in [0, 1]")
    train_set = value.get("trainSet")
    selection_set = value.get("selectionSet")
    if not isinstance(train_set, list) or not train_set:
        raise ValueError("SkillOpt bridge requires a non-empty trainSet")
    if not isinstance(selection_set, list) or not selection_set:
        raise ValueError("SkillOpt bridge requires a non-empty selectionSet")
    _validate_examples([*train_set, *selection_set])
    validate_json_size(value["objective"], value["maxEvidenceChars"], "SkillOpt objective")
    validate_json_size(
        value.get("background", ""),
        value["maxEvidenceChars"],
        "SkillOpt background",
    )
    for example in [*train_set, *selection_set]:
        validate_json_size(
            example.get("data"),
            value["maxEvidenceChars"],
            f"SkillOpt example {example.get('id')!r}",
        )
    trainer = value.get("trainer")
    if not isinstance(trainer, dict):
        raise ValueError("SkillOpt bridge requires trainer settings")
    if "optimizerBackend" in trainer or "targetBackend" in trainer:
        raise ValueError(
            "SkillOpt bridge fixes model backends to its metered OpenAI-compatible path"
        )
    for key in ["epochs", "batchSize"]:
        _positive_int(trainer.get(key), f"trainer.{key}")
    for key in [
        "accumulation",
        "editBudget",
        "minEditBudget",
        "analystWorkers",
        "minibatchSize",
        "mergeBatchSize",
        "maxAnalystRounds",
        "evaluationWorkers",
    ]:
        if trainer.get(key) is not None:
            _positive_int(trainer[key], f"trainer.{key}")
    if (
        trainer.get("minEditBudget") is not None
        and trainer.get("editBudget") is not None
        and trainer["minEditBudget"] > trainer["editBudget"]
    ):
        raise ValueError("SkillOpt bridge trainer.minEditBudget must not exceed trainer.editBudget")
    reasoning_effort = trainer.get("reasoningEffort")
    if reasoning_effort is not None and (
        not isinstance(reasoning_effort, str)
        or not reasoning_effort.strip()
        or reasoning_effort.strip() != reasoning_effort
    ):
        raise ValueError("SkillOpt bridge trainer.reasoningEffort must be trimmed and non-empty")
    _optional_choice(
        trainer,
        "learningRateSchedule",
        {"constant", "linear", "cosine", "autonomous"},
    )
    _optional_choice(
        trainer,
        "learningRateControl",
        {"fixed", "autonomous", "none"},
    )
    _optional_choice(
        trainer,
        "updateMode",
        {"patch", "rewrite_from_suggestions", "full_rewrite_minibatch"},
    )
    for key in ["failureOnly", "useSlowUpdate", "useMetaSkill"]:
        if trainer.get(key) is not None and not isinstance(trainer[key], bool):
            raise ValueError(f"SkillOpt bridge trainer.{key} must be a boolean")
    if "overrides" in trainer and not isinstance(trainer["overrides"], dict):
        raise ValueError("SkillOpt trainer.overrides must be an object")
    validate_no_secrets(
        trainer.get("overrides", {}),
        "trainer.overrides",
        "SkillOpt",
    )
    if "testSet" in value or "test_set" in value:
        raise ValueError("SkillOpt bridge does not accept final test cases")


def _validate_examples(examples: list[Any]) -> None:
    seen: set[str] = set()
    storage_ids: set[str] = set()
    for example in examples:
        if not isinstance(example, dict) or not isinstance(example.get("id"), str):
            raise ValueError("SkillOpt examples require string ids")
        example_id = example["id"]
        if not example_id or example_id in seen:
            raise ValueError("SkillOpt example ids must be unique and non-empty")
        if "data" not in example:
            raise ValueError("SkillOpt examples require data")
        storage_id = hashlib.sha256(example_id.encode()).hexdigest()
        if storage_id in storage_ids:
            raise ValueError("SkillOpt example storage id collision")
        seen.add(example_id)
        storage_ids.add(storage_id)


def _positive_int(value: Any, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"SkillOpt bridge {label} must be a positive integer")


def _optional_choice(
    value: dict[str, Any],
    key: str,
    allowed: set[str],
) -> None:
    if value.get(key) is not None and value[key] not in allowed:
        raise ValueError(
            f"SkillOpt bridge trainer.{key} must be one of {', '.join(sorted(allowed))}"
        )


if __name__ == "__main__":
    main()
