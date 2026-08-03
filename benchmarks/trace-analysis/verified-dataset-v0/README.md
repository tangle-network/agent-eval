# verified-dataset-v0 — execution-verified gold labels as RL rows

The first artifact of the verified-labels flywheel: gold "incorrect step" annotations that a replay-verify batch re-executed inside the original docker image, joined with their trajectories into trainer-ready rows.
The label on every row was decided by execution (returncode/signature comparison at the gold step, plus a fix arm), not by a rater.
The pipeline is the deliverable; rows scale with every future replay batch.
Flywheel context and the phase-2 capture spec live in [`docs/verified-labels-flywheel.md`](../../../docs/verified-labels-flywheel.md).

## Artifact (out of git — 1.4 MB, sha-pinned)

Location: `~/bench-cache/ctb-20260801/verified-dataset-v0/`

| file | sha256 | contents |
| --- | --- | --- |
| `rows.jsonl` | `afcbfb7b21c14868f8654bb27d113f42ba66fd951bcdc64b5f32b1e8b33641e3` | 22 `VerifiedFindingRow` lines (1,436,306 bytes) |
| `manifest.json` | committed by the builder run | summary + source provenance + emitted-file shas |

Source pins (embedded per row and in the manifest):

| source | sha256 |
| --- | --- |
| `replay-batch/run2-20260802/batch-report.json` | `be6236dce691ea9df7c850040c995dd1f2274aaf559c45836c726bc480288fb3` |
| `ctb-holdout-labels.json` (holdout-1) | `53af5ffe3962f3378f2d65419b92b8a56fe7d6c8efc619a0bc2b8f0872bc4f83` |
| `ctb-holdout2-labels.json` (holdout-2) | `2db46579b7993edc376acbbcacf67a1d0ddfcdb94e28930c2bb8dfcf1dc32fb2` |
| `split3/ctb-split3-labels.json` (split3) | `d0347ec7a5ec9a07bd3fcd16aa06b07bcb33ffabca39cb0b0f7a564fb500ae08` |

Run2 composition (n=22): 16 reproduced, 13 signature-strict, fix arms 9 flipped / 2 not-flipped / 5 generation-failed / 6 not-attempted.
Per corpus — holdout-1: 4 rows (2 reproduced, 1 flipped); holdout-2: 9 (9, 7); split3: 9 (5, 1).

## Row schema — `agent-eval/verified-finding@0`

One row per replayable case (JSONL). Full types: `src/rl/verified-findings-dataset.ts` (exported from `@tangle-network/agent-eval/rl`).

| field | meaning |
| --- | --- |
| `caseId` | `<runId>/<corpus>/<trajId>` — unique across batches |
| `task` | agent, model, task name, difficulty, solved, step count (from the gold label entry) |
| `gold.stepK` | the verified gold step — earliest replayable incorrect step |
| `gold.actionAtK` | exact command the agent ran at k (never truncated — it is the labeled object) |
| `gold.goldIncorrectSteps` / `gold.labelIncorrectSteps` | replay targets vs every labeled incorrect step |
| `gold.recordedReturncodeAtK` | returncode the original trajectory recorded at k |
| `trajectory` | prefix steps 1..k (action + observation, observations truncated at 4000 chars with original length kept); post-k steps are excluded so a trainer never sees the future |
| `verification.reproduced` | batch verdict: prefix divergence ≤ tolerance AND arm A reproduced the recorded returncode at k |
| `verification.signatureStrict` | arm A also matched the failure signature (raw evidence — can be true on a non-reproduced case) |
| `verification.prefixDivergenceDetail` | per-step `{step, expectedReturncode, actualExit}` from the per-case verdict |
| `verification.armAExit` / `armACommand` | executed evidence at k |
| `fix.outcome` | `flipped` \| `not-flipped` \| `generation-failed` \| `not-attempted` (batch report is authoritative; arm B exit carried) |
| `provenance` | run id, batch/labels/steps sha256s, docker image + derived replay image, cwd, original/arm-A run ids |

Join discipline: any missing or inconsistent join (label absent, step-count mismatch, k outside the gold set, arm B verdict missing on a fix command) throws — a partially joined dataset is never written.

## Regenerate

```bash
pnpm build
node benchmarks/trace-analysis/tools/build-verified-dataset.mjs \
  --report ~/bench-cache/ctb-20260801/replay-batch/run2-20260802/batch-report.json \
  --run-id run2-20260802 \
  --run-dir ~/bench-cache/ctb-20260801/replay-batch/run2-20260802 \
  --out ~/bench-cache/ctb-20260801/verified-dataset-v0 \
  --corpus 'holdout-1=/home/drew/bench-cache/ctb-20260801/ctb-holdout-labels.json::/home/drew/bench-cache/ctb-20260801/ctb-holdout-prepared' \
  --corpus 'holdout-2=/home/drew/bench-cache/ctb-20260801/ctb-holdout2-labels.json::/home/drew/bench-cache/ctb-20260801/ctb-holdout2-prepared' \
  --corpus 'split3=/home/drew/bench-cache/ctb-20260801/split3/ctb-split3-labels.json::/home/drew/bench-cache/ctb-20260801/split3/ctb-split3-prepared'
```

The build is deterministic given the same inputs: `rows.jsonl` reproduces byte-identical (manifest `generatedAt` varies).
