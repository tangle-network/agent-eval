"""Validate the private JSON protocol consumed by the GEPA bridge."""

from __future__ import annotations

import importlib
import json
import math
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from agent_eval_rpc.gepa_model_proxy import _validated_reflection_options
from agent_eval_rpc.optimizer_bridge_common import (
    validate_json_size,
    validate_no_secrets,
    validate_optimizer_model_budget,
)


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError("GEPA bridge input must be a JSON object")
    return payload


def _validate_input(value: dict[str, Any]) -> None:
    required_strings = [
        "callbackUrl",
        "callbackToken",
        "objective",
        "evaluationId",
        "attemptId",
        "compatibleRunId",
        "runId",
        "outputDir",
    ]
    for key in required_strings:
        if (
            not isinstance(value.get(key), str)
            or not value[key].strip()
            or value[key].strip() != value[key]
        ):
            raise ValueError(f"GEPA bridge input requires non-empty string {key}")
    if not re.fullmatch(r"[0-9a-f]{64}", value["compatibleRunId"]):
        raise ValueError("GEPA bridge input compatibleRunId must be a SHA-256 digest")
    if not isinstance(value.get("runtimeIdentity"), dict):
        raise ValueError("GEPA bridge input requires runtimeIdentity")
    validate_no_secrets(value["runtimeIdentity"], "runtimeIdentity", "GEPA")
    if not _is_candidate(value.get("seedCandidate")):
        raise ValueError("GEPA bridge input requires a text seedCandidate")
    if value.get("resume") not in {"never", "if-compatible", "required"}:
        raise ValueError("GEPA bridge input resume must be never, if-compatible, or required")
    seed = value.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("GEPA bridge input seed must be an integer")
    recipe = value.get("recipe")
    if not isinstance(recipe, dict):
        raise ValueError("GEPA bridge input requires a recipe object")
    _validate_recipe(recipe)
    _validate_engine_modules(value.get("engineModules"))
    _validate_candidate_recipe(value["seedCandidate"], recipe)
    if value.get("modelProxy") is not None:
        if value["engineModules"]:
            raise ValueError("GEPA bridge modelProxy cannot be combined with engineModules")
        _validate_model_proxy(value["modelProxy"], recipe)
    if not isinstance(value.get("maxCandidateChars"), int) or value["maxCandidateChars"] <= 0:
        raise ValueError("GEPA bridge input maxCandidateChars must be a positive integer")
    if not isinstance(value.get("maxEvidenceChars"), int) or value["maxEvidenceChars"] <= 0:
        raise ValueError("GEPA bridge input maxEvidenceChars must be a positive integer")
    if _candidate_chars(value["seedCandidate"]) > value["maxCandidateChars"]:
        raise ValueError("GEPA bridge seedCandidate exceeds maxCandidateChars")
    if not isinstance(value.get("trainSet"), list) or not isinstance(
        value.get("selectionSet"), list
    ):
        raise ValueError("GEPA bridge input requires trainSet and selectionSet arrays")
    if not value["trainSet"] or not value["selectionSet"]:
        raise ValueError("GEPA bridge requires non-empty trainSet and selectionSet")
    validate_json_size(value["objective"], value["maxEvidenceChars"], "GEPA objective")
    validate_json_size(
        value.get("background", ""),
        value["maxEvidenceChars"],
        "GEPA background",
    )
    _validate_examples(
        [*value["trainSet"], *value["selectionSet"]],
        value["maxEvidenceChars"],
    )
    if "testSet" in value or "test_set" in value:
        raise ValueError("GEPA bridge does not accept final test cases")


def _validate_selected_candidate(
    candidate: Any,
    seed_candidate: str | dict[str, str],
    max_candidate_chars: int,
) -> None:
    if not _is_candidate(candidate):
        raise RuntimeError("GEPA produced no valid candidate")
    if isinstance(candidate, dict) != isinstance(seed_candidate, dict):
        raise RuntimeError("GEPA changed the candidate surface shape")
    if _candidate_chars(candidate) > max_candidate_chars:
        raise RuntimeError("GEPA candidate exceeds maxCandidateChars")


