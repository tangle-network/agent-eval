#!/usr/bin/env python3
"""Recompute the CodeTraceBench outcome/evidence taxonomy from retained inputs.

Classes describe the first gold incorrect step, not a causal diagnosis of the
agent's final task result. A solved task may contain incorrect steps. A failed
task with no annotated incorrect step remains unknown.
"""

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


SUBMIT_ONLY = re.compile(
    r"echo\s+(?:\"COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\"|"
    r"'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'|COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT)"
)
RETURN_CODE = re.compile(r"<returncode>(-?\d+)</returncode>")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def input_specs(cache, repository):
    root = repository / "benchmarks/trace-analysis/codetracebench-glm52-20260730"
    return [
        ("dev", root / "input-labels.json", cache / "ctb-prepared", cache / "ctb-traces"),
        ("holdout-1", cache / "ctb-holdout-labels.json", cache / "ctb-holdout-prepared", cache / "ctb-holdout-traces"),
        ("holdout-2", cache / "ctb-holdout2-labels.json", cache / "ctb-holdout2-prepared", cache / "ctb-holdout2-traces"),
        ("split-3", cache / "split3/ctb-split3-labels.json", cache / "split3/ctb-split3-prepared", cache / "split3/ctb-split3-traces"),
        ("sweagent", cache / "sweagent/ctb-sweagent-labels.json", cache / "sweagent/work", cache / "sweagent/traces"),
    ]


def first_gold_class(label, step):
    action = step["action"].strip()
    if action == "submit" or SUBMIT_ONLY.fullmatch(action):
        return "unsolved-submit-only"
    if "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" in action:
        return "unsolved-submit-with-work"
    match = RETURN_CODE.search(step["observation"] or "")
    if match:
        code = int(match.group(1))
        if code == 0:
            return "unsolved-command-exit-0"
        if code == 127:
            return "unsolved-command-exit-127"
        return "unsolved-command-other-nonzero"
    if label["agent"] == "SWE-agent":
        return "unsolved-aci-no-returncode"
    return "unsolved-other-no-returncode"


def load_trace(path, trace_id):
    spans = [json.loads(line) for line in path.read_text().splitlines() if line]
    if not spans or any(span.get("trace_id") != trace_id for span in spans):
        raise ValueError(f"{path}: absent or mismatched trace ID")
    roots = [span for span in spans if span.get("span_id") == "root"]
    if len(roots) != 1:
        raise ValueError(f"{path}: expected one root span")
    return len(spans), roots[0].get("attributes", {})


def classify(cache, repository):
    cases = []
    sources = []
    seen = set()
    for name, labels_path, prepared, traces in input_specs(cache, repository):
        labels = json.loads(labels_path.read_text())
        source = {"corpus": name, "labelsSha256": digest(labels_path), "cases": len(labels)}
        sources.append(source)
        steps_set = hashlib.sha256()
        traces_set = hashlib.sha256()
        source_spans = 0
        for label in labels:
            trace_id = label["traj_id"]
            if trace_id in seen:
                raise ValueError(f"duplicate trace ID: {trace_id}")
            seen.add(trace_id)
            steps_path = prepared / "normalized" / trace_id / "steps.json"
            steps_set.update(f"{trace_id}\t{digest(steps_path)}\n".encode())
            steps = json.loads(steps_path.read_text())
            if len(steps) != label["step_count"]:
                raise ValueError(f"{trace_id}: step count differs from label")
            if [step["step_id"] for step in steps] != list(range(1, len(steps) + 1)):
                raise ValueError(f"{trace_id}: noncontiguous step IDs")
            gold = sorted({step_id for stage in label["incorrect_stages"] for step_id in stage["incorrect_step_ids"]})
            if any(step_id < 1 or step_id > len(steps) for step_id in gold):
                raise ValueError(f"{trace_id}: gold step outside trajectory")
            trace_path = traces / f"{trace_id}.otlp.jsonl"
            traces_set.update(f"{trace_id}\t{digest(trace_path)}\n".encode())
            span_count, root = load_trace(trace_path, trace_id)
            source_spans += span_count
            if root.get("benchmark.name") != "CodeTraceBench":
                raise ValueError(f"{trace_id}: wrong trace origin")
            if label["solved"]:
                klass = "solved-with-gold" if gold else "solved-no-gold"
            elif not gold:
                klass = "unsolved-unknown-no-gold"
            else:
                klass = first_gold_class(label, steps[gold[0] - 1])
            first_step = steps[gold[0] - 1] if gold else None
            match = RETURN_CODE.search(first_step["observation"] or "") if first_step else None
            cases.append({
                "traceId": trace_id,
                "corpus": name,
                "agent": label["agent"],
                "solved": label["solved"],
                "class": klass,
                "goldIncorrectSteps": gold,
                "firstGoldStep": gold[0] if gold else None,
                "firstGoldReturncode": int(match.group(1)) if match else None,
                "traceSpans": span_count,
            })
        source["stepsSetSha256"] = steps_set.hexdigest()
        source["tracesSetSha256"] = traces_set.hexdigest()
        source["traceSpans"] = source_spans
    cases.sort(key=lambda case: case["traceId"])
    classes = defaultdict(list)
    for case in cases:
        classes[case["class"]].append(case["traceId"])
    verified_sources = []
    verified = defaultdict(dict)
    for run in ("run2", "run6"):
        path = cache / "verified-dataset-v1" / run / "rows.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines() if line]
        verified_sources.append({"run": run, "sha256": digest(path), "rows": len(rows)})
        for row in rows:
            key = row["corpus"] + "/" + row["trajId"]
            if run in verified[key]:
                raise ValueError(f"duplicate replay row: {run}/{key}")
            verified[key][run] = {
                "reproduced": row["verification"]["reproduced"],
                "recordedReturncode": row["gold"]["recordedReturncodeAtK"],
                "signature": row["verification"]["signature"],
                "fixOutcome": row["fix"]["outcome"],
            }
    if any(set(runs) != {"run2", "run6"} for runs in verified.values()):
        raise ValueError("verified runs do not cover the same unique cases")
    if any(key.split("/", 1)[1] not in seen for key in verified):
        raise ValueError("verified case absent from 239-trace corpus")
    return {
        "schema": "agent-eval/code-trace-failure-taxonomy@1",
        "source": "NJU-LINK/CodeTraceBench",
        "revision": "aa213b84ffb6690fc37ca15766d6ca174ec36d4d",
        "interpretation": "Observed task outcome and first annotated incorrect-step evidence; not a causal root-cause or hosted-agent prevalence estimate.",
        "units": {"trajectories": len(cases), "solved": sum(case["solved"] for case in cases), "unsolved": sum(not case["solved"] for case in cases), "verifiedUniqueCases": len(verified), "verifiedRunRows": sum(item["rows"] for item in verified_sources)},
        "sources": sources,
        "verifiedSources": verified_sources,
        "classes": [{"id": klass, "count": len(ids), "denominator": len(cases), "traceIds": sorted(ids)} for klass, ids in sorted(classes.items())],
        "cases": cases,
        "verifiedCases": [{"caseId": key, **verified[key]} for key in sorted(verified)],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path.home() / "bench-cache/ctb-20260801")
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = classify(args.cache, args.repository)
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
