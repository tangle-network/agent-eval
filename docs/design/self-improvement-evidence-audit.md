# Evidence audit: selfImprove and optimizer benefit

Historical runs contain gains, nulls, and regressions.
They do not establish optimizer superiority over a direct edit or current-branch improvement across tasks.
A historical GEPA analyst comparison reported 0.4285 to 0.4809 pooled micro F1, with important validity limits described below.
A later GEPA challenger lost 0.0561 on fresh agent families.
These results justify preserving candidates, checking transfer, and reporting negative or inconclusive outcomes.

This was a read-only audit on 2026-09-13 of `feat/evaluation-integrity` over `dda9941437190c9c541b3f54946bfeeb153366fe`.
The implementation changes were uncommitted during inspection.
No paid calls or new model experiments ran for this audit.
Current-branch fixture tests are distinct from all historical model results below.

## Inspected evidence

Paths below are relative to the repository root unless stated otherwise.

- All 10 [registry records](../../evidence/INDEX.md): 2 `CERTIFIED`, 6 `MEASURED-ONCE`, 1 `RESOLVED-NULL`, and 1 `UNVERIFIED`.
  These are registry labels; this audit did not recertify those records.
- The archived extraction comparison, its original implementation, and 20 optimization-related notebook records.
- Four committed CodeTraceBench result files, both certification reports, and both preregistrations.
- Current selfImprove, final-comparison, method-integrity, and final-evidence fixtures.

Searches covered `evidence/`, `examples/`, `benchmarks/`, `docs/`, and `.evolve/`.
There was no root `results/` directory and only one archived method-comparison JSON in examples.
Queries used `rg`, `git show` at the producing revision, and Python JSON parsing.
For each committed analyst result, model observation counts, positive-label micro F1, call totals, and cost sums were independently recomputed.

The following referenced raw artifacts were unavailable locally:

- `~/bench-cache/ctb-20260801/certification/`: incumbent and manual-width-adaptive arms.
- `~/bench-cache/ctb-20260801/cert2/`: rejected G2 arms.
- `.evolve/substrate-proof/appworld/d3-scaled-comparison.json`.
- `.evolve/compare-optimization-methods/` and `.evolve/compare-drivers/`.
- `examples/findings-ablation/index.ts` and the referenced session scratch artifacts for bridge and CAD proofs.

The registry's `.evolve/certification-2026-08-02-preregistration.md` reference is stale.
The committed replacement is [benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/preregistration.md](../../benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/preregistration.md).

## Model-backed evidence

