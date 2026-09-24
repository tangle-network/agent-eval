#!/usr/bin/env python3
"""Independent raw-label checker for predict.mjs output."""

import argparse
import hashlib
import json
import random
import re
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def step_f1(gold, predicted):
    matched = len(gold & predicted)
    denominator = len(gold) + len(predicted)
    return 0.0 if denominator == 0 else 2 * matched / denominator


def interval(values):
    values = sorted(values)
    def at(q):
        x = q * (len(values) - 1)
        low = int(x)
        return values[low] + (values[min(low + 1, len(values) - 1)] - values[low]) * (x - low)
    return [at(0.025), at(0.975)]


def paired_bootstrap(differences):
    if not differences:
        return None
    rng = random.Random(7)
    n = len(differences)
    return interval([sum(differences[rng.randrange(n)] for _ in range(n)) / n for _ in range(10000)])


def gold_steps(row):
    stages = row['incorrect_stages']
    if isinstance(stages, str):
        stages = json.loads(stages)
    if not isinstance(stages, list):
        raise ValueError(f"{row['traj_id']}: invalid incorrect_stages")
    steps = [step for stage in stages for step in stage.get('incorrect_step_ids', [])]
    if len(steps) != len(set(steps)) or any(not isinstance(step, int) or step < 1 or step > row['step_count'] for step in steps):
        raise ValueError(f"{row['traj_id']}: invalid or repeated gold steps")
    return set(steps)


def reference_rows(path, selected_rows):
    if path is None:
        return None
    data = json.loads(Path(path).read_text())
    observations = [row for row in data['result']['observations'] if row['runnerId'] == 'dspy-rlm']
    by_case = {}
    for observation in observations:
        trace_id = observation['caseId'].removeprefix('codetrace:')
        if trace_id not in selected_rows:
            continue
        predicted = set()
        if not observation.get('error'):
            for finding in observation['findings']:
                if finding['area'] != 'incorrect':
                    continue
                for evidence in finding['evidence_refs']:
                    match = re.fullmatch(r'trace://(.+)/span/step-(\d+)', evidence['uri'])
                    if not match or match.group(1) != trace_id:
                        raise ValueError(f'{trace_id}: bad finding evidence URI')
                    predicted.add(int(match.group(2)))
        actual = step_f1(selected_rows[trace_id]['gold'], predicted)
        if abs(actual - observation['score']['f1']) > 1e-9:
            raise ValueError(f'{trace_id}: recorded analyst F1 disagrees with independent checker')
        by_case.setdefault(trace_id, []).append({
            'repetition': observation['repetition'],
            'f1': actual,
            'costUsd': observation['usage']['cost']['usd'],
            'costKind': observation['usage']['cost']['kind'],
            'calls': observation['usage']['calls'],
        })
    if set(by_case) != set(selected_rows):
        raise ValueError(f'reference case mismatch: missing {sorted(set(selected_rows) - set(by_case))}')
    reference = {}
    for trace_id, repetitions in by_case.items():
        if sorted(row['repetition'] for row in repetitions) != [0, 1]:
            raise ValueError(f'{trace_id}: expected model repetitions 0 and 1')
        reference[trace_id] = sum(row['f1'] for row in repetitions) / 2
    return {
        'byCase': reference,
        'receipts': {
            'observations': len(observations),
            'includedObservations': sum(map(len, by_case.values())),
            'calls': sum(row['calls'] for group in by_case.values() for row in group),
            'estimatedCostUsd': sum(row['costUsd'] for group in by_case.values() for row in group),
            'costKinds': sorted({row['costKind'] for group in by_case.values() for row in group}),
        },
    }


