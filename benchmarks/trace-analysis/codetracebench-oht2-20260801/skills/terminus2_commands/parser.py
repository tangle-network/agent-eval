"""Terminus2 command-level parser: one step per issued command, not per episode.

CodeTraceBench annotates Terminus2 trajectories at the granularity of
individual commands: every entry of an episode response's `commands` array is
one step, in episode order then array order. Episodes whose response.txt is
not JSON (or carries no commands) contribute no steps. This enumeration
reproduces the CodeTraceBench `step_count` on 220/222 verified Terminus2
rows; the remaining 2 archives contain no agent-logs data at all.

Terminal output is only observable per episode (the next episode's prompt),
so it attaches to the episode's final command; earlier commands in the same
batch carry a null observation and share a `parallel_group` equal to the
episode number.
"""

from __future__ import annotations

import json
from pathlib import Path

from codetracer.models import FileRef, NormalizedTrajectory, StepRecord


class Terminus2CommandsParser:
    format_id = "terminus2_commands"

    def can_parse(self, run_dir: Path) -> bool:
        agent_logs = run_dir / "agent-logs"
        if not agent_logs.is_dir():
            return False
        for episode in agent_logs.iterdir():
            if (
                episode.is_dir()
                and episode.name.startswith("episode-")
                and (episode / "response.txt").exists()
            ):
                return True
        return False

    def parse(self, run_dir: Path) -> NormalizedTrajectory:
        steps = _extract_steps(run_dir)
        return NormalizedTrajectory(
            steps=steps,
            task_description=_read_task(run_dir),
            metadata={"format": self.format_id, "run_dir": str(run_dir)},
        )


def _safe_read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def _file_ref(path: Path, base: Path) -> FileRef | None:
    if not path.exists():
        return None
    content = _safe_read(path)
    lines = content.splitlines()
    rel = str(path.relative_to(base)) if base in path.parents else str(path)
    return FileRef(path=rel, line_start=1, line_end=max(1, len(lines)), content=content)


def _episode_commands(response_text: str) -> tuple[list[str], str | None]:
    """Return the episode's command keystrokes and its reasoning text."""
    try:
        obj = json.loads(response_text)
    except ValueError:
        return [], None
    if not isinstance(obj, dict):
        return [], None
    keystrokes: list[str] = []
    commands = obj.get("commands")
    if isinstance(commands, list):
        for command in commands:
            if isinstance(command, dict):
                value = command.get("keystrokes")
                keystrokes.append(value if isinstance(value, str) else json.dumps(command, ensure_ascii=False))
            elif isinstance(command, str):
                keystrokes.append(command)
    analysis = obj.get("analysis") or obj.get("state_analysis") or ""
    plan = obj.get("plan") or obj.get("explanation") or ""
    thinking = "\n".join(part for part in (analysis, plan) if isinstance(part, str) and part)
    return keystrokes, (thinking or None)


def _action_text(keystrokes: str) -> str:
    # Blank keystrokes (bare Enter, empty send) are annotated steps; render
    # them as their JSON literal so the step survives non-empty action gates
    # while the exact keystrokes stay recoverable.
    if keystrokes.strip():
        return keystrokes
    return json.dumps(keystrokes, ensure_ascii=False)


def _observation_text(prompt_text: str) -> str:
    marker = "New Terminal Output:"
    index = prompt_text.find(marker)
    if index != -1:
        return prompt_text[index + len(marker):].strip()
    return prompt_text.strip()


def _extract_steps(run_dir: Path) -> list[StepRecord]:
    logs = run_dir / "agent-logs"
    if not logs.is_dir():
        return []
    numbers = []
    for path in logs.iterdir():
        if path.is_dir() and path.name.startswith("episode-"):
            try:
                numbers.append(int(path.name.split("-", 1)[1]))
            except ValueError:
                pass
    steps: list[StepRecord] = []
    for episode in sorted(numbers):
        response_path = logs / f"episode-{episode}" / "response.txt"
        if not response_path.exists():
            continue
        keystrokes, thinking = _episode_commands(_safe_read(response_path))
        if not keystrokes:
            continue
        next_prompt = logs / f"episode-{episode + 1}" / "prompt.txt"
        action_ref = _file_ref(response_path, run_dir)
        for position, keys in enumerate(keystrokes):
            final = position == len(keystrokes) - 1
            observation = (
                _observation_text(_safe_read(next_prompt))
                if final and next_prompt.exists()
                else None
            )
            steps.append(
                StepRecord(
                    step_id=len(steps) + 1,
                    action=_action_text(keys),
                    observation=observation,
                    thinking=thinking if position == 0 else None,
                    parallel_group=episode,
                    action_ref=action_ref,
                    observation_ref=_file_ref(next_prompt, run_dir) if observation is not None else None,
                )
            )
    return steps


def _read_task(run_dir: Path) -> str:
    results = run_dir / "results.json"
    if results.exists():
        try:
            value = json.loads(_safe_read(results)).get("instruction", "")
            return value if isinstance(value, str) else ""
        except ValueError:
            pass
    return ""


parser = Terminus2CommandsParser()
