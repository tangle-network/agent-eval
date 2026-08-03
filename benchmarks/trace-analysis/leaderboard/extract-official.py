#!/usr/bin/env python3
"""Extract embedded codeTraceCalibration official-metric numbers from every analyst-benchmark artifact.

Never recomputes silently: the embedded officialAllRowF1 is the cited value.
A separate --bitmatch mode recomputes one artifact's value from raw observations
with the exact semantics of benchmark-public-calibration.ts:officialCodeTraceF1
and asserts bit equality, proving the extraction reads the same field the scorer wrote.
"""
import json
import re
import sys
import urllib.parse
from pathlib import Path

TRACE_DIR = Path(__file__).resolve().parents[1]
BENCH_CACHE = Path.home() / 'bench-cache/ctb-20260801'

ARTIFACTS = [
    # in-repo published runs
    str(TRACE_DIR / 'codetracebench-glm52-20260730/result.json'),
    str(TRACE_DIR / 'codetracebench-glm52-20260730/fair-result.json'),
    str(TRACE_DIR / 'codetracebench-glm52-20260730/codetracer-result.json'),
    str(TRACE_DIR / 'codetracebench-phasea-blocks-20260731/result.json'),
    str(TRACE_DIR / 'codetracebench-rlm-glm52-20260731/result.json'),
    # certification (shipped-config runs)
    str(BENCH_CACHE / 'certification/cert-g-h2/result.json'),
    str(BENCH_CACHE / 'certification/cert-w-h2/result.json'),
    str(BENCH_CACHE / 'certification/cert-inc-h2/result.json'),
    str(BENCH_CACHE / 'certification/cert-g-s3/result.json'),
    str(BENCH_CACHE / 'certification/cert-w-s3/result.json'),
    str(BENCH_CACHE / 'certification/cert-inc-s3/result.json'),
    # cert2 (OH/T2 stock + g2)
    str(BENCH_CACHE / 'cert2/stock-oh/result.json'),
    str(BENCH_CACHE / 'cert2/stock-t2/result.json'),
    str(BENCH_CACHE / 'cert2/g2-oh/result.json'),
    str(BENCH_CACHE / 'cert2/g2-t2/result.json'),
    # salvaged
    str(BENCH_CACHE / 'salvaged-runs/rlm-smoke9/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/rlm-chk/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/rlm-full5/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/rlm-full6/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/rlm-full7/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/ctb-smoke/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/ctb-phasea3/result.json'),
    # smokes / probes
    str(BENCH_CACHE / 'family-framing-smoke/stock-openhands/result.json'),
    str(BENCH_CACHE / 'family-framing-smoke/framing-openhands/result.json'),
    str(BENCH_CACHE / 'split3-restored/smoke-run/result.json'),
    str(BENCH_CACHE / 'gepa-run/cli-proof/result.json'),
    # selection-experiment runs salvaged from /dev/shm 2026-08-03
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-full-dev/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-full-h1/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-serial-dev/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-serial-h1/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-h1-probe/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-smoke-narrow/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-smoke-wide/result.json'),
    str(BENCH_CACHE / 'salvaged-runs/devshm-20260803/mp-tw-smoke-wide-rep/result.json'),
]

STEP_URI = re.compile(r'^trace://([^/]+)/span/step-(\d+)$')


def official_f1(observation):
    expected = set()
    score = observation['score']
    for issue_id in list(score['matchedIssueIds']) + list(score['missedIssueIds']):
        m = re.fullmatch(r'incorrect:(\d+)', issue_id)
        if not m:
            raise TypeError(f"{observation['caseId']}: invalid label {issue_id}")
        expected.add(int(m.group(1)))
    trajectory_id = (observation.get('caseMetadata') or {}).get('trajectoryId')
    predicted = set()
    if not observation.get('error'):
        for finding in observation['findings']:
            if finding['area'] != 'incorrect':
                continue
            for evidence in finding['evidence_refs']:
                m = STEP_URI.match(evidence['uri'])
                if not m or urllib.parse.unquote(m.group(1)) != trajectory_id:
                    raise TypeError(f"{observation['caseId']}: bad evidence {evidence['uri']}")
                predicted.add(int(m.group(2)))
    matched = len(predicted & expected)
    precision = 0 if not predicted else matched / len(predicted)
    recall = 0 if not expected else matched / len(expected)
    return 0 if precision + recall == 0 else (2 * precision * recall) / (precision + recall)


def bitmatch(path):
    d = json.loads(Path(path).read_text())
    ok = True
    for runner in d['codeTraceCalibration']['runners']:
        rid = runner['runnerId']
        obs = [o for o in d['result']['observations'] if o['runnerId'] == rid]
        rows = [official_f1(o) for o in obs]
        # explicit left fold: TS uses reduce((a,b)=>a+b,0); Python>=3.12 sum() is
        # Neumaier-compensated and differs by 1 ulp on 64-row sums
        total = 0.0
        for value in rows:
            total += value
        recomputed = total / len(rows) if rows else None
        embedded = runner['officialAllRowF1']
        match = recomputed == embedded
        ok = ok and match
        print(f'{path} runner={rid} embedded={embedded!r} recomputed={recomputed!r} '
              f'rows={len(rows)} BITMATCH={match}')
    return ok


def extract():
    out = []
    for path in ARTIFACTS:
        p = Path(path)
        if not p.exists():
            out.append({'path': path, 'missing': True})
            continue
        d = json.loads(p.read_text())
        cal = d.get('codeTraceCalibration')
        inputs = d.get('inputs', {})
        prov = d.get('result', {}).get('provenance', {})
        meta = prov.get('metadata', {})
        row = {
            'path': path,
            'runIdentitySha256': d.get('runIdentitySha256'),
            'datasetSplit': inputs.get('datasetSplit'),
            'datasetRevision': inputs.get('datasetRevision'),
            'labelsSha256': inputs.get('labelsSha256'),
            'sourceRowCount': inputs.get('sourceRowCount'),
            'model': meta.get('model'),
            'rlmSamples': meta.get('rlmSamples'),
            'outputAdapter': meta.get('outputAdapter'),
            'protocolSha256': meta.get('protocolSha256'),
            'implementationSha256': meta.get('implementationSha256'),
            'promptVariant': meta.get('promptVariant') or meta.get('instructionsVariant'),
            'metadataExtra': {k: v for k, v in meta.items()
                              if k not in ('model', 'rlmSamples', 'outputAdapter', 'protocolSha256',
                                           'implementationSha256')
                              and isinstance(v, (str, int, float, bool))},
            'repetitions': prov.get('repetitions'),
            'caseCount': prov.get('caseCount'),
            'startedAt': prov.get('startedAt'),
            'endedAt': prov.get('endedAt'),
            'runners': cal['runners'] if cal else None,
        }
        out.append(row)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--bitmatch':
        sys.exit(0 if bitmatch(sys.argv[2]) else 1)
    extract()
