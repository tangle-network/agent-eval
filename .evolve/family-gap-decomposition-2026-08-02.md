# OpenHands/Terminus2 family gap: measured loss decomposition (cert2 stock runs, 2026-08-02)

**Verdict: the ~2x family gap (mini-SWE 0.6288 vs OpenHands 0.2896 / Terminus2 0.2162 official micro F1) is a localization-and-enumeration failure on trajectories twice as long, not an input-fidelity or block-shape failure.**
The `far` class — gold steps missed with every citation more than 2 steps away — holds 49% of OpenHands and 47% of Terminus2 gold mass, versus 14% on mini-SWE holdout-2.
Crediting each existing citation to an unmatched gold step at any distance (`snapFar`) recovers official micro F1 to 0.6128 (OH, +32.3pp) and 0.4703 (T2, +25.4pp): the analyst finds real incidents but reports the wrong ones, and reports half as many as the labels contain (1.62/1.66 predicted blocks per run vs 3.0 gold blocks per case; mini-SWE: 2.78 vs 2.93).
Every number below is recomputed from the cert2 stock runs' own observations plus the sealed labels and OTLP traces.
No model was called for this decomposition.

## Method

| Item | Value |
| --- | --- |
| Runs | `~/bench-cache/ctb-20260801/cert2/stock-oh` and `stock-t2` (glm-5.2, dspy-rlm, 2 repetitions, 32 cases each, 0 failed runs), stock prompt = round-1 GEPA winner |
| mini-SWE reference | `benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/result-holdout2.json` (same engine and prompt, holdout-2, official micro F1 0.6288) |
| Labels | `/dev/shm/ctb-openhands-cert32-labels.json` (sha256 `2cf55793…`, 32 rows, 16 labeled, 87 gold steps), `/dev/shm/ctb-terminus2-cert32-labels.json` (sha256 `24e47110…`, 32 rows, 16 labeled, 100 gold steps) — both SPENT for claims, legal for diagnosis |
| Traces | `/dev/shm/ctb-oht2-traces-{openhands,terminus2}`; normalized trees `~/bench-cache/ctb-20260801/oht2/work/{family}/normalized` |
| Tool | `benchmarks/trace-analysis/tools/decompose-analyst-loss.mjs`, extended in this change (official-metric view, tool-type classes, blind reasons, far direction, block shape, constant-rule calibration) |

Metric reconciliation, verified against the runs' own summaries: `result.summaries[].f1` computes micro precision over **positive (issue-bearing) runs only** — OH 43/123 = 0.3496, T2 40/170 = 0.2353 — reproducing 0.2896 and 0.2162 exactly.
Findings on trusted-negative and unlabeled rows never enter the official metric.
The tool now reports both this official view and the pooled all-runs view, and computes every counterfactual in the official currency.

Reproduce:

```bash
node benchmarks/trace-analysis/tools/decompose-analyst-loss.mjs \
  --labels /dev/shm/ctb-openhands-cert32-labels.json \
  --traces /dev/shm/ctb-oht2-traces-openhands \
  --normalized ~/bench-cache/ctb-20260801/oht2/work/openhands/normalized \
  --run stock-oh=$HOME/bench-cache/ctb-20260801/cert2/stock-oh --markdown
# same shape for terminus2 and for the mini-SWE holdout-2 reference
```

## Result 1 — the three families, same instrument, one table

Gold-step classes (gold observations = gold steps x 2 repetitions; official micro over positive runs):

| Family | official F1 | recall | precision | hit (+blindHit) | near | far | silent | blind missed | gold obs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mini-SWE holdout-2 | 0.6288 | 0.6622 | 0.5986 | 249 (66.2%) | 30 (8.0%) | 54 (14.4%) | 0 | 43 (11.4%) | 376 |
| OpenHands cert32 | 0.2896 | 0.2471 | 0.3496 | 43 (24.7%) | 27 (15.5%) | 85 (48.9%) | 16 (9.2%) | 3 (1.7%) | 174 |
| Terminus2 cert32 | 0.2162 | 0.2000 | 0.2353 | 40 (20.0%) | 13 (6.5%) | 93 (46.5%) | 20 (10.0%) | 34 (17.0%) | 200 |

