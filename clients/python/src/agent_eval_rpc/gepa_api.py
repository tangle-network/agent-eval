"""Resolve the installed GEPA Optimize Anything API without replacing its search."""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from types import ModuleType
from typing import Any, Literal


@dataclass(frozen=True)
class GepaApi:
    module: ModuleType
    config_class: Any
    config_shape: Literal["engine", "launcher"]

    @property
    def optimize_anything(self) -> Any:
        return self.module.optimize_anything

    def composition(self, name: str) -> Any | None:
        return getattr(self.module, name, None)


def load_gepa_api() -> GepaApi:
    try:
        module = importlib.import_module("gepa.optimize_anything")
    except ImportError as error:
        raise RuntimeError(
            "GEPA bridge requires the official gepa package. "
            'Install "gepa[full]==0.1.4" or the documented source revision.'
        ) from error

    optimize_anything = getattr(module, "optimize_anything", None)
    if not callable(optimize_anything):
        raise RuntimeError("Installed GEPA package does not expose optimize_anything()")

    engine_config = getattr(module, "OptimizeAnythingConfig", None)
    if engine_config is not None:
        return GepaApi(
            module=module,
            config_class=engine_config,
            config_shape="engine",
        )

    launcher_config = getattr(module, "GEPAConfig", None)
    if launcher_config is not None:
        return GepaApi(
            module=module,
            config_class=launcher_config,
            config_shape="launcher",
        )

    raise RuntimeError(
        "Installed GEPA package exposes neither OptimizeAnythingConfig nor GEPAConfig"
    )
