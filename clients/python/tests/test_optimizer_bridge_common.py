from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from agent_eval_rpc.optimizer_bridge_common import (
    atomic_write_json,
    atomic_write_text,
    locked_run,
    package_provenance,
    validate_no_secrets,
)


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


def test_locked_run_blocks_before_reading_a_concurrently_partial_manifest(
    tmp_path: Path,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []
    material = {"input": "same"}

    def hold_run() -> None:
        try:
            with locked_run(
                label="test",
                schema="test.v1",
                material=material,
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
                schema="test.v1",
                material=material,
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
        schema="test.v1",
        material=material,
        resume="if-compatible",
        attempt_id="third",
        output_root=tmp_path,
        resume_supported=True,
        resume_scope="test engine",
    ) as repeated:
        assert repeated.manifest_existed is True
        assert repeated.restore_requested is True
        assert json.loads((repeated.run_dir / "manifest.json").read_text()) == repeated.manifest


def test_locked_run_rejects_an_unlocked_partial_manifest(tmp_path: Path) -> None:
    material = {"input": "same"}
    with locked_run(
        label="test",
        schema="test.v1",
        material=material,
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
            schema="test.v1",
            material=material,
            resume="if-compatible",
            attempt_id="second",
            output_root=tmp_path,
            resume_supported=True,
            resume_scope="test engine",
        ):
            pass


def test_locked_run_archives_state_that_has_no_identity_manifest(tmp_path: Path) -> None:
    material = {"input": "same"}
    with locked_run(
        label="test",
        schema="test.v1",
        material=material,
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
        schema="test.v1",
        material=material,
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


def test_atomic_writes_replace_complete_files_and_remove_temporaries(tmp_path: Path) -> None:
    text_path = tmp_path / "seed.md"
    json_path = tmp_path / "manifest.json"

    atomic_write_text(text_path, "first")
    atomic_write_text(text_path, "second")
    atomic_write_json(json_path, {"value": 2})

    assert text_path.read_text() == "second"
    assert json.loads(json_path.read_text()) == {"value": 2}
    assert list(tmp_path.glob(".*.tmp")) == []