| Date and task | Optimizer and comparison | Observed result | Units and costs | Evidence limit |
| --- | --- | --- | --- | --- |
| June 1, transaction extraction | Package-local GEPA-style reflection, GEPA-style Pareto, and SkillOpt-style patching versus an intentionally underspecified prompt | Baseline 0.625; reflection and SkillOpt 1.0; Pareto 0.958 | 8 search cases, 6 reported final cases; 182 captured worker calls; $0.013237 captured worker cost | SkillOpt selected on the reported final set; optimizer model costs omitted; no official Python optimizers |
| June 1, findings ablation | Local GEPA with versus without analyst findings | Both 1.0 from baseline 0.625; difference 0, archived CI [0, 0] | 6 reported cases, 130 calls, $0.009, 131 seconds | Zero findings were generated; the proposed mechanism never activated; notebook only |
| May 30, legal agents | Local gepaDriver candidates versus incumbent | Candidate fee scores 100 to 83/92; hallucination-free score 100 to 85; selected baseline | 4 scorable personas; 2 named final personas; gen1/pop2/reps2 | Model, cost, and complete paired rows missing; notebook only |
| June 1, AppWorld difficulty 3 | Local drivers versus a competent baseline, deepseek-v4-pro worker | Small baseline 0.794, lift 0; scaled baseline 0.885, both GEPA lifts 0; memory -0.047 | Small n=6; scaled notebook n=8 with unclear repeated-cell meaning; scaled cost $2.58 | Raw comparison absent; null does not isolate whether remaining errors are prompt-fixable |
| August 1, CodeTraceBench analyst | Real Python GEPA instructions versus stock and manual width-adaptive arm, glm-5.2 | Pooled micro F1: GEPA 0.4809, stock 0.4285, manual 0.4047 | 69 cases, 2 reps, 138 model observations per arm; search $4.46; six comparison runs documented $50.63 | Paired intervals cross zero; point-estimate promotion; split3 later retired; baseline raw files unavailable |
| August 2, CodeTraceBench transfer | Real Python GEPA G2 versus shipping G1, same analyst engine/model | Fresh pooled micro F1 0.1928 versus 0.2489; G2 rejected | 64 cases, 128 observations per arm; search $7.05; four comparison runs documented $31.07 | G2 raw files unavailable; intervals cross zero; Terminus2 has 30 source clusters for 32 cases |
| August 3, cross-family selection | Real GEPA prompt search with a macro objective | Macro 0.163 to 0.187; micro 0.3399 to 0.1897; TP 26 to 11; recall 0.325 to 0.138 | 24 train / 16 selection cases, 56 evaluations, $6.42 | Selection-only rejection; no fresh final experiment; notebook only |
| August 19–20, AIME | Official Python GEPA and live bridge; glm-5.3 worker, deepseek-v4-flash optimizer | Search completed in attempts 11–14; final comparison never completed | Train8/selection8/final10; 14 launches; about $4 reported | Machinery evidence, no lift verdict; substantial shared-host contention and task timeouts |
| August 20, CLI bridge toy | Official GEPA autoresearch engine and unmodified Claude CLI through a loopback route | Deterministic length objective about 0.286 to 1.0 | 12 optimizer evaluations, 2 submitted candidates, 8/8 wire calls, $0.029778336, 39.7 seconds | Real candidate-authoring calls; deterministic toy score; registry-only artifacts |
| June 8, OpenSCAD directive | GEPA versus handwritten directive | Reported +9.5 percentage points on compiled-CAD quality | One final split; task count and cost missing | Weak external-repository pointer; no pinned command or run directory |

The AppWorld notebook also reports GSM8K baseline 1.0 with both deepseek-v4-pro and deepseek-v4-flash.
Its sample counts and costs are absent.
Its aggregate phrase “five configs” does not reconcile with its enumerated task variants; no total run count is inferred here.
The findings and extraction records are related demonstrations and must not be counted as independent replication.

### June extraction: exact limitations

Artifact: [examples/compare-optimization-methods/results/deepseek-chat-20260601.json](../../examples/compare-optimization-methods/results/deepseek-chat-20260601.json).
It was created at `a648fae334c740d8e0f368e81f68ae933cdb1135` under `examples/compare-drivers-canonical/results/`.
The current directory name does not identify the historical optimizer implementation.

At that revision, inspect these producing sources with `git show`:

- `examples/compare-drivers-canonical/index.ts`.
- `examples/_shared/extraction-task.ts`.
- `src/campaign/presets/compare-drivers.ts`.
- `src/campaign/presets/run-skill-opt.ts`.
- `src/campaign/presets/run-improvement-loop.ts`.
- `src/campaign/drivers/gepa.ts` and `src/campaign/drivers/skill-opt.ts`.

The baseline was `Extract the transaction info from the message as JSON.`
The optimizer received the omitted schema, formatting rules, and suggested mutation primitives.
Winners mainly supplied merchant, amount, date, category, and formatting requirements.
The deterministic composite averages four normalized field matches; six transactions are the sample units, not 24 independent fields.
No direct edit control tested whether copying the supplied requirements achieved the same benefit.

The same `HOLDOUT` entered the inner optimizers and the outer comparison.
SkillOpt accepted patches using those six cases and fed rejection scores plus accepted-delta notes into subsequent proposals.
Its reported final score is therefore selection-set performance.
The GEPA-style entries selected on train, then exposed those cases to an inner gate before outer rescoring.
Their returned surface did not depend on that gate.
This establishes unequal final-data access; it does not prove that every numerical GEPA gain was false.

| Historical driver | Baseline | Candidate | Lift | Archived lift CI | Captured driver scoring cost |
| --- | ---: | ---: | ---: | --- | ---: |
| gepa-reflection | 0.625 | 1.000 | 0.375 | [0.167, 0.542] | $0.002921 |
| skill-opt | 0.625 | 1.000 | 0.375 | [0.167, 0.542] | $0.004005 |
| gepa-pareto | 0.625 | 0.958 | 0.333 | [0.167, 0.542] | $0.002929 |