def _is_candidate(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if not isinstance(value, dict) or not value:
        return False
    return all(
        isinstance(name, str)
        and bool(name.strip())
        and name.strip() == name
        and isinstance(content, str)
        for name, content in value.items()
    )


def _candidate_chars(value: str | dict[str, str]) -> int:
    if isinstance(value, str):
        return len(value)
    return len(json.dumps(value, sort_keys=True, separators=(",", ":")))


def _validate_examples(examples: list[Any], max_evidence_chars: int) -> None:
    seen: set[str] = set()
    for example in examples:
        if not isinstance(example, dict) or not isinstance(example.get("id"), str):
            raise ValueError("GEPA bridge examples require string ids")
        example_id = example["id"]
        if not example_id or example_id in seen:
            raise ValueError("GEPA bridge example ids must be unique and non-empty")
        if "data" not in example:
            raise ValueError("GEPA bridge examples require data")
        validate_json_size(
            example["data"],
            max_evidence_chars,
            f"GEPA example {example_id!r}",
        )
        seen.add(example_id)


def _validate_recipe(recipe: dict[str, Any]) -> None:
    kind = recipe.get("kind")
    if kind == "engine":
        _validate_engine_run(recipe.get("run"), "recipe.run")
        return
    if kind == "sequential":
        _validate_engine_runs(recipe.get("runs"), "recipe.runs", minimum=1)
        return
    if kind == "adaptive-sequential":
        runs = recipe.get("runs")
        if not isinstance(runs, list) or len(runs) < 2:
            raise ValueError("GEPA recipe.runs must contain at least two engine runs")
        for index, run in enumerate(runs):
            _validate_engine_options(run, f"recipe.runs[{index}]")
        _validate_positive_int(recipe.get("maxEvaluations"), "recipe.maxEvaluations")
        _validate_positive_int(recipe.get("plateauEvaluations"), "recipe.plateauEvaluations")
        if recipe.get("patience") is not None:
            _validate_positive_int(recipe["patience"], "recipe.patience")
        minimum = recipe.get("minEvaluationsPerStage")
        if minimum is not None and (
            isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 0
        ):
            raise ValueError("GEPA recipe.minEvaluationsPerStage must be a non-negative integer")
        epsilon = recipe.get("improvementEpsilon")
        if epsilon is not None and (
            isinstance(epsilon, bool)
            or not isinstance(epsilon, (float, int))
            or not math.isfinite(epsilon)
            or epsilon < 0
        ):
            raise ValueError("GEPA recipe.improvementEpsilon must be a non-negative finite number")
        cycle = recipe.get("cycle")
        if cycle is not None and not isinstance(cycle, bool):
            raise ValueError("GEPA recipe.cycle must be a boolean")
        if recipe.get("maxSwitches") is not None:
            _validate_positive_int(recipe["maxSwitches"], "recipe.maxSwitches")
        if recipe.get("maxConcurrency") is not None:
            _validate_positive_int(recipe["maxConcurrency"], "recipe.maxConcurrency")
        return
    if kind in {"best-of", "vote"}:
        _validate_engine_runs(recipe.get("runs"), "recipe.runs", minimum=2)
        _validate_parallel_controls(recipe)
        return
    if kind == "omni":
        _validate_engine_runs(recipe.get("explore"), "recipe.explore", minimum=2)
        _validate_engine_run(recipe.get("continueWith"), "recipe.continueWith")
        _validate_parallel_controls(recipe)
        return
    raise ValueError("GEPA bridge input has an unsupported recipe")


def _validate_engine_modules(value: Any) -> None:
    if not isinstance(value, list):
        raise ValueError("GEPA bridge input engineModules must be an array")
    seen: set[str] = set()
    for module in value:
        if not isinstance(module, str) or not module:
            raise ValueError("GEPA bridge input engineModules must contain module names")
        if any(not part.isidentifier() or part.startswith("_") for part in module.split(".")):
            raise ValueError(
                "GEPA bridge input engineModules must contain public dotted Python module names"
            )
        if module in seen:
            raise ValueError("GEPA bridge input engineModules must not contain duplicates")
        seen.add(module)


def _import_engine_modules(modules: list[str]) -> None:
    for module in modules:
        try:
            importlib.import_module(module)
        except Exception as error:
            raise RuntimeError(
                f"GEPA could not import engine registration module {module!r}"
            ) from error


def _validate_model_proxy(value: Any, recipe: dict[str, Any]) -> None:
    if not isinstance(value, dict):
        raise ValueError("GEPA bridge input modelProxy must be an object")
    for key in ["baseUrl", "apiKey", "model"]:
        item = value.get(key)
        if not isinstance(item, str) or not item.strip() or item.strip() != item:
            raise ValueError(f"GEPA bridge input modelProxy.{key} must be non-empty")
    parsed = urlparse(value["baseUrl"])
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("GEPA bridge modelProxy.baseUrl must be a loopback HTTP URL")
    validate_optimizer_model_budget(
        value.get("budget"),
        "GEPA bridge input modelProxy.budget",
    )

    for index, run in enumerate(_recipe_engine_runs(recipe)):
        if run["engine"] != "gepa":
            raise ValueError(
                "GEPA bridge modelProxy supports only the standard gepa engine; "
                f"recipe engine {index} is {run['engine']!r}"
            )
        engine_config = run["engineConfig"]
        validate_no_secrets(
            engine_config,
            f"recipe engine {index}.engineConfig",
            "GEPA",
        )
        reflection = engine_config.get("reflection", {})
        if not isinstance(reflection, dict):
            raise ValueError("GEPA engineConfig.reflection must be an object")
        if "reflection_lm" in reflection:
            raise ValueError("GEPA modelProxy replaces engineConfig.reflection.reflection_lm")
        options = reflection.get("reflection_lm_kwargs", {})
        if options is None:
            options = {}
        if not isinstance(options, dict):
            raise ValueError("GEPA reflection_lm_kwargs must be an object")
        _validated_reflection_options(options, value["budget"])


def _validate_candidate_recipe(
    candidate: str | dict[str, str],
    recipe: dict[str, Any],
) -> None:
    if isinstance(candidate, str):
        return
    unsupported = next(
        (run["engine"] for run in _recipe_engine_runs(recipe) if run["engine"] != "gepa"),
        None,
    )
    if unsupported is not None:
        raise ValueError(
            "GEPA component candidates require the 'gepa' engine; "
            f"'{unsupported}' accepts one text candidate"
        )


def _recipe_engine_runs(recipe: dict[str, Any]) -> list[dict[str, Any]]:
    kind = recipe["kind"]
    if kind == "engine":
        return [recipe["run"]]
    if kind == "omni":
        return [*recipe["explore"], recipe["continueWith"]]
    return recipe["runs"]


def _validate_engine_runs(value: Any, label: str, *, minimum: int) -> None:
    if not isinstance(value, list) or len(value) < minimum:
        raise ValueError(
            f"GEPA {label} must contain at least {minimum} bounded engine "
            f"{'run' if minimum == 1 else 'runs'}"
        )
    for index, run in enumerate(value):
        _validate_engine_run(run, f"{label}[{index}]")


def _validate_engine_run(value: Any, label: str) -> None:
    _validate_engine_options(value, label)
    _validate_positive_int(value.get("maxEvaluations"), f"{label}.maxEvaluations")


def _validate_engine_options(value: Any, label: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"GEPA bridge input {label} must be an object")
    engine = value.get("engine")
    if not isinstance(engine, str) or not engine.strip() or engine.strip() != engine:
        raise ValueError(f"GEPA bridge input {label}.engine must be a trimmed non-empty string")
    max_proposer_cost = value.get("maxProposerCostUsd")
    if (
        isinstance(max_proposer_cost, bool)
        or not isinstance(max_proposer_cost, (float, int))
        or not math.isfinite(max_proposer_cost)
        or max_proposer_cost <= 0
    ):
        raise ValueError(
            f"GEPA bridge input {label}.maxProposerCostUsd must be a positive finite number"
        )
    engine_config = value.setdefault("engineConfig", {})
    if not isinstance(engine_config, dict):
        raise ValueError(f"GEPA bridge input {label}.engineConfig must be an object")
    validate_no_secrets(engine_config, f"{label}.engineConfig", "GEPA")
    if value.get("maxConcurrency") is not None:
        _validate_positive_int(value["maxConcurrency"], f"{label}.maxConcurrency")
    stop_at_score = value.get("stopAtScore")
    if stop_at_score is not None and (
        isinstance(stop_at_score, bool)
        or not isinstance(stop_at_score, (float, int))
        or not math.isfinite(stop_at_score)
    ):
        raise ValueError(f"GEPA bridge input {label}.stopAtScore must be a finite number")
    sandbox = value.get("sandbox")
    if sandbox is not None and not isinstance(sandbox, bool):
        raise ValueError(f"GEPA bridge input {label}.sandbox must be a boolean")


def _validate_parallel_controls(recipe: dict[str, Any]) -> None:
    if recipe.get("maxWorkers") is not None:
        _validate_positive_int(recipe["maxWorkers"], "recipe.maxWorkers")


def _validate_positive_int(value: Any, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"GEPA bridge input {label} must be a positive integer")