def score_mode(rows, mode, reference):
    case_rows = []
    for trace_id, row in sorted(rows.items()):
        predicted_list = row['prediction']['predictions'][mode]
        predicted = set(predicted_list)
        if len(predicted) != len(predicted_list) or any(not isinstance(step, int) or step < 1 or step > row['label']['step_count'] for step in predicted):
            raise ValueError(f'{trace_id}: invalid predicted steps')
        gold = row['gold']
        case_rows.append({
            'traceId': trace_id,
            'taskName': row['label']['task_name'],
            'gold': sorted(gold),
            'predicted': sorted(predicted),
            'f1': step_f1(gold, predicted),
            'matched': len(gold & predicted),
            'labelState': 'positive' if gold else 'trusted-negative' if row['label']['solved'] is True else 'unlabeled',
            'stepsWithReturncode': row['prediction']['stepsWithReturncode'],
            'stepsWithoutReturncode': row['prediction']['stepsWithoutReturncode'],
            'nonzeroSteps': row['prediction']['nonzeroSteps'],
            'traceSha256': row['prediction']['traceSha256'],
        })
    gold_total = sum(len(row['gold']) for row in case_rows)
    pred_total = sum(len(row['predicted']) for row in case_rows)
    matched_total = sum(row['matched'] for row in case_rows)
    mean_f1 = sum(row['f1'] for row in case_rows) / len(case_rows)
    reference_mean = None if reference is None else sum(reference['byCase'][row['traceId']] for row in case_rows) / len(case_rows)
    differences_empty = [row['f1'] for row in case_rows]
    differences_reference = None if reference is None else [row['f1'] - reference['byCase'][row['traceId']] for row in case_rows]
    negatives = [row for row in case_rows if row['labelState'] == 'trusted-negative']
    return {
        'mode': mode,
        'cases': len(case_rows),
        'meanPerRowF1': mean_f1,
        'microF1': 0 if gold_total + pred_total == 0 else 2 * matched_total / (gold_total + pred_total),
        'matchedGoldSteps': matched_total,
        'goldSteps': gold_total,
        'predictedSteps': pred_total,
        'positiveCases': sum(row['labelState'] == 'positive' for row in case_rows),
        'trustedNegativeCases': len(negatives),
        'trustedNegativeFalsePositives': sum(bool(row['predicted']) for row in negatives),
        'unlabeledCases': sum(row['labelState'] == 'unlabeled' for row in case_rows),
        'actionsWithReturncode': sum(row['stepsWithReturncode'] for row in case_rows),
        'actionsWithoutReturncode': sum(row['stepsWithoutReturncode'] for row in case_rows),
        'casesWithNonzeroReturncode': sum(bool(row['nonzeroSteps']) for row in case_rows),
        'pairedVsEmpty': {'meanDelta': mean_f1, 'ci95': paired_bootstrap(differences_empty)},
        'pairedVsReference': None if reference is None else {
            'referenceMeanF1': reference_mean,
            'meanDelta': mean_f1 - reference_mean,
            'ci95': paired_bootstrap(differences_reference),
        },
        'rows': case_rows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('predictions')
    parser.add_argument('labels')
    parser.add_argument('--exclude-labels')
    parser.add_argument('--reference')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    # Calibration controls establish the exact-set metric before real labels are read.
    assert step_f1({2}, {2}) == 1
    assert step_f1({2}, {3}) == 0
    assert step_f1(set(), set()) == 0

    predictions = json.loads(Path(args.predictions).read_text())
    if predictions['schema'] != 'agent-eval/autoresearch-returncode-predictions@1':
        raise ValueError('unrecognized prediction schema')
    prediction_rows = {row['traceId']: row for row in predictions['rows']}
    if len(prediction_rows) != len(predictions['rows']) or predictions['traceFiles'] != len(prediction_rows):
        raise ValueError('missing or duplicated prediction cases')
    labels = json.loads(Path(args.labels).read_text())
    label_ids = [row['traj_id'] for row in labels]
    if len(set(label_ids)) != len(label_ids) or set(label_ids) != set(prediction_rows):
        raise ValueError(f'label/prediction case mismatch: labels={len(label_ids)} predictions={len(prediction_rows)}')
    exclusion_tasks = set()
    if args.exclude_labels:
        exclusion_tasks = {row['task_name'] for row in json.loads(Path(args.exclude_labels).read_text())}
    excluded = [row['traj_id'] for row in labels if row['task_name'] in exclusion_tasks]
    selected = {row['traj_id']: {'label': row, 'prediction': prediction_rows[row['traj_id']], 'gold': gold_steps(row)} for row in labels if row['traj_id'] not in excluded}
    if not selected or len({row['label']['task_name'] for row in selected.values()}) != len(selected):
        raise ValueError('no independent task units or repeated task name')
    modes = sorted(set(next(iter(prediction_rows.values()))['predictions']))
    if any(set(row['predictions']) != set(modes) for row in prediction_rows.values()):
        raise ValueError('inconsistent prediction modes')
    reference = reference_rows(args.reference, selected)
    scores = [score_mode(selected, mode, reference) for mode in modes]
    result = {
        'schema': 'agent-eval/autoresearch-returncode-score@1',
        'inputs': {
            'predictionSha256': digest(args.predictions),
            'labelsSha256': digest(args.labels),
            'excludedLabelsSha256': digest(args.exclude_labels) if args.exclude_labels else None,
            'referenceSha256': digest(args.reference) if args.reference else None,
            'selectedCases': len(selected),
            'excludedTaskOverlap': sorted(excluded),
        },
        'referenceReceipts': None if reference is None else reference['receipts'],
        'scores': scores,
    }
    Path(args.out).write_text(json.dumps(result, indent=2) + '\n')
    print(f"{len(selected)} tasks, modes: {', '.join(modes)}, excluded: {len(excluded)}")
    for score in scores:
        print(f"{score['mode']}: mean F1 {score['meanPerRowF1']:.4f}, micro F1 {score['microF1']:.4f}, matched {score['matchedGoldSteps']}/{score['goldSteps']}")


if __name__ == '__main__':
    main()
