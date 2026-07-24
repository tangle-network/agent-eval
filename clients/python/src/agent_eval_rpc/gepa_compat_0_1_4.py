from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

GEPA_VERSION = "0.1.4"
GEPA_REVISION = "f919db0a622e2e9f9204779b81fe00cc1b2d808f"


@dataclass
class GepaRestoreObserver:
    state_dir: Path
    state_iteration: int
    state_evaluations: int
    state_candidates: list[Any]
    restored: bool = False
    _engine_module: ModuleType | None = None
    _original_initialize: Any = None

    def __enter__(self) -> GepaRestoreObserver:
        import gepa.core.engine as engine_module

        original_initialize = engine_module.initialize_gepa_state
        if (
            getattr(original_initialize, "__module__", None) != "gepa.core.state"
            or getattr(original_initialize, "__name__", None) != "initialize_gepa_state"
        ):
            raise RuntimeError(
                "GEPA 0.1.4 resume compatibility no longer matches "
                "gepa.core.engine.initialize_gepa_state"
            )

        self._engine_module = engine_module
        self._original_initialize = original_initialize

        def initialize_and_observe(*args: Any, **kwargs: Any) -> Any:
            state = original_initialize(*args, **kwargs)
            run_dir = kwargs.get("run_dir", args[0] if args else None)
            if run_dir is not None and Path(run_dir).resolve() == self.state_dir.resolve():
                if (
                    state.i != self.state_iteration
                    or state.total_num_evals != self.state_evaluations
                    or state.program_candidates != self.state_candidates
                ):
                    raise RuntimeError(
                        "GEPA loaded state that differs from the compatible run snapshot"
                    )
                self.restored = True
            return state

        engine_module.initialize_gepa_state = initialize_and_observe
        return self

    def __exit__(self, *_args: Any) -> None:
        if self._engine_module is not None and self._original_initialize is not None:
            self._engine_module.initialize_gepa_state = self._original_initialize


def load_restore_observer(
    run_dir: Path,
    upstream: dict[str, str],
    *,
    trusted: bool,
) -> GepaRestoreObserver | None:
    state_dir = run_dir / "engine" / "state"
    state_path = state_dir / "gepa_state.bin"
    try:
        state_info = state_path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(state_info.st_mode):
        raise RuntimeError("GEPA resume state must be a regular file")
    if not trusted:
        raise RuntimeError(
            "GEPA resume state uses Python pickle; set trustedResumeState only "
            "for state created locally in a directory you control"
        )
    _validate_local_state_permissions(run_dir, state_path)
    revision = upstream.get("revision")
    if upstream.get("version") != GEPA_VERSION or revision not in {None, GEPA_REVISION}:
        raise RuntimeError(
            "GEPA resume observation supports only the published "
            f"{GEPA_VERSION} package or revision {GEPA_REVISION}"
        )
    try:
        from gepa.core.state import GEPAState

        state = GEPAState.load(str(state_dir))
    except Exception:
        return None
    return GepaRestoreObserver(
        state_dir=state_dir,
        state_iteration=state.i,
        state_evaluations=state.total_num_evals,
        state_candidates=list(state.program_candidates),
    )


def _validate_local_state_permissions(run_dir: Path, state_path: Path) -> None:
    if os.name != "posix" or not hasattr(os, "geteuid"):
        raise RuntimeError("GEPA pickle resume requires POSIX ownership checks")
    expected_owner = os.geteuid()
    paths = [
        run_dir,
        run_dir / "engine",
        run_dir / "engine" / "state",
        state_path,
    ]
    for path in paths:
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise RuntimeError(f"GEPA resume path disappeared: {path}") from error
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError(f"GEPA resume path must not be a symlink: {path}")
        if info.st_uid != expected_owner:
            raise RuntimeError(f"GEPA resume path is not owned by the current user: {path}")
        if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise RuntimeError(f"GEPA resume path is writable by another user: {path}")
