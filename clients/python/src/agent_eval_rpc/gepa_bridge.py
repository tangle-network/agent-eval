"""Run GEPA against a callback owned by @tangle-network/agent-eval.

GEPA owns candidate generation. The Node process owns agent execution, judges,
and all final-test scoring. The input format has no test-set field, so a GEPA
engine cannot receive final comparison cases through this bridge.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import math
import os
from pathlib import Path
from typing import Any

import httpx

from agent_eval_rpc.gepa_api import GepaApi, load_gepa_api
from agent_eval_rpc.gepa_bridge_contract import (
    AGENT_CLI_ENGINES,
    recipe_has_agent_cli_engine,
)
from agent_eval_rpc.gepa_bridge_contract import (
    _import_engine_modules as _import_engine_modules,
)
from agent_eval_rpc.gepa_bridge_contract import _read_json as _read_json
from agent_eval_rpc.gepa_bridge_contract import (
    _recipe_engine_runs as _recipe_engine_runs,
)
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
            "GEPA model-backed reflection requires the documented GEPA dependency set. "
            'Install "gepa==0.1.4" with the documented dependencies or '
            "the documented source revision."
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
    api = load_gepa_api()
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
            # The TypeScript owner supplies the same caller-configured deadline
            # used to bound the bridge process, in milliseconds.
            timeout=input_value["timeoutMs"] / 1000.0,
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

        selection_set = input_value["selectionSet"]
        comparison_set = selection_set or input_value["trainSet"]
        if not comparison_set:
            raise ValueError("GEPA selection re-score requires at least one example")
        rows = [evaluate_one(candidate, item) for item in comparison_set]
        return (
            sum(score for score, _ in rows) / len(rows),
            {
                "comparison": ("selection-set" if selection_set else "train-set-fallback"),
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
                seed=input_value["seed"],
                seed_candidate=input_value["seedCandidate"],
                evaluator=evaluate,
                train_set=input_value["trainSet"],
                selection_set=input_value["selectionSet"],
                objective=input_value["objective"],
                background=input_value.get("background", ""),
                output_dir=run.run_dir,
                api=api,
                model_proxy=model_proxy,
                proxy_usage=proxy_usage,
            )
            resumed = False
        else:
            with restore_tracker:
                result, phase_results = _run_recipe(
                    recipe=recipe,
                    seed=input_value["seed"],
                    seed_candidate=input_value["seedCandidate"],
                    evaluator=evaluate,
                    train_set=input_value["trainSet"],
                    selection_set=input_value["selectionSet"],
                    objective=input_value["objective"],
                    background=input_value.get("background", ""),
                    output_dir=run.run_dir,
                    api=api,
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
        # Agent CLI engines self-report adapter cost from claude output that the
        # reflection proxy hooks never observe, so the equality holds only for
        # pure reflection recipes. The TS ledger stays the cost authority.
        if proxy_snapshot is not None and not recipe_has_agent_cli_engine(recipe):
            proxy_cost = proxy_snapshot["costUsd"]
            if proposer_cost is not None and (
                not isinstance(proxy_cost, float)
                or not math.isclose(
                    proposer_cost,
                    proxy_cost,
                    rel_tol=1e-9,
                    abs_tol=1e-12,
                )
            ):
                raise RuntimeError(
                    f"GEPA reported proposer cost {proposer_cost!r}, "
                    f"but the model proxy measured {proxy_cost!r}"
                )
        run_id = run.run_dir.name
        candidate_population = _write_candidate_population_artifact(
            result=result,
            seed_candidate=input_value["seedCandidate"],
            run_id=run_id,
            attempt_id=input_value["attemptId"],
            output_root=output_root,
            max_candidates=input_value["maxPopulationCandidates"],
            max_candidate_chars=input_value["maxCandidateChars"],
            selection_scenario_ids=[
                example["id"]
                for example in (input_value["selectionSet"] or input_value["trainSet"])
            ],
        )
        if (
            recipe["kind"] == "engine"
            and recipe["run"]["engine"] == "gepa"
            and candidate_population is None
        ):
            raise RuntimeError("GEPA result omitted its candidate population")

    atomic_write_json(output_root / "upstream.json", upstream)
    output = {
        "bestCandidate": candidate,
        "bestScore": float(best_score),
        "totalEvaluations": evaluation_count,
        "upstreamReportedEvaluations": upstream_evaluations,
        "recipeKind": recipe["kind"],
        # The run seed reaches only standard gepa engine configs; agent engines
        # (autoresearch, best_of_n, meta_harness) accept no seed parameter.
        "seedApplied": all(
            engine_run["engine"] == "gepa" for engine_run in _recipe_engine_runs(recipe)
        ),
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
    if candidate_population is not None:
        output["candidatePopulation"] = candidate_population
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
    seed: int,
    seed_candidate: str,
    evaluator: Any,
    train_set: list[Any],
    selection_set: list[Any],
    objective: str,
    background: str,
    output_dir: Path,
    api: GepaApi,
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
            api,
            bounded_run,
            path,
            seed=seed,
            model_proxy=model_proxy,
            proxy_usage=proxy_usage,
        )

    if recipe["kind"] == "engine":
        result = api.optimize_anything(
            seed_candidate,
            **task,
            config=engine_config(recipe["run"], output_dir / "engine"),
        )
        return result, [result]

    if recipe["kind"] == "sequential":
        optimize_sequential = api.composition("optimize_sequential")
        if optimize_sequential is None:
            raise _missing_composition(recipe["kind"])
        configs = [
            engine_config(run, output_dir / f"stage-{index}")
            for index, run in enumerate(recipe["runs"])
        ]
        result = optimize_sequential(seed_candidate, **task, configs=configs)
        return result, _nested_results(result, "all_results")

    if recipe["kind"] == "adaptive-sequential":
        optimize_adaptive_sequential = api.composition("optimize_adaptive_sequential")
        if optimize_adaptive_sequential is None:
            raise _missing_composition(recipe["kind"])
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
        optimize_best_of = api.composition("optimize_best_of")
        optimize_vote = api.composition("optimize_vote")
        if optimize_best_of is None or optimize_vote is None:
            raise _missing_composition(recipe["kind"])
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

    optimize_best_of = api.composition("optimize_best_of")
    if optimize_best_of is None:
        raise _missing_composition(recipe["kind"])
    explore_configs = [
        engine_config(run, output_dir / f"explore-{index}")
        for index, run in enumerate(recipe["explore"])
    ]
    explore_kwargs: dict[str, Any] = {"configs": explore_configs}
    if recipe.get("maxWorkers") is not None:
        explore_kwargs["max_workers"] = recipe["maxWorkers"]
    explore = optimize_best_of(seed_candidate, **task, **explore_kwargs)
    explore_results = _nested_results(explore, "all_results")
    continuation = api.optimize_anything(
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
    metadata = _result_metadata(result)
    if recipe_kind in {"sequential", "adaptive-sequential"}:
        return metadata.get("best_stage_candidate", result.best_candidate)
    return result.best_candidate


def _selected_score(result: Any, recipe_kind: str) -> Any:
    metadata = _result_metadata(result)
    if recipe_kind in {"sequential", "adaptive-sequential"}:
        stage_score = metadata.get("best_stage_score")
        if stage_score is not None:
            return stage_score
    best_score = getattr(result, "best_score", None)
    if best_score is not None:
        return best_score
    scores = getattr(result, "val_aggregate_scores", None)
    best_index = getattr(result, "best_idx", None)
    if isinstance(scores, list) and isinstance(best_index, int) and 0 <= best_index < len(scores):
        return scores[best_index]
    return None


def _write_candidate_population_artifact(
    *,
    result: Any,
    seed_candidate: str | dict[str, str],
    run_id: str,
    attempt_id: str,
    output_root: Path,
    max_candidates: int,
    max_candidate_chars: int,
    selection_scenario_ids: list[str],
) -> dict[str, Any] | None:
    artifact = _candidate_population_artifact(
        result=result,
        seed_candidate=seed_candidate,
        run_id=run_id,
        max_candidates=max_candidates,
        max_candidate_chars=max_candidate_chars,
        selection_scenario_ids=selection_scenario_ids,
    )
    if artifact is None:
        return None
    path = output_root / f"candidate-population-{attempt_id}.json"
    atomic_write_json(path, artifact)
    contents = path.read_bytes()
    return {
        "scope": "gepa-candidate-population",
        "path": str(path),
        "sha256": f"sha256:{hashlib.sha256(contents).hexdigest()}",
        "bytes": len(contents),
        "runId": run_id,
        "candidates": len(artifact["candidates"]),
        "bestIndex": artifact["bestIndex"],
        "maxCandidates": max_candidates,
        "maxCandidateChars": max_candidate_chars,
        "scenarioIds": list(selection_scenario_ids),
        "surfaceKind": "components" if isinstance(seed_candidate, dict) else "text",
    }


def _candidate_population_artifact(
    *,
    result: Any,
    seed_candidate: str | dict[str, str],
    run_id: str,
    max_candidates: int,
    max_candidate_chars: int,
    selection_scenario_ids: list[str],
) -> dict[str, Any] | None:
    # GEPA 0.1.4 returns GEPAResult directly. The pinned source API returns its
    # public Result wrapper and preserves the exact GEPAResult in metadata.
    official_result = _result_metadata(result).get("gepa_result")
    if official_result is not None:
        result = official_result
    field_names = (
        "candidates",
        "parents",
        "val_aggregate_scores",
        "val_subscores",
        "discovery_eval_counts",
    )
    fields = {name: getattr(result, name, None) for name in field_names}
    if all(value is None for value in fields.values()):
        return None
    if any(not isinstance(value, list) for value in fields.values()):
        raise RuntimeError("GEPA produced an incomplete candidate population")

    candidates = fields["candidates"]
    parents = fields["parents"]
    aggregate_scores = fields["val_aggregate_scores"]
    subscores = fields["val_subscores"]
    discovery_counts = fields["discovery_eval_counts"]
    count = len(candidates)
    if count == 0 or count > max_candidates:
        raise RuntimeError(f"GEPA candidate population must contain 1..{max_candidates} candidates")
    population_fields = (parents, aggregate_scores, subscores, discovery_counts)
    if any(len(values) != count for values in population_fields):
        raise RuntimeError("GEPA candidate population fields have different lengths")

    best_index = getattr(result, "best_idx", None)
    if (
        isinstance(best_index, bool)
        or not isinstance(best_index, int)
        or not 0 <= best_index < count
    ):
        raise RuntimeError("GEPA candidate population has an invalid best index")
    string_key = getattr(result, "_str_candidate_key", None)
    rows: list[dict[str, Any]] = []
    for index in range(count):
        candidate = _external_population_candidate(
            candidates[index],
            seed_candidate=seed_candidate,
            string_key=string_key,
        )
        _validate_selected_candidate(candidate, seed_candidate, max_candidate_chars)
        parent_indices = _candidate_parent_indices(parents[index], index)
        selection_scores = _candidate_selection_scores(
            subscores[index], selection_scenario_ids, index
        )
        aggregate_score = _candidate_aggregate_score(
            aggregate_scores[index], selection_scores, index
        )
        discovery_count = discovery_counts[index]
        if (
            isinstance(discovery_count, bool)
            or not isinstance(discovery_count, int)
            or discovery_count < 0
        ):
            raise RuntimeError(f"GEPA candidate {index} has an invalid discovery evaluation count")
        rows.append(
            {
                "index": index,
                "candidate": candidate,
                "parentIndices": parent_indices,
                "aggregateScore": aggregate_score,
                "selectionScores": selection_scores,
                "discoveryEvaluationCount": discovery_count,
            }
        )

    return {
        "schemaVersion": 1,
        "scope": "gepa-candidate-population",
        "runId": run_id,
        "bestIndex": best_index,
        "candidates": rows,
    }


def _external_population_candidate(
    candidate: Any,
    *,
    seed_candidate: str | dict[str, str],
    string_key: Any,
) -> Any:
    if isinstance(seed_candidate, str):
        if isinstance(candidate, str):
            return candidate
        if (
            not isinstance(candidate, dict)
            or not isinstance(string_key, str)
            or not isinstance(candidate.get(string_key), str)
        ):
            raise RuntimeError("GEPA changed a text candidate's population shape")
        return candidate[string_key]
    if not isinstance(candidate, dict):
        raise RuntimeError("GEPA changed a component candidate's population shape")
    return candidate


def _candidate_parent_indices(value: Any, index: int) -> list[int | None]:
    if not isinstance(value, list) or not value:
        raise RuntimeError(f"GEPA candidate {index} has invalid parents")
    parents: list[int | None] = []
    seen: set[int | None] = set()
    for parent in value:
        if parent is None:
            if index != 0:
                raise RuntimeError(f"GEPA candidate {index} has a null parent")
        elif isinstance(parent, bool) or not isinstance(parent, int) or not 0 <= parent < index:
            raise RuntimeError(f"GEPA candidate {index} has an invalid parent index")
        if parent in seen:
            raise RuntimeError(f"GEPA candidate {index} repeats a parent index")
        seen.add(parent)
        parents.append(parent)
    if index == 0 and parents != [None]:
        raise RuntimeError("GEPA root candidate must have one null parent")
    return parents


def _candidate_selection_scores(
    value: Any,
    selection_scenario_ids: list[str],
    candidate_index: int,
) -> list[dict[str, Any]]:
    if not isinstance(value, dict):
        raise RuntimeError(f"GEPA candidate {candidate_index} has invalid selection scores")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_scenario_id, raw_score in value.items():
        if (
            isinstance(raw_scenario_id, int)
            and not isinstance(raw_scenario_id, bool)
            and 0 <= raw_scenario_id < len(selection_scenario_ids)
        ):
            scenario_id = selection_scenario_ids[raw_scenario_id]
        elif isinstance(raw_scenario_id, str) and raw_scenario_id in selection_scenario_ids:
            scenario_id = raw_scenario_id
        else:
            raise RuntimeError(
                f"GEPA candidate {candidate_index} has an unknown selection scenario"
            )
        if (
            isinstance(raw_score, bool)
            or not isinstance(raw_score, (float, int))
            or not math.isfinite(raw_score)
        ):
            raise RuntimeError(f"GEPA candidate {candidate_index} has an invalid selection score")
        if scenario_id in seen:
            raise RuntimeError(f"GEPA candidate {candidate_index} repeats a selection scenario")
        seen.add(scenario_id)
        rows.append({"scenarioId": scenario_id, "score": float(raw_score)})
    return sorted(rows, key=lambda row: row["scenarioId"])


def _candidate_aggregate_score(
    value: Any,
    selection_scores: list[dict[str, Any]],
    candidate_index: int,
) -> float | None:
    if not selection_scores:
        if value != float("-inf"):
            raise RuntimeError(
                f"GEPA candidate {candidate_index} has a score without selection evidence"
            )
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise RuntimeError(f"GEPA candidate {candidate_index} has an invalid aggregate score")
    score = float(value)
    mean = sum(row["score"] for row in selection_scores) / len(selection_scores)
    if not math.isclose(score, mean, rel_tol=1e-9, abs_tol=1e-12):
        raise RuntimeError(
            f"GEPA candidate {candidate_index} aggregate score differs from its selection scores"
        )
    return score


def _missing_composition(kind: str) -> RuntimeError:
    return RuntimeError(
        f"GEPA bridge recipe '{kind}' requires GEPA's official composition "
        "functions. Install the GEPA source commit documented in the "
        "agent-eval-rpc README."
    )


def _forward_seed(engine_config: dict[str, Any], seed: int) -> None:
    """Write the run seed into a GEPAConfig-shaped dict's nested engine settings.

    Both supported GEPA generations read the seed at ``engine.seed``:
    the published 0.1.4 launcher config and the pinned source revision's
    ``engine_config`` pass-through for the standard gepa engine.
    """
    nested_engine = engine_config.setdefault("engine", {})
    if not isinstance(nested_engine, dict):
        raise ValueError("GEPA engineConfig.engine must be an object")
    if "seed" in nested_engine:
        raise ValueError(
            "GEPA engineConfig.engine.seed conflicts with the bridge seed input; "
            "the bridge forwards the run seed"
        )
    nested_engine["seed"] = seed


def _engine_config(
    api: GepaApi,
    run: dict[str, Any],
    output_dir: Path,
    *,
    seed: int,
    model_proxy: dict[str, Any] | None,
    proxy_usage: _ProxyUsage | None,
) -> Any:
    engine_config = copy.deepcopy(run["engineConfig"])
    agent_cli_run = run["engine"] in AGENT_CLI_ENGINES and bool(
        model_proxy is not None and model_proxy.get("anthropicEndpoint")
    )
    if model_proxy is not None and not agent_cli_run:
        # Agent CLI runs receive no reflection model: their claude subprocess
        # meters through the proxy's Anthropic route via the process env.
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

    if api.config_shape == "engine":
        # Agent engines construct strict config dataclasses without a seed
        # field, so the seed reaches only the standard gepa engine.
        if run["engine"] == "gepa":
            _forward_seed(engine_config, seed)
        kwargs: dict[str, Any] = {
            "engine": run["engine"],
            "max_evals": run.get("maxEvaluations"),
            "output_dir": output_dir / "evaluations",
            "run_dir": str(output_dir / "state"),
            "engine_config": engine_config,
            "max_concurrency": run.get("maxConcurrency", 1),
        }
        if run.get("maxProposerCostUsd") is not None:
            kwargs["max_token_cost"] = run["maxProposerCostUsd"]
        if run.get("stopAtScore") is not None:
            kwargs["stop_at_score"] = run["stopAtScore"]
        if run.get("sandbox") is not None:
            kwargs["sandbox"] = run["sandbox"]
        return api.config_class(**kwargs)

    if run["engine"] != "gepa":
        raise RuntimeError(
            f"GEPA engine '{run['engine']}' requires the documented official source revision; "
            "the published package supports the standard 'gepa' engine"
        )
    _forward_seed(engine_config, seed)
    nested_engine = engine_config["engine"]
    nested_engine["max_metric_calls"] = run.get("maxEvaluations")
    if run.get("maxProposerCostUsd") is not None:
        nested_engine["max_reflection_cost"] = run["maxProposerCostUsd"]
    nested_engine["run_dir"] = str(output_dir / "state")
    nested_engine["max_workers"] = run.get("maxConcurrency", 1)
    if run.get("stopAtScore") is not None:
        if "stop_callbacks" in engine_config:
            raise ValueError(
                "GEPA engineConfig.stop_callbacks cannot be serialized; use stopAtScore"
            )
        from gepa.utils import ScoreThresholdStopper

        engine_config["stop_callbacks"] = [ScoreThresholdStopper(run["stopAtScore"])]
    return api.config_class(**engine_config)


def _nested_results(result: Any, key: str) -> list[Any]:
    metadata = _result_metadata(result)
    results = metadata.get(key)
    if not isinstance(results, list) or not results:
        raise RuntimeError(f"GEPA recipe returned no {key}")
    return results


def _result_evaluations(result: Any) -> int:
    total_evaluations = getattr(result, "total_evals", None)
    if total_evaluations is None:
        total_evaluations = getattr(result, "total_metric_calls", None)
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
        metadata = _result_metadata(result)
        adapter_cost = metadata.get("adapter_cost")
        if isinstance(adapter_cost, bool) or not isinstance(adapter_cost, (float, int)):
            return None
        cost = float(adapter_cost)
        if not math.isfinite(cost) or cost < 0:
            return None
        costs.append(cost)
    return sum(costs)


def _result_metadata(result: Any) -> dict[str, Any]:
    metadata = getattr(result, "metadata", None)
    return metadata if isinstance(metadata, dict) else {}


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
