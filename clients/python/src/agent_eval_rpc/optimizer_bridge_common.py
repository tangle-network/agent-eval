from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import platform
import re
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout


def validate_no_secrets(value: Any, path: str, label: str) -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            validate_no_secrets(item, f"{path}[{index}]", label)
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key)).lower().replace("-", "_")
        if any(
            segment
            in {
                "auth",
                "authorization",
                "cookie",
                "credential",
                "credentials",
                "key",
                "password",
                "secret",
                "session",
                "token",
            }
            for segment in normalized.split("_")
        ):
            raise ValueError(f"{label} {path}.{key} must be supplied through the environment")
        validate_no_secrets(item, f"{path}.{key}", label)


def validate_json_size(value: Any, max_chars: int, label: str) -> None:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be finite JSON") from error
    if len(encoded) > max_chars:
        raise ValueError(f"{label} exceeds maxEvidenceChars ({len(encoded)} > {max_chars})")


def validate_optimizer_model_budget(value: Any, label: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    max_cost = value.get("maxCostUsd")
    if (
        isinstance(max_cost, bool)
        or not isinstance(max_cost, (int, float))
        or not math.isfinite(max_cost)
        or max_cost <= 0
    ):
        raise ValueError(f"{label}.maxCostUsd must be a positive finite number")
    for key in (
        "maxRequests",
        "maxRequestBytes",
        "maxResponseBytes",
        "maxOutputTokensPerRequest",
    ):
        entry = value.get(key)
        if isinstance(entry, bool) or not isinstance(entry, int) or entry <= 0:
            raise ValueError(f"{label}.{key} must be a positive integer")
    timeout = value.get("requestTimeoutMs")
    if timeout is not None and (
        isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0
    ):
        raise ValueError(f"{label}.requestTimeoutMs must be a positive integer")
    pricing = value.get("pricing")
    if not isinstance(pricing, dict):
        raise ValueError(f"{label}.pricing must be an object")
    for key in ("inputUsdPerMillion", "outputUsdPerMillion"):
        rate = pricing.get(key)
        if (
            isinstance(rate, bool)
            or not isinstance(rate, (int, float))
            or not math.isfinite(rate)
            or rate < 0
        ):
            raise ValueError(f"{label}.pricing.{key} must be non-negative and finite")


@dataclass(frozen=True)
class LockedRun:
    run_dir: Path
    manifest: dict[str, Any]
    manifest_existed: bool
    restore_requested: bool


def package_provenance(package_name: str) -> dict[str, str]:
    try:
        package = distribution(package_name)
    except PackageNotFoundError as error:
        raise RuntimeError(
            f"{package_name} is importable but its package metadata is unavailable"
        ) from error

    provenance = {"package": package_name, "version": package.version}
    direct_url_text = package.read_text("direct_url.json")
    if not direct_url_text:
        source_url = _project_source_url(package.metadata.get_all("Project-URL") or [])
        if source_url is not None:
            provenance["sourceUrl"] = source_url
        return provenance
    try:
        direct_url = json.loads(direct_url_text)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{package_name} direct_url.json is invalid") from error
    source_url = direct_url.get("url")
    if isinstance(source_url, str) and source_url.strip() and not source_url.startswith("file:"):
        provenance["sourceUrl"] = source_url
    vcs_info = direct_url.get("vcs_info")
    if isinstance(vcs_info, dict):
        revision = vcs_info.get("commit_id")
        if isinstance(revision, str) and revision.strip():
            provenance["revision"] = revision
    return provenance


def inspect_optimizer_runtime(
    *,
    optimizer_package: str,
    optimizer_module: str,
    engine_modules: list[str],
) -> dict[str, Any]:
    return {
        "python": {
            "implementation": sys.implementation.name,
            "version": platform.python_version(),
        },
        "bridge": {
            **package_provenance("agent-eval-rpc"),
            "sourceSha256": module_source_sha256("agent_eval_rpc"),
        },
        "optimizer": {
            **package_provenance(optimizer_package),
            "sourceSha256": module_source_sha256(optimizer_module),
        },
        "engineModules": [
            {"module": module, "sourceSha256": module_source_sha256(module)}
            for module in engine_modules
        ],
    }


def module_source_sha256(module_name: str) -> str:
    spec = importlib.util.find_spec(module_name)
    if spec is None:
        raise RuntimeError(f"module {module_name!r} is unavailable")

    roots = [Path(path) for path in (spec.submodule_search_locations or [])]
    if not roots:
        if not spec.origin or spec.origin in {"built-in", "frozen"}:
            raise RuntimeError(f"module {module_name!r} has no inspectable source")
        roots = [Path(spec.origin)]

    digest = hashlib.sha256()
    files: list[tuple[str, Path]] = []
    for root_index, root in enumerate(roots):
        if root.is_file():
            files.append((f"{root_index}/{root.name}", root))
            continue
        if not root.is_dir():
            raise RuntimeError(f"module {module_name!r} source is unavailable")
        for path in root.rglob("*"):
            if "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"}:
                continue
            if path.is_symlink():
                raise RuntimeError(
                    f"module {module_name!r} source contains unsupported symlink {path}"
                )
            if path.is_file():
                files.append((f"{root_index}/{path.relative_to(root).as_posix()}", path))
    if not files:
        raise RuntimeError(f"module {module_name!r} has no inspectable source files")
    for relative, path in sorted(files):
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def validate_runtime_identity(value: Any, expected: dict[str, Any], label: str) -> None:
    if value != expected:
        raise RuntimeError(f"{label} runtime changed after source inspection")


