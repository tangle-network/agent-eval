# CodeTraceBench Official-Metric Leaderboard

Every real-model trace-analysis configuration this repository has measured, ranked on CodeTraceBench's published metric, with the instrument-quality evidence needed to decide which numbers are trustworthy.
Snapshot date: 2026-08-03.
All numbers are extracted from run artifacts on disk; none are recomputed with different semantics (see [Reproduce](#reproduce) for the bit-match proof).

## The metric

**Official all-row F1** is CodeTraceBench's published score: per-trajectory F1 over predicted vs labeled incorrect step ids, averaged over every row of the split.
The reference implementation is [`src/analyst/benchmark-public-calibration.ts`](../../src/analyst/benchmark-public-calibration.ts) (`officialCodeTraceF1`), which matches the scorer snippet in the upstream CodeTracer `README.md` ("Evaluation Metrics") symbol for symbol.
Three properties matter when reading any number below:

1. A row with an empty label set scores 0 regardless of the prediction, and a row where the analyst run failed scores 0.
   The metric therefore mixes detection quality with split composition: a split with 16/32 label-empty rows has a hard ceiling of 0.50, and a split with 2/32 label-empty rows has a ceiling of 0.94.
2. **Official all-row F1 is only comparable within a single split.**
   Cross-split comparisons compare label composition, not analysts.
3. Every artifact also records our diagnostic **scored micro F1** (micro precision/recall over labeled-positive rows plus solved label-empty controls, failures excluded from predictions but counted).
   Micro F1 is reported as context, never as the ranking metric.

## Citation rules

1. Cite a number only together with its split's labels digest and status from the [instrument-quality ledger](#instrument-quality-ledger).
   Numbers from SPENT splits are readable history and may not back new public claims.
2. Same-rows only: a comparison row is honest only if both tools ran the identical trajectory set and labels (byte-verified by the `traceFiles[].sha256` and `labelsSha256` fields embedded in each artifact).
   Numbers lifted from a paper on different rows are context, and must carry the not-same-rows caveat.
3. Config identity is `protocolSha256` (and `implementationSha256`), not the narrative name.
   Run identity for reproduction is `runIdentitySha256` plus `startedAt` (identical configs re-run share `runIdentitySha256`).
4. A run with failed observations keeps its official score (failures score 0) but must disclose the failure count.
   Runs from parallel measurement chains are flagged: parallel execution against this provider measurably destroys runs (see protocol notes).
5. Smoke runs (fewer than the full split's rows) are never rankable.

## Configurations

All runs use analyst model `glm-5.2` (z.ai), dataset `NJU-LINK/CodeTraceBench` revision `aa213b84ffb6690fc37ca15766d6ca174ec36d4d`, runners `empty` + one analyst, `runnerOrderSeed 0`, census case selection unless noted.
Narrative labels below come from the run naming and the `.evolve/progress.md` ledger; the digests are authoritative.

| Label | `protocolSha256` (8) | `implementationSha256` (8) | Description |
| --- | --- | --- | --- |
| direct-v1 | `166e399c` | `4dba263b` | Retired one-shot direct runner, incorrect-step adapter; two arms: with final-test artifacts, and trajectory-only ("fair") |
| direct-blocks | `2aa97505` | `b959a4c1` | One-shot direct runner, incorrect-block adapter |
| rlm-stock-r0 | `bd0347aa` | `87e10f21` | Recursive DSPy RLM analyst, pre-GEPA stock prompt |
| rlm-gepa (g) | `4006588e` | `027db213` | GEPA-round-1 optimized prompt; promoted to stock 2026-08-01 |
| rlm-incumbent (inc) | `5811b534` | `027db213` | Incumbent stock prompt at certification time |
| rlm-width-W (w) | `dc8e043a` | `1de4cccc` | Hand-designed width-adaptive arm; rejected by its pre-registered gate |
| rlm-stock (cert2) | `747ac229` | `a3f5a820` | Shipped stock prompt at 2026-08-01 (post GEPA-r1 promotion), updated implementation |
| rlm-gepa-r2 (g2) | `0629426b` | `a3f5a820` | GEPA-round-2 winner candidate; rejected (below stock on both cross-family splits) |
| rlm-framing | `0bd09994` | `a3f5a820` | Family-framing prompt variant (dev smoke only) |
| CodeTracer (pinned) | n/a | upstream `2d302191` | Upstream CodeTracer at revision `2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34`, memory disabled, trajectory-only |
| empty | n/a | n/a | Constant baseline embedded in every run; predicts nothing; official all-row F1 = 0 on every split |

## Instrument-quality ledger

Constant-rule calibration computed directly from each labels file under the official per-row semantics (`leaderboard/calibrate-splits.py`).
`flag-last-step` predicts exactly the final step of every trajectory; `flag-all-steps` predicts every step.
A split cannot certify a configuration whose score a constant rule approaches.

| Split | Labels sha256 (8) | n | Positives | Label-empty | Gold steps | flag-last-step | last-step hit rows | flag-all-steps | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mini-SWE cert32 ("dev32") | `5d8b4024` | 32 | 16 | 16 | 55 | 0.0000 | 0/32 | 0.0956 | SPENT (tuning split; published baseline) |
| mini-SWE holdout-1 | `53af5ffe` | 32 | 16 | 16 | 76 | 0.0437 | 3/32 | 0.1125 | SPENT (used for GEPA train/selection) |
| mini-SWE holdout-2 | `2db46579` | 32 | 30 | 2 | 188 | 0.0879 | 9/32 | 0.3326 | Burned once (2026-08-01 certification); mini-SWE claims closed |
| mini-SWE split3 remainder-37 | `d0347ec7` | 37 | 37 | 0 | 58 | 0.1099 | 5/37 | 0.1125 | DEGENERATE for config selection (see finding below) |
| mini-SWE thin-blind-28 (restored) | `bf573bec` | 28 | 28 | 0 | 40 | 0.1310 | 4/28 | 0.1061 | Smoke only; input-blindness-fixed restoration of split3 rows |
| OpenHands cert32 | `2cf55793` | 32 | 16 | 16 | 87 | 0.0125 | 1/32 | 0.1021 | SPENT (burned 2026-08-01 cert2) |
| Terminus2 cert32 | `24e47110` | 32 | 16 | 16 | 100 | 0.0000 | 0/32 | 0.0770 | SPENT (burned 2026-08-01 cert2) |
| OpenHands dev pool | `2bd62a9d` | 464 | 146 | 318 | 494 | 0.0313 | 22/464 | 0.0455 | Tuning-legal |
| Terminus2 dev pool | `8388ffde` | 188 | 50 | 138 | 338 | 0.0000 | 0/188 | 0.0395 | Tuning-legal |
| SWE-agent 106 | `399cfed3` | 106 | 57 | 49 | 200 | 0.1895 | 38/106 | 0.0941 | CLEAN — imported 2026-08-02, no analyst run yet |

### Finding: split3 cannot select between configurations

On split3 (37 rows, all positive, only 58 gold steps — 1.6 per row), the three certified configurations land within 0.54 points of each other on the official metric (g 0.1844, inc 0.1830, w 0.1791) while the flag-last-step constant rule scores 0.1099.
The metric spread between real configs is smaller than the gap to a trivial rule, and the two metrics disagree on the ranking (micro F1 orders w 0.1805 > g 0.1799 > inc 0.1693).
Any leaderboard position established on this split is noise; the split is retained only as evidence about the thin-gold narrow regime.

### Finding: SWE-agent labels carry a last-step artifact

On the freshly imported SWE-agent 106 rows, flagging only each trajectory's final step scores official all-row F1 0.1895 by hitting 38/106 rows — higher than every measured cross-family configuration score on the OpenHands and Terminus2 cert32 splits (0.118–0.150).
(A prior session note quoted this as 39/106; the executed recomputation in `leaderboard/calibrate-splits.py` gives 38/106.)
Any future SWE-agent leaderboard entry must publish the constant-rule row beside the model row, or the number is not interpretable.

### Finding: parallel measurement chains destroy runs

`mp-tw-full-h1` (parallel chain) failed all 96/96 observations — 66 scored plus 30 unlabeled — in 4.3 minutes (96 cost-ledger records with unknown cost), while the serially executed `mp-tw-serial-h1` on the same split completed 94/96 observations.
All rankable numbers below come from serial chains; parallel-chain runs are listed as non-rankable.

### Note: holdout-2 composition

Holdout-2 is cascade-skewed by construction: 30/32 rows positive, 188 gold steps.
Its official numbers (0.48–0.54) are not comparable to any 16/32-positive split (ceiling differences dominate); they are comparable only within the holdout-2 table.

## Leaderboards

One table per split, ranked on official all-row F1.
"Failed" counts scored observations (positives + trusted negatives) that errored; they score 0 and stay in the mean.
Costs are settled totals from each run's `cost-ledger.jsonl`; the 20260730 trio costs are the same-rate estimates from that run's README.

### mini-SWE cert32 — labels `5d8b4024`, 32 rows, SPENT

| # | Config | Reps | Obs | Official all-row F1 | Micro F1 | Failed | Cost USD | Date | Artifact |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | rlm-width-W (serial) | 3 | 96 | 0.1526 | 0.3231 | 2/72 | 9.96 | 2026-08-01 | `salvaged-runs/devshm-20260803/mp-tw-serial-dev` |
| 2 | direct-v1 (trajectory-only) | 2 | 64 | 0.1502 | 0.3099 | 2/48 | 1.16 | 2026-07-30 | repo `codetracebench-glm52-20260730/fair-result.json` |
| 3 | direct-v1 (+ test artifacts) | 2 | 64 | 0.1347 | 0.3273 | 1/48 | 1.21 | 2026-07-30 | repo `codetracebench-glm52-20260730/result.json` |
| 4 | direct-blocks | 2 | 64 | 0.1296 | 0.3007 | 7/48 | n/a | 2026-07-31 | repo `codetracebench-phasea-blocks-20260731` (= `salvaged-runs/ctb-phasea3`) |
| 5 | CodeTracer (pinned, trajectory-only) | 2 | 64 | 0.1161 | 0.2754 | 2/48 | 7.27 | 2026-07-30 | repo `codetracebench-glm52-20260730/codetracer-result.json` |
| 6 | rlm-stock-r0 | 2 | 64 | 0.1021 | 0.3282 | 3/48 | n/a | 2026-07-31 | repo `codetracebench-rlm-glm52-20260731` (= `salvaged-runs/rlm-full7`) |

Non-rankable on this split: `mp-tw-full-dev` (parallel chain, 8/72 failed, official 0.1486, $9.79); `rlm-full5`/`rlm-full6` (46/48 and 34/48 failed, official 0.0179 each — broken runs); smokes `rlm-smoke9`, `rlm-chk`, `ctb-smoke`, `gepa-run/cli-proof`, `mp-tw-smoke-narrow` (1–4 obs).

The direct-v1 rows and the CodeTracer row are the same-rows head-to-head published 2026-07-30: identical 32 trajectories, identical labels, same model, and CodeTracer's own normalizer preparing the inputs.
On that run CodeTracer used 933 model calls, 10.44M uncached input tokens, and $7.27 (same-rate repricing; its own price config reported $63.64) against Agent Eval's 64 calls and $1.16–$1.21.

### mini-SWE holdout-1 — labels `53af5ffe`, 32 rows, SPENT

| # | Config | Reps | Obs | Official all-row F1 | Micro F1 | Failed | Cost USD | Date | Artifact |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | rlm-width-W (serial) | 3 | 96 | 0.1737 | 0.3542 | 2/66 | 11.33 | 2026-08-01 | `salvaged-runs/devshm-20260803/mp-tw-serial-h1` |

Non-rankable: `mp-tw-full-h1` (parallel wipeout, 66/66 failed, official 0.0000); smokes `mp-tw-h1-probe`, `mp-tw-smoke-wide`, `mp-tw-smoke-wide-rep` (1–2 obs).

### mini-SWE holdout-2 — labels `2db46579`, 32 rows (30 positive), burned once 2026-08-01

| # | Config | Reps | Obs | Official all-row F1 | Micro F1 | Failed | Cost USD | Artifact |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | rlm-gepa (g) | 2 | 64 | 0.5427 | 0.6288 | 0/60 | 7.96 | `certification/cert-g-h2` |
| 2 | rlm-incumbent (inc) | 2 | 64 | 0.5246 | 0.5641 | 0/60 | 7.97 | `certification/cert-inc-h2` |
| 3 | rlm-width-W (w) | 2 | 64 | 0.4805 | 0.5224 | 1/60 | 7.67 | `certification/cert-w-h2` |

Constant flag-last-step on this split: 0.0879 — the ranked configs clear it by 5.5–6.2×, so holdout-2 discriminates.
This is the certification that promoted the GEPA prompt to stock (evolve ledger, 2026-08-01: pooled-sealed micro 0.4809 vs incumbent 0.4285 over both burned splits).

### mini-SWE split3 remainder-37 — labels `d0347ec7`, 37 rows, DEGENERATE

| # | Config | Reps | Obs | Official all-row F1 | Micro F1 | Failed | Cost USD | Artifact |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | rlm-gepa (g) | 2 | 74 | 0.1844 | 0.1799 | 0/74 | 9.07 | `certification/cert-g-s3` |
| 2 | rlm-incumbent (inc) | 2 | 74 | 0.1830 | 0.1693 | 1/74 | 9.24 | `certification/cert-inc-s3` |
| 3 | rlm-width-W (w) | 2 | 74 | 0.1791 | 0.1805 | 1/74 | 8.72 | `certification/cert-w-s3` |

Ranked for completeness only; see the degeneracy finding above.

### OpenHands cert32 — labels `2cf55793`, 32 rows, SPENT

| # | Config | Reps | Obs | Official all-row F1 | Micro F1 | Failed | Cost USD | Artifact |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | rlm-stock | 2 | 64 | 0.1381 | 0.2436 | 0/60 | 7.33 | `cert2/stock-oh` |
| 2 | rlm-gepa-r2 (g2) | 2 | 64 | 0.1220 | 0.1828 | 1/60 | 8.15 | `cert2/g2-oh` |

### Terminus2 cert32 — labels `24e47110`, 32 rows, SPENT

| # | Config | Reps | Obs | Official all-row F1 | Micro F1 | Failed | Cost USD | Artifact |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | rlm-stock | 2 | 64 | 0.1497 | 0.1896 | 0/52 | 7.56 | `cert2/stock-t2` |
| 2 | rlm-gepa-r2 (g2) | 2 | 64 | 0.1186 | 0.1633 | 2/52 | 8.03 | `cert2/g2-t2` |

The cross-family result is the sharpest fact in this document: the prompt GEPA-optimized on mini-SWE traces transfers WORSE than stock to both other agent families (−1.6pp OpenHands, −3.1pp Terminus2 official).
For scale, a flag-last-step constant rule reaches 0.1895 on the (different-split) SWE-agent labels — absolute scores in the 0.12–0.15 range must always be read against their own split's constant-rule calibration.
`cert2/status.txt` records exit code 2 for both g2 arms; their artifacts contain complete 64-observation sets (1–2 failed observations).

### Dev smokes (tuning-legal pools, non-rankable)

| Run | Split (labels) | Obs | Official | Micro | Failed | Cost USD | Date |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `family-framing-smoke/stock-openhands` | OH dev 6-row smoke (`1b687899`) | 12 | 0.4611 | 0.3023 | 0/12 | 1.51 | 2026-08-03 |
| `family-framing-smoke/framing-openhands` | OH dev 6-row smoke (`1b687899`) | 12 | 0.2149 | 0.2151 | 1/12 | 1.38 | 2026-08-03 |
| `split3-restored/smoke-run` | thin-blind-28 subset (`bf573bec`) | 8 | 0.1958 | 0.2000 | 0/8 | n/a | 2026-08-01 |

A `family-framing-smoke/stock-terminus2` run was in flight (holding the measurement mutex) at this snapshot's extraction time, 2026-08-03T06:32Z; it is not included.

## Published-tool context (NOT same rows)

The CodeTracer paper reports headline incorrect-step localization scores of roughly 48% and 50.9%.
Those numbers were produced on the full curated dataset with different rows, different label composition, its own harness, and its cross-trajectory memory enabled — none of which hold for any row in this document, so they are not comparable to any number here.
We additionally could not verify those figures against any artifact on disk at snapshot time (they do not appear in the pinned CodeTracer repository at `2d302191`); they are recorded here only as the upstream claim to be tested by a future same-rows run.
The only honest CodeTracer comparison we hold is the pinned same-rows run above: 0.1161 official all-row F1 on the mini-SWE cert32 rows with memory disabled, against our 0.1347/0.1502 on identical inputs.

## Full run ledger

Every analyst-benchmark artifact holding an embedded `codeTraceCalibration`, including duplicates and broken runs.
`Run id` is `runIdentitySha256` (8); identical configs re-run share it, so `startedAt` disambiguates.
Paths are relative to `~/bench-cache/ctb-20260801/` unless prefixed `repo:` (this repository, `benchmarks/trace-analysis/`).

| Artifact | Run id | Labels | Protocol | Reps | Official | Micro | Failed | Started |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| repo:`codetracebench-glm52-20260730/result.json` | `044393f7` | `5d8b4024` | `166e399c` | 2 | 0.1347 | 0.3273 | 1 | 2026-07-30T15:31Z |
| repo:`codetracebench-glm52-20260730/fair-result.json` | `34159faa` | `5d8b4024` | `166e399c` | 2 | 0.1502 | 0.3099 | 2 | 2026-07-30T15:35Z |
| repo:`codetracebench-glm52-20260730/codetracer-result.json` | n/a | `5d8b4024` | upstream `2d302191` | 2 | 0.1161 | 0.2754 | 2 | 2026-07-30 |
| repo:`codetracebench-phasea-blocks-20260731/result.json` | `ddc3e665` | `5d8b4024` | `2aa97505` | 2 | 0.1296 | 0.3007 | 7 | 2026-07-31T06:51Z |
| repo:`codetracebench-rlm-glm52-20260731/result.json` | `e6304c8a` | `5d8b4024` | `bd0347aa` | 2 | 0.1021 | 0.3282 | 3 | 2026-07-31T09:42Z |
| `certification/cert-g-h2` | `24883695` | `2db46579` | `4006588e` | 2 | 0.5427 | 0.6288 | 0 | 2026-08-01T12:53Z |
| `certification/cert-w-h2` | `74ece843` | `2db46579` | `dc8e043a` | 2 | 0.4805 | 0.5224 | 1 | 2026-08-01T12:28Z |
| `certification/cert-inc-h2` | `229d11c0` | `2db46579` | `5811b534` | 2 | 0.5246 | 0.5641 | 0 | 2026-08-01T12:04Z |
| `certification/cert-g-s3` | `417161b6` | `d0347ec7` | `4006588e` | 2 | 0.1844 | 0.1799 | 0 | 2026-08-01T14:21Z |
| `certification/cert-w-s3` | `df4ce98c` | `d0347ec7` | `dc8e043a` | 2 | 0.1791 | 0.1805 | 1 | 2026-08-01T13:51Z |
| `certification/cert-inc-s3` | `dfff2ee1` | `d0347ec7` | `5811b534` | 2 | 0.1830 | 0.1693 | 1 | 2026-08-01T13:20Z |
| `cert2/stock-oh` | `30d80958` | `2cf55793` | `747ac229` | 2 | 0.1381 | 0.2436 | 0 | 2026-08-01T22:51Z |
| `cert2/stock-t2` | `abda3035` | `24e47110` | `747ac229` | 2 | 0.1497 | 0.1896 | 0 | 2026-08-01T23:37Z |
| `cert2/g2-oh` | `0e688fd3` | `2cf55793` | `0629426b` | 2 | 0.1220 | 0.1828 | 1 | 2026-08-01T23:11Z |
| `cert2/g2-t2` | `0f1d655c` | `24e47110` | `0629426b` | 2 | 0.1186 | 0.1633 | 2 | 2026-08-02T00:00Z |
| `salvaged-runs/rlm-smoke9` | `b4b0f57e` | `5d8b4024` | `80f3ca7f` | 1 | 0.1250 | 0.4000 | 0 | smoke, 4 obs |
| `salvaged-runs/rlm-chk` | `a9d72390` | `5d8b4024` | `80f3ca7f` | 1 | 0.0000 | 0.0000 | 0 | smoke, 2 obs |
| `salvaged-runs/rlm-full5` | `1856e5b1` | `5d8b4024` | `bd0347aa` | 2 | 0.0179 | 0.0678 | 46 | broken, 2026-07-31T09:12Z |
| `salvaged-runs/rlm-full6` | `1be7492a` | `5d8b4024` | `bd0347aa` | 2 | 0.0179 | 0.0593 | 34 | broken, 2026-07-31T09:23Z |
| `salvaged-runs/rlm-full7` | `e6304c8a` | `5d8b4024` | `bd0347aa` | 2 | 0.1021 | 0.3282 | 3 | duplicate of repo rlm run (same `startedAt`) |
| `salvaged-runs/ctb-smoke` | `5f60033c` | `5d8b4024` | `1e31880c` | 1 | 0.0000 | 0.0000 | 1 | smoke, 2 obs |
| `salvaged-runs/ctb-phasea3` | `ddc3e665` | `5d8b4024` | `2aa97505` | 2 | 0.1296 | 0.3007 | 7 | duplicate of repo phasea run (same `startedAt`) |
| `family-framing-smoke/stock-openhands` | `a5446d3f` | `1b687899` | `747ac229` | 2 | 0.4611 | 0.3023 | 0 | 2026-08-03T05:08Z |
| `family-framing-smoke/framing-openhands` | `c83c5424` | `1b687899` | `0bd09994` | 2 | 0.2149 | 0.2151 | 1 | 2026-08-03T05:39Z |
| `split3-restored/smoke-run` | `e8ee878d` | `bf573bec` | `6a9d8784` | 2 | 0.1958 | 0.2000 | 0 | smoke, 8 obs |
| `gepa-run/cli-proof` | `8d4f6631` | `5d8b4024` | `cb2a5beb` | 1 | 0.5000 | 0.5000 | 0 | smoke, 1 obs |
| `salvaged-runs/devshm-20260803/mp-tw-full-dev` | `526dc2ff` | `5d8b4024` | `dc8e043a` | 3 | 0.1486 | 0.3660 | 8 | parallel chain, 2026-08-01T09:04Z |
| `salvaged-runs/devshm-20260803/mp-tw-full-h1` | `3664d62f` | `53af5ffe` | `bd0347aa` | 3 | 0.0000 | 0.0000 | 66 | parallel wipeout, 2026-08-01T09:04Z |
| `salvaged-runs/devshm-20260803/mp-tw-serial-dev` | `526dc2ff` | `5d8b4024` | `dc8e043a` | 3 | 0.1526 | 0.3231 | 2 | 2026-08-01T10:42Z |
| `salvaged-runs/devshm-20260803/mp-tw-serial-h1` | `5cdb66a4` | `53af5ffe` | `dc8e043a` | 3 | 0.1737 | 0.3542 | 2 | 2026-08-01T10:05Z |
| `salvaged-runs/devshm-20260803/mp-tw-h1-probe` | `b6a4eebc` | `53af5ffe` | `dc8e043a` | 1 | 0.0000 | 0.0000 | 0 | smoke, 1 obs |
| `salvaged-runs/devshm-20260803/mp-tw-smoke-narrow` | `ec347ceb` | `5d8b4024` | `bd0347aa` | 1 | 0.6667 | 0.6667 | 0 | smoke, 1 obs |
| `salvaged-runs/devshm-20260803/mp-tw-smoke-wide` | `b6a4eebc` | `53af5ffe` | `dc8e043a` | 1 | 0.0000 | 0.0000 | 0 | smoke, 1 obs |
| `salvaged-runs/devshm-20260803/mp-tw-smoke-wide-rep` | `550c5da5` | `53af5ffe` | `dc8e043a` | 2 | 0.7636 | 0.7619 | 0 | smoke, 2 obs |

## Full digests

Labels files (sha256 → local path at snapshot time):

```
5d8b4024c3e2114965cbf2f2fa0124bbf59b3fb134824fa06dd6a38ee07e8412  repo benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json
53af5ffe3962f3378f2d65419b92b8a56fe7d6c8efc619a0bc2b8f0872bc4f83  ~/bench-cache/ctb-20260801/ctb-holdout-labels.json
2db46579b7993edc376acbbcacf67a1d0ddfcdb94e28930c2bb8dfcf1dc32fb2  ~/bench-cache/ctb-20260801/ctb-holdout2-labels.json
d0347ec7a5ec9a07bd3fcd16aa06b07bcb33ffabca39cb0b0f7a564fb500ae08  ~/bench-cache/ctb-20260801/split3/ctb-split3-labels.json
bf573beca3bd58c2f2937671dfaa54095f6438523d07caa22608e1e87b114c1d  ~/bench-cache/ctb-20260801/split3-restored/thin-blind-labels.json
2cf557938f0c1d8d239ede37de91e0f5cb58a9f2854e2e74ab1baa764cf91fde  ~/bench-cache/ctb-20260801/oht2/ctb-openhands-cert32-labels.json
24e471101c652aa0a7d9edc6dc9081d1a67589b1481f21c71552d47106cae3e6  ~/bench-cache/ctb-20260801/oht2/ctb-terminus2-cert32-labels.json
2bd62a9d5ec785482611e1b02a1a829cf98c0777b6ae1ac9b1867b8fc9e4b8c6  ~/bench-cache/ctb-20260801/oht2/ctb-openhands-dev-labels.json
8388ffde9c1b3b3f8f04afb4356a3b10abefda6db9ecd0216f65003bf6251958  ~/bench-cache/ctb-20260801/oht2/ctb-terminus2-dev-labels.json
399cfed3b9b53dc47e61735ad0dde94acfeb3fcd63cd9879fe96e90df093d6d1  ~/bench-cache/ctb-20260801/sweagent/ctb-sweagent-labels.json
```

Only the first labels file is published in this repository today; publishing the remaining label manifests is gap item 2 below.
Every run artifact additionally embeds per-trajectory `sha256` digests for its exact input archives (`inputs.traceFiles[]`), so any row can be byte-verified against re-prepared inputs.

## Reproduce

Extraction and calibration scripts live in [`leaderboard/`](./leaderboard/); paths inside them reference the operator bench cache described above.

```bash
# 1. Extract every embedded official-metric number (writes JSON to stdout)
python3 benchmarks/trace-analysis/leaderboard/extract-official.py

# 2. Prove extraction reads the exact field the scorer wrote (bit-match, exit 0 on success)
python3 benchmarks/trace-analysis/leaderboard/extract-official.py --bitmatch \
  ~/bench-cache/ctb-20260801/certification/cert-g-h2/result.json

# 3. Constant-rule calibration table from raw labels
python3 benchmarks/trace-analysis/leaderboard/calibrate-splits.py
```

Bit-match note: the recomputation reproduces the embedded doubles exactly (`cert-g-h2` → `0.5427281892181798`, `stock-oh` → `0.13809445762570763`, 20260730 baseline → `0.13470062923187923`).
One trap is documented in the script: Python ≥3.12 `sum()` is Neumaier-compensated and differs from the TypeScript `reduce` fold by 1 ulp on 64-row sums, so the bit-match uses an explicit left fold.
The extractor itself only ever *reads* embedded values; the bit-match exists to prove it reads the same field the scorer wrote.
The extraction snapshot used for this document is committed as [`leaderboard/official-extract-20260803.json`](./leaderboard/official-extract-20260803.json).

## Appendix: what a submission-ready public claim still needs

Ranked by effort, smallest first.

1. **File the upstream CodeTraceBench issue for the degenerate wave** (hours).
   Report the split3 finding: 37-row all-positive remainder with 58 gold steps where three materially different analysts land within 0.54pp of the official metric and within 7.5pp of a flag-last-step constant rule, plus the last-step label artifact measured on the SWE-agent rows (0.1895 / 38 of 106 rows), plus the input-blindness normalizer defect that thin-blind-28 restores.
   The constant-rule calibration script in this directory is the reproducible evidence.
2. **Publish the label manifests** (hours).
   Nine of ten label files above exist only in the operator bench cache; a public claim needs them (or their derivation scripts plus digests) in-repo.
3. **Official-metric run of the shipping config on a clean split with ≥3 reps** (one mutex session, ~$40 at the measured ~$0.125/observation — 64-observation runs above cost $7.3–8.2 — for 106 rows × 3 reps).
   Every existing shipping-config number sits on a SPENT or burned split; the SWE-agent 106 (imported, sealed, spot-proofed 3/3) is the only clean candidate, and its table must carry the constant-rule row (0.1895) beside the model row.
   2-rep confidence intervals of ±0.15–0.28 (evolve ledger) cannot certify small deltas; 3+ reps minimum.
4. **Same-rows CodeTracer head-to-head on that clean split** (one mutex session, ~$25–35 extrapolating $7.27/64 obs to 106 rows).
   Pinned revision, memory disabled, byte-identical inputs via its own normalizer — the same protocol as the 20260730 trio.
5. **Full official verified-1000 run** (days, ~$125 per repetition for our analyst at the measured ~$0.125/observation — ~$375 at 3 reps — plus a materially larger CodeTracer bill).
   Only after items 1–4: the verified-1000 split mixes agent families whose labels carry the artifacts documented above, so publishing without the instrument ledger would reproduce the same interpretability failure this leaderboard exists to prevent.
