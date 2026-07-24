"""Run GEPA against a callback owned by @tangle-network/agent-eval.

GEPA owns candidate generation. The Node process owns agent execution, judges,
and all final-test scoring. The input format has no test-set field, so a GEPA
engine cannot receive final comparison cases through this bridge.
"""

from __future__ import annotations

import argparse
import copy
import math
import os
from pathlib import Path
from typing import Any

import httpx

from agent_eval_rpc.gepa_bridge_contract import (
    _import_engine_modules as _import_engine_modules,
)
from agent_eval_rpc.gepa_bridge_contract import _read_json as _read_json
from agent_eval_rpc.gepa_bridge_contract import _validate_input as _validate_input
from agent_eval_rpc.gepa_bridge_contract import (
    _validate_selected_candidate as _validate_selected_candidate,
)
from agent_eval_rpc.gepa_compat_0_1_4 import (
    GepaRestoreObserver,
    load_restore_observer,
)
from agent_eval_rpc.gepa_model_proxy import (
    _official_reflection_model as _official_reflection_model,
)
from agent_eval_rpc.gepa_model_proxy import _ProxyUsage as _ProxyUsage
from agent_eval_rpc.optimizer_bridge_common import (
    archive_unrestorable_state,
    atomic_write_json,
    inspect_optimizer_runtime,
    locked_run,
    validate_runtime_identity,
)


def _require_model_proxy_dependencies(input_value: dict[str, Any]) -> None:
    if input_value.get("modelProxy") is None:
        return
    try:
        import litellm  # noqa: F401
    except ImportError as error:
        raise RuntimeError(
            "GEPA model-backed reflection requires the full GEPA dependency set. "
            "Install gepa[full] from the documented source revision."
        ) from error


def main() -> None:
    previous_umask = os.umask(0o077)
    try:
        _main()
    finally:
        os.umask(previous_umask)


