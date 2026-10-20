"""Start and probe the restricted Deno/Pyodide interpreter."""

from __future__ import annotations

import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from agent_eval_rpc.dspy_rlm_validation import (
    _reject_json_constant,
)


@contextmanager
def _probed_interpreter(dspy: Any) -> Any:
    with tempfile.TemporaryDirectory(prefix="agent-eval-dspy-rlm-") as import_map_dir:
        import_map_path = Path(import_map_dir) / "import-map.json"
        import_map_path.write_text(json.dumps(_PYODIDE_IMPORT_MAP), encoding="utf-8")
        deno_command = _build_deno_command(dspy, import_map_path)
        yield from _run_probed_interpreter(dspy, deno_command)


def _run_probed_interpreter(dspy: Any, deno_command: list[str]) -> Any:
    interpreter = dspy.PythonInterpreter(deno_command=deno_command)
    try:
        try:
            probe_output = interpreter.execute("print(1+1)")
        except Exception as error:
            raise RuntimeError(
                "DSPy RLM sandbox startup probe failed before any model call"
            ) from error
        if not isinstance(probe_output, str) or probe_output.strip() != "2":
            raise RuntimeError(
                "DSPy RLM sandbox startup probe returned "
                f"{probe_output!r}, expected '2', before any model call"
            )
        yield interpreter, deno_command
    finally:
        interpreter.shutdown()


# DSPy's runner.js imports npm:pyodide without a version, and --no-config means
# no lockfile: a cold cache would execute whatever npm dist-tags.latest points
# at. The import map pins the interpreter the sandbox runs; transitive npm
# ranges below this root are the residual unpinned surface.
_PYODIDE_VERSION = "314.0.3"


_PYODIDE_IMPORT_MAP = {
    "imports": {"npm:pyodide/pyodide.js": f"npm:pyodide@{_PYODIDE_VERSION}/pyodide.js"}
}


def _build_deno_command(dspy: Any, import_map_path: Path) -> list[str]:
    deno_executable = _find_deno_executable()
    runner_path = _dspy_runner_path(dspy)
    deno_cache_dir = _deno_cache_dir(deno_executable)
    for label, path in (("DSPy runner", runner_path), ("Deno cache", deno_cache_dir)):
        if "," in str(path):
            raise RuntimeError(f"{label} path cannot contain a comma: {path}")
    return [
        str(deno_executable),
        "run",
        "--no-config",
        f"--import-map={import_map_path}",
        "--node-modules-dir=none",
        f"--allow-read={runner_path},{deno_cache_dir}",
        str(runner_path),
    ]


def _find_deno_executable() -> Path:
    executable_name = "deno.exe" if os.name == "nt" else "deno"
    beside_python = Path(sys.executable).parent / executable_name
    if beside_python.is_file() and os.access(beside_python, os.X_OK):
        return beside_python.resolve()

    from_path = shutil.which(executable_name)
    if from_path is not None:
        return Path(from_path).resolve()

    try:
        from deno import find_deno_bin

        packaged = Path(find_deno_bin())
    except (FileNotFoundError, ImportError) as error:
        raise RuntimeError(
            "DSPy RLM requires the deno==2.9.7 executable beside the Python interpreter"
        ) from error
    if not packaged.is_file() or not os.access(packaged, os.X_OK):
        raise RuntimeError(f"DSPy RLM Deno executable is not executable: {packaged}")
    return packaged.resolve()


def _dspy_runner_path(dspy: Any) -> Path:
    runner_path = Path(inspect.getfile(dspy.PythonInterpreter)).with_name("runner.js")
    if not runner_path.is_file():
        raise RuntimeError(f"DSPy PythonInterpreter runner is unavailable: {runner_path}")
    return runner_path.resolve()


def _deno_cache_dir(deno_executable: Path) -> Path:
    configured = os.environ.get("DENO_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    try:
        completed = subprocess.run(
            [str(deno_executable), "info", "--json", "--no-config"],
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("DSPy RLM could not inspect the Deno cache directory") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or f"exit code {completed.returncode}"
        raise RuntimeError(f"DSPy RLM could not inspect the Deno cache directory: {detail}")
    try:
        info = json.loads(completed.stdout, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("Deno info returned invalid JSON") from error
    deno_dir = info.get("denoDir") if isinstance(info, dict) else None
    if not isinstance(deno_dir, str) or not deno_dir.strip():
        raise RuntimeError("Deno info did not report denoDir")
    return Path(deno_dir).expanduser().resolve()


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
