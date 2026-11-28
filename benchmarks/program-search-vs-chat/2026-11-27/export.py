"""Build each arm's curve file for compare.py from its run's own records.

    python3 -I export.py program-search RUN_DIR > curve.json
    python3 -I export.py chat RUN_DIR GRADED.json > curve.json

program-search reads the engine run's evolve-progress.jsonl (each scored program, with the run's cumulative seat tokens when it
landed), evolve-turns.jsonl (each seat turn as OpenCode metered it, and whether the plan refused it for capacity) and
seat-admission.json (when the run was admitted). Its window runs from admission to its last turn or scored program.

chat reads the chat run's grade-versions output (GRADED.json: every recorded construction graded by the board check, at the
run's cumulative fresh and cached tokens) and adds, from the run's observer.jsonl, its harness turns (agent.turn events), its
Runtime driver attempts (agent.execution records with an attempt) and the attempts the plan refused for request rate
(classification unavailable, signal rate_limit_error).
"""
import json
import os
import sys


def lines(path):
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path, encoding="utf-8"):
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def program_search(run):
    turns, rows = lines(os.path.join(run, "evolve-turns.jsonl")), lines(os.path.join(run, "evolve-progress.jsonl"))
    tokens = {name: sum(turn["tokens"][name] for turn in turns) for name in ("input", "output", "reasoning", "cacheRead", "cacheWrite")}
    fresh = tokens["input"] + tokens["cacheWrite"] + tokens["output"] + tokens["reasoning"]
    admission = json.load(open(os.path.join(run, "seat-admission.json")))
    ends = [turn["at"] for turn in turns] + [row.get("receivedAt") or row["at"] for row in rows]
    return {"runId": os.path.basename(run.rstrip("/")),
            "rows": [{key: row.get(key) for key in ("at", "generation", "fresh", "tokens", "grade", "solved", "program")} for row in rows],
            "seat": {"tokens": tokens, "fresh": fresh, "turns": len(turns), "refused": sum(1 for turn in turns if turn.get("capacity"))},
            "startedAt": admission.get("admittedAt"), "endedAt": max(ends) if ends else None}


def chat(run, graded_path):
    graded = json.load(open(graded_path))
    turns = attempts = refused = 0
    for record in lines(os.path.join(run, "observer.jsonl")):
        event = record.get("event", record)
        target = event.get("target")
        if target == "agent.turn":
            turns += 1
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        attempt = payload.get("record") if isinstance(payload.get("record"), dict) else None
        if target == "agent.execution" and attempt is not None and "attempt" in attempt:
            attempts += 1
            refused += attempt.get("classification") == "unavailable" and attempt.get("unavailableSignal") == "rate_limit_error"
    graded["total"].update({"turns": turns, "attempts": attempts, "refused": refused})
    return graded


if __name__ == "__main__":
    kind, run, *rest = sys.argv[1:]
    print(json.dumps(program_search(run) if kind == "program-search" else chat(run, rest[0]), indent=1))