def _main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    input_value = _read_json(Path(args.input))
    if input_value.get("operation") == "inspect":
        engine_modules = input_value.get("engineModules")
        if not isinstance(engine_modules, list) or not all(
            isinstance(module, str) for module in engine_modules
        ):
            raise ValueError("GEPA inspection requires engineModules")
        atomic_write_json(Path(args.output), {"runtime": _runtime_identity(engine_modules)})
        return
    _validate_input(input_value)
    _import_engine_modules(input_value["engineModules"])

    try:
        from gepa.optimize_anything import OptimizeAnythingConfig, optimize_anything
    except ImportError as error:
        raise RuntimeError(
            "GEPA bridge requires GEPA's Optimize Anything source version. "
            "Install the commit documented in the agent-eval-rpc README."
        ) from error
    _require_model_proxy_dependencies(input_value)

    evaluation_count = 0

    def evaluate_one(
        candidate: str | dict[str, str],
        example: dict[str, Any],
    ) -> tuple[float, dict[str, Any]]:
        nonlocal evaluation_count
        if not isinstance(example.get("id"), str):
            raise ValueError("GEPA requested an example without a string id")
        response = httpx.post(
            input_value["callbackUrl"],
            headers={"Authorization": f"Bearer {input_value['callbackToken']}"},
            json={"candidate": candidate, "exampleId": example["id"]},
            timeout=300.0,
        )
        response.raise_for_status()
        evaluation_count += 1
        payload = response.json()
        score = payload.get("score")
        if not isinstance(score, (float, int)) or not math.isfinite(score):
            raise ValueError("agent-eval callback returned an invalid score")
        info = payload.get("info")
        return float(score), info if isinstance(info, dict) else {}

    def evaluate(
        candidate: str | dict[str, str],
        example: dict[str, Any] | None = None,
    ) -> tuple[float, dict[str, Any]]:
        if example is not None:
            if not isinstance(example, dict):
                raise ValueError("GEPA requested an invalid example")
            return evaluate_one(candidate, example)

        comparison_set = input_value["selectionSet"] or input_value["trainSet"]
        if not comparison_set:
            raise ValueError("GEPA selection re-score requires at least one example")
        rows = [evaluate_one(candidate, item) for item in comparison_set]
        return (
            sum(score for score, _ in rows) / len(rows),
            {
                "comparison": "selection-set",
                "examples": [
                    {"id": item["id"], "score": score, "info": info}
                    for item, (score, info) in zip(comparison_set, rows, strict=True)
                ],
            },
        )

    output_root = Path(input_value["outputDir"])
    output_root.mkdir(parents=True, exist_ok=True)
    runtime_identity = _runtime_identity(input_value["engineModules"])
    validate_runtime_identity(
        input_value["runtimeIdentity"],
        runtime_identity,
        "GEPA",
    )
    upstream = runtime_identity["optimizer"]
    recipe = input_value["recipe"]
    model_proxy = input_value.get("modelProxy")
    proxy_usage = _ProxyUsage() if model_proxy is not None else None
    with locked_run(
        label="GEPA",
        compatible_run_id=input_value["compatibleRunId"],
        run_id=input_value["runId"],
        runtime_identity=runtime_identity,
        resume=input_value["resume"],
        attempt_id=input_value["attemptId"],
        output_root=output_root,
        resume_supported=_supports_resume(recipe),
        resume_scope=_resume_scope(recipe),
    ) as run:
        restore_tracker: GepaRestoreObserver | None = None
        if run.restore_requested:
            restore_tracker = load_restore_observer(
                run.run_dir,
                upstream,
                trusted=input_value["trustedResumeState"],
            )
            if restore_tracker is None:
                if input_value["resume"] == "required":
                    raise RuntimeError(
                        f"GEPA compatible run '{run.run_dir.name}' has no restorable "
                        "official GEPA state"
                    )
                archive_unrestorable_state(
                    run.run_dir / "engine",
                    input_value["attemptId"],
                )

        if restore_tracker is None:
            result, phase_results = _run_recipe(
                recipe=recipe,
                seed_candidate=input_value["seedCandidate"],
                evaluator=evaluate,
                train_set=input_value["trainSet"],
                selection_set=input_value["selectionSet"],
                objective=input_value["objective"],
                background=input_value.get("background", ""),
                output_dir=run.run_dir,
                config_class=OptimizeAnythingConfig,
                optimize_anything_fn=optimize_anything,
                model_proxy=model_proxy,
                proxy_usage=proxy_usage,
            )
            resumed = False
        else:
            with restore_tracker:
                result, phase_results = _run_recipe(
                    recipe=recipe,
                    seed_candidate=input_value["seedCandidate"],
                    evaluator=evaluate,
                    train_set=input_value["trainSet"],
                    selection_set=input_value["selectionSet"],
                    objective=input_value["objective"],
                    background=input_value.get("background", ""),
                    output_dir=run.run_dir,
                    config_class=OptimizeAnythingConfig,
                    optimize_anything_fn=optimize_anything,
                    model_proxy=model_proxy,
                    proxy_usage=proxy_usage,
                )
            if not restore_tracker.restored:
                raise RuntimeError(
                    "GEPA did not restore the compatible official state during optimization"
                )
            resumed = True

        candidate = _selected_candidate(result, recipe["kind"])
        _validate_selected_candidate(
            candidate,
            input_value["seedCandidate"],
            input_value["maxCandidateChars"],
        )
        best_score = _selected_score(result, recipe["kind"])
        if (
            isinstance(best_score, bool)
            or not isinstance(best_score, (float, int))
            or not math.isfinite(best_score)
        ):
            raise RuntimeError("GEPA produced an invalid best score")
        upstream_evaluations = sum(
            _result_evaluations(phase_result) for phase_result in phase_results
        )
        proposer_cost = _reported_proposer_cost(phase_results)
        proxy_snapshot = proxy_usage.snapshot() if proxy_usage is not None else None
        if proxy_snapshot is not None:
            proxy_cost = proxy_snapshot["costUsd"]
            if (
                proposer_cost is None
                or not isinstance(proxy_cost, float)
                or not math.isclose(proposer_cost, proxy_cost, rel_tol=1e-9, abs_tol=1e-12)
            ):
                raise RuntimeError(
                    f"GEPA reported proposer cost {proposer_cost!r}, "
                    f"but the model proxy measured {proxy_cost!r}"
                )
        run_id = run.run_dir.name

    atomic_write_json(output_root / "upstream.json", upstream)
    output = {
        "bestCandidate": candidate,
        "bestScore": float(best_score),
        "totalEvaluations": evaluation_count,
        "upstreamReportedEvaluations": upstream_evaluations,
        "recipeKind": recipe["kind"],
        "proposerCostAccounting": (
            "metered"
            if proxy_snapshot is not None
            else "reported"
            if proposer_cost is not None
            else "unavailable"
        ),
        "upstream": upstream,
        "runId": run_id,
        "resumed": resumed,
    }
    if proxy_snapshot is not None:
        output["proposerCostUsd"] = proxy_snapshot["costUsd"]
        output["tokenUsage"] = {
            key: proxy_snapshot[key]
            for key in (
                "inputTokens",
                "outputTokens",
                "totalTokens",
                "calls",
                "requestAttempts",
            )
        }
    elif proposer_cost is not None:
        output["proposerCostUsd"] = proposer_cost
    atomic_write_json(Path(args.output), output)
    if proxy_usage is not None:
        proxy_usage.close()


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
    model_proxy: dict[str, Any] | None,
    proxy_usage: _ProxyUsage | None,
) -> tuple[Any, list[Any]]:
    task = {
        "evaluator": evaluator,
        "dataset": train_set,
        "valset": selection_set,
        "objective": objective,
        "background": background,
    }

    def engine_config(run: dict[str, Any], path: Path) -> Any:
        bounded_run = copy.deepcopy(run)
        if bounded_run.get("maxEvaluations") is not None:
            bounded_run["maxEvaluations"] = _upstream_evaluation_limit(
                bounded_run["maxEvaluations"],
                bounded_run.get("maxConcurrency", 1) - 1,
            )
        return _engine_config(
            config_class,
            bounded_run,
            path,
            model_proxy=model_proxy,
            proxy_usage=proxy_usage,
        )

    if recipe["kind"] == "engine":
        result = optimize_anything_fn(
            seed_candidate,
            **task,
            config=engine_config(recipe["run"], output_dir / "engine"),
        )
        return result, [result]

    if recipe["kind"] == "sequential":
        try:
            from gepa.optimize_anything import optimize_sequential
        except ImportError as error:
            raise _missing_composition(recipe["kind"]) from error
        configs = [
            engine_config(run, output_dir / f"stage-{index}")
            for index, run in enumerate(recipe["runs"])
        ]
        result = optimize_sequential(seed_candidate, **task, configs=configs)
        return result, _nested_results(result, "all_results")

    if recipe["kind"] == "adaptive-sequential":
        try:
            from gepa.optimize_anything import optimize_adaptive_sequential
        except ImportError as error:
            raise _missing_composition(recipe["kind"]) from error
        configs = [
            engine_config(run, output_dir / f"stage-{index}")
            for index, run in enumerate(recipe["runs"])
        ]
        result = optimize_adaptive_sequential(
            seed_candidate,
            **task,
            configs=configs,
            plateau_evals=recipe["plateauEvaluations"],
            max_evals=_upstream_evaluation_limit(
                recipe["maxEvaluations"],
                recipe.get("maxConcurrency", 1) - 1,
            ),
            patience=recipe.get("patience", 1),
            min_evals_per_stage=recipe.get("minEvaluationsPerStage", 0),
            improvement_epsilon=recipe.get("improvementEpsilon", 0.0),
            cycle=recipe.get("cycle", True),
            max_switches=recipe.get("maxSwitches"),
            max_concurrency=recipe.get("maxConcurrency", 1),
            output_dir=output_dir / "adaptive-evaluations",
        )
        return result, [result]

    if recipe["kind"] in {"best-of", "vote"}:
        try:
            from gepa.optimize_anything import optimize_best_of, optimize_vote
        except ImportError as error:
            raise _missing_composition(recipe["kind"]) from error
        configs = [
            engine_config(run, output_dir / f"engine-{index}")
            for index, run in enumerate(recipe["runs"])
        ]
        choose = optimize_best_of if recipe["kind"] == "best-of" else optimize_vote
        kwargs: dict[str, Any] = {"configs": configs}
        if recipe.get("maxWorkers") is not None:
            kwargs["max_workers"] = recipe["maxWorkers"]
        result = choose(seed_candidate, **task, **kwargs)
        return result, _nested_results(result, "all_results")

    try:
        from gepa.optimize_anything import optimize_best_of, optimize_vote
    except ImportError as error:
        raise _missing_composition(recipe["kind"]) from error
    explore_configs = [
        engine_config(run, output_dir / f"explore-{index}")
        for index, run in enumerate(recipe["explore"])
    ]
    explore_kwargs: dict[str, Any] = {"configs": explore_configs}
    if recipe.get("maxWorkers") is not None:
        explore_kwargs["max_workers"] = recipe["maxWorkers"]
    explore = optimize_best_of(seed_candidate, **task, **explore_kwargs)
    explore_results = _nested_results(explore, "all_results")
    continuation = optimize_anything_fn(
        explore.best_candidate,
        **task,
        config=engine_config(recipe["continueWith"], output_dir / "continue"),
    )
    return continuation, [*explore_results, continuation]


