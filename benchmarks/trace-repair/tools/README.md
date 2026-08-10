# trace-repair tools

## assay-tbench-corpus.mjs

Cost gate for TB-Repair.
It measures whether the public Terminal-Bench 2.0 trajectory dump holds enough replayable failed `mini-swe-agent` trajectories to justify a fleet campaign, and it answers that question before any budget is spent.

The tool reads the parquet shards with the duckdb CLI, cross-references upstream task definitions, and writes `ASSAY.md` plus `assay.json` into the data directory.
Every input is verified on entry.
A missing shard, a missing clone, or a missing duckdb binary fails loud instead of producing a partial report.

### Run it

```bash
node benchmarks/trace-repair/tools/assay-tbench-corpus.mjs \
  --data-dir ~/bench-cache/tbench-20260808 \
  [--tb2 DIR] [--duckdb PATH] \
  [--check-images | --images-json PATH] \
  [--verify-task NAME]
```

- `--data-dir` holds the `train-*.parquet` shards and receives both report files. Default: `~/bench-cache/tbench-20260808`.
- `--tb2` points at a `harbor-framework/terminal-bench-2` clone. Default: `<data-dir>/tb2`.
- `--check-images` reads image manifests from Docker Hub, which rate-limits anonymous callers. `--images-json` replays a manifest capture instead, and the report records which of the two produced its numbers.
- `--verify-task NAME` runs the real grading loop on one task: grade the untouched image, apply the reference `solution/solve.sh`, re-grade. It adds the "Grading mechanism proven end-to-end" section. Without the flag that section is absent.

A full pass over both shards takes about 10 seconds.
`--verify-task` adds the task's own solve time, roughly 3 minutes for `gcode-to-text`.

### Reproducibility

Every query orders by a deterministic tiebreaker, so two runs over the same inputs produce byte-identical reports apart from the generated timestamp and, under `--verify-task`, the measured wall-clock seconds.
Treat any other difference as an input that moved.

### Admission tiers

Admission is tiered on what survived the scrape, not on raw failure.
Roughly 10.8% of recorded commands were replaced by `$N` placeholders, and those ids are a per-occurrence counter rather than a content dictionary, so the dropped text carries no recovery key.
Affected rows are filtered, never repaired.

- **Tier B** — every recorded command intact. This is the admission set for prefix replay: replay re-executes recorded commands and regenerates observations, so a placeholder in an observation costs the analyst context but never breaks execution. A placeholder in a command does break it.
- **Tier A** — Tier B plus observations and reasoning intact. Stricter, and biased toward short trajectories, because a long run has more chances to lose a field.

### Evidence layout

The tool writes into `--data-dir`, which stays outside the repo because the parquet shards are about 211 MiB.

```
<data-dir>/
  train-0000{0,1}-of-00002.parquet   corpus shards
  tb2/                               pinned terminal-bench-2 clone
  ASSAY.md                           report, human-readable
  assay.json                         same measurements, machine-readable
  tb2_images.json                    captured image manifests for --images-json
```

### Pins and decay

Pin the clone at `2fd12b88aafdd04a52c298e3940bcb189f9766d6`.
Task definitions move under unchanged names, so an unpinned clone silently regrades against different tests.

Never rebuild a task image from its `environment/Dockerfile` for replay work.
Local builds drift from the published images the trajectories were recorded against, because the Dockerfiles install unpinned apt and pip packages.
Pull the published image per task.

33 of 89 reference solutions fetch from the network at solve time, which makes a certified fail -> pass loop a decaying asset.
Re-certify with `certify-task-oracle.sh` before a campaign.
Exclude `make-doom-for-mips`: it has a 0.0% pass rate across all 52,104 rows.

## certify-task-oracle.sh

Certifies that a task can still separate a solved state from an unsolved one.
It runs the harbor grading loop by hand against the published image, in batch, across as many tasks as you name.

`assay-tbench-corpus.mjs --verify-task` proves the same loop for one task and folds the result into the assay report.
This script is the recurring operation: certify the task set a campaign is about to sample from, and write per-task evidence.

