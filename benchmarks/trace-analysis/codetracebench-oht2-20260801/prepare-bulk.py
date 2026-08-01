#!/usr/bin/env python3
"""Bulk, per-row fault-tolerant CodeTraceBench preparation for one agent family.

Downloads the pinned dataset archives for every manifest row of the requested
family, normalizes each trajectory with the pinned upstream CodeTracer skills,
and pre-validates the exact invariants the traces `import-codetracebench`
command enforces. The traces importer is all-or-nothing, so every row that
would abort the bulk import is excluded here and recorded in the receipt with
a machine-readable reason. Passing rows are emitted verbatim into a labels
JSON array that feeds `traces import-codetracebench` unchanged.

Run with the pinned CodeTracer revision:

  uv run \
    --with 'git+https://github.com/NJU-LINK/CodeTracer.git@2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34' \
    prepare-bulk.py --manifest bench_manifest.verified.jsonl \
    --family OpenHands --out WORK_DIR --labels-out LABELS.json
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlparse

from codetracer.query.normalizer import Normalizer
from codetracer.skills.pool import SkillPool

DATASET_REVISION = "aa213b84ffb6690fc37ca15766d6ca174ec36d4d"
CODETRACER_REVISION = "2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34"
DATASET_BASE_URL = (
    "https://huggingface.co/datasets/NJU-LINK/CodeTraceBench/resolve/"
    f"{DATASET_REVISION}/"
)
DATASET_ORIGIN = urlparse(DATASET_BASE_URL)
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
USER_SKILLS_DIR = Path(__file__).resolve().parent / "skills"

# Manifest `agent` value -> CodeTracer skills allowed to normalize the row.
# swe_raw OpenHands trials publish LiteLLM completion logs, handled by the
# openhands_completions user skill; terminal-bench trials use the upstream
# openhands sessions skill. A row that detects as any skill outside its
# family set is a faithfulness failure, not a fallback. mini-SWE rows keep
# the original prepare.py staging path and are out of scope here.
FAMILY_SKILLS = {
    "OpenHands": ("openhands_sessions", "openhands_completions"),
    "Terminus2": ("terminus2_commands",),
}

# Mirrors of the traces importer gates (src/codetracebench-trajectory.ts).
# A row that trips any of these would abort the all-or-nothing bulk import.
TRAJECTORY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
LABEL_KEY = re.compile(
    r"""\\?["'](?:incorrect_stages|incorrect_step_ids|unuseful_step_ids"""
    r"""|annotation_relpath|incorrect_error_stage_count)\\?["']\s*:""",
    re.IGNORECASE,
)
LABEL_ARRAY = re.compile(
    r"""\\?["']labels\\?["']\s*:\s*\[[^\]]*\\?["'](?:incorrect|unuseful)\\?["']""",
    re.IGNORECASE,
)
ANNOTATION_PATH = re.compile(
    r"(?:agent_failure_analysis|step_annotations(?:_all)?|merged_cleaned_step\d*)[\\/]",
    re.IGNORECASE,
)


class RowFailure(Exception):
    def __init__(self, reason: str, detail: str):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


def parse_args():
    parser = argparse.ArgumentParser(
        description="Prepare every importable CodeTraceBench row for one agent family."
    )
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--family", choices=sorted(FAMILY_SKILLS), required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--labels-out", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0, help="0 means every row")
    return parser.parse_args()


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def safe_posix_path(value, label):
    if not isinstance(value, str) or not value:
        raise RowFailure("unsafe-path", f"{label} must be a non-empty string")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise RowFailure("unsafe-path", f"{label} is unsafe: {value}")
    return path


def load_family_rows(manifest_path, family, limit):
    rows = []
    with manifest_path.open() as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"{manifest_path}:{line_number} is not an object")
            if row.get("agent") == family:
                rows.append(row)
    if not rows:
        raise ValueError(f"manifest has no rows for family '{family}'")
    seen = set()
    for row in rows:
        trace_id = row.get("traj_id")
        if not isinstance(trace_id, str) or not trace_id:
            raise ValueError("manifest row has no traj_id")
        if trace_id in seen:
            raise ValueError(f"duplicate traj_id: {trace_id}")
        seen.add(trace_id)
    if limit > 0:
        rows = rows[:limit]
    return rows


