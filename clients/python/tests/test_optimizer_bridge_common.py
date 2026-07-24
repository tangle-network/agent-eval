from __future__ import annotations

import importlib
import json
import re
import threading
from pathlib import Path

import pytest

import agent_eval_rpc.optimizer_bridge_common as optimizer_bridge_common
from agent_eval_rpc.optimizer_bridge_common import (
    atomic_write_json,
    atomic_write_text,
    inspect_optimizer_runtime,
    locked_run,
    module_source_sha256,
    package_provenance,
    validate_no_secrets,
    validate_runtime_identity,
)

COMPATIBLE_RUN_ID = "1" * 64
OTHER_COMPATIBLE_RUN_ID = "2" * 64
RUNTIME_IDENTITY = {
    "python": {"implementation": "cpython", "version": "3.12.0"},
    "bridge": {
        "package": "agent-eval-rpc",
        "version": "0.125.0",
        "sourceSha256": "3" * 64,
    },
    "optimizer": {
        "package": "test-optimizer",
        "version": "1.0.0",
        "sourceSha256": "4" * 64,
    },
    "engineModules": [],
}


def test_pinned_upstream_packages_report_exact_sources() -> None:
    gepa = package_provenance("gepa")
    assert gepa == {
        "package": "gepa",
        "version": "0.1.4",
        "sourceUrl": "https://github.com/gepa-ai/gepa.git",
        "revision": "f919db0a622e2e9f9204779b81fe00cc1b2d808f",
    }

    skillopt = package_provenance("skillopt")
    assert skillopt == {
        "package": "skillopt",
        "version": "0.2.0",
        "sourceUrl": "https://github.com/microsoft/SkillOpt.git",
        "revision": "61735e3922efc2b90c6d6cab561e62e98452ca90",
    }


@pytest.mark.parametrize(
    "key",
    [
        "apiKey",
        "AWS_SECRET_ACCESS_KEY",
        "custom-auth-token",
        "database_password",
        "session_cookie",
    ],
)
def test_secret_validation_rejects_common_credential_names(key: str) -> None:
    with pytest.raises(ValueError, match="must be supplied through the environment"):
        validate_no_secrets({"nested": [{key: "secret"}]}, "config", "optimizer")


def test_runtime_inspection_hashes_bridge_optimizer_and_engine_sources() -> None:
    runtime = inspect_optimizer_runtime(
        optimizer_package="gepa",
        optimizer_module="gepa",
        engine_modules=["agent_eval_rpc.optimizer_bridge_common"],
    )

    assert runtime["bridge"] == {
        **package_provenance("agent-eval-rpc"),
        "sourceSha256": module_source_sha256("agent_eval_rpc"),
    }
    assert runtime["optimizer"] == {
        **package_provenance("gepa"),
        "sourceSha256": module_source_sha256("gepa"),
    }
    assert runtime["engineModules"] == [
        {
            "module": "agent_eval_rpc.optimizer_bridge_common",
            "sourceSha256": module_source_sha256("agent_eval_rpc.optimizer_bridge_common"),
        }
    ]
    assert re.fullmatch(r"[0-9a-f]{64}", runtime["bridge"]["sourceSha256"])
    assert re.fullmatch(r"[0-9a-f]{64}", runtime["optimizer"]["sourceSha256"])