Reflection versus SkillOpt had delta 0, CI [0, 0].
Reflection versus Pareto had delta 0.042, CI [0, 0.125].
Both archived comparisons used `favored: 'tie'`; that does not establish equivalence.

Captured worker usage was 18,226 input tokens and 7,560 output tokens across 182 records over 126 seconds.
The rate calculation `18226 * 0.27 / 1e6 + 7560 * 1.10 / 1e6 = 0.01323702` matches the rounded artifact cost.
The listed driver costs sum to $0.009855; $0.003382 of captured worker cost has no named phase breakdown in this artifact.
More importantly, the captured `records` array was populated only by the extraction worker.
The optimizer drivers called `callLlm` directly and discarded model usage and cost.
Therefore, end-to-end optimization cost and total model-call count are unknown.
The archived `honestVerdict: 'lift-proven'` is not valid current certification or proof of optimizer superiority.

### CodeTraceBench: useful gains and failed transfer

Full source reports and all measured fields:

- [benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/README.md](../../benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/README.md) and `preregistration.md`.
- [benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/README.md](../../benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/README.md) and `preregistration.md`.
- `.evolve/experiments.jsonl`, lines 26, 29, 33, 34, and 41.

Round 1 used real Python GEPA at historical script revision `0eb2e32`, with 40 evaluations on 10 train and 6 selection cases.
The output contract stayed fixed.
The selected prompt hash was `d3829fb855690a3a385f498049801c14bb990c6e49858a6739bd331c0ab324e1`.
Search selection composite rose from 0.281 to 0.331; this is separate from final micro F1.

The final experiment used glm-5.2 through z.ai, stock DSPy RLM execution, seed0, and two repetitions.
Arms ran serially; each run used concurrency6, maxOutput8192, timeout1,200,000ms, maxCost30, and maxArtifact8MiB.
The environment was Node24.16.0 on Linux x64.
The dataset revision was `aa213b84ffb6690fc37ca15766d6ca174ec36d4d`.
Model names were recorded; a provider-served immutable model snapshot was not demonstrated by this audit.

| Arm and final split | Micro F1 | Macro F1 | Recall | Precision | Failed model observations | Documented cost |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Incumbent / holdout2 | 0.5641 | 0.5596 | 0.6436 | 0.5021 | 0/64 | $7.97 |
| Manual W / holdout2 | 0.5224 | 0.5125 | 0.5426 | 0.5037 | 1/64 | $7.67 |
| GEPA G / holdout2 | 0.6288 | 0.5789 | 0.6622 | 0.5986 | 0/64 | $7.96 |
| Incumbent / split3 | 0.1693 | 0.1830 | 0.3276 | 0.1141 | 1/74 | $9.24 |
| Manual W / split3 | 0.1805 | 0.1791 | 0.3190 | 0.1259 | 1/74 | $8.72 |
| GEPA G / split3 | 0.1799 | 0.1844 | 0.3017 | 0.1282 | 0/74 | $9.07 |

There were 32 holdout2 cases and 37 split3 cases: 69 cases and 138 model observations per arm.
Only 30 holdout2 cases had positive labels; the paired F1 table consequently used 30 + 37 = 67 positive cases.
The notebook's “67 fresh cases” must not replace the execution denominator.
Pooled macro F1 was G0.3611, incumbent0.3516, and W0.3284.

G versus incumbent paired F1 intervals were [-0.027, +0.067] on holdout2 and [-0.042, +0.046] on split3.
W intervals were [-0.096, +0.001] and [-0.064, +0.053], respectively.
Reported median paired delta was zero for all four comparisons.
Promotion followed a preregistered pooled point-estimate rule; it did not require statistical exclusion of zero.
The wide-cascade holdout2 gain of 0.0647 is a useful historical signal.

After certification, split3 was retired: 27/37 cases label the final submit step.
A constant last-step prediction scored micro F1 0.568 there, versus about 0.180 for the analyst.
Consequently, the pooled result cannot support a general analysis-quality claim.
The reports' stronger language about unbiased instruments and certification must be read with this disclosed correction.

