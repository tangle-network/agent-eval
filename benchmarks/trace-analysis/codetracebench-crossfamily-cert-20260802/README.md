# Cross-family certification — shipping analyst on OpenHands + Terminus2 (2026-08-02)

Two results in one pre-registered experiment (decision rules fixed before the challenger was known: [`preregistration.md`](./preregistration.md)).

## Result 1 — the GEPA round-2 challenger was REJECTED

| Arm | pooled-cert micro F1 (128 obs) | OpenHands micro | Terminus2 micro | failed |
| --- | ---: | ---: | ---: | ---: |
| **stock (shipping, sha `d3829fb8…`)** | **0.2489** | 0.2896 | 0.2162 | 0/128 |
| G2 challenger (sha `1bb303e7…`) | 0.1928 | 0.2086 | 0.1822 | 3/128 |

Paired per-case f1 CIs: OpenHands [−0.126, +0.058], Terminus2 [−0.143, +0.023] — both spanning zero, pooled point estimate decisively against the challenger per rule 1.
The challenger's selection-split edge (+0.064 gold-mass-weighted, micro 0.400→0.509 on n=12 spent-split scenarios) did not transfer — the third consecutive tuning-vs-fresh reversal in this campaign.
The gold-mass-weighted selection metric is recorded as overfit-prone at n=12.
The shipping prompt stands unchanged.

## Result 2 — the first cross-family measurement of the shipping analyst

The stock arms are the first numbers ever measured for this analyst on agent families other than mini-SWE-agent:

| Instrument | Family | micro F1 | macro F1 |
| --- | --- | ---: | ---: |
| holdout-2 (2026-08-01 certification) | mini-SWE, cascade-wide gold | 0.6288 | 0.5789 |
| OH-cert32 (this run) | OpenHands | 0.2896 | 0.2762 |
| T2-cert32 (this run) | Terminus2 | 0.2162 | 0.2995 |

The analyst generalizes across families but with a ~2× gap versus its home family.
This gap is now the largest measured open lever; 652 tuning-legal OpenHands/Terminus2 rows exist for attacking it (`benchmarks/trace-analysis/codetracebench-oht2-20260801/`).

## Instruments (both now SPENT for this configuration family)

| Split | Rows | Gold steps | Labels sha256 |
| --- | ---: | ---: | --- |
| ctb-openhands-cert32 | 32 (16 labeled + 16 empty) | 87 | `2cf557938f0c1d8d…` |
| ctb-terminus2-cert32 | 32 (16 labeled + 16 empty) | 100 | `24e471101c652aa0…` |

Sealed 2026-08-01 by seeded stratified sampling (seed 20260801) from the fresh 716-row import, before the challenger existed.
Pre-seal positional calibration (the split3 lesson): best constant rule scores 0.043 (OH) / 0.024 (T2) — both families honest.
Seal receipt: `~/bench-cache/ctb-20260801/oht2/ctb-oht2-seal-receipt.json`.

## Artifacts

Committed here: the stock (surviving) arm's canonical `result-stock-openhands.json` / `result-stock-terminus2.json` + `preregistration.md`.
Rejected-arm artifacts pinned by sha256, durable in `~/bench-cache/ctb-20260801/cert2/`:

| File | sha256 |
| --- | --- |
| g2-oh/result.json | `d90ee2168da127cc174aa0317b2c6c0d840d1ae4cc724a0a65b8dac3e142ce9b` |
| g2-t2/result.json | `c4595a05fbc421f8669a30e57783345fb3e92ad5d8cbc654c61c2443891653c2` |

Run protocol: 4 strictly-serial runs, 2 repetitions, seed 0, glm-5.2 via z.ai direct, official scorer unchanged, $31.07 total measured.
Scoring tool: `benchmarks/trace-analysis/tools/compare-analyst-runs.mjs`.

## Citation rule

The mini-SWE reference for the shipping configuration remains `codetracebench-glm52-certified-20260801/`.
This directory adds the cross-family numbers for the same configuration; cite family-specific claims from here.
