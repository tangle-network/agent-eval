#!/usr/bin/env python3

import argparse
import hashlib
import json
import shutil
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlparse

from codetracer.query.normalizer import Normalizer
from codetracer.skills.pool import SkillPool

DATASET_REVISION = "aa213b84ffb6690fc37ca15766d6ca174ec36d4d"
DATASET_BASE_URL = (
    "https://huggingface.co/datasets/NJU-LINK/CodeTraceBench/resolve/"
    f"{DATASET_REVISION}/"
)
DATASET_ORIGIN = urlparse(DATASET_BASE_URL)
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024


def parse_args():
    parser = argparse.ArgumentParser(
        description="Prepare the pinned CodeTraceBench reference inputs."
    )
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=8)
    return parser.parse_args()


def sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def load_rows(path):
    data = path.read_bytes()
    rows = json.loads(data)
    if not isinstance(rows, list) or not rows:
        raise ValueError("labels must contain a non-empty JSON array")
    seen = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise TypeError(f"label row {index} is not an object")
        trace_id = row.get("traj_id")
        artifact_path = row.get("artifact_path")
        source_path = row.get("source_relpath")
        step_count = row.get("step_count")
        if not isinstance(trace_id, str) or not trace_id:
            raise ValueError(f"label row {index} has no traj_id")
        if trace_id in seen:
            raise ValueError(f"duplicate traj_id: {trace_id}")
        seen.add(trace_id)
        safe_posix_path(artifact_path, f"{trace_id} artifact_path")
        safe_posix_path(source_path, f"{trace_id} source_relpath")
        if not isinstance(step_count, int) or step_count <= 0:
            raise ValueError(f"{trace_id} has an invalid step_count")
    return rows, data


def safe_posix_path(value, label):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"{label} is unsafe: {value}")
    return path


def dataset_url(value):
    path = safe_posix_path(value, "artifact_path")
    url = urljoin(DATASET_BASE_URL, path.as_posix())
    parsed = urlparse(url)
    if parsed.scheme != DATASET_ORIGIN.scheme or parsed.netloc != DATASET_ORIGIN.netloc:
        raise ValueError("artifact URL escaped the pinned dataset origin")
    return url


def download_archive(row, archive_dir):
    trace_id = row["traj_id"]
    target = archive_dir / f"{trace_id}.tar.zst"
    request = urllib.request.Request(
        dataset_url(row["artifact_path"]),
        headers={"User-Agent": "agent-eval-public-benchmark/1"},
    )
    digest = hashlib.sha256()
    size = 0
    temporary = target.with_suffix(".part")
    try:
        with (
            # nosemgrep: dynamic-urllib-use-detected
            urllib.request.urlopen(request, timeout=120) as response,
            temporary.open("xb") as output,
        ):
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise ValueError(f"{trace_id} archive exceeds {MAX_ARCHIVE_BYTES} bytes")
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
    }


def download_archives(rows, archive_dir, workers):
    archive_dir.mkdir()
    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(download_archive, row, archive_dir): row["traj_id"]
            for row in rows
        }
        for future in as_completed(futures):
            results.append(future.result())
    return sorted(results, key=lambda row: row["traceId"])


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
        raise ValueError(f"archive listing differs between tar modes: {archive}")
    for name, detail in zip(names, details, strict=True):
        safe_posix_path(name.rstrip("/"), f"{archive.name} member")
        if not detail or detail[0] not in ("-", "d"):
            raise ValueError(f"{archive.name} contains a non-file member: {name}")
    return len(names)


def extract_archives(rows, archive_dir, extracted_dir):
    extracted_dir.mkdir()
    counts = []
    for row in rows:
        trace_id = row["traj_id"]
        archive = archive_dir / f"{trace_id}.tar.zst"
        member_count = archive_members(archive)
        target = extracted_dir / trace_id
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
        counts.append({"traceId": trace_id, "members": member_count})
    return counts


def normalizer_source(row, extracted_root, staging_root, pool):
    trace_id = row["traj_id"]
    case_root = extracted_root / trace_id
    declared = case_root.joinpath(*PurePosixPath(row["source_relpath"]).parts)
    source_dir = declared if declared.is_dir() else declared.parent
    if pool.detect(source_dir) is not None:
        return source_dir
    trajectories = sorted(case_root.rglob("*.traj.json"))
    if declared.is_file() and declared.name.endswith(".traj.json"):
        trajectories = [declared]
    if len(trajectories) != 1:
        raise ValueError(
            f"{trace_id} expected one supported trajectory, found {len(trajectories)}"
        )
    run_dir = staging_root / trace_id
    logs = run_dir / "agent-logs"
    logs.mkdir(parents=True)
    shutil.copy2(trajectories[0], logs / "mini.traj.json")
    return run_dir


def normalize_trajectories(rows, extracted_dir, normalized_dir, staging_dir):
    normalized_dir.mkdir()
    staging_dir.mkdir()
    pool = SkillPool()
    normalizer = Normalizer(pool)
    results = []
    for row in rows:
        trace_id = row["traj_id"]
        source = normalizer_source(row, extracted_dir, staging_dir, pool)
        skill = normalizer.detect(source)
        if skill is None:
            raise ValueError(f"{trace_id} has no CodeTracer normalizer")
        output = normalized_dir / trace_id
        output.mkdir()
        trajectory = normalizer.normalize(source, skill, output_dir=output, quiet=True)
        if len(trajectory.steps) != row["step_count"]:
            raise ValueError(
                f"{trace_id} normalized {len(trajectory.steps)} steps, "
                f"expected {row['step_count']}"
            )
        steps = (output / "steps.json").read_bytes()
        task = output / "task.md"
        results.append(
            {
                "traceId": trace_id,
                "normalizer": skill.name,
                "steps": len(trajectory.steps),
                "stepsSha256": sha256_bytes(steps),
                "taskSha256": sha256_bytes(task.read_bytes()) if task.exists() else None,
            }
        )
    return results


def main():
    args = parse_args()
    if args.workers <= 0:
        raise ValueError("--workers must be positive")
    args.out.mkdir(parents=True, exist_ok=False)
    rows, labels_bytes = load_rows(args.labels)
    archives = download_archives(rows, args.out / "archives", args.workers)
    extracted = extract_archives(rows, args.out / "archives", args.out / "extracted")
    normalized = normalize_trajectories(
        rows,
        args.out / "extracted",
        args.out / "normalized",
        args.out / "staging",
    )
    shutil.rmtree(args.out / "staging")
    receipt = {
        "kind": "agent-eval/codetracebench-preparation",
        "datasetRevision": DATASET_REVISION,
        "labelsSha256": sha256_bytes(labels_bytes),
        "rows": len(rows),
        "archives": archives,
        "extracted": extracted,
        "normalized": normalized,
    }
    (args.out / "prepare-receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    )
    print(
        json.dumps(
            {
                "rows": len(rows),
                "archiveBytes": sum(row["bytes"] for row in archives),
                "steps": sum(row["steps"] for row in normalized),
                "out": str(args.out.resolve()),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
