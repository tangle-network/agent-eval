# Pre-registration — round-2 certification on fresh cross-family instruments

Written 2026-08-01, BEFORE any model run against the sealed instruments and before GEPA round-2's winner is known.

## Instruments (sealed 2026-08-01, receipt `~/bench-cache/ctb-20260801/oht2/ctb-oht2-seal-receipt.json`)

| Split | Rows | Gold steps | Labels sha256 (prefix) | Family |
| --- | ---: | ---: | --- | --- |
| ctb-openhands-cert32 | 32 (16 labeled + 16 empty) | 87 | `2cf55793…` | OpenHands |
| ctb-terminus2-cert32 | 32 (16 labeled + 16 empty) | 100 | `24e47110…` | Terminus2 |

Pre-seal calibration (split3 lesson): best constant positional rule scores 0.043 (OH) / 0.024 (T2) — both families positionally honest.
No model has ever run on any OHT2 row; both splits were cut by seeded stratified sampling (seed 20260801) from the full import.

## Arms (2)

| Arm | Config |
| --- | --- |
| stock | current main stock prompt (= round-1 GEPA winner, sha `d3829fb8…`), stock engine |
| G2-winner | same engine + `--instructions-file` round-2 winner (sha recorded at readout from `summary.json`; if `winnerChanged` is false the certification is cancelled — nothing to certify) |

## Protocol

Strictly serial, 2 repetitions, seed 0, concurrency 6, glm-5.2 z.ai direct, max-output-tokens 8192, per-run `--max-cost-usd 30`, disk-backed `--out`.
4 runs total (2 arms × 2 splits), ~$30 expected.
Scoring: `compare-analyst-runs.mjs` per-split paired deltas + pooled-cert micro.

## Decision rules (fixed now)

1. Promote G2-winner iff pooled-cert micro(G2) ≥ micro(stock) AND neither family's paired f1 CI lower bound < −0.10.
2. Micro F1 is the promotion criterion; macro and per-family numbers reported, never substituted.
3. >10% failed runs on any run invalidates that run — rerun once serially before concluding.
4. Whatever the arm outcome, the stock arm's numbers are the first cross-family generalization measurement of the shipping analyst (mini-SWE-only until now) — report them per family regardless.
5. These two splits are burned for this config family after one readout.

## Explicitly out of scope

The N restore-step-reasoning arm is NOT in this certification (its smoke missed the primary gate; its full A/B, if funded, runs on the spent mini-SWE splits as measurement, then would need its own sealed instrument round).