def _project_source_url(project_urls: list[str]) -> str | None:
    by_label: dict[str, str] = {}
    for project_url in project_urls:
        label, separator, url = project_url.partition(",")
        if separator and url.strip():
            by_label[label.strip().lower()] = url.strip()
    for label in ["repository", "source", "source code", "homepage"]:
        if label in by_label:
            return by_label[label]
    return None


@contextmanager
def locked_run(
    *,
    label: str,
    compatible_run_id: str,
    run_id: str,
    runtime_identity: dict[str, Any],
    resume: str,
    attempt_id: str,
    output_root: Path,
    resume_supported: bool,
    resume_scope: str,
) -> Iterator[LockedRun]:
    if not re.fullmatch(r"[0-9a-f]{64}", compatible_run_id):
        raise RuntimeError(f"{label} compatible run ID is invalid")
    if resume == "required" and not resume_supported:
        raise RuntimeError(
            f"{label} cannot resume {resume_scope}; official upstream state restoration "
            "is not available"
        )

    effective_resume = resume if resume_supported else "never"
    expected_run_id = (
        compatible_run_id if effective_resume != "never" else f"{compatible_run_id}-{attempt_id}"
    )
    if run_id != expected_run_id:
        raise RuntimeError(f"{label} run ID does not match its resume mode and attempt")
    manifest_body = {
        "optimizer": label,
        "compatibleRunId": compatible_run_id,
        "runtime": runtime_identity,
    }
    runs_root = output_root / "runs"
    runs_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    run_dir = runs_root / run_id
    manifest_path = run_dir / "manifest.json"
    manifest = {**manifest_body, "runId": run_id}

    lock = FileLock(f"{run_dir}.lock")
    try:
        lock.acquire(timeout=0)
    except Timeout as error:
        raise RuntimeError(f"{label} run '{run_id}' is already active") from error
    try:
        run_dir_existed = run_dir.exists()
        manifest_existed = manifest_path.exists()
        if effective_resume == "required" and not manifest_existed:
            raise RuntimeError(f"{label} compatible run '{compatible_run_id}' does not exist")
        if effective_resume == "never" and manifest_existed:
            raise RuntimeError(f"{label} fresh run '{run_id}' already exists; use a new attemptId")
        if manifest_existed:
            existing = _read_manifest(label, run_id, manifest_path)
            if existing != manifest:
                raise RuntimeError(f"{label} run '{run_id}' manifest does not match")
        else:
            if run_dir_existed:
                archive_unrestorable_state(run_dir, attempt_id)
            run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            atomic_write_json(manifest_path, manifest)

        yield LockedRun(
            run_dir=run_dir,
            manifest=manifest,
            manifest_existed=manifest_existed,
            restore_requested=manifest_existed and effective_resume != "never",
        )
    finally:
        lock.release()


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(
        path,
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


def atomic_write_text(path: Path, value: str) -> None:
    _atomic_write(path, value.encode())


def archive_unrestorable_state(path: Path, attempt_id: str) -> Path | None:
    if not path.exists():
        return None
    suffix = hashlib.sha256(attempt_id.encode()).hexdigest()[:12]
    archive = path.with_name(f"{path.name}.unrestorable-{suffix}")
    index = 1
    while archive.exists():
        archive = path.with_name(f"{path.name}.unrestorable-{suffix}-{index}")
        index += 1
    os.replace(path, archive)
    _fsync_directory(path.parent)
    return archive


def _read_manifest(label: str, run_id: str, path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} run '{run_id}' has an unreadable manifest") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} run '{run_id}' has an unreadable manifest")
    return value


def _atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
