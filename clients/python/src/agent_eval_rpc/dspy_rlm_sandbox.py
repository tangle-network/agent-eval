"""Probe DSPy's restricted interpreter before admitting any model work."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any


@contextmanager
def _probed_interpreter(dspy: Any) -> Any:
    # RLM's guest imports real DSPy. The default interpreter owns its pinned
    # Pyodide runtime, restricted permissions, bundle and startup snapshots.
    # A custom deno_command cannot provide that supported guest environment.
    interpreter = dspy.PythonInterpreter()
    try:
        try:
            interpreter.provide_dspy()
            probe_output = interpreter.execute("import dspy; print(1+1)")
        except Exception as error:
            raise RuntimeError(
                "DSPy RLM sandbox startup probe failed before any model call"
            ) from error
        if not isinstance(probe_output, str) or probe_output.strip() != "2":
            raise RuntimeError(
                "DSPy RLM sandbox startup probe returned "
                f"{probe_output!r}, expected '2', before any model call"
            )
        yield interpreter, interpreter.deno_command
    finally:
        interpreter.shutdown()


def _pyodide_version() -> str:
    # Optional DSPy is loaded only for an actual RLM invocation.
    from dspy.primitives.sandbox_bundle import PYODIDE_VERSION

    if not isinstance(PYODIDE_VERSION, str) or not PYODIDE_VERSION:
        raise RuntimeError("DSPy's interpreter has no pinned Pyodide identity")
    return PYODIDE_VERSION


def _sandbox_attestation(deno_command: list[str]) -> dict[str, Any]:
    options = [part for part in deno_command[1:] if part.startswith("-")]
    permissions: dict[str, Any] = {}
    for part in options:
        if part in ("-A", "--allow-all"):
            permissions["allow-all"] = {"scoped": False}
            continue
        if part.startswith("--allow-"):
            name, _, value = part.partition("=")
            scope_entries = [entry for entry in value.split(",") if entry] if value else []
            permissions[name.removeprefix("--")] = (
                {"scoped": True, "paths": len(scope_entries)}
                if scope_entries
                else {"scoped": False}
            )
    node_modules_dir = next(
        (part.partition("=")[2] for part in options if part.startswith("--node-modules-dir")),
        "default",
    )
    return {
        "config": "none" if "--no-config" in options else "discovered",
        "nodeModulesDir": node_modules_dir or "default",
        "permissions": permissions,
    }
