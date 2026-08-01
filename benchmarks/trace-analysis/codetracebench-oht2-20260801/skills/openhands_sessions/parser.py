"""OpenHands session-event parser matching the CodeTraceBench annotation.

CodeTraceBench counts every action event that received a cause-paired
observation — run, run_ipython, read, edit, think, recall alike — not just
terminal commands, so the seed openhands skill (run/run_ipython only)
undercounts. Events are read from the first available view: the flat
sessions/*.json export, then sessions/sessions/<id>/events/, then
event_cache shards. This enumeration reproduces the CodeTraceBench
`step_count` on 183 of 199 verified terminal-bench OpenHands rows; the
rest are archives whose published views disagree with the annotation and
they fail loudly on the step-count gate.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from codetracer.models import FileRef, NormalizedTrajectory, StepRecord

_SHARD = re.compile(r"^(\d+)-(\d+)\.json$")


class OpenHandsSessionsParser:
    format_id = "openhands_sessions"

    def can_parse(self, run_dir: Path) -> bool:
        sessions = run_dir / "sessions"
        if not sessions.is_dir():
            return False
        if (sessions / "sessions").is_dir():
            return True
        return any(p.suffix == ".json" for p in sessions.iterdir() if p.is_file())

    def parse(self, run_dir: Path) -> NormalizedTrajectory:
        events, view = _load_events(run_dir)
        steps = _extract_steps(events)
        return NormalizedTrajectory(
            steps=steps,
            task_description=_task_text(events, run_dir),
            metadata={"format": self.format_id, "run_dir": str(run_dir), "view": view},
        )


def _load_events(run_dir: Path) -> tuple[list[dict[str, Any]], str]:
    sessions = run_dir / "sessions"
    flat = [p for p in sessions.iterdir() if p.is_file() and p.suffix == ".json"]
    if flat:
        main = max(flat, key=lambda p: p.stat().st_size)
        data = json.loads(main.read_text(encoding="utf-8", errors="replace"))
        if isinstance(data, list) and data:
            return [e for e in data if isinstance(e, dict)], "flat"
    root = sessions / "sessions"
    if root.is_dir():
        for session_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            events_dir = session_dir / "events"
            if events_dir.is_dir():
                events = []
                for path in events_dir.iterdir():
                    if path.suffix != ".json":
                        continue
                    try:
                        event = json.loads(path.read_text(encoding="utf-8", errors="replace"))
                    except ValueError:
                        continue
                    if isinstance(event, dict):
                        events.append(event)
                if events:
                    events.sort(key=_event_id)
                    return events, "events"
            cache_dir = session_dir / "event_cache"
            if cache_dir.is_dir():
                events = []
                for path in sorted(cache_dir.iterdir(), key=_shard_key):
                    try:
                        shard = json.loads(path.read_text(encoding="utf-8", errors="replace"))
                    except ValueError:
                        continue
                    if isinstance(shard, list):
                        events.extend(e for e in shard if isinstance(e, dict))
                if events:
                    events.sort(key=_event_id)
                    return events, "cache"
    raise ValueError(f"no OpenHands session events in {run_dir}")


def _event_id(event: dict[str, Any]) -> int:
    value = event.get("id")
    return value if isinstance(value, int) else 10**9


def _shard_key(path: Path) -> tuple[int, int]:
    match = _SHARD.match(path.name)
    return (int(match.group(1)), int(match.group(2))) if match else (10**9, 10**9)


def _action_text(event: dict[str, Any]) -> str:
    action = event.get("action") or ""
    args = event.get("args") if isinstance(event.get("args"), dict) else {}
    if action == "run" and isinstance(args.get("command"), str):
        text = args["command"]
    elif action == "run_ipython" and isinstance(args.get("code"), str):
        text = args["code"]
    elif action == "think" and isinstance(args.get("thought"), str):
        text = args["thought"]
    else:
        rendered = {k: v for k, v in args.items() if k != "thought"}
        text = f"{action}({json.dumps(rendered, ensure_ascii=False)})"
    # Blank commands (bare Enter) are annotated steps; render them as their
    # JSON literal so the step survives non-empty action gates losslessly.
    if not text.strip():
        text = json.dumps(text, ensure_ascii=False)
    return text


def _thinking_text(event: dict[str, Any]) -> str | None:
    if event.get("action") == "think":
        return None
    args = event.get("args") if isinstance(event.get("args"), dict) else {}
    thought = args.get("thought")
    if isinstance(thought, str) and thought.strip():
        return thought
    return None


def _memory_ref(payload: Any) -> FileRef:
    return FileRef(
        path="<memory>",
        line_start=1,
        line_end=1,
        content=json.dumps(payload, ensure_ascii=False),
    )


def _extract_steps(events: list[dict[str, Any]]) -> list[StepRecord]:
    observations: dict[int, dict[str, Any]] = {}
    for event in events:
        cause = event.get("cause")
        if isinstance(cause, int) and "observation" in event:
            observations.setdefault(cause, event)

    steps: list[StepRecord] = []
    for event in events:
        event_id = event.get("id")
        if "action" not in event or not isinstance(event_id, int):
            continue
        observed = observations.get(event_id)
        if observed is None:
            continue
        content = observed.get("content")
        steps.append(
            StepRecord(
                step_id=len(steps) + 1,
                action=_action_text(event),
                observation=content if isinstance(content, str) else "",
                thinking=_thinking_text(event),
                tool_type=event.get("action") or None,
                action_ref=_memory_ref(event),
                observation_ref=_memory_ref(observed),
            )
        )
    return steps


def _task_text(events: list[dict[str, Any]], run_dir: Path) -> str:
    for event in events:
        if event.get("action") == "message" and event.get("source") == "user":
            args = event.get("args") if isinstance(event.get("args"), dict) else {}
            content = args.get("content")
            if isinstance(content, str) and content.strip():
                return content
    results = run_dir / "results.json"
    if results.exists():
        try:
            value = json.loads(
                results.read_text(encoding="utf-8", errors="replace")
            ).get("instruction", "")
            if isinstance(value, str):
                return value
        except ValueError:
            pass
    return ""


parser = OpenHandsSessionsParser()