```bash
benchmarks/trace-repair/tools/certify-task-oracle.sh [options] TASK [TASK...]

  --tb2 DIR          terminal-bench-2 clone      (default: $TB2_DIR or ~/bench-cache/terminal-bench-2)
  --out DIR          per-task evidence root      (default: $TB_OUT_DIR or ~/bench-cache/bringup-results)
  --image-tag TAG    published image tag         (default: $TB_IMAGE_TAG or 20251031)
  --image-repo REPO  published image repo prefix (default: $TB_IMAGE_REPO or alexgshaw)
  --pull             pull the published image when it is absent
```

Exit status is 0 only when every named task certified.

### What it asserts

Phase A grades the untouched image and must score 0.
Phase B applies the reference `solution/solve.sh`, re-grades, and must score 1.

| verdict | meaning |
| --- | --- |
| `CERTIFIED` | phase A scored 0 and phase B scored 1 |
| `BROKEN_ORACLE_passes_unsolved` | phase A scored 1; the tests do not detect the unsolved state, so the task can measure nothing |
| `NOT_CERTIFIED(...)` | any other pair, with both rewards named |
| `IMAGE_MISSING` / `NO_TASK_DIR` / `TEST_INJECT_FAILED` | a precondition failed; nothing was graded |

`BROKEN_ORACLE_passes_unsolved` is checked before the certified case.
A task whose tests pass on an untouched image cannot measure a repair, whatever phase B reports.

Both phases record whether `/tests` existed before the agent phase.
`ABSENT` is the ungameability precondition: the solution ran to completion with no test directory present, so it could not have passed by writing its own reward.
The verifier's upload overwrites `/tests` at grade time.

### Evidence layout

Per-task evidence lands under `--out`, outside the repo because it holds container logs.

```
<out>/
  summary.psv          one header row, then one row per certification, appended
  <task>.log           full console transcript for the task
  <task>/
    unsolved-tests.txt phase A verifier stdout
    oracle.txt         reference solution stdout
    solved-tests.txt   phase B verifier stdout
```

A reward of `NO_REWARD_FILE` means the task's `test.sh` wrote nothing.
That is reported as-is and never folded into 0, because a missing reward and a zero reward are different failures.

## tb-images.mjs

Pinned task-image store.
A replay is only valid against the exact image bytes the recorded trajectory ran on, and a campaign must not stall because a third-party registry became unreachable mid-run.
This tool supplies both properties.

`tb-images.lock.json` pins all 89 terminal-bench-2 task images by registry manifest digest, beside the terminal-bench-2 commit the references were read from.
A republished tag then fails `verify` loudly instead of swapping the bits under a recorded trajectory.

```bash
node benchmarks/trace-repair/tools/tb-images.mjs <lock|warm|archive|verify|status> [options]

  --lock PATH        lockfile                   (default: benchmarks/trace-repair/tb-images.lock.json)
  --tb2 DIR          terminal-bench-2 clone     (default: ~/bench-cache/terminal-bench-2)
  --store DIR        local image store          (default: ~/bench-cache/tb-images)
  --tasks LIST       comma-separated task names, or `all`
  --tasks-file PATH  one task name per line
  --reserve N        pull budget held back      (default: 10)
  --archive          also `docker save` each warmed image
  --accept-moved     rewrite a pin whose tag moved, instead of failing
  --quota            report the remaining Docker Hub budget
```

`lock`, `warm` and `archive` write, so they take an exclusive lock on the store.
Two campaigns cannot corrupt one store.

### Which commands touch the network

| command | network | spends pull quota |
| --- | --- | --- |
| `lock` | manifest `HEAD` per task | no |
| `warm` | layer fetch for cold images only | yes, under `--reserve` |
| `archive` | none | no |
| `verify` | none | no |
| `status` | only with `--quota` | no |

Run `verify` at campaign start.
It is local-only, so an exhausted quota cannot throttle a run already under way.
`warm` defers rather than exceeding its budget: it stops while the reserve is intact and reports what is still cold.

### Two identities per image

Each image records both, because they survive different things.

- `digest` — the registry manifest digest. What we pull by. Immune to tag movement.
- `imageId` — the local image config id. What we verify by.

`docker save` followed by `docker load` preserves the config id and the tag but drops `RepoDigests`, so a restored archive can no longer be checked against its manifest digest.
Verification keys off the config id for that reason.

Measured Docker Hub anonymous limits that shape the budget logic (2026-08-09, one IP): 100 manifest `GET`s per 3600 s, and a manifest `HEAD` costs 0.
Resolving all 89 digests is therefore free; only a cold layer fetch spends quota.