Counterfactual official micro F1, one class neutralised at a time:

| Counterfactual | mini-SWE h2 | OpenHands | Terminus2 |
| --- | ---: | ---: | ---: |
| baseline | 0.6288 | 0.2896 | 0.2162 |
| dropBlindGold (blind gold leaves denominator) | 0.6303 (+0.002) | 0.2778 (−0.012) | 0.2381 (+0.022) |
| snapNear (credit citations within ±2) | 0.6616 (+0.033) | 0.3704 (+0.081) | 0.2270 (+0.011) |
| **snapFar (credit any citation, any distance)** | 0.7803 (+0.152) | **0.6128 (+0.323)** | **0.4703 (+0.254)** |
| dropEscaped (suppress self-marked escaped blocks) | 0.5959 (−0.033) | 0.2618 (−0.028) | 0.1557 (−0.061) |
| abstainSolved (report nothing on solved) | 0.5506 (−0.078) | 0.2140 (−0.076) | 0.2114 (−0.005) |

Reading these:

- **Localization is the family gap.** Under snapFar, OpenHands lands at 0.6128 — within noise of mini-SWE's shipping baseline (0.6288). The analyst's citations exist; they sit on the wrong incident.
- **Input blindness is not the OH story (−1.2pp) and a minor T2 term (+2.2pp).** All 34 blind T2 gold observations are byte-duplicate keystroke spans (reason `duplicate`; 0 `blank`); none was ever hit. OH has 6 blind gold observations, 3 hit anyway.
- **The mini-SWE M2/M3 conclusions replicate on both new families**: escaped-block suppression and solved-trace abstention lose F1 everywhere.

## Result 2 — the far class is under-enumeration plus early anchoring

