"""Exercise the bridge on retained artifact responses, without a model request."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from agent_eval_rpc.gepa_api import load_gepa_api
from agent_eval_rpc.gepa_bridge import _decode_images, _run_recipe
from gepa.strategies.instruction_proposal import InstructionProposalSignature


def main() -> None:
    responses = json.loads(Path(sys.argv[1]).read_text())
    output = Path(sys.argv[2])
    rows = {row["info"]["scenarioId"]: row for row in responses}
    if len(rows) < 3:
        raise ValueError("Requires three distinct retained scenarios")
    calls: list[str] = []

    def evaluate(_candidate: Any, example: dict[str, Any]) -> tuple[float, dict[str, Any]]:
        row = rows[example["id"]]
        calls.append(example["id"])
        return row["score"], _decode_images(row["info"])

    def refuse_model(_prompt: Any) -> str:
        raise RuntimeError("This retained proof never authorizes a model request")

    api = load_gepa_api()
    result, _ = _run_recipe(
        recipe={"kind": "engine", "run": {
            "engine": "gepa", "maxEvaluations": len(rows),
            "engineConfig": {
                "engine": {"max_workers": 1, "parallel": False,
                           "capture_stdio": False, "frontier_type": "hybrid"},
                "reflection": {"reflection_lm": refuse_model},
            },
        }},
        seed=1, seed_candidate="retained-source", evaluator=evaluate,
        train_set=[{"id": key} for key in rows],
        selection_set=[{"id": key} for key in rows],
        objective="Retain the measured per-objective frontier; no generation",
        background="Replay of retained actual renders, not an optimization quality result",
        output_dir=output, api=api, model_proxy=None, proxy_usage=None,
    )
    if len(calls) != len(rows):
        raise ValueError("Unexpected GEPA callback count")
    population = result.to_dict()
    objective_keys = set(responses[0]["info"]["scores"])
    if set(population.get("objective_pareto_front", {})) != objective_keys:
        raise ValueError("Official frontier lost objective keys")
    aggregate = population.get("val_aggregate_subscores", [])
    if len(aggregate) != 1 or set(aggregate[0]) != objective_keys:
        raise ValueError("Official aggregate lost objective scores")
    for key in objective_keys:
        expected = sum(row["info"]["scores"][key] for row in responses) / len(responses)
        if abs(aggregate[0][key] - expected) > 1e-10:
            raise ValueError(f"Official aggregate changed objective {key}")
    (output / "frontier.json").write_text(json.dumps(population, default=str, indent=2))
    prompt = InstructionProposalSignature.prompt_renderer({
        "current_instruction_doc": "retained-source",
        "dataset_with_feedback": [_decode_images(row["info"]) for row in responses],
    })
    if not isinstance(prompt, list):
        raise ValueError("Official reflection renderer did not emit multimodal messages")
    images = [part for message in prompt for part in message["content"] if part["type"] == "image_url"]
    if len(images) != len(rows):
        raise ValueError("Reflection lost a retained image")
    (output / "reflection-prompt.json").write_text(json.dumps(prompt))
    summary = {
        "scenarios": calls, "objectiveKeys": sorted(responses[0]["info"]["scores"]),
        "frontierKeys": sorted(population), "imageParts": len(images),
        "modelRequests": 0, "scope": "Baseline frontier and actual reflection prompt construction only; no search or quality improvement claim",
        "promptSha256": hashlib.sha256(json.dumps(prompt).encode()).hexdigest(),
    }
    (output / "bridge-proof.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