def _upstream_evaluation_limit(hard_limit: int, concurrency_slack: int) -> int:
    upstream_limit = hard_limit - concurrency_slack
    if upstream_limit <= 0:
        raise ValueError(
            "GEPA maxEvaluations must exceed the possible concurrent evaluation overshoot "
            f"of {concurrency_slack}"
        )
    return upstream_limit


def _selected_candidate(result: Any, recipe_kind: str) -> Any:
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    if recipe_kind in {"sequential", "adaptive-sequential"}:
        return metadata.get("best_stage_candidate", result.best_candidate)
    return result.best_candidate


def _selected_score(result: Any, recipe_kind: str) -> Any:
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    if recipe_kind in {"sequential", "adaptive-sequential"}:
        return metadata.get("best_stage_score", result.best_score)
    return result.best_score


def _missing_composition(kind: str) -> RuntimeError:
    return RuntimeError(
        f"GEPA bridge recipe '{kind}' requires GEPA's official composition "
        "functions. Install the GEPA source commit documented in the "
        "agent-eval-rpc README."
    )


def _engine_config(
    config_class: Any,
    run: dict[str, Any],
    output_dir: Path,
    *,
    model_proxy: dict[str, Any] | None,
    proxy_usage: _ProxyUsage | None,
) -> Any:
    engine_config = copy.deepcopy(run["engineConfig"])
    if model_proxy is not None:
        if run["engine"] != "gepa" or proxy_usage is None:
            raise ValueError("GEPA modelProxy supports only the standard gepa engine")
        reflection = engine_config.setdefault("reflection", {})
        if not isinstance(reflection, dict):
            raise ValueError("GEPA engineConfig.reflection must be an object")
        if "reflection_lm" in reflection:
            raise ValueError("GEPA modelProxy replaces engineConfig.reflection.reflection_lm")
        reflection_options = reflection.pop("reflection_lm_kwargs", {})
        if reflection_options is None:
            reflection_options = {}
        if not isinstance(reflection_options, dict):
            raise ValueError("GEPA reflection_lm_kwargs must be an object")
        reflection["reflection_lm"] = _official_reflection_model(
            config=model_proxy,
            options=reflection_options,
            shared_usage=proxy_usage,
        )

    kwargs: dict[str, Any] = {
        "engine": run["engine"],
        "max_evals": run.get("maxEvaluations"),
        "max_token_cost": run["maxProposerCostUsd"],
        "output_dir": output_dir / "evaluations",
        "run_dir": str(output_dir / "state"),
        "engine_config": engine_config,
    }
    kwargs["max_concurrency"] = run.get("maxConcurrency", 1)
    if run.get("stopAtScore") is not None:
        kwargs["stop_at_score"] = run["stopAtScore"]
    if run.get("sandbox") is not None:
        kwargs["sandbox"] = run["sandbox"]
    return config_class(
        **kwargs,
    )


def _nested_results(result: Any, key: str) -> list[Any]:
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    results = metadata.get(key)
    if not isinstance(results, list) or not results:
        raise RuntimeError(f"GEPA recipe returned no {key}")
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


def _supports_resume(recipe: dict[str, Any]) -> bool:
    return recipe["kind"] == "engine" and recipe["run"]["engine"] == "gepa"


def _resume_scope(recipe: dict[str, Any]) -> str:
    if recipe["kind"] == "engine":
        return f"engine '{recipe['run']['engine']}'"
    return f"recipe '{recipe['kind']}'"


def _runtime_identity(engine_modules: list[str]) -> dict[str, Any]:
    return inspect_optimizer_runtime(
        optimizer_package="gepa",
        optimizer_module="gepa",
        engine_modules=engine_modules,
    )


if __name__ == "__main__":
    main()
