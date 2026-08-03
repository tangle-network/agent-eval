#!/usr/bin/env python3
"""Constant-rule calibration per split, under the official CodeTraceBench per-row F1.

Semantics match agent-eval src/analyst/benchmark-public-calibration.ts:officialCodeTraceF1
and the scorer snippet in CodeTracer README.md: per-row F1 over incorrect step ids,
0 whenever either predicted or expected set is empty; mean over every row.
"""
import hashlib
import json
import statistics

SPLITS = [
    ('mini-SWE cert32 (dev32)', '/home/drew/code/agent-eval/benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json'),
    ('mini-SWE holdout-1', '/home/drew/bench-cache/ctb-20260801/ctb-holdout-labels.json'),
    ('mini-SWE holdout-2', '/home/drew/bench-cache/ctb-20260801/ctb-holdout2-labels.json'),
    ('mini-SWE split3 remainder-37', '/home/drew/bench-cache/ctb-20260801/split3/ctb-split3-labels.json'),
    ('mini-SWE thin-blind-28 (restored)', '/home/drew/bench-cache/ctb-20260801/split3-restored/thin-blind-labels.json'),
    ('OpenHands cert32', '/home/drew/bench-cache/ctb-20260801/oht2/ctb-openhands-cert32-labels.json'),
    ('Terminus2 cert32', '/home/drew/bench-cache/ctb-20260801/oht2/ctb-terminus2-cert32-labels.json'),
    ('OpenHands dev pool', '/home/drew/bench-cache/ctb-20260801/oht2/ctb-openhands-dev-labels.json'),
    ('Terminus2 dev pool', '/home/drew/bench-cache/ctb-20260801/oht2/ctb-terminus2-dev-labels.json'),
    ('SWE-agent 106', '/home/drew/bench-cache/ctb-20260801/sweagent/ctb-sweagent-labels.json'),
]


def expected_steps(row):
    steps = set()
    for stage in row.get('incorrect_stages') or []:
        for step in stage.get('incorrect_step_ids') or []:
            steps.add(int(step))
    return steps


def row_f1(pred, expected):
    matched = len(pred & expected)
    precision = 0 if not pred else matched / len(pred)
    recall = 0 if not expected else matched / len(expected)
    return 0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


print('| Split | labels sha256 (8) | n | positives | label-empty | gold steps | empty rule | flag-last-step | last-step hit rows | flag-all-steps |')
print('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for name, path in SPLITS:
    raw = open(path, 'rb').read()
    sha = hashlib.sha256(raw).hexdigest()[:8]
    data = json.loads(raw)
    rows = data if isinstance(data, list) else data['rows']
    exp = [(expected_steps(r), int(r['step_count'])) for r in rows]
    positives = sum(1 for e, _ in exp if e)
    gold = sum(len(e) for e, _ in exp)
    last = [row_f1({sc}, e) for e, sc in exp]
    allsteps = [row_f1(set(range(1, sc + 1)), e) for e, sc in exp]
    print(f'| {name} | `{sha}` | {len(rows)} | {positives} | {len(rows) - positives} | {gold} '
          f'| 0.000 | {statistics.mean(last):.4f} | {sum(1 for v in last if v > 0)}/{len(rows)} '
          f'| {statistics.mean(allsteps):.4f} |')