Predicted block volume and position (positive runs; predicted blocks from the runner's own `block_first_step`/`block_last_step` metadata):

| Family | predicted blocks/run | gold blocks/case | pred width mean | gold width mean | pred start fraction p50 | gold start fraction p50 | positive-run median step_count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mini-SWE h2 | 2.78 | 2.93 | 2.54 | 2.14 | 0.735 | 0.763 | 24 |
| OpenHands | 1.62 | 3.06 | 2.37 | 1.78 | 0.538 | 0.672 | 48 |
| Terminus2 | 1.66 | 3.00 | 3.21 | 2.08 | 0.464 | 0.655 | 48 |

- **Block shape is NOT the mismatch**: gold widths are 1.8–2.1 everywhere and predicted widths 2.4–3.2 everywhere; the block-shape-mismatch arm candidate is rejected by measurement.
- **Enumeration halves on the long families**: 1.62/1.66 blocks per run against 3.0 in the labels, while mini-SWE matches (2.78 vs 2.93). Recall is capped at ~55% before any localization error.
- **Predictions anchor early**: on OH, 60 of 85 far-missed gold observations have every citation EARLIER than the gold step (17 later, 8 straddling); predicted position p50 0.538 vs gold 0.672. T2: 42 earlier / 37 later / 14 straddling. On mini-SWE the direction is the opposite and small (3 earlier / 46 later) and positions match (0.735 vs 0.763). The analyst reads a 48–95-step trajectory, commits to the first convincing incident, and never reaches the mid-late segment where the labels live.
- Trajectory length is the regime switch: positive-run median step_count doubles (24 → 48). The engine's iteration budget saturates on ALL families (median 14–15 LLM calls per observation everywhere, cap 14), so the same reading budget covers half the trace — saturation alone does not separate the families and raising it alone is not the arm.
- The `silent` class (0 → 9–10%) is the same failure at its extreme: 7 of 8 zero-finding positive runs are solved trajectories where the mid-trace mistake was never reached; each ran 75–163s of real analysis.

## Result 3 — family-specific defects (measured, smaller than far)

**OpenHands tool-type table** (gold observations by the normalized step's tool_type):

| tool_type | gold | hit | near | far | silent | blind |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| run | 92 | 16 | 15 | 53 | 6 | 2 |
| str_replace_editor | 28 | 17 | 5 | 4 | 1 | 1 |
| edit | 26 | 6 | 3 | 13 | 4 | 0 |
| execute_bash | 8 | 2 | 2 | 2 | 2 | 0 |
| run_ipython | 8 | 0 | 0 | 8 | 0 | 0 |
| task_tracker | 6 | 0 | 0 | 3 | 3 | 0 |
| read | 4 | 2 | 0 | 2 | 0 | 0 |
| think | 2 | 0 | 2 | 0 | 0 | 0 |

- **Whitespace-buried `run` commands are hit 0/28.** 28 of 92 gold `run` observations have an action that is mostly blank lines with the command buried mid-block (faithful rendering of the raw completion; 451/5890 `run` steps corpus-wide), and none was ever matched, versus 16/64 (25%) on clean `run` gold. Upper bound if padded gold hit at the clean rate: ≈ +4pp recall, OH only.
- Non-shell gold (read/think/recall/task_tracker) is 12/174 (6.9%) — action-type confusion alone cannot explain the gap, and Terminus2 (100% shell) shows the same far explosion.
- Diagnostic-looking gold is NOT family-specific: read-only commands (cat/ls/grep/wc/help/kill/…) hold 33% of T2-dev gold but also 35% of mini-SWE holdout-2 gold, where the analyst still scores 0.63. The stock prompt's diagnostic-exclusion doctrine is not the differentiator.
- **Terminus2 duplicate keystrokes**: 34/200 gold observations (17.0%) sit on spans byte-identical to another span in the same session (repeated commands, bare Enter); zero were hit. Worth +2.2pp (dropBlindGold). A citation-disambiguation fix would cap there.

False positives on label-empty rows (outside the official metric but user-visible in `traces analyze`): OH trusted-negative runs carry 56 findings across 14/28 runs; T2 trusted-negative 52 findings across 12/20 runs; T2 failed-unlabeled rows draw 89 findings over 12 runs.

## Result 4 — instrument calibration under wider constant rules

Constant positional rules, official scorer, labeled cases only (tool section `split structure`):

| Split | n-0 | n-1 | n-2 | last-2 window | best swept rule (shift 0–15, width 1–3) |
| --- | ---: | ---: | ---: | ---: | --- |
| OpenHands cert32 | 0.019 | 0.039 | 0.000 | 0.050 | n-6..n-8 → **0.222** |
| Terminus2 cert32 | 0.000 | 0.034 | 0.017 | 0.030 | n-12..n-14 → **0.122** |
| mini-SWE holdout-2 | 0.083 | 0.193 | 0.101 | 0.242 | n-1..n-3 → **0.331** |

The pre-seal calibration (0.043 OH / 0.024 T2) tested single-step and 2-step rules; a wider 3-step window at fixed offset reaches 0.222 on OH-cert32.
The shipping analyst still beats every constant rule on every split, but the OH margin is only +0.068 (0.2896 vs 0.222) versus +0.298 on mini-SWE — the analyst currently adds almost no localization signal over position priors on OpenHands.
Any future certification on these splits should report the swept-rule margin, not only the single-step rules.

## Rejected arm candidates (each killed by a measured number above)

| Candidate | Evidence against |
| --- | --- |
| Input restoration (restore-step-reasoning pattern) | The OHT2 prepare skills already populate `thinking`, and it lands in span content: 230/230 OH and 440/440 T2 sampled steps with thinking carry it in the OTLP span. Blind gold is 1.7% (OH) / 17% (T2, +2.2pp ceiling). |
| Block-shape mismatch | Gold width 1.78/2.08 vs mini-SWE 2.14; predicted widths overlap; positions of gold are family-similar (p50 0.65–0.76). |
| Action-type reframing alone | Non-shell gold is 6.9% of OH mass; T2 is 100% shell with the same far share. |
| Raise iteration budget alone | The budget saturates identically on mini-SWE (median 15 calls/obs, 48/64 at ≥14) where F1 is 0.63. |
| Escape suppression / solved abstention | −2.8 to −6.1pp / −0.5 to −7.6pp measured. |

## The one arm: family-aware coverage framing (instructions override)

Target class: `far` + `silent` + under-enumeration — 58% of OH and 57% of T2 gold mass, ceiling +32.3pp / +25.4pp (snapFar).
Change: a family-framing instructions file for `--instructions-file` (mechanism already shipped: `benchmark-instructions-override.ts` binds the override sha into the run's protocol digest).
The file keeps the stock GEPA-winner block doctrine verbatim and adds an evidence-conditioned coverage-and-enumeration section plus the two family grammar notes (OpenHands rendered tool calls with whitespace-buried run commands; Terminus2 duplicate keystokes anchored by surrounding observations, cite the occurrence inside the failing segment).
No step-count or block-count priors: the shape-prior lesson (−10 to −15pp, `.evolve` 2026-07-31) stays enforced.
Smoke pre-registration, gates, and readout: `benchmarks/trace-analysis/codetracebench-oht2-20260801/family-framing/` (committed before the paid run).

## Appendix A — per-case table, OpenHands cert32 positive cases (stock arm)

`classes` lists each gold step and its class; `cited` every step the run accused.

| case | solved | annotation | steps | gold | input-blind gold | rep | findings | cited | matched | classes |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- | --- |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-cprofiling-python-591d66e2 | yes | agent_failure_analysis | 30 | 18,20,21,22,23,24 | - | 0 | 4 | 21,22,23,24 | 21,22,23,24 | 18:far 20:near 21:hit 22:hit 23:hit 24:hit |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-cprofiling-python-591d66e2 | yes | agent_failure_analysis | 30 | 18,20,21,22,23,24 | - | 1 | 0 | - | - | 18:silent 20:silent 21:silent 22:silent 23:silent 24:silent |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-db-wal-recovery-644b805f | no | agent_failure_analysis | 48 | 40,41,42,43 | - | 1 | 5 | 4,41,42,43,44 | 41,42,43 | 40:near 41:hit 42:hit 43:hit |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-db-wal-recovery-644b805f | no | agent_failure_analysis | 48 | 40,41,42,43 | - | 0 | 7 | 4,5,6,41,42,43,44 | 41,42,43 | 40:near 41:hit 42:hit 43:hit |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-large-scale-text-editing-796163f1 | yes | agent_failure_analysis | 34 | 7,8,11,12,13 | - | 1 | 1 | 7 | 7 | 7:hit 8:near 11:far 12:far 13:far |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-large-scale-text-editing-796163f1 | yes | agent_failure_analysis | 34 | 7,8,11,12,13 | - | 0 | 1 | 7 | 7 | 7:hit 8:near 11:far 12:far 13:far |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-parallel-particle-simulator-6cd5c6fc | no | agent_failure_analysis | 45 | 23,25 | - | 0 | 4 | 34,36,37,38 | - | 23:far 25:far |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-parallel-particle-simulator-6cd5c6fc | no | agent_failure_analysis | 45 | 23,25 | - | 1 | 5 | 7,21,22,23,34 | 23 | 23:hit 25:near |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-predict-customer-churn-d58fa4e0 | no | agent_failure_analysis | 25 | 6,8,10,11,13,14,17 | - | 0 | 1 | 6 | 6 | 6:hit 8:near 10:far 11:far 13:far 14:far 17:far |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-predict-customer-churn-d58fa4e0 | no | agent_failure_analysis | 25 | 6,8,10,11,13,14,17 | - | 1 | 9 | 8,9,10,11,12,13,14,15,16 | 8,10,11,13,14 | 6:near 8:hit 10:hit 11:hit 13:hit 14:hit 17:near |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-solana-data-c854dc09 | no | agent_failure_analysis | 52 | 49,51 | - | 0 | 6 | 23,36,46,47,48,50 | - | 49:near 51:near |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-solana-data-c854dc09 | no | agent_failure_analysis | 52 | 49,51 | - | 1 | 4 | 23,48,49,50 | 49 | 49:hit 51:near |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-triton-interpret-1cede581 | no | agent_failure_analysis | 61 | 8,36,37,39,41,42,44 | - | 0 | 6 | 9,10,43,44,45,46 | 44 | 8:near 36:far 37:far 39:far 41:near 42:near 44:hit |
| openhands-Anthropic__Claude-Sonnet-4-20250514-Thinking-triton-interpret-1cede581 | no | agent_failure_analysis | 61 | 8,36,37,39,41,42,44 | - | 1 | 7 | 5,6,7,9,43,44,45 | 44 | 8:near 36:far 37:far 39:far 41:near 42:near 44:hit |
| openhands-DeepSeek__DeepSeek-V3.2-blind-maze-explorer-5x5-3f7ee417 | yes | agent_failure_analysis | 55 | 27,34,39,41 | - | 0 | 0 | - | - | 27:silent 34:silent 39:silent 41:silent |
| openhands-DeepSeek__DeepSeek-V3.2-blind-maze-explorer-5x5-3f7ee417 | yes | agent_failure_analysis | 55 | 27,34,39,41 | - | 1 | 2 | 41,42 | 41 | 27:far 34:far 39:near 41:hit |
| openhands-DeepSeek__DeepSeek-V3.2-git-multibranch-0bbc5d81 | no | agent_failure_analysis | 95 | 55,56,57,58,59,76,77,78,79,82,83,87,90 | 79 | 0 | 2 | 5,6 | - | 55:far 56:far 57:far 58:far 59:far 76:far 77:far 78:far 79:blind 82:far 83:far 87:far 90:far |
| openhands-DeepSeek__DeepSeek-V3.2-git-multibranch-0bbc5d81 | no | agent_failure_analysis | 95 | 55,56,57,58,59,76,77,78,79,82,83,87,90 | 79 | 1 | 2 | 5,6 | - | 55:far 56:far 57:far 58:far 59:far 76:far 77:far 78:far 79:blind 82:far 83:far 87:far 90:far |
| openhands-DeepSeek__DeepSeek-V3.2-implement-eigenvectors-from-eigenvalues-research-paper-9e960b82 | no | agent_failure_analysis | 68 | 18,19,21,23,24,25,56,57,59,60,62 | - | 0 | 5 | 31,32,33,34,35 | - | 18:far 19:far 21:far 23:far 24:far 25:far 56:far 57:far 59:far 60:far 62:far |
| openhands-DeepSeek__DeepSeek-V3.2-implement-eigenvectors-from-eigenvalues-research-paper-9e960b82 | no | agent_failure_analysis | 68 | 18,19,21,23,24,25,56,57,59,60,62 | - | 1 | 1 | 35 | - | 18:far 19:far 21:far 23:far 24:far 25:far 56:far 57:far 59:far 60:far 62:far |
| openhands-DeepSeek__DeepSeek-V3.2-mixed-integer-programming-b8149b32 | yes | agent_failure_analysis | 52 | 33,34,44,45,48 | - | 1 | 2 | 14,25 | - | 33:far 34:far 44:far 45:far 48:far |
| openhands-DeepSeek__DeepSeek-V3.2-mixed-integer-programming-b8149b32 | yes | agent_failure_analysis | 52 | 33,34,44,45,48 | - | 0 | 3 | 14,25,34 | 34 | 33:near 34:hit 44:far 45:far 48:far |
| openhands-OpenAI__GPT-5-django__django-15930-f153f9fc | yes | merged_cleaned_step25 | 48 | 44,45 | - | 1 | 0 | - | - | 44:silent 45:silent |
| openhands-OpenAI__GPT-5-django__django-15930-f153f9fc | yes | merged_cleaned_step25 | 48 | 44,45 | - | 0 | 2 | 29,30 | - | 44:far 45:far |
| openhands-OpenAI__GPT-5-instance_ansible__ansible-bf98f031f3f5af31a2d78dc2f0a58fe92ebae0bb-v1055803c3a812189a1133297f7f5468579283f86-c62b0ad0 | no | merged_cleaned_step25 | 64 | 33,36,37,50,53,54,55,58,59,61 | 36,61 | 0 | 12 | 33,34,35,36,37,55,56,57,58,59,60,61 | 33,36,37,55,58,59,61 | 33:hit 36:blindHit 37:hit 50:far 53:near 54:near 55:hit 58:hit 59:hit 61:blindHit |
| openhands-OpenAI__GPT-5-instance_ansible__ansible-bf98f031f3f5af31a2d78dc2f0a58fe92ebae0bb-v1055803c3a812189a1133297f7f5468579283f86-c62b0ad0 | no | merged_cleaned_step25 | 64 | 33,36,37,50,53,54,55,58,59,61 | 36,61 | 1 | 6 | 33,34,35,36,55,56 | 33,36,55 | 33:hit 36:blindHit 37:near 50:far 53:near 54:near 55:hit 58:near 59:far 61:blind |
| openhands-OpenAI__GPT-5-matplotlib__matplotlib-26113-3e60723a | yes | merged_cleaned_step25 | 33 | 26,27,28,33 | - | 0 | 0 | - | - | 26:silent 27:silent 28:silent 33:silent |
| openhands-OpenAI__GPT-5-matplotlib__matplotlib-26113-3e60723a | yes | merged_cleaned_step25 | 33 | 26,27,28,33 | - | 1 | 4 | 13,14,15,24 | - | 26:near 27:far 28:far 33:far |
| openhands-OpenAI__GPT-5-mui__material-ui-13534-53934742 | yes | merged_cleaned_step20_three_waves | 30 | 11,12,13 | - | 0 | 4 | 11,12,13,23 | 11,12,13 | 11:hit 12:hit 13:hit |
| openhands-OpenAI__GPT-5-mui__material-ui-13534-53934742 | yes | merged_cleaned_step20_three_waves | 30 | 11,12,13 | - | 1 | 3 | 11,12,13 | 11,12,13 | 11:hit 12:hit 13:hit |
| openhands-OpenAI__GPT-5-sympy__sympy-17318-8d1c8af1 | no | merged_cleaned_step25 | 26 | 13,25 | - | 0 | 14 | 13,14,15,16,17,18,19,20,21,22,23,24,25,26 | 13,25 | 13:hit 25:hit |
| openhands-OpenAI__GPT-5-sympy__sympy-17318-8d1c8af1 | no | merged_cleaned_step25 | 26 | 13,25 | - | 1 | 1 | 13 | 13 | 13:hit 25:far |

## Appendix B — per-case table, Terminus2 cert32 positive cases (stock arm)

| case | solved | annotation | steps | gold | input-blind gold | rep | findings | cited | matched | classes |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- | --- |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-build-linux-kernel-qemu-7699e895 | no | agent_failure_analysis | 81 | 17 | - | 0 | 10 | 54,55,56,57,58,59,60,61,62,63 | - | 17:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-build-linux-kernel-qemu-7699e895 | no | agent_failure_analysis | 81 | 17 | - | 1 | 1 | 17 | 17 | 17:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-catch-me-if-you-can-d89cfe9a | no | agent_failure_analysis | 68 | 59,61 | - | 0 | 7 | 49,51,59,61,65,67,68 | 59,61 | 59:hit 61:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-catch-me-if-you-can-d89cfe9a | no | agent_failure_analysis | 68 | 59,61 | - | 1 | 12 | 20,21,22,23,24,25,26,27,28,29,30,31 | - | 59:far 61:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-count-dataset-tokens-ad1d3494 | no | agent_failure_analysis | 40 | 36,37,38,39 | - | 1 | 3 | 38,39,40 | 38,39 | 36:near 37:near 38:hit 39:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-count-dataset-tokens-ad1d3494 | no | agent_failure_analysis | 40 | 36,37,38,39 | - | 0 | 2 | 38,39 | 38,39 | 36:near 37:near 38:hit 39:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-download-youtube-402af613 | no | agent_failure_analysis | 35 | 20,21 | - | 0 | 5 | 24,25,26,27,28 | - | 20:far 21:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-download-youtube-402af613 | no | agent_failure_analysis | 35 | 20,21 | - | 1 | 10 | 24,25,28,29,30,31,32,33,34,35 | - | 20:far 21:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-get-bitcoin-nodes-34b1eb45 | no | agent_failure_analysis | 21 | 9 | - | 0 | 1 | 9 | 9 | 9:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-get-bitcoin-nodes-34b1eb45 | no | agent_failure_analysis | 21 | 9 | - | 1 | 4 | 9,10,11,12 | 9 | 9:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-logistic-regression-divergence-0b8df7b3 | no | agent_failure_analysis | 27 | 6,8 | - | 0 | 5 | 3,6,8,11,15 | 6,8 | 6:hit 8:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-logistic-regression-divergence-0b8df7b3 | no | agent_failure_analysis | 27 | 6,8 | - | 1 | 17 | 2,3,6,7,8,9,11,12,15,16,19,20,21,22,23,24,25 | 6,8 | 6:hit 8:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-make-mips-interpreter-35ea4c65 | no | agent_failure_analysis | 61 | 41,42,43,46,47,48,49,52,53,54,55 | - | 1 | 9 | 52,53,54,55,56,58,59,60,61 | 52,53,54,55 | 41:far 42:far 43:far 46:far 47:far 48:far 49:far 52:hit 53:hit 54:hit 55:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-make-mips-interpreter-35ea4c65 | no | agent_failure_analysis | 61 | 41,42,43,46,47,48,49,52,53,54,55 | - | 0 | 17 | 32,33,34,35,36,37,38,39,46,47,48,49,50,58,59,60,61 | 46,47,48,49 | 41:near 42:far 43:far 46:hit 47:hit 48:hit 49:hit 52:near 53:far 54:far 55:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-parallel-particle-simulator-56d1327d | no | agent_failure_analysis | 107 | 59,60,61,63,64 | - | 1 | 5 | 2,3,105,106,107 | - | 59:far 60:far 61:far 63:far 64:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-parallel-particle-simulator-56d1327d | no | agent_failure_analysis | 107 | 59,60,61,63,64 | - | 0 | 1 | 2 | - | 59:far 60:far 61:far 63:far 64:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-parallelize-graph-619aaf8f | no | agent_failure_analysis | 47 | 13,14,15,16,17,18,19 | - | 0 | 8 | 39,40,41,43,44,45,46,47 | - | 13:far 14:far 15:far 16:far 17:far 18:far 19:far |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-parallelize-graph-619aaf8f | no | agent_failure_analysis | 47 | 13,14,15,16,17,18,19 | - | 1 | 4 | 15,16,17,44 | 15,16,17 | 13:near 14:near 15:hit 16:hit 17:hit 18:near 19:near |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-pytorch-model-cli-3c920ed8 | no | agent_failure_analysis | 20 | 7,8,9 | - | 0 | 4 | 5,6,7,8 | 7,8 | 7:hit 8:hit 9:near |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-pytorch-model-cli-3c920ed8 | no | agent_failure_analysis | 20 | 7,8,9 | - | 1 | 5 | 5,6,7,8,9 | 7,8,9 | 7:hit 8:hit 9:hit |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-rstan-to-pystan-6adcbc5e | yes | agent_failure_analysis | 38 | 7,20,21,22 | - | 0 | 0 | - | - | 7:silent 20:silent 21:silent 22:silent |
| terminus2-Anthropic__Claude-Sonnet-4-20250514-Thinking-rstan-to-pystan-6adcbc5e | yes | agent_failure_analysis | 38 | 7,20,21,22 | - | 1 | 1 | 7 | 7 | 7:hit 20:far 21:far 22:far |
| terminus2-DeepSeek__DeepSeek-V3.2-fix-git-bbd1fcbd | yes | agent_failure_analysis | 49 | 12,17,18,19,20,21 | 12,17,18,20,21 | 0 | 0 | - | - | 12:blind 17:blind 18:blind 19:silent 20:blind 21:blind |
| terminus2-DeepSeek__DeepSeek-V3.2-fix-git-bbd1fcbd | yes | agent_failure_analysis | 49 | 12,17,18,19,20,21 | 12,17,18,20,21 | 1 | 0 | - | - | 12:blind 17:blind 18:blind 19:silent 20:blind 21:blind |
| terminus2-DeepSeek__DeepSeek-V3.2-leelachess0-pytorch-conversion-a0b986ad | no | agent_failure_analysis | 200 | 131,134,135,136,137,139,141,195,197,199 | - | 1 | 2 | 147,150 | - | 131:far 134:far 135:far 136:far 137:far 139:far 141:far 195:far 197:far 199:far |
| terminus2-DeepSeek__DeepSeek-V3.2-leelachess0-pytorch-conversion-a0b986ad | no | agent_failure_analysis | 200 | 131,134,135,136,137,139,141,195,197,199 | - | 0 | 16 | 8,9,10,112,113,131,132,133,134,135,136,137,138,139,140,141 | 131,134,135,136,137,139,141 | 131:hit 134:hit 135:hit 136:hit 137:hit 139:hit 141:hit 195:far 197:far 199:far |
| terminus2-DeepSeek__DeepSeek-V3.2-organization-json-generator-30fb23d8 | no | agent_failure_analysis | 20 | 9 | - | 1 | 1 | 9 | 9 | 9:hit |
| terminus2-DeepSeek__DeepSeek-V3.2-organization-json-generator-30fb23d8 | no | agent_failure_analysis | 20 | 9 | - | 0 | 12 | 9,10,11,12,13,14,15,16,17,18,19,20 | 9 | 9:hit |
| terminus2-DeepSeek__DeepSeek-V3.2-overfull-hbox-c11dbef0 | no | agent_failure_analysis | 191 | 91,92,93,94,123,125,126,127,128,139,140,142,144,149,150 | - | 1 | 6 | 84,85,86,87,88,109 | - | 91:far 92:far 93:far 94:far 123:far 125:far 126:far 127:far 128:far 139:far 140:far 142:far 144:far 149:far 150:far |
| terminus2-DeepSeek__DeepSeek-V3.2-overfull-hbox-c11dbef0 | no | agent_failure_analysis | 191 | 91,92,93,94,123,125,126,127,128,139,140,142,144,149,150 | - | 0 | 1 | 37 | - | 91:far 92:far 93:far 94:far 123:far 125:far 126:far 127:far 128:far 139:far 140:far 142:far 144:far 149:far 150:far |
| terminus2-DeepSeek__DeepSeek-V3.2-protocol-analysis-rs-f24dfce5 | no | agent_failure_analysis | 229 | 92,93,96,100,101,103,107,108,109,111,112,113,114,116,196,199,201,202,204,209,211,212,213,214,215,217 | 93,96,101,103,113,114,116,199,204,209,212,214 | 1 | 1 | 215 | 215 | 92:far 93:blind 96:blind 100:far 101:blind 103:blind 107:far 108:far 109:far 111:far 112:far 113:blind 114:blind 116:blind 196:far 199:blind 201:far 202:far 204:blind 209:blind 211:far 212:blind 213:near 214:blind 215:hit 217:near |
| terminus2-DeepSeek__DeepSeek-V3.2-protocol-analysis-rs-f24dfce5 | no | agent_failure_analysis | 229 | 92,93,96,100,101,103,107,108,109,111,112,113,114,116,196,199,201,202,204,209,211,212,213,214,215,217 | 93,96,101,103,113,114,116,199,204,209,212,214 | 0 | 0 | - | - | 92:silent 93:blind 96:blind 100:silent 101:blind 103:blind 107:silent 108:silent 109:silent 111:silent 112:silent 113:blind 114:blind 116:blind 196:silent 199:blind 201:silent 202:silent 204:blind 209:blind 211:silent 212:blind 213:silent 214:blind 215:silent 217:silent |

## Threats to validity

- cert32 splits are SPENT for certification claims; every number here is diagnosis, not a certified score.
- 16 positive cases per family; per-class counts are 13–93 gold observations, so single-case swings move class shares by up to ±6pp.
- `far` conflates "wrong incident" and "annotation labels a different real incident than the model's real incident"; the qualitative reads (django-15930, mixed-integer-programming, parallel-particle-simulator) show the model's far accusations are usually themselves genuine mistakes the labels do not mark. The metric is fidelity to CodeTraceBench's annotation, not ground truth about the trajectory.
- The whitespace-padding hit-rate comparison (0/28 vs 16/64) is not length-controlled; padded actions may correlate with harder cases.
- The constant-rule sweep reuses the labels it is scored on (in-sample by construction); it calibrates the instrument, it is not an analyst.