def dataset_url(value):
    path = safe_posix_path(value, "artifact_path")
    url = urljoin(DATASET_BASE_URL, path.as_posix())
    parsed = urlparse(url)
    if parsed.scheme != DATASET_ORIGIN.scheme or parsed.netloc != DATASET_ORIGIN.netloc:
        raise RowFailure("unsafe-path", "artifact URL escaped the pinned dataset origin")
    return url


def archive_members(archive):
    names = subprocess.run(
        ["tar", "--zstd", "-tf", str(archive)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    details = subprocess.run(
        ["tar", "--zstd", "-tvf", str(archive)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if len(names) != len(details):
        raise RowFailure("bad-archive", f"listing differs between tar modes: {archive.name}")
    for name, detail in zip(names, details, strict=True):
        safe_posix_path(name.rstrip("/"), f"{archive.name} member")
        if not detail or detail[0] not in ("-", "d"):
            raise RowFailure("bad-archive", f"{archive.name} has a non-file member: {name}")
    return len(names)


def download_archive(row, archive_dir):
    trace_id = row["traj_id"]
    target = archive_dir / f"{trace_id}.tar.zst"
    if target.exists():
        try:
            archive_members(target)
            return {
                "traceId": trace_id,
                "path": target.name,
                "bytes": target.stat().st_size,
                "sha256": sha256_bytes(target.read_bytes()),
                "reused": True,
            }
        except (RowFailure, subprocess.CalledProcessError):
            target.unlink()
    request = urllib.request.Request(
        dataset_url(row["artifact_path"]),
        headers={"User-Agent": "agent-eval-public-benchmark/1"},
    )
    digest = hashlib.sha256()
    size = 0
    temporary = target.with_suffix(".part")
    temporary.unlink(missing_ok=True)
    try:
        with (
            # nosemgrep: dynamic-urllib-use-detected
            urllib.request.urlopen(request, timeout=120) as response,
            temporary.open("xb") as output,
        ):
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise RowFailure(
                        "bad-archive", f"{trace_id} exceeds {MAX_ARCHIVE_BYTES} bytes"
                    )
                digest.update(chunk)
                output.write(chunk)
        temporary.replace(target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "traceId": trace_id,
        "path": target.name,
        "bytes": size,
        "sha256": digest.hexdigest(),
        "reused": False,
    }


def extract_archive(row, archive_dir, extracted_dir):
    trace_id = row["traj_id"]
    archive = archive_dir / f"{trace_id}.tar.zst"
    member_count = archive_members(archive)
    target = extracted_dir / trace_id
    if target.exists():
        shutil.rmtree(target)
    target.mkdir()
    subprocess.run(
        [
            "tar",
            "--zstd",
            "--extract",
            "--file",
            str(archive),
            "--directory",
            str(target),
            "--no-same-owner",
            "--no-same-permissions",
        ],
        check=True,
    )
    return member_count


def locate_run_dir(row, case_root, pool, family_skills):
    """Find the shallowest directory the skill pool detects, breadth-first.

    The manifest's source_relpath names the layout inside the upstream data
    repository, not inside the published archive, so detection walks the
    archive tree. The first detected directory must detect as one of the
    row's family skills; any other skill winning detection is a
    faithfulness failure.
    """
    declared = case_root.joinpath(*safe_posix_path(row["source_relpath"], "source_relpath").parts)
    queue = []
    if declared.is_dir():
        queue.append(declared)
    queue.append(case_root)
    seen = set()
    while queue:
        current = queue.pop(0)
        real = current.resolve()
        if real in seen:
            continue
        seen.add(real)
        detected = pool.detect(current)
        if detected is not None:
            if detected not in family_skills:
                raise RowFailure(
                    "wrong-normalizer",
                    f"detected '{detected}', expected one of {sorted(family_skills)}",
                )
            return current, detected
        queue.extend(sorted(p for p in current.iterdir() if p.is_dir()))
    raise RowFailure("no-normalizer", "no CodeTracer skill detects any directory")


def validate_importer_invariants(row, output_dir):
    """Mirror the traces importer gates so one bad row cannot abort the batch."""
    trace_id = row["traj_id"]
    steps_path = output_dir / "steps.json"
    steps = json.loads(steps_path.read_text(encoding="utf-8"))
    if not isinstance(steps, list) or not steps:
        raise RowFailure("empty-steps", "steps.json must be a non-empty array")
    if len(steps) != row["step_count"]:
        raise RowFailure(
            "step-count-mismatch",
            f"normalized {len(steps)} steps, manifest declares {row['step_count']}",
        )
    contents = []
    task_path = output_dir / "task.md"
    if task_path.exists():
        task_content = task_path.read_text(encoding="utf-8").strip()
        if not task_content:
            raise RowFailure("empty-task", "task.md exists but is empty")
        contents.append(task_content)
    else:
        contents.append(f"Task: {row.get('task_name') or ''}")
    for index, step in enumerate(steps):
        label = f"steps.json[{index}]"
        if not isinstance(step, dict):
            raise RowFailure("bad-step", f"{label} is not an object")
        if step.get("step_id") != index + 1:
            raise RowFailure(
                "bad-step", f"{label}.step_id is {step.get('step_id')}, expected {index + 1}"
            )
        action = step.get("action")
        if not isinstance(action, str) or not action.strip():
            raise RowFailure("empty-action", f"{label}.action is empty")
        if "observation" not in step:
            raise RowFailure("bad-step", f"{label}.observation key is missing")
        observation = step["observation"]
        if observation is not None and not isinstance(observation, str):
            raise RowFailure("bad-step", f"{label}.observation is not a string or null")
        thinking = step.get("thinking")
        if thinking is not None and (not isinstance(thinking, str) or not thinking.strip()):
            raise RowFailure("bad-step", f"{label}.thinking is present but empty")
        for ref_key in ("action_ref", "observation_ref"):
            ref = step.get(ref_key)
            if ref is None:
                continue
            if not isinstance(ref, dict):
                raise RowFailure("bad-step", f"{label}.{ref_key} is not an object or null")
            if not isinstance(ref.get("path"), str) or not ref["path"].strip():
                raise RowFailure("bad-step", f"{label}.{ref_key}.path is empty")
            starts = ref.get("line_start")
            ends = ref.get("line_end")
            if not isinstance(starts, int) or starts < 1:
                raise RowFailure("bad-step", f"{label}.{ref_key}.line_start is invalid")
            if not isinstance(ends, int) or ends < starts:
                raise RowFailure("bad-step", f"{label}.{ref_key}.line_end is invalid")
            if not isinstance(ref.get("content"), str):
                raise RowFailure("bad-step", f"{label}.{ref_key}.content is not a string")
        visible = [thinking, action] if isinstance(thinking, str) else [action]
        contents.append("\n".join(part for part in visible if part))
        if isinstance(observation, str):
            contents.append(observation)
    scan_label_leak(row, contents)
    steps_bytes = steps_path.read_bytes()
    return {
        "steps": len(steps),
        "stepsSha256": sha256_bytes(steps_bytes),
        "taskSha256": sha256_bytes(task_path.read_bytes()) if task_path.exists() else None,
    }


def scan_label_leak(row, contents):
    annotation = (row.get("annotation_relpath") or "").replace("\\", "/").lower()
    labels = row.get("incorrect_stages")
    serialized_labels = None
    if labels not in (None, [], ""):
        serialized_labels = compact(json.dumps(labels, separators=(",", ":")))
    for text in contents:
        if LABEL_KEY.search(text) or LABEL_ARRAY.search(text) or ANNOTATION_PATH.search(text):
            raise RowFailure("label-leak", "visible content matches an annotation pattern")
        if annotation and annotation in text.replace("\\", "/").lower():
            raise RowFailure("label-leak", "visible content contains the annotation path")
        if serialized_labels and serialized_labels in compact(text):
            raise RowFailure("label-leak", "visible content contains serialized labels")


def compact(value):
    return re.sub(r"\s+", "", value)


def prepare_row(row, pool, normalizer, family_skills, directories):
    trace_id = row.get("traj_id")
    if not isinstance(trace_id, str) or not TRAJECTORY_ID.match(trace_id):
        raise RowFailure("bad-traj-id", f"traj_id fails the importer pattern: {trace_id!r}")
    step_count = row.get("step_count")
    if not isinstance(step_count, int) or step_count <= 0:
        raise RowFailure("bad-step-count", f"step_count is {step_count!r}")
    if not row.get("artifact_path") or not row.get("source_relpath"):
        raise RowFailure("no-artifact", "manifest row has no artifact_path/source_relpath")
    archive = download_archive(row, directories["archives"])
    members = extract_archive(row, directories["archives"], directories["extracted"])
    case_root = directories["extracted"] / trace_id
    run_dir, detected = locate_run_dir(row, case_root, pool, family_skills)
    output_dir = directories["normalized"] / trace_id
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir()
    skill = normalizer.detect(run_dir, format_override=detected)
    trajectory = normalizer.normalize(run_dir, skill, output_dir=output_dir, quiet=True)
    if len(trajectory.steps) != step_count:
        detail = f"normalized {len(trajectory.steps)} steps, manifest declares {step_count}"
        shutil.rmtree(output_dir)
        raise RowFailure("step-count-mismatch", detail)
    try:
        checks = validate_importer_invariants(row, output_dir)
    except RowFailure:
        shutil.rmtree(output_dir)
        raise
    return {
        "traceId": trace_id,
        "status": "pass",
        "normalizer": skill.name,
        "runDir": str(run_dir.relative_to(case_root)) or ".",
        "archiveBytes": archive["bytes"],
        "archiveSha256": archive["sha256"],
        "members": members,
        **checks,
    }


def main():
    args = parse_args()
    if args.workers <= 0:
        raise ValueError("--workers must be positive")
    rows = load_family_rows(args.manifest, args.family, args.limit)
    family_skills = FAMILY_SKILLS[args.family]
    directories = {
        "archives": args.out / "archives",
        "extracted": args.out / "extracted",
        "normalized": args.out / "normalized",
    }
    args.out.mkdir(parents=True, exist_ok=True)
    for directory in directories.values():
        directory.mkdir(exist_ok=True)

    downloadable = [r for r in rows if r.get("artifact_path") and r.get("source_relpath")]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(download_archive, row, directories["archives"]) for row in downloadable]
        for future in as_completed(futures):
            future.result()

    skill_pool = SkillPool(user_dir=USER_SKILLS_DIR)
    normalizer = Normalizer(skill_pool)
    results = []
    passed = []
    for row in rows:
        try:
            entry = prepare_row(row, skill_pool, normalizer, family_skills, directories)
            passed.append(row)
        except RowFailure as failure:
            entry = {
                "traceId": row.get("traj_id"),
                "status": "fail",
                "reason": failure.reason,
                "detail": failure.detail,
            }
        except Exception as failure:  # noqa: BLE001 — receipts must name every unexpected loss
            entry = {
                "traceId": row.get("traj_id"),
                "status": "fail",
                "reason": "unexpected-error",
                "detail": f"{type(failure).__name__}: {failure}",
            }
        results.append(entry)

    failures = [entry for entry in results if entry["status"] == "fail"]
    reasons = {}
    for entry in failures:
        reasons[entry["reason"]] = reasons.get(entry["reason"], 0) + 1
    labels_bytes = (json.dumps(passed, indent=2) + "\n").encode()
    args.labels_out.parent.mkdir(parents=True, exist_ok=True)
    args.labels_out.write_bytes(labels_bytes)
    receipt = {
        "kind": "agent-eval/codetracebench-bulk-preparation",
        "datasetRevision": DATASET_REVISION,
        "codetracerRevision": CODETRACER_REVISION,
        "family": args.family,
        "skills": list(family_skills),
        "counts": {
            "candidates": len(rows),
            "passed": len(passed),
            "failed": len(failures),
            "failureReasons": reasons,
        },
        "labelsFile": args.labels_out.name,
        "labelsSha256": sha256_bytes(labels_bytes),
        "rows": results,
    }
    receipt_path = args.out / "prepare-bulk-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "family": args.family,
                "candidates": len(rows),
                "passed": len(passed),
                "failed": len(failures),
                "failureReasons": reasons,
                "steps": sum(e["steps"] for e in results if e["status"] == "pass"),
                "labels": str(args.labels_out.resolve()),
                "receipt": str(receipt_path.resolve()),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