G2 search later improved a weighted selection objective by 0.064 on 12 cases, with micro F1 0.400 to 0.509 and macro -0.032.
On fresh OpenHands and Terminus2, G2 pooled micro was 0.1928 versus stock0.2489, with 3/128 versus 0/128 failures.
Per-family G2 micro was OH0.2086/T20.1822, versus stock OH0.2896/T20.2162.
Paired intervals were OH[-0.126, +0.058] and T2[-0.143, +0.023].
The fixed promotion rule rejected G2; its selection gain did not transfer.
The later August3 macro-versus-micro divergence was found on selection data and is not another fresh final result.

### Raw recomputation and accounting

These four files contain the surviving model arm and an empty control; they do not contain the unavailable incumbent/W/G2 arms.
Historical comparison deltas and intervals therefore remain documented evidence rather than independently reconstructed comparisons.

| Label | Committed raw result | Run identity SHA256 |
| --- | --- | --- |
| G/h2 | [benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/result-holdout2.json](../../benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/result-holdout2.json) | `24883695f29e0b928f3a55d000e985682d18f810eb63c2c70b00e95418a34fac` |
| G/s3 | [benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/result-split3.json](../../benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/result-split3.json) | `417161b661138fb03977e475ae76be22e54d2153b32bb1842c0a6dde49ecc200` |
| Stock/OH | [benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/result-stock-openhands.json](../../benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/result-stock-openhands.json) | `30d80958be3d71f56a780850c7791cb4d078a8d98bc696140181611f94f7be95` |
| Stock/T2 | [benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/result-stock-terminus2.json](../../benchmarks/trace-analysis/codetracebench-crossfamily-cert-20260802/result-stock-terminus2.json) | `abda3035ded04b3625981b2073d6b24a152fb4223836471481d4858f8a9589a3` |

| Label | Observations / cases / clusters | Positive / negative / unlabeled observations | Positive-label TP / FP / FN | Recomputed micro F1 | Model calls | Estimated model cost |
| --- | --- | --- | --- | ---: | ---: | ---: |
| G/h2 | 64 / 32 / 32 | 60 / 0 / 4 | 249 / 167 / 127 | 0.628787879 | 912 | $7.9586602 |
| G/s3 | 74 / 37 / 37 | 74 / 0 / 0 | 35 / 238 / 81 | 0.179948586 | 1045 | $9.0744110 |
| Stock/OH | 64 / 32 / 32 | 32 / 28 / 4 | 43 / 80 / 131 | 0.289562290 | 855 | $7.3335628 |
| Stock/T2 | 64 / 32 / 30 | 32 / 20 / 12 | 40 / 130 / 160 | 0.216216216 | 883 | $7.5553616 |

Counts, call totals, and estimated cost sums reconcile against each result summary.
All four model arms have zero failed observations, zero unknown-cost observations, and zero unknown token-usage observations.
Every model observation explicitly labels its cost `estimated`; the reports' wording “measured cost” must not imply provider-billed receipts.
The table does not include GEPA search cost or missing comparison arms.

| Label | Input tokens | Output tokens | Cached tokens | Reasoning tokens | Unknown cache-write usage observations |
| --- | ---: | ---: | ---: | ---: | ---: |
| G/h2 | 2,055,464 | 578,167 | 9,089,024 | 0 | 64/64 |
| G/s3 | 2,553,890 | 659,891 | 10,150,528 | 0 | 74/74 |
| Stock/OH | 2,336,470 | 445,036 | 8,254,336 | 0 | 64/64 |
| Stock/T2 | 2,257,624 | 457,760 | 8,656,192 | 0 | 64/64 |

Cache-write usage is unknown for every observation; summary zero totals do not establish measured zeros.
Trusted-negative false-positive rates are OH0.5 on 28 observations and T20.6 on 20 observations.
They are null on h2/s3 because those model arms have no trusted-negative observations.
The normalized calibration F1 includes negative predictions, giving OH0.243626062 and T20.189573460.
Those are different quantities from the historical positive-label micro F1 above.

| Label | Latency minimum ms | Median ms | Mean ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| G/h2 | 58,387.888 | 134,080.197 | 149,395.929 | 280,446.514 | 388,678.939 |
| G/s3 | 66,049.095 | 131,120.154 | 150,738.482 | 281,274.392 | 348,210.556 |
| Stock/OH | 50,270.252 | 101,125.396 | 112,446.304 | 203,914.120 | 233,030.922 |
| Stock/T2 | 40,764.354 | 108,713.527 | 118,436.742 | 206,919.628 | 223,641.819 |

