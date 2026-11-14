"""Direct calibration of the pinned, unchanged public TBS ODE artifact verifier.

The controls intentionally use public author references. They are not agent
solutions. Running this helper does not run Harbor or establish isolation.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "sources.json").read_text())
VERSIONS = {"numpy": "1.26.4", "pandas": "2.2.2", "scipy": "1.13.0",
            "sympy": "1.13.1", "pytest": "8.4.1"}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(task):
    for entry in PINS["ode"]["files"]:
        path = task / entry["path"]
        if sha256(path) != entry["sha256"]:
            raise ValueError(f"Pinned upstream content changed: {path}")
    versions = {}
    for name, expected in VERSIONS.items():
        module = __import__(name)
        versions[name] = module.__version__
        if versions[name] != expected:
            raise ValueError(f"{name}: expected {expected}, found {versions[name]}")
    return versions


def prepare(task, output):
    validate(task)
    sys.path.insert(0, str(task / "tests"))
    import pandas as pd
    from submission_checker import parse_expression, symbolic_complexity

    reference = json.loads((task / "tests/hidden_reference.json").read_text())
    reference_predictions = pd.read_csv(task / "tests/hidden_test_trajectories.csv")
    for name in ("author-reference", "corrupted-vector-field"):
        artifact = output / name
        artifact.mkdir(parents=True, exist_ok=False)
        equations = dict(reference["equations"])
        predictions = reference_predictions.copy()
        if name == "corrupted-vector-field":
            equations = {axis: f"0.5*({value})" for axis, value in equations.items()}
            predictions[["x", "y", "z"]] *= 0.5
        complexity = {axis: symbolic_complexity(parse_expression(value))
                      for axis, value in equations.items()}
        complexity["total"] = sum(complexity.values())
        content = {"state_variables": reference["state_variables"], "time_variable": "t",
                   "equations": equations, "parameters": {}, "complexity": complexity}
        (artifact / "equations.json").write_text(json.dumps(content, indent=2) + "\n")
        predictions.to_csv(artifact / "predictions.csv", index=False)
        (artifact / "report.md").write_text(
            "Author-reference grader calibration fixture. Not an agent solution or discovery.\n")
    print(json.dumps({"prepared": str(output), "agent_executed": False}))


def grade(task, artifact, output):
    versions = validate(task)
    output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, RESULTS_DIR=str(artifact), TESTS_DIR=str(task / "tests"),
               PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    command = [sys.executable, "-m", "pytest", "-q", "-c", os.devnull,
               "--confcutdir=" + str(task / "tests"), str(task / "tests/test_outputs.py"),
               "--junitxml=" + str(output / "junit.xml")]
    start = time.monotonic()
    process = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, timeout=120)
    (output / "stdout.txt").write_text(process.stdout)
    if process.returncode not in (0, 1):
        raise RuntimeError(f"pytest did not grade: exit {process.returncode}: {process.stdout}")
    tree = ET.parse(output / "junit.xml")
    cases = tree.findall(".//testcase")
    errors = tree.findall(".//error")
    skipped = tree.findall(".//skipped")
    if len(cases) != 8 or errors or skipped:
        raise RuntimeError(f"Incomplete grader: cases={len(cases)}, errors={len(errors)}, skipped={len(skipped)}")
    checks = [{"name": case.attrib["name"], "passed": case.find("failure") is None,
               "failure": None if case.find("failure") is None else case.find("failure").attrib.get("message")}
              for case in cases]
    passed = all(check["passed"] for check in checks)
    if passed != (process.returncode == 0):
        raise RuntimeError("pytest exit and recorded test outcomes disagree")
    result = {"scope": "direct-public-upstream-verifier-calibration",
              "agent_executed": False, "harbor_environment_executed": False,
              "source_revision": PINS["recipes"]["terminal-bench-science"]["source"]["revision"],
              "command": command, "exit_code": process.returncode,
              "duration_seconds": time.monotonic() - start,
              "dependencies": versions, "python_version": sys.version,
              "tests": checks, "tests_passed": sum(check["passed"] for check in checks),
              "tests_total": len(checks), "passed": passed,
              "artifact_sha256": {name: sha256(artifact / name) for name in
                                  ("equations.json", "predictions.csv", "report.md")},
              "stdout_sha256": sha256(output / "stdout.txt"),
              "junit_sha256": sha256(output / "junit.xml")}
    (output / "native-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "grade"))
    parser.add_argument("--task", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artifact", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "prepare":
            prepare(args.task.resolve(), args.output.resolve())
        elif args.artifact is None:
            parser.error("grade requires --artifact")
        else:
            grade(args.task.resolve(), args.artifact.resolve(), args.output.resolve())
    except Exception as error:
        print(json.dumps({"succeeded": False, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
