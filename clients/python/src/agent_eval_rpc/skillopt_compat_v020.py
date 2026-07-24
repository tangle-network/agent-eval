"""Version-pinned resume instrumentation for SkillOpt 0.2.0."""

from __future__ import annotations

import hashlib
import inspect
import json
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from types import ModuleType
from typing import Any

SKILLOPT_VERSION = "0.2.0"
_PRIVATE_LOADERS = ("_load_runtime_state", "_load_history")
_PATCH_LOCK = threading.RLock()


@dataclass
class SkillOptV020RestoreTracker:
    """Observe whether SkillOpt consumed the exact state selected for resume."""

    trainer_module: ModuleType
    work_dir: Path
    source: str
    snapshot_digest: str
    runtime_observed: bool = False
    history_observed: bool = False
    runtime_absence_observed: bool = False
    _runtime_loader: Callable[[str], Any] | None = field(default=None, init=False, repr=False)
    _history_loader: Callable[[str], Any] | None = field(default=None, init=False, repr=False)
    _lock_held: bool = field(default=False, init=False, repr=False)

    @property
    def restored(self) -> bool:
        if self.source == "runtime_state":
            return self.runtime_observed
        return self.history_observed and self.runtime_absence_observed

    def __enter__(self) -> SkillOptV020RestoreTracker:
        _PATCH_LOCK.acquire()
        self._lock_held = True
        try:
            runtime_loader, history_loader = _require_compatible_private_api(self.trainer_module)
            self._runtime_loader = runtime_loader
            self._history_loader = history_loader

            def load_runtime_state(out_root: str) -> Any:
                value = runtime_loader(out_root)
                if Path(out_root).resolve() == self.work_dir.resolve():
                    self.runtime_absence_observed = not value
                    if (
                        self.source == "runtime_state"
                        and value
                        and _json_digest(value) == self.snapshot_digest
                    ):
                        self.runtime_observed = True
                return value

            def load_history(out_root: str) -> Any:
                value = history_loader(out_root)
                if (
                    Path(out_root).resolve() == self.work_dir.resolve()
                    and self.source == "history"
                    and value
                    and _json_digest(value) == self.snapshot_digest
                ):
                    self.history_observed = True
                return value

            self.trainer_module._load_runtime_state = load_runtime_state
            self.trainer_module._load_history = load_history
            return self
        except BaseException:
            self._release()
            raise

    def __exit__(self, *_args: Any) -> None:
        self._release()

    def _release(self) -> None:
        try:
            if self._runtime_loader is not None:
                self.trainer_module._load_runtime_state = self._runtime_loader
            if self._history_loader is not None:
                self.trainer_module._load_history = self._history_loader
        finally:
            if self._lock_held:
                self._lock_held = False
                _PATCH_LOCK.release()


def load_restore_tracker(
    trainer_module: ModuleType,
    work_dir: Path,
) -> SkillOptV020RestoreTracker | None:
    """Load compatible state only after proving the pinned private API is present."""

    runtime_loader, history_loader = _require_compatible_private_api(trainer_module)
    if not work_dir.is_dir():
        return None
    try:
        history = history_loader(str(work_dir))
        runtime_state = runtime_loader(str(work_dir))
    except Exception:
        return None
    if runtime_state and _valid_runtime_state(work_dir, runtime_state):
        return SkillOptV020RestoreTracker(
            trainer_module=trainer_module,
            work_dir=work_dir,
            source="runtime_state",
            snapshot_digest=_json_digest(runtime_state),
        )
    if history and _valid_history(work_dir, history):
        return SkillOptV020RestoreTracker(
            trainer_module=trainer_module,
            work_dir=work_dir,
            source="history",
            snapshot_digest=_json_digest(history),
        )
    return None


def _require_compatible_private_api(
    trainer_module: ModuleType,
) -> tuple[Callable[[str], Any], Callable[[str], Any]]:
    try:
        installed_version = metadata.version("skillopt")
    except metadata.PackageNotFoundError as error:
        raise RuntimeError("SkillOpt 0.2.0 is required for resume support") from error
    if installed_version != SKILLOPT_VERSION:
        raise RuntimeError(
            "SkillOpt resume support requires exactly "
            f"{SKILLOPT_VERSION}; found {installed_version}"
        )

    loaders: list[Callable[[str], Any]] = []
    for name in _PRIVATE_LOADERS:
        loader = getattr(trainer_module, name, None)
        if not callable(loader):
            raise RuntimeError(
                f"SkillOpt {SKILLOPT_VERSION} resume support requires "
                f"skillopt.engine.trainer.{name}"
            )
        try:
            parameters = list(inspect.signature(loader).parameters.values())
        except (TypeError, ValueError) as error:
            raise RuntimeError(
                f"Cannot inspect SkillOpt {SKILLOPT_VERSION} private function {name}"
            ) from error
        if (
            len(parameters) != 1
            or parameters[0].name != "out_root"
            or parameters[0].kind
            not in {
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            }
        ):
            raise RuntimeError(
                f"SkillOpt {SKILLOPT_VERSION} private function {name} changed signature"
            )
        loaders.append(loader)
    return loaders[0], loaders[1]


def _valid_runtime_state(work_dir: Path, value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    last_step = value.get("last_completed_step", 0)
    if isinstance(last_step, bool) or not isinstance(last_step, int) or last_step < 0:
        return False
    try:
        current_path = Path(
            value.get("current_skill_path") or work_dir / "skills" / f"skill_v{last_step:04d}.md"
        )
    except TypeError:
        return False
    return _readable_run_file(work_dir, current_path)


def _valid_history(work_dir: Path, value: Any) -> bool:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, dict) for item in value)
    ):
        return False
    last_step = value[-1].get("step")
    if isinstance(last_step, bool) or not isinstance(last_step, int) or last_step < 0:
        return False
    if not _readable_run_file(work_dir, work_dir / "skills" / f"skill_v{last_step:04d}.md"):
        return False
    if (work_dir / "best_skill.md").is_file():
        return True
    try:
        best_record = max(value, key=lambda item: float(item.get("best_score", 0.0)))
    except (TypeError, ValueError):
        return False
    best_step = best_record.get("best_step")
    return (
        not isinstance(best_step, bool)
        and isinstance(best_step, int)
        and best_step >= 0
        and _readable_run_file(
            work_dir,
            work_dir / "skills" / f"skill_v{best_step:04d}.md",
        )
    )


def _readable_run_file(work_dir: Path, path: Path) -> bool:
    try:
        resolved = path.resolve()
        if not resolved.is_relative_to(work_dir.resolve()) or not resolved.is_file():
            return False
        resolved.read_text()
    except (OSError, UnicodeError):
        return False
    return True


def _json_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
