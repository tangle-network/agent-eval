"""OpenHands LiteLLM completion-log parser: <name>-<timestamp>.json per LLM call.

CodeTraceBench's swe_raw OpenHands trials publish one JSON file per LLM call
(`messages`, `response`, `kwargs`, `timestamp`, `cost`) instead of an event
stream. History condensation means the final call's message list can be a
truncated view, so the trajectory is read from the call file whose messages
contain the most tool-call steps — the fullest materialized view of the run.
Steps are that view's assistant tool calls (excluding `finish`) in order,
paired with tool results by tool_call_id. This enumeration reproduces the
CodeTraceBench `step_count` on all 313 verified swe_raw OpenHands rows.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from codetracer.models import FileRef, NormalizedTrajectory, StepRecord

_COMPLETION_FILE = re.compile(r"-(\d+(?:\.\d+)?)\.json$")


class OpenHandsCompletionsParser:
    format_id = "openhands_completions"

    def can_parse(self, run_dir: Path) -> bool:
        files = _completion_files(run_dir)
        if not files:
            return False
        try:
            data = json.loads(files[0].read_text(encoding="utf-8", errors="replace"))
        except Exception:
            return False
        return isinstance(data, dict) and "messages" in data and "response" in data

    def parse(self, run_dir: Path) -> NormalizedTrajectory:
        files = _completion_files(run_dir)
        if not files:
            raise ValueError(f"no completion-log files in {run_dir}")
        view, view_path = _fullest_view(files)
        steps = _extract_steps(view, view_path)
        return NormalizedTrajectory(
            steps=steps,
            task_description=_first_user_text(view),
            metadata={"format": self.format_id, "run_dir": str(run_dir), "view": view_path.name},
        )


def _completion_files(run_dir: Path) -> list[Path]:
    out: list[tuple[float, Path]] = []
    for path in run_dir.iterdir():
        if not path.is_file():
            continue
        match = _COMPLETION_FILE.search(path.name)
        if not match:
            continue
        try:
            timestamp = float(match.group(1))
        except ValueError:
            continue
        out.append((timestamp, path))
    return [path for _, path in sorted(out)]


def _fullest_view(files: list[Path]) -> tuple[list[dict[str, Any]], Path]:
    best: list[dict[str, Any]] | None = None
    best_path: Path | None = None
    best_count = -1
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        messages = data.get("messages")
        if not isinstance(messages, list):
            raise ValueError(f"{path.name} has no messages list")
        count = _step_count(messages)
        if count > best_count:
            best, best_path, best_count = messages, path, count
    assert best is not None and best_path is not None
    return best, best_path


def _step_count(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if _call_name(call) != "finish":
                total += 1
    return total


def _call_name(call: dict[str, Any]) -> str:
    function = call.get("function") or {}
    return function.get("name") or "" if isinstance(function, dict) else ""


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(parts)
    return ""


def _action_text(call: dict[str, Any]) -> str:
    name = _call_name(call)
    function = call.get("function") or {}
    raw_args = function.get("arguments") if isinstance(function, dict) else ""
    args: Any = None
    if isinstance(raw_args, str):
        try:
            args = json.loads(raw_args)
        except ValueError:
            args = None
    text: str | None = None
    if isinstance(args, dict):
        if name == "execute_bash" and isinstance(args.get("command"), str):
            text = args["command"]
        elif name in ("execute_ipython_cell", "run_ipython") and isinstance(args.get("code"), str):
            text = args["code"]
        elif name == "think" and isinstance(args.get("thought"), str):
            text = args["thought"]
    if text is None:
        rendered = raw_args if isinstance(raw_args, str) else json.dumps(raw_args, ensure_ascii=False)
        text = f"{name}({rendered})"
    # Blank commands (bare Enter, empty send) are annotated steps; render
    # them as their JSON literal so the step survives non-empty action gates
    # losslessly.
    if not text.strip():
        text = json.dumps(text, ensure_ascii=False)
    return text


def _memory_ref(payload: Any) -> FileRef:
    return FileRef(
        path="<memory>",
        line_start=1,
        line_end=1,
        content=json.dumps(payload, ensure_ascii=False),
    )


def _extract_steps(messages: list[dict[str, Any]], view_path: Path) -> list[StepRecord]:
    results: dict[str, dict[str, Any]] = {}
    for message in messages:
        call_id = message.get("tool_call_id")
        if message.get("role") == "tool" and isinstance(call_id, str) and call_id not in results:
            results[call_id] = message

    pending: list[tuple[dict[str, Any], str | None]] = []
    for message in messages:
        if message.get("role") != "assistant":
            continue
        thinking = _text(message.get("content")).strip() or None
        for call in message.get("tool_calls") or []:
            if _call_name(call) == "finish":
                continue
            pending.append((call, thinking))
            thinking = None

    steps: list[StepRecord] = []
    for index, (call, thinking) in enumerate(pending):
        call_id = call.get("id")
        result = results.get(call_id) if isinstance(call_id, str) else None
        if result is None and index != len(pending) - 1:
            raise ValueError(
                f"{view_path.name}: tool call {call_id!r} at step {index + 1} has no result"
            )
        steps.append(
            StepRecord(
                step_id=index + 1,
                action=_action_text(call),
                observation=_text(result.get("content")) if result else None,
                thinking=thinking,
                tool_type=_call_name(call) or None,
                action_ref=_memory_ref(call),
                observation_ref=_memory_ref(result) if result else None,
            )
        )
    return steps


def _first_user_text(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") == "user":
            return _text(message.get("content"))
    return ""


parser = OpenHandsCompletionsParser()
