"""Run GEPA against a callback owned by @tangle-network/agent-eval.

This module is intentionally small. GEPA owns candidate generation; the Node
process owns agent execution, judges, and all final-test scoring. The input
format has no test-set field, so a GEPA engine cannot receive final comparison
cases through this bridge.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import httpx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    input_value = _read_json(Path(args.input))
    _validate_input(input_value)

    try:
        from gepa.optimize_anything import OptimizeAnythingConfig, optimize_anything
    except ImportError as error:
        raise RuntimeError(
            "GEPA bridge requires the optional dependency. Install with "
            "`pip install 'agent-eval-rpc[gepa]'`."
        ) from error

    def evaluate(
        candidate: str, example: dict[str, Any] | None = None
    ) -> tuple[float, dict[str, Any]]:
        if not isinstance(example, dict) or not isinstance(example.get("id"), str):
            raise ValueError("GEPA requested an example without a string id")
        response = httpx.post(
            input_value["callbackUrl"],
            headers={"Authorization": f"Bearer {input_value['callbackToken']}"},
            json={"candidate": candidate, "exampleId": example["id"]},
            timeout=300.0,
        )
        response.raise_for_status()
        payload = response.json()
        score = payload.get("score")
        if not isinstance(score, (float, int)) or not math.isfinite(score):
            raise ValueError("agent-eval callback returned an invalid score")
        info = payload.get("info")
        return float(score), info if isinstance(info, dict) else {}

    output_dir = Path(input_value["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    recipe = input_value["recipe"]
    result, phase_results = _run_recipe(
        recipe=recipe,
        seed_candidate=input_value["seedCandidate"],
        evaluator=evaluate,
        train_set=input_value["trainSet"],
        selection_set=input_value["selectionSet"],
        objective=input_value["objective"],
        background=input_value.get("background", ""),
        output_dir=output_dir,
        config_class=OptimizeAnythingConfig,
        optimize_anything_fn=optimize_anything,
    )
    candidate = result.best_candidate
    if not isinstance(candidate, str) or not candidate.strip():
        raise RuntimeError("GEPA produced no text candidate")
    if len(candidate) > input_value["maxCandidateChars"]:
        raise RuntimeError("GEPA candidate exceeds maxCandidateChars")
    best_score = result.best_score
    if (
        isinstance(best_score, bool)
        or not isinstance(best_score, (float, int))
        or not math.isfinite(best_score)
    ):
        raise RuntimeError("GEPA produced an invalid best score")
    total_evaluations = sum(_result_evaluations(phase_result) for phase_result in phase_results)
    proposer_cost = _reported_proposer_cost(phase_results)
    output = {
        "bestCandidate": candidate,
        "bestScore": float(best_score),
        "totalEvaluations": total_evaluations,
        "recipeKind": recipe["kind"],
        "proposerCostAccounting": "reported" if proposer_cost is not None else "unavailable",
    }
    if proposer_cost is not None:
        output["proposerCostUsd"] = proposer_cost
    Path(args.output).write_text(json.dumps(output) + "\n")


def _run_recipe(
    *,
    recipe: dict[str, Any],
    seed_candidate: str,
    evaluator: Any,
    train_set: list[Any],
    selection_set: list[Any],
    objective: str,
    background: str,
    output_dir: Path,
    config_class: Any,
    optimize_anything_fn: Any,
) -> tuple[Any, list[Any]]:
    task = {
        "evaluator": evaluator,
        "dataset": train_set,
        "valset": selection_set,
        "objective": objective,
        "background": background,
    }
    if recipe["kind"] == "engine":
        result = optimize_anything_fn(
            seed_candidate,
            **task,
            config=_engine_config(config_class, recipe["run"], output_dir / "engine"),
        )
        return result, [result]

    try:
        from gepa.optimize_anything import optimize_best_of
    except ImportError as error:
        raise RuntimeError(
            "GEPA bridge recipe 'best-of-then-continue' requires "
            "gepa.optimize_anything.optimize_best_of. Install the GEPA source "
            "version pinned by agent-eval-rpc[gepa]."
        ) from error

    explore_configs = [
        _engine_config(config_class, run, output_dir / f"explore-{index}")
        for index, run in enumerate(recipe["explore"])
    ]
    explore = optimize_best_of(seed_candidate, **task, configs=explore_configs)
    explore_results = _parallel_results(explore)
    continuation = optimize_anything_fn(
        explore.best_candidate,
        **task,
        config=_engine_config(config_class, recipe["continueWith"], output_dir / "continue"),
    )
    return continuation, [*explore_results, continuation]


def _engine_config(config_class: Any, run: dict[str, Any], output_dir: Path) -> Any:
    return config_class(
        engine=run["engine"],
        max_evals=run["maxEvaluations"],
        max_token_cost=run["maxProposerCostUsd"],
        output_dir=output_dir,
        engine_config=run["engineConfig"],
    )


def _parallel_results(result: Any) -> list[Any]:
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    results = metadata.get("all_results")
    if not isinstance(results, list) or not results:
        raise RuntimeError("GEPA optimize_best_of returned no engine results")
    return results


def _result_evaluations(result: Any) -> int:
    total_evaluations = result.total_evals
    if (
        isinstance(total_evaluations, bool)
        or not isinstance(total_evaluations, int)
        or total_evaluations < 0
    ):
        raise RuntimeError("GEPA produced an invalid evaluation count")
    return total_evaluations


def _reported_proposer_cost(results: list[Any]) -> float | None:
    costs: list[float] = []
    for result in results:
        metadata = result.metadata if isinstance(result.metadata, dict) else {}
        adapter_cost = metadata.get("adapter_cost")
        if isinstance(adapter_cost, bool) or not isinstance(adapter_cost, (float, int)):
            return None
        cost = float(adapter_cost)
        if not math.isfinite(cost) or cost < 0:
            return None
        costs.append(cost)
    return sum(costs)


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError("GEPA bridge input must be a JSON object")
    return payload


def _validate_input(value: dict[str, Any]) -> None:
    if value.get("version") != 2:
        raise ValueError("GEPA bridge input requires version 2")
    required_strings = [
        "callbackUrl",
        "callbackToken",
        "objective",
        "seedCandidate",
        "outputDir",
    ]
    for key in required_strings:
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise ValueError(f"GEPA bridge input requires non-empty string {key}")
    recipe = value.get("recipe")
    if not isinstance(recipe, dict):
        raise ValueError("GEPA bridge input requires a recipe object")
    _validate_recipe(recipe)
    if not isinstance(value.get("maxCandidateChars"), int) or value["maxCandidateChars"] <= 0:
        raise ValueError("GEPA bridge input maxCandidateChars must be a positive integer")
    if not isinstance(value.get("trainSet"), list) or not isinstance(
        value.get("selectionSet"), list
    ):
        raise ValueError("GEPA bridge input requires trainSet and selectionSet arrays")
    if "testSet" in value or "test_set" in value:
        raise ValueError("GEPA bridge does not accept final test cases")


def _validate_recipe(recipe: dict[str, Any]) -> None:
    kind = recipe.get("kind")
    if kind == "engine":
        _validate_engine_run(recipe.get("run"), "recipe.run")
        return
    if kind == "best-of-then-continue":
        explore = recipe.get("explore")
        if not isinstance(explore, list) or len(explore) < 2:
            raise ValueError("GEPA recipe.explore must contain at least two engine runs")
        for index, run in enumerate(explore):
            _validate_engine_run(run, f"recipe.explore[{index}]")
        _validate_engine_run(recipe.get("continueWith"), "recipe.continueWith")
        return
    raise ValueError("GEPA bridge input has an unsupported recipe")


def _validate_engine_run(value: Any, label: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"GEPA bridge input {label} must be an object")
    engine = value.get("engine")
    if not isinstance(engine, str) or not engine.strip() or engine.strip() != engine:
        raise ValueError(f"GEPA bridge input {label}.engine must be a trimmed non-empty string")
    max_evaluations = value.get("maxEvaluations")
    if (
        isinstance(max_evaluations, bool)
        or not isinstance(max_evaluations, int)
        or max_evaluations <= 0
    ):
        raise ValueError(f"GEPA bridge input {label}.maxEvaluations must be a positive integer")
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


if __name__ == "__main__":
    main()