def test_module_source_hash_changes_with_source_content(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    module_path = tmp_path / "sample_optimizer.py"
    module_path.write_text("VALUE = 1\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()

    first = module_source_sha256("sample_optimizer")
    module_path.write_text("VALUE = 2\n")
    importlib.invalidate_caches()
    second = module_source_sha256("sample_optimizer")

    assert re.fullmatch(r"[0-9a-f]{64}", first)
    assert re.fullmatch(r"[0-9a-f]{64}", second)
    assert second != first


def test_module_source_hash_includes_packaged_prompt_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    package_path = tmp_path / "sample_prompt_optimizer"
    prompt_path = package_path / "prompts" / "reflection.md"
    prompt_path.parent.mkdir(parents=True)
    (package_path / "__init__.py").write_text("VALUE = 1\n")
    prompt_path.write_text("First reflection policy.\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    importlib.invalidate_caches()

    first = module_source_sha256("sample_prompt_optimizer")
    prompt_path.write_text("Changed reflection policy.\n")
    second = module_source_sha256("sample_prompt_optimizer")

    assert second != first


def test_runtime_identity_validation_requires_the_inspected_value() -> None:
    validate_runtime_identity(RUNTIME_IDENTITY, RUNTIME_IDENTITY, "test")

    changed = {
        **RUNTIME_IDENTITY,
        "optimizer": {
            **RUNTIME_IDENTITY["optimizer"],
            "sourceSha256": "5" * 64,
        },
    }
    with pytest.raises(RuntimeError, match="runtime changed after source inspection"):
        validate_runtime_identity(changed, RUNTIME_IDENTITY, "test")


def test_locked_run_blocks_before_reading_a_concurrently_partial_manifest(
    tmp_path: Path,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []

    def hold_run() -> None:
        try:
            with locked_run(
                label="test",
                compatible_run_id=COMPATIBLE_RUN_ID,
                run_id=COMPATIBLE_RUN_ID,
                runtime_identity=RUNTIME_IDENTITY,
                resume="if-compatible",
                attempt_id="first",
                output_root=tmp_path,
                resume_supported=True,
                resume_scope="test engine",
            ) as run:
                manifest_path = run.run_dir / "manifest.json"
                manifest_path.write_text("{")
                entered.set()
                release.wait(timeout=5)
                atomic_write_json(manifest_path, run.manifest)
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=hold_run)
    thread.start()
    assert entered.wait(timeout=5)
    try:
        with pytest.raises(RuntimeError, match="already active"):
            with locked_run(
                label="test",
                compatible_run_id=COMPATIBLE_RUN_ID,
                run_id=COMPATIBLE_RUN_ID,
                runtime_identity=RUNTIME_IDENTITY,
                resume="if-compatible",
                attempt_id="second",
                output_root=tmp_path,
                resume_supported=True,
                resume_scope="test engine",
            ):
                pass
    finally:
        release.set()
        thread.join(timeout=5)

    assert not thread.is_alive()
    assert errors == []
    with locked_run(
        label="test",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=COMPATIBLE_RUN_ID,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="third",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as repeated:
        assert repeated.manifest_existed is True
        assert repeated.restore_requested is True
        assert repeated.manifest == {
            "optimizer": "test",
            "compatibleRunId": COMPATIBLE_RUN_ID,
            "runId": COMPATIBLE_RUN_ID,
            "runtime": RUNTIME_IDENTITY,
        }
        assert json.loads((repeated.run_dir / "manifest.json").read_text()) == repeated.manifest


def test_locked_run_rejects_an_unlocked_partial_manifest(tmp_path: Path) -> None:
    with locked_run(
        label="test",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=COMPATIBLE_RUN_ID,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="first",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as run:
        manifest_path = run.run_dir / "manifest.json"
    manifest_path.write_text("{")

    with pytest.raises(RuntimeError, match="unreadable manifest"):
        with locked_run(
            label="test",
            compatible_run_id=COMPATIBLE_RUN_ID,
            run_id=COMPATIBLE_RUN_ID,
            runtime_identity=RUNTIME_IDENTITY,
            resume="if-compatible",
            attempt_id="second",
            output_root=tmp_path,
            resume_supported=True,
            resume_scope="test engine",
        ):
            pass


def test_locked_run_archives_state_that_has_no_identity_manifest(tmp_path: Path) -> None:
    with locked_run(
        label="test",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=COMPATIBLE_RUN_ID,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="first",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as initial:
        run_dir = initial.run_dir
    (run_dir / "manifest.json").unlink()
    (run_dir / "upstream-state.bin").write_bytes(b"untrusted")

    with locked_run(
        label="test",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=COMPATIBLE_RUN_ID,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="second",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as fresh:
        assert fresh.run_dir == run_dir
        assert fresh.restore_requested is False
        assert not (fresh.run_dir / "upstream-state.bin").exists()

    archived = list(run_dir.parent.glob(f"{run_dir.name}.unrestorable-*"))
    assert len(archived) == 1
    assert (archived[0] / "upstream-state.bin").read_bytes() == b"untrusted"


def test_locked_run_reuses_only_an_explicit_compatible_runtime(
    tmp_path: Path,
) -> None:
    with locked_run(
        label="GEPA",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=COMPATIBLE_RUN_ID,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="first",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as initial:
        initial_path = initial.run_dir
        assert initial.restore_requested is False

    with locked_run(
        label="GEPA",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=COMPATIBLE_RUN_ID,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="second",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as repeated:
        assert repeated.run_dir == initial_path
        assert repeated.restore_requested is True

    with locked_run(
        label="GEPA",
        compatible_run_id=OTHER_COMPATIBLE_RUN_ID,
        run_id=OTHER_COMPATIBLE_RUN_ID,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="other",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as other:
        assert other.run_dir != initial_path
        assert other.restore_requested is False

    changed_runtime = {
        **RUNTIME_IDENTITY,
        "optimizer": {
            **RUNTIME_IDENTITY["optimizer"],
            "sourceSha256": "5" * 64,
        },
    }
    with pytest.raises(RuntimeError, match="manifest does not match"):
        with locked_run(
            label="GEPA",
            compatible_run_id=COMPATIBLE_RUN_ID,
            run_id=COMPATIBLE_RUN_ID,
            runtime_identity=changed_runtime,
            resume="if-compatible",
            attempt_id="changed-runtime",
            output_root=tmp_path,
            resume_supported=True,
            resume_scope="test engine",
        ):
            pass


@pytest.mark.parametrize("compatible_run_id", ["short", "A" * 64, "g" * 64])
def test_locked_run_rejects_invalid_compatible_run_ids(
    compatible_run_id: str,
    tmp_path: Path,
) -> None:
    with pytest.raises(RuntimeError, match="compatible run ID is invalid"):
        with locked_run(
            label="test",
            compatible_run_id=compatible_run_id,
            run_id=compatible_run_id,
            runtime_identity=RUNTIME_IDENTITY,
            resume="if-compatible",
            attempt_id="attempt",
            output_root=tmp_path,
            resume_supported=True,
            resume_scope="test engine",
        ):
            pass


@pytest.mark.parametrize(
    ("resume", "run_id"),
    [
        ("if-compatible", OTHER_COMPATIBLE_RUN_ID),
        ("never", COMPATIBLE_RUN_ID),
    ],
)
def test_locked_run_rejects_a_run_id_incompatible_with_resume_mode(
    resume: str,
    run_id: str,
    tmp_path: Path,
) -> None:
    with pytest.raises(RuntimeError, match="run ID does not match"):
        with locked_run(
            label="test",
            compatible_run_id=COMPATIBLE_RUN_ID,
            run_id=run_id,
            runtime_identity=RUNTIME_IDENTITY,
            resume=resume,
            attempt_id="fresh",
            output_root=tmp_path,
            resume_supported=True,
            resume_scope="test engine",
        ):
            pass


def test_locked_run_fresh_attempts_are_isolated_and_non_reusable(
    tmp_path: Path,
) -> None:
    with locked_run(
        label="GEPA",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=f"{COMPATIBLE_RUN_ID}-fresh-one",
        runtime_identity=RUNTIME_IDENTITY,
        resume="never",
        attempt_id="fresh-one",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as first:
        first_path = first.run_dir
        assert first.manifest_existed is False
        assert first.restore_requested is False

    with locked_run(
        label="GEPA",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=f"{COMPATIBLE_RUN_ID}-fresh-two",
        runtime_identity=RUNTIME_IDENTITY,
        resume="never",
        attempt_id="fresh-two",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as second:
        assert second.run_dir != first_path
        assert second.manifest_existed is False
        assert second.restore_requested is False

    with pytest.raises(RuntimeError, match="fresh run .* already exists"):
        with locked_run(
            label="GEPA",
            compatible_run_id=COMPATIBLE_RUN_ID,
            run_id=f"{COMPATIBLE_RUN_ID}-fresh-one",
            runtime_identity=RUNTIME_IDENTITY,
            resume="never",
            attempt_id="fresh-one",
            output_root=tmp_path,
            resume_supported=True,
            resume_scope="test engine",
        ):
            pass


def test_locked_run_treats_unsupported_optional_resume_as_fresh(
    tmp_path: Path,
) -> None:
    run_id = f"{COMPATIBLE_RUN_ID}-unsupported"
    with locked_run(
        label="test",
        compatible_run_id=COMPATIBLE_RUN_ID,
        run_id=run_id,
        runtime_identity=RUNTIME_IDENTITY,
        resume="if-compatible",
        attempt_id="unsupported",
        output_root=tmp_path,
        resume_supported=False,
        resume_scope="test engine",
    ) as run:
        assert run.run_dir.name == run_id
        assert run.restore_requested is False


def test_locked_run_requires_existing_compatible_state(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="compatible run .* does not exist"):
        with locked_run(
            label="test",
            compatible_run_id=COMPATIBLE_RUN_ID,
            run_id=COMPATIBLE_RUN_ID,
            runtime_identity=RUNTIME_IDENTITY,
            resume="required",
            attempt_id="required",
            output_root=tmp_path,
            resume_supported=True,
            resume_scope="test engine",
        ):
            pass


def test_atomic_writes_replace_complete_files_and_remove_temporaries(tmp_path: Path) -> None:
    text_path = tmp_path / "seed.md"
    json_path = tmp_path / "manifest.json"

    atomic_write_text(text_path, "first")
    atomic_write_text(text_path, "second")
    atomic_write_json(json_path, {"value": 2})

    assert text_path.read_text() == "second"
    assert json.loads(json_path.read_text()) == {"value": 2}
    assert list(tmp_path.glob(".*.tmp")) == []


def test_atomic_write_failure_preserves_the_previous_file_and_removes_temporary(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    path = tmp_path / "manifest.json"
    path.write_text("previous")

    def reject_replace(source: Path, destination: Path) -> None:
        raise OSError(f"cannot replace {source} with {destination}")

    monkeypatch.setattr(optimizer_bridge_common.os, "replace", reject_replace)
    with pytest.raises(OSError, match="cannot replace"):
        atomic_write_text(path, "incomplete")

    assert path.read_text() == "previous"
    assert list(tmp_path.glob(".*.tmp")) == []
