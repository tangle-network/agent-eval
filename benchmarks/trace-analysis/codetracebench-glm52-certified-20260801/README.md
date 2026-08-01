# CodeTraceBench certified run — GEPA-optimized analyst prompt (2026-08-01)

This directory is the certified reference for the shipping recursive analyst configuration.
It replaces `codetracebench-rlm-glm52-20260731` as the citable number, per that directory's own embargo note.
The decision protocol was pre-registered before any sealed case ran: see [`preregistration.md`](./preregistration.md) (written 2026-08-01, before launch).

## What was certified

Three arms, two sealed splits, strictly serial runs, 2 repetitions, seed 0, glm-5.2 via z.ai direct, official scorer unchanged.

| Arm | Configuration | Instructions sha256 |
| --- | --- | --- |
| incumbent | main @ 856b3a6 stock prompt + stock bridge | `5811b534…` (protocol) |
| W | width-adaptive prompt + bridge edits (branch `mp/track-w-width-adaptive` @ 9c04e8e) | protocol `bd0347aa…` |
| G-winner | stock engine + GEPA-optimized instructions (this directory's shipping config) | `d3829fb855690a3a385f498049801c14bb990c6e49858a6739bd331c0ab324e1` |

The G-winner instruction text is now the stock prompt in this tree: `publicBenchmarkRlmInstructions('codetracebench')` reproduces it byte-identically (verified in-build; sha above).
It was produced by `scripts/gepa-analyst-campaign.ts` — real Python GEPA, 40 evaluations, glm-5.2 reflection, output contract frozen verbatim, trained on 10 / selected on 6 scenarios from the spent pinned-32 dev split only.

## Sealed instruments

| Split | Rows | Gold steps | Labels sha256 | Skew |
| --- | ---: | ---: | --- | --- |
| holdout-2 | 32 (30 labeled-positive) | 188 | `2db46579b7993edc376acbbcacf67a1d0ddfcdb94e28930c2bb8dfcf1dc32fb2` | cascade-wide by construction |
| split3 | 37 | 58 | `d0347ec7a5ec9a07bd3fcd16aa06b07bcb33ffabca39cb0b0f7a564fb500ae08` | entire remaining compatible pool — unbiased by construction, thin-gold (~1.6 steps/case) |

Neither split had ever been run against any model before this certification.
Both arms' selection/tuning used only the spent dev splits.

## Results — every arm, every split (n = 2 reps × cases; scorer = official micro/macro F1)

| Run | micro F1 | macro F1 | recall | precision | failed runs | cost USD | runIdentitySha256 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| incumbent · holdout-2 | 0.5641 | 0.5596 | 0.6436 | 0.5021 | 0/64 | 7.97 | `229d11c0…` |
| W · holdout-2 | 0.5224 | 0.5125 | 0.5426 | 0.5037 | 1/64 | 7.67 | `74ece843…` |
| **G-winner · holdout-2** | **0.6288** | **0.5789** | **0.6622** | **0.5986** | **0/64** | 7.96 | `24883695…` |
| incumbent · split3 | 0.1693 | 0.1830 | 0.3276 | 0.1141 | 1/74 | 9.24 | `dfff2ee1…` |
| W · split3 | 0.1805 | 0.1791 | 0.3190 | 0.1259 | 1/74 | 8.72 | `df4ce98c…` |
| **G-winner · split3** | **0.1799** | 0.1844 | 0.3017 | 0.1282 | **0/74** | 9.07 | `417161b6…` |

Pooled-sealed (both splits, 138 observations per arm):

| Arm | pooled micro F1 | pooled macro F1 | failed |
| --- | ---: | ---: | ---: |
| incumbent | 0.4285 | 0.3516 | 1/138 |
| W | 0.4047 | 0.3284 | 2/138 |
| **G-winner** | **0.4809** | **0.3611** | **0/138** |

Paired per-case f1 deltas vs incumbent (cluster bootstrap, 2000 resamples, seed-deterministic):

| Comparison | delta (median) | 95% CI | paired cases |
| --- | ---: | --- | ---: |
| W vs incumbent · holdout-2 | 0 | [−0.096, +0.001] | 30 |
| G vs incumbent · holdout-2 | 0 | [−0.027, +0.067] | 30 |
| W vs incumbent · split3 | 0 | [−0.064, +0.053] | 37 |
| G vs incumbent · split3 | 0 | [−0.042, +0.046] | 37 |

## Decision (per the pre-registered rules, applied without modification)

- **W: rejected** — rule 1 requires pooled-sealed micro ≥ incumbent; 0.4047 < 0.4285.
- **G-winner: promoted** — rule 3: 0.4809 beats both incumbent (0.4285) and W (0.4047); no run exceeded the 10% failure bound.
- Disclosed honestly: the per-case paired CIs span zero on both splits; the promotion criterion is the pooled micro point estimate, fixed before launch.
The +5.2pp pooled gain concentrates in the wide-cascade regime (+6.5pp micro, +9.7pp precision on holdout-2).
- Every arm collapses on the thin-gold split3 population (micro 0.17–0.18) — the narrow regime remains the open problem; no configuration measured to date solves it.

## Artifacts

In this directory: the promoted arm's canonical `result-holdout2.json` / `result-split3.json` (reports are derivable from them via the scorer), plus `preregistration.md`.
Uncommitted arm artifacts (durable copy `~/bench-cache/ctb-20260801/certification/`), pinned by sha256:

| File | sha256 |
| --- | --- |
| cert-inc-h2/result.json | `fe58478988e0c752a776b3e6f1177cf6eed7d4497e2f16167dd8c37f54604372` |
| cert-w-h2/result.json | `561ce577aacba03151adf6e3fa5491594f4de4c927a643425454e86b122c6b04` |
| cert-inc-s3/result.json | `aa7c13e4849197f89e6665fa88428841a1caf42aae9f34a0ed8692bff63fc0a3` |
| cert-w-s3/result.json | `f64a7efc02a27119988897e4f705004767a3e242377d32afb05fa04878ce03b1` |

Comparison tool: `benchmarks/trace-analysis/tools/compare-analyst-runs.mjs` (validated 373/373 fields against published artifacts).
Split3 build receipts: `~/bench-cache/ctb-20260801/split3/` (importer `@tangle-network/traces@0.9.19`, dataset revision `aa213b84…`, CodeTracer pin `2d302191…`).

## Citation rule

Numbers here describe the configuration whose instructions hash to `d3829fb8…` running on the engine at this tree.
The spent dev splits (pinned-32, holdout-1) are selection instruments only; do not cite dev numbers as performance claims.
Both sealed splits are now SPENT for this configuration family — future certification requires fresh splits (OpenHands/Terminus2 importers would add 742 upstream rows).
