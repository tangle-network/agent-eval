"""Build the registered comparison from the arms' curves: `python3 -I compare.py RUNS.json > results.json`.

RUNS.json names, for each board, each arm's curve file and run id:
    {"circle-packing": {"chat-glm54": {"runId": ..., "curve": "runs/<id>.json"}, "program-search-glm54": {...}}, ...}
A curve file is either a chat run's `grade-versions` output (`versions`: each recorded construction graded by the board check,
with the run's cumulative fresh and cached tokens at its commit, and `total`, with its first and last metered times, its
model turns, and its Runtime driver `attempts` and the `refused` ones the plan refused for request rate) or a program-search
run's evolve progress (`rows`: each scored program with the run's cumulative seat tokens when it landed; `seat`: the run's
final token state, its seat `turns` and the `refused` ones; `startedAt` and `endedAt`).

The throughput diagnostics are read whatever the outcome: samples per hour (scored programs from model proposals, so not the
initial program, for program search; graded construction versions for chat), fresh tokens per sample and model turns per hour,
each over the arm's wall time from its first to its last record, reported beside the arm's wall-clock window and its refusal
share (refused harness invocations over all of them), because the seat's contention is measured, not matched.

Per registered spec.json: a board's matched token point is the smaller of the two GLM-5.4 arms' total fresh tokens; each arm's
progress there is read from its best graded construction at or before that point, and again at its full budget. The estimand
searchMinusChat is the mean over boards of the paired difference in progress (a board one arm did not answer contributes 0).
"""
import json
import sys
from datetime import datetime

REFERENCE = {
    # The share of the gap from a naive packing (26 circles of radius 0.08, sum 2.08) to the record that a packing closed.
    "circle-packing": {"direction": "maximize", "bar": 2.6359830849176076, "progress": lambda distance: 1 - min(1.0, max(0.0, distance) / (2.6359830849176076 - 2.08))},
    # How far a construction beat the published bar, in units of the board's minimum improvement (1e-8), capped at 1.
    "first-autocorrelation": {"direction": "minimize", "bar": 1.502743486709583, "progress": lambda distance: min(1.0, max(0.0, -distance / 1e-8))},
}


def points(curve):
    """(fresh, cached, grade) for every graded construction of a curve, in token order, and the curve's final token totals."""
    if "versions" in curve:
        rows = [(row["fresh"], row["cached"], row["grade"]) for row in curve["versions"]]
        return rows, {"fresh": curve["total"]["fresh"], "cached": curve["total"]["cached"]}
    rows = [(row["fresh"], row["tokens"]["cacheRead"], row["grade"]) for row in curve["rows"]]
    seat = curve["seat"]
    return rows, {"fresh": seat["fresh"], "cached": seat["tokens"]["cacheRead"]}


def hours(start, end):
    if not start or not end:
        return None
    parse = lambda at: datetime.fromisoformat(at.replace("Z", "+00:00"))
    return max(0.0, (parse(end) - parse(start)).total_seconds() / 3600)


def throughput(curve):
    """(samples, model turns, wall hours, wall-clock window, refused invocations, invocations) of a curve."""
    if "versions" in curve:
        total = curve["total"]
        window = [total.get("startedAt"), total.get("at")]
        return len(curve["versions"]), total.get("turns"), hours(*window), window, total.get("refused"), total.get("attempts")
    seat, window = curve["seat"], [curve.get("startedAt"), curve.get("endedAt")]
    samples = sum(1 for row in curve["rows"] if row.get("generation", 0) > 0)
    return samples, seat.get("turns"), hours(*window), window, seat.get("refused"), seat.get("turns")


def best_at(rows, limit):
    """The best graded construction among rows at or before `limit` fresh tokens, by graded distance (lower is closer)."""
    graded = [(fresh, grade) for fresh, _, grade in rows if fresh <= limit and grade and grade.get("value") is not None]
    if not graded:
        return None
    fresh, grade = min(graded, key=lambda row: (row[1]["value"], row[0]))
    return {"freshAtBest": fresh, "distance": grade["value"], "value": grade["score"]}


def curve_of(rows):
    """The best-so-far curve: each point where the arm's best graded distance improved."""
    out, best = [], None
    for fresh, cached, grade in sorted(rows, key=lambda row: row[0]):
        if not grade or grade.get("value") is None:
            continue
        if best is None or grade["value"] < best:
            best = grade["value"]
            out.append({"fresh": fresh, "cached": cached, "distance": grade["value"], "value": grade["score"]})
    return out


def main(path):
    runs = json.load(open(path))
    rows, diffs = [], []
    for board, arms in runs.items():
        reference = REFERENCE[board]
        curves = {arm: json.load(open(spec["curve"])) for arm, spec in arms.items()}
        loaded = {arm: (spec, *points(curves[arm])) for arm, spec in arms.items()}
        glm = [arm for arm in ("chat-glm54", "program-search-glm54") if arm in loaded]
        matched = min(loaded[arm][2]["fresh"] for arm in glm) if len(glm) == 2 else None
        progress = {}
        for arm, (spec, graded, total) in loaded.items():
            at_matched = best_at(graded, matched) if matched is not None else None
            at_full = best_at(graded, float("inf"))
            progress[arm] = reference["progress"](at_matched["distance"]) if at_matched else 0.0
            samples, turns, wall, window, refused, invocations = throughput(curves[arm])
            per_hour = lambda count: None if count is None or not wall else count / wall
            rows.append({"board": board, "arm": arm, "runId": spec["runId"], "progress": progress[arm],
                         "progressAtFullBudget": reference["progress"](at_full["distance"]) if at_full else 0.0,
                         "bestDistance": at_matched and at_matched["distance"], "bestValue": at_matched and at_matched["value"],
                         "bestAtFullBudget": at_full, "matchedFreshTokens": matched, "freshTokensTotal": total["fresh"], "cachedTokensTotal": total["cached"],
                         "billedUsd": 0, "samples": samples, "wallHours": wall, "wallClockWindow": window, "samplesPerHour": per_hour(samples),
                         "refusals": refused, "refusalShare": refused / invocations if refused is not None and invocations else None,
                         "freshTokensPerSample": total["fresh"] / samples if samples else None, "modelTurnsPerHour": per_hour(turns),
                         "curve": curve_of(graded)})
        if len(glm) == 2:
            diffs.append(progress["program-search-glm54"] - progress["chat-glm54"])
    estimand = {"searchMinusChat": {"value": sum(diffs) / len(diffs) if diffs else None, "pairs": len(diffs), "differences": diffs}}
    print(json.dumps({"rows": rows, "estimands": estimand}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
