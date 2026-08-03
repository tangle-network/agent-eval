"""SWE-agent .traj parser: one step per `trajectory[]` entry, in order.

CodeTraceBench annotates classic SWE-agent runs against the .traj file's
`trajectory` array: every entry is one step, including entries whose action
is blank. This enumeration reproduces the CodeTraceBench `step_count` on
106/108 verified SWE-agent rows; the other 2 archives publish a
function-call-style trajectory (92-94% empty `response` fields) whose
annotated view condensed the run, so no published view matches and those
rows must fail step-count checks rather than import misaligned labels.

The run directory holds exactly one `<trial>.traj`; ambiguity (zero or
several .traj files) refuses detection instead of guessing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from codetracer.models import FileRef, NormalizedTrajectory, StepRecord

_DEMONSTRATION_MARKER = "--- DEMONSTRATION ---"


class SweAgentTrajParser:
    format_id = "sweagent_traj"

    def can_parse(self, run_dir: Path) -> bool:
        traj_path = _single_traj_file(run_dir)
        if traj_path is None:
            return False
        try:
            data = json.loads(traj_path.read_text(encoding="utf-8", errors="replace"))
        except ValueError:
            return False
        return isinstance(data, dict) and isinstance(data.get("trajectory"), list)

    def parse(self, run_dir: Path) -> NormalizedTrajectory:
        traj_path = _single_traj_file(run_dir)
        if traj_path is None:
            raise ValueError(f"expected exactly one .traj file in {run_dir}")
        data = json.loads(traj_path.read_text(encoding="utf-8", errors="replace"))
        trajectory = data.get("trajectory")
        if not isinstance(trajectory, list):
            raise ValueError(f"{traj_path.name} has no trajectory array")
        steps = [
            _step(index, entry, traj_path)
            for index, entry in enumerate(trajectory)
        ]
        return NormalizedTrajectory(
            steps=steps,
            task_description=_task_text(data),
            metadata={"format": self.format_id, "run_dir": str(run_dir), "traj": traj_path.name},
        )


def _single_traj_file(run_dir: Path) -> Path | None:
    if not run_dir.is_dir():
        return None
    candidates = sorted(p for p in run_dir.glob("*.traj") if p.is_file())
    return candidates[0] if len(candidates) == 1 else None


def _step(index: int, entry: Any, traj_path: Path) -> StepRecord:
    label = f"{traj_path.name}#trajectory[{index}]"
    if not isinstance(entry, dict):
        raise ValueError(f"{label} is not an object")
    observation = entry.get("observation")
    if observation is not None and not isinstance(observation, str):
        raise ValueError(f"{label}.observation is neither a string nor null")
    thought = entry.get("thought")
    thinking = thought if isinstance(thought, str) and thought.strip() else None
    return StepRecord(
        step_id=index + 1,
        action=_action_text(entry.get("action")),
        observation=observation,
        thinking=thinking,
        action_ref=FileRef(
            path=label,
            line_start=1,
            line_end=1,
            content=json.dumps(entry, ensure_ascii=False),
        ),
        # The raw entry in action_ref already carries the observation's
        # source; a second ref would only duplicate it.
        observation_ref=None,
    )


def _action_text(raw: Any) -> str:
    text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
    # Blank actions (empty send, model returned no command) are annotated
    # steps; render them as their JSON literal so the step survives
    # non-empty action gates losslessly.
    if not text.strip():
        text = json.dumps(text, ensure_ascii=False)
    return text


def _task_text(data: dict[str, Any]) -> str:
    """First user history message that is not the interface demonstration."""
    history = data.get("history")
    if not isinstance(history, list):
        return ""
    for message in history:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, str) or _DEMONSTRATION_MARKER in content:
            continue
        if content.strip():
            return content.strip()
    return ""


parser = SweAgentTrajParser()