Latency is per completed analyst observation under concurrency6; it is not serial campaign duration.
The exact protocol, implementation, dependency-lock, labels, trace, and candidate hashes remain in the linked raw results.

## Current selected-candidate behavior

The implementation preserves the search-selected candidate independently of its final gate decision.
`runFinalComparison()` compares that selected surface without selecting a replacement.
`src/contract/self-improve-method.ts` returns `selected.winnerSurface`.
`src/contract/self-improve.ts` returns `result.winnerSurface`.

Inspected fixtures establish these intended behaviors:

- `tests/campaign/final-evidence-integration.test.ts`: eight independent binary pairs produce lift1 and default-gate `ship`.
  The declared-unit comparison runs twice without consuming evidence when no ledger policy is supplied.
- The same file: four fractional pairs preserve `WIN` and lift0.215 while the default gate returns `hold`.
- `tests/contract-self-improve-method-integrity.test.ts`: method-selected `WIN` remains selected despite losing on train.
  Four final dispatches produce lift0.4; this test injects an always-ship gate.
- Deferred-final fixtures preserve the selected candidate, execute zero final calls, and leave final score/lift absent.
- No-op fixtures return the baseline and hold; these reflect unchanged selection rather than gate-driven candidate replacement.
- Ledger lifecycle fixtures cover method and proposer paths with an injected hold gate.

These are fixed, marker, or echo fixtures.
Some controlled receipt fixtures set backend `real`; that literal does not turn them into model-backed efficacy evidence.
This historical audit inspected fixture source independently of the implementation's test runs.
The implementation also adds a default-gate regression for a selected candidate that loses on final tasks.
It checks negative lift, a refusing gate, and preservation of the selected candidate.

The branch's `claim` option declares units separately from optional fresh-evidence accounting.
This separation supports repeated development comparisons without misrepresenting them as new confirmation.
The interval API also seals the cluster-bootstrap `value` selector in `IntervalSpec`; submitted row evidence no longer chooses it after sealing.
Neither API correction is itself evidence of improved model behavior.

## Smallest meaningful benefit experiment

Use the current public `selfImprove({ method, claim })` path with the maintained official optimizer and the production agent entrypoint.
Choose a real task panel with observed prompt-fixable errors under a reasonable current baseline.
Do not manufacture benefit solely by withholding known output requirements from that baseline.

1. Run a small execution-and-capture smoke before a full search.
   Verify candidate identity, worker and optimizer receipts, missingness, and retained raw scores.
2. Use three arms: unchanged baseline, a direct edit from the same development evidence, and the official optimizer.
   Fix authoring/search resource limits and preserve actual spending separately for each arm.
3. Partition by source task or incident into development, selection, and fresh final units.
   Pin the population, practical effect, primary metric, failure policy, and stopping rule before final exposure.
4. Estimate final sample size from development variation and the desired practical effect using maintained power helpers.
   Count independent source units and account for clustering; do not substitute repeated calls or a universal 20-unit floor.
5. Freeze the selected candidates and compare all arms on paired final units under a balanced execution schedule.
   Report baseline-to-candidate lift and optimizer-to-direct-edit lift, including uncertainty, failures, costs, and latency.
6. Use the final-evidence ledger when making a fresh-confirmation claim.
   Retain the candidate, its diff, and all observed scores even when the gate holds or evidence is inconclusive.

No paid experiment was launched by this audit.
A cost forecast should use the current configured model rates and observed smoke usage before the search starts.
A single successful search demonstrates that run's benefit; repeat searches are required to estimate optimizer reliability across seeds or tasks.

## Supported communication

The implementation improves how users declare claims, preserve evidence, inspect uncertainty, and compare selected candidates.
Historical useful-task optimization has produced gains, nulls, and regressions.
The evidence supports testing automated evaluation engineering through explicit outcome checks and independent confirmation.
It does not support claiming universal self-improvement, optimizer superiority over a direct edit, or current-branch model-quality lift.

See [evaluation integrity](../evaluation-integrity.md) for the public API and the book chapters motivating its methodology.
