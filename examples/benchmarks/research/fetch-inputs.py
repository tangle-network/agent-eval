"""Fetch pinned public inputs for the importer and ODE verifier demonstration.

No benchmark code, container, agent, or judge executes. The resulting packages
are explicitly partial: all TBS task metadata, four task source directories,
all ten MKA showcase metadata/rubrics, and one MKA task's three real images.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

PINS = json.loads((Path(__file__).parent / "sources.json").read_text())


def read_url(url):
    request = urllib.request.Request(url, headers={"User-Agent": "AgentEval-public-protocol-example"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def fetch_package(root, name, source, revision, records, scope):
    destination = root / name
    destination.mkdir(parents=True, exist_ok=False)

    def fetch(record):
        path, url, expected_blob = record
        relative = Path(path)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"Unsafe source path: {path}")
        data = read_url(url)
        blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if expected_blob and blob != expected_blob:
            raise ValueError(f"Git blob mismatch: {path}")
        if data.startswith(b"version https://git-lfs.github.com/spec/v1"):
            raise ValueError(f"Unhydrated Git LFS pointer: {path}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"path": path, "url": url, "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "git_blob_sha1": blob}

    with ThreadPoolExecutor(max_workers=6) as pool:
        files = sorted(pool.map(fetch, records), key=lambda entry: entry["path"])
    manifest = {"source": source, "revision": revision, "scope": scope,
                "benchmark_executed": False, "files": files}
    (destination / "REFERENCE_MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"package": name, "files": len(files), "bytes": sum(f["bytes"] for f in files)}))


def main(root):
    repo = "harbor-framework/terminal-bench-science"
    revision = PINS["recipes"]["terminal-bench-science"]["source"]["revision"]
    tree = json.loads(read_url(f"https://api.github.com/repos/{repo}/git/trees/{revision}?recursive=1"))
    if tree.get("truncated"):
        raise ValueError("GitHub returned a truncated tree")
    representatives = (
        "tasks/" + PINS["ode"]["relativeTask"] + "/",
        "tasks/physical-sciences/physics/frustrated-heisenberg-nqs/",
        "tasks/earth-sciences/atmospheric-sciences/sparse-network-assimilation/",
        "tasks/life-sciences/biology/ont-tn-qc/",
    )
    selected = [entry for entry in tree["tree"] if entry["type"] == "blob" and (
        entry["path"] in {"LICENSE", "README.md", "CITATION.cff"}
        or (entry["path"].startswith("tasks/") and entry["path"].endswith(("/task.toml", "/instruction.md")))
        or entry["path"].startswith(representatives))]
    roster = sorted(entry["path"][6:-10] for entry in selected if entry["path"].endswith("/task.toml"))
    if roster != PINS["recipes"]["terminal-bench-science"]["taskIds"]:
        raise ValueError("Pinned TBS roster changed")
    fetch_package(root, "terminal-bench-science-v0.1.0", f"https://github.com/{repo}", revision,
        [(entry["path"], f"https://raw.githubusercontent.com/{repo}/{revision}/{entry['path']}", entry["sha"])
         for entry in selected],
        {"kind": "partial-upstream-checkout", "all_task_metadata_and_instructions": True,
         "complete_source_task_directories": list(representatives),
         "external_dependencies_and_datasets_not_hydrated": True})
    dataset = "google/multimodal-knowledge-agent"
    revision = PINS["recipes"]["mka-showcase"]["source"]["revision"]
    names = ["README.md"]
    for task in PINS["recipes"]["mka-showcase"]["taskIds"]:
        names.extend([f"tasks/{task}/metadata.json", f"tasks/{task}/rubrics.json"])
    rf = "task_143a5623f26c404baaeb63ccd891e196"
    names.extend(f"tasks/{rf}/input/{name}" for name in
                 ("block_diagram.png", "signoff_performance_limits.png", "validation_spectrum.jpg"))
    fetch_package(root, "mka-showcase", f"https://huggingface.co/datasets/{dataset}", revision,
        [(path, f"https://huggingface.co/datasets/{dataset}/resolve/{revision}/{urllib.parse.quote(path)}", None)
         for path in names],
        {"kind": "public-showcase-partial-package", "metadata_and_rubrics_tasks": 10,
         "full_input_tasks": [rf], "private_official_200_task_benchmark": False,
         "official_grader_included": False})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    main(args.root.resolve())
