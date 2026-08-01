# Narrow thin-gold regime: measured loss decomposition (split3, 2026-08-01)

**Verdict: 55% of split3's gold mass sits on trace spans the analyst cannot tell apart, because the trace we hand it drops every step's reasoning text and keeps only the shell command.**
Thirty-two of 58 gold steps land on a span whose visible content is either a byte-for-byte duplicate of another span in the same trajectory or nothing but mini-SWE-agent's `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` boilerplate.
Twenty-one of 37 cases have *every* gold step in that state.
A one-line positional rule — "accuse step `step_count - 1`, nothing else" — scores micro F1 0.568 on this split against 0.180 for the shipping analyst, because that is where the annotation convention puts the label and content cannot separate it from the neighbouring step.
The split3 collapse is therefore not a reasoning failure to optimize away; it is an input-fidelity defect plus a split whose labels are positionally degenerate.

Every number below is recomputed from the three certified runs' own observations, the split3 labels, and the split3 OTLP traces.
No model was called to produce this decomposition.

## Method

| Item | Value |
| --- | --- |
| Split | `verified-miniswe-normalizer-remainder-37`, labels sha256 `d0347ec7a5ec9a07bd3fcd16aa06b07bcb33ffabca39cb0b0f7a564fb500ae08` |
| Cases / gold steps | 37 / 58 (1.57 gold steps per case); 24 solved, 13 unsolved |
| Runs | `/dev/shm/cert-{inc,w,g}-s3`, runner `dspy-rlm`, glm-5.2, 2 repetitions → 74 observations per arm |
| Scoring | unchanged official scorer: a finding matches gold `incorrect:N` when `area = incorrect` and it cites `trace://<traj>/span/step-N` |
| Micro F1 | recall = Σmatched/Σexpected, precision = Σsupported/Σfindings, harmonic mean — reproduces `result.summaries[].f1` exactly |
| Tool | `benchmarks/trace-analysis/tools/decompose-analyst-loss.mjs` (committed with this artifact) |

Reproduce:

```bash
node benchmarks/trace-analysis/tools/decompose-analyst-loss.mjs \
  --labels /dev/shm/ctb-split3-labels.json \
  --traces /dev/shm/ctb-split3-traces \
  --run gepa=/dev/shm/cert-g-s3 --run incumbent=/dev/shm/cert-inc-s3 --run W=/dev/shm/cert-w-s3 \
  --markdown
```

### Failure classes

Per gold step, from the run's own citations:

| Class | Meaning |
| --- | --- |
| `input-blind` | the gold span's content repeats another span in the same trace, or carries nothing beyond the submit boilerplate — no analyst can single it out from what the trace shows |
| `hit` | a finding cites the gold step exactly |
| `near` | nearest citation is 1–2 steps away (block-boundary error) |
| `far` | nearest citation is >2 steps away |
| `silent` | the run cited nothing anywhere in the trajectory |

Unsupported findings split into `near` (≤2 steps from a gold step) and `pad` (>2 steps), each further split by the trajectory's `solved` flag.

## Result 1 — the three arms are the same instrument on this split

| Arm | recall | precision | micro F1 | matched/expected | supported/findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| incumbent | 0.3276 | 0.1141 | 0.1693 | 38/116 | 38/333 |
| W | 0.3190 | 0.1259 | 0.1805 | 37/116 | 37/294 |
| GEPA winner (shipping) | 0.3017 | 0.1282 | 0.1799 | 35/116 | 35/273 |

## Result 2 — where the loss is

Gold-step classes (116 gold observations = 58 gold steps × 2 repetitions):

| Arm | input-blind (missed) | input-blind (hit anyway) | hit | near | far | silent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| incumbent | 55 | 9 | 29 | 8 | 6 | 9 |
| W | 63 | 1 | 36 | 5 | 6 | 5 |
| GEPA winner | 60 | 4 | 31 | 10 | 6 | 5 |

Finding classes (unsupported findings by distance to the nearest gold step):

| Arm | supported | near (≤2) | pad (>2) | pad on solved | pad on unsolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| incumbent | 38 | 64 | 231 | 120 | 111 |
| W | 37 | 50 | 207 | 111 | 96 |
| GEPA winner | 35 | 53 | 185 | 118 | 67 |

Recall restricted to gold the trace can actually single out — the honest capability number:

| Arm | diagnosable-gold recall | input-blind-gold recall |
| --- | ---: | ---: |
| incumbent | 29/52 = 0.558 | 9/64 = 0.141 |
| W | 36/52 = 0.692 | 1/64 = 0.016 |
| GEPA winner | 31/52 = 0.596 | 4/64 = 0.063 |

## Result 3 — counterfactual micro F1, one class neutralised at a time

| Counterfactual | incumbent | W | GEPA winner |
| --- | ---: | ---: | ---: |
| baseline | 0.1693 | 0.1805 | 0.1799 |
| drop input-blind gold from the denominator | 0.1543 (−0.015) | 0.2087 (+0.028) | 0.1931 (+0.013) |
| credit a citation within ±2 steps | 0.2673 (+0.098) | 0.2829 (+0.102) | 0.3342 (+0.154) |
| suppress every block the analyst marked `escaped` | 0.1905 (+0.021) | 0.1751 (−0.005) | 0.1667 (−0.013) |
| report nothing on solved trajectories | 0.1037 (−0.066) | 0.0976 (−0.083) | 0.0693 (−0.111) |

Reading these:

- **Removing the input-blind gold barely moves F1 even though it doubles recall** (GEPA winner: recall 0.302 → 0.596), because precision is the binding term and the 238 unsupported findings stay.
- **±2 tolerance is worth +15.4pp** on the shipping arm — the largest single recoverable class *under the current input*.
- **`escape_status` is not discriminative.** It fires often (77 of 273 expanded findings on the GEPA arm) but escaped findings are supported at 9/77 = 11.7% versus 26/196 = 13.3% unescaped. Suppressing them costs −1.3pp. The M3-shaped arm is dead on this split.
- **Solved-trace abstention is a large net loss** (−11.1pp). The "FP flood on solved traces" hypothesis is refuted: pad findings per observation are 118/48 = 2.46 on solved and 67/26 = 2.58 on unsolved, and *recall* is higher on solved (28/76 = 0.368) than unsolved (7/40 = 0.175).

## Result 4 — split3 is positionally degenerate, and the other splits are not

A single deterministic rule, "accuse exactly step `step_count - shift`", scored against the unchanged official scorer on labelled cases only:

| Split | positive cases | gold | n−0 F1 | n−1 F1 | n−2 F1 | last-2 window F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| split3-37 | 37 | 58 | 0.105 | **0.568** | 0.021 | 0.485 |
| dev-32 | 16 | 55 | 0.000 | 0.113 | 0.085 | 0.092 |
| holdout1-32 | 16 | 76 | 0.065 | 0.152 | 0.087 | 0.185 |
| holdout2-32 | 30 | 188 | 0.083 | 0.193 | 0.101 | 0.242 |

On split3 the constant rule beats every measured analyst configuration by more than 3×; on the other three splits it is worthless.
The cause is visible in the annotation provenance: split3 draws 32 of 37 rows from CodeTraceBench's `merged_cleaned_step20_three_waves` / `merged_cleaned_step25` waves (dev-32 draws 5 of 32), and in those waves the labelled step is overwhelmingly the agent's submit decision at `step_count - 1`.

**Any micro-F1 number certified on split3 is measuring position-guessing, not diagnosis. Split3 must not be used to certify a prompt or engine change.**

## Result 5 — the input defect is fleet-wide, split3 is just its worst case

Input-blind gold under the same rule, per split:

| Split | gold steps | input-blind | share | cases with every gold blind | duplicate assistant spans |
| --- | ---: | ---: | ---: | ---: | --- |
| split3-37 | 58 | 32 | 55.2% | 21/37 | 110/967 |
| dev-32 | 55 | 6 | 10.9% | 2/16 | 67/505 |
| holdout1-32 | 76 | 16 | 21.1% | 2/16 | 48/537 |
| holdout2-32 | 188 | 39 | 20.7% | 0/30 | 113/900 |

## Root cause, traced to the line

CodeTracer's normalizer writes `steps.json` with the extracted shell command in `action` and the assistant's reasoning nowhere.
`@tangle-network/traces` builds each assistant span as `[step.thinking, step.action].join('\n')` (`src/codetracebench-trajectory.ts:132`), and `thinking` is never populated, so the span content is the bash command alone.
mini-SWE-agent ends most trajectories with two identical submit commands, so the last two spans are byte-identical while the raw trajectory distinguishes them clearly:

- step 21 (labelled `incorrect`): "The compiler error now is due to duplicated tests in the test suite, which I cannot modify. My core fix is in non-test files…" — the agent submitting on a failing build.
- step 22: "Providing code context used for patch generation."

Verified on the raw artifacts: for all 37 split3 cases the raw trajectory has exactly one assistant message per normalized step (967/967), and every step's `action` appears inside its paired message, so the pairing is unambiguous.
Label alignment itself is *not* off by one — sampled gold steps match their paired assistant message exactly at offset 0.

## Comparison with the M1/M2/M3 decomposition

`2026-07-30-breakout-verified-trace-analysis.md` ranked the loss on dev-32 as M1 under-enumeration (+20.8pp), M2 region padding (+8.8pp), M3 recovered-error conflation (+4.0pp).

- **M1 survives, transformed.** Gold blocks on split3 are thin (44 width-1, 7 width-2), so there is little intra-block under-enumeration left; what remains is boundary error, measured here as the ±2 counterfactual (+15.4pp).
- **M2 survives and is now the binding term.** 185 of 273 findings (68%) are >2 steps from any gold step, and precision, not recall, caps F1.
- **M3 is dead as stated.** The per-finding escape decision exists and fires, but it does not separate supported from unsupported findings, and suppressing escaped blocks *loses* 1.3pp. Solved-trace abstention loses 11.1pp.
- **A fourth mechanism dominates and was not in the earlier ranking: M4, input blindness** — 55% of gold mass on split3 (11–21% elsewhere) is unreachable because the trace omits the agent's own reasoning.

## The one arm: restore each step's reasoning to the trace input

**Change.** A new deterministic preprocessing stage, `benchmarks/trace-analysis/tools/restore-step-reasoning.mjs`, pairs the raw trajectory's assistant messages to the normalized steps and writes each step's reasoning text into `thinking` in a *copy* of the normalized tree.
The traces importer already joins `thinking` and `action` into span content, so no importer or prompt change is needed, and the unrestored input stays byte-identical for the A/B.

**Why this and not a prompt edit.** It targets the largest measured class (M4), it is pure preprocessing with no model in the loop, and it is the only candidate that converts a positional guess into evidence: after restoration the analyst can read "I am submitting although the build fails" and cite it. The alternatives were measured and rejected above (escape suppression −1.3pp, solved abstention −11.1pp), and a positional prior would be a shape prior on a split we have just shown to be positionally degenerate.

**Measured effect on the input (no model calls):** 967/967 steps restored, +383,920 bytes of reasoning, trace directory 4.9 MB → 5.3 MB.
Input-blind gold on split3 falls from 64/116 gold observations to **0/116**; duplicate assistant spans fall from 110/967 to 2/967.
Re-importing the *unrestored* tree with the same importer (`@tangle-network/traces` 0.11.0) reproduces the baseline trace bytes exactly (`outputSha256 9f81b4648001abb34f190befdf5482ea03b96b354e0033c1468fd79ac668e7ec`), so the restored arm differs from the certified baseline in exactly one thing.

### Pre-registered smoke (written before the run)

Four spent split3 cases, chosen by the shipping selector's deterministic order (`sha256(seed \0 caseId)` ascending, seed 0) over the eligible class — cases with ≤3 gold steps and at least one input-blind gold step (28 of 37 qualify):

1. `miniswe-OpenAI__GPT-5-ponylang__ponyc-2247-a9fb6037`
2. `miniswe-OpenAI__GPT-5-instance_ansible__ansible-0fd88717c953b92ed8a50495d55e630eb5d59166-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-09135d56`
3. `miniswe-OpenAI__GPT-5-sveltejs__svelte-11913-1fe8a1b7`
4. `miniswe-OpenAI__GPT-5-facebook__zstd-2094-7f31a0cb`

Baseline for those four, read out of the certified GEPA-winner run (`/dev/shm/cert-g-s3`, 8 observations): recall 0.300 (3/10), precision 0.1034 (3/29), micro F1 0.1538, input-blind gold recall **1/8 = 0.125**, diagnosable-gold recall 2/2.

| Gate | Threshold |
| --- | --- |
| Primary (mechanism) | input-blind gold recall ≥ 3/8 = 0.375 |
| Secondary (no harm) | micro precision ≥ 0.073 (baseline − 0.03) |
| Composite | micro F1 ≥ 0.25 (baseline 0.1538) |
| Kill | input-blind gold recall ≤ 1/8, or micro F1 < 0.1538 |

The smoke is class-conditional by construction: it estimates the effect *within* the input-blind thin-gold class, not a split-level delta. n = 8 observations; it decides whether to pay for a full measurement, nothing more.

### Smoke result

Pending — appended below after the run.

## Appendix — per-case, per-repetition table (GEPA winner arm, split3)

`classes` lists each gold step and its class. `cited` lists every step the run accused.

| case | solved | annotation | steps | gold | input-blind gold | rep | findings | cited | matched | classes |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- | --- |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-sam-cell-seg-93dae667 | no | agent_failure_analysis | 20 | 8,13 | - | 0 | 2 | 13,20 | 13 | 8:far 13:hit |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-sam-cell-seg-93dae667 | no | agent_failure_analysis | 20 | 8,13 | - | 1 | 2 | 13,20 | 13 | 8:far 13:hit |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-vul-flask-4946dda9 | no | agent_failure_analysis | 36 | 30,32,34 | - | 1 | 11 | 10,11,12,21,22,23,24,25,26,27,28 | - | 30:near 32:far 34:far |
| miniswe-Anthropic__Claude-Sonnet-4-20250514-Thinking-vul-flask-4946dda9 | no | agent_failure_analysis | 36 | 30,32,34 | - | 0 | 0 | - | - | 30:silent 32:silent 34:silent |
| miniswe-DeepSeek__DeepSeek-V3.2-build-linux-kernel-qemu-ea803cf1 | no | agent_failure_analysis | 31 | 31 | 31 | 0 | 3 | 11,23,31 | 31 | 31:blindHit |
| miniswe-DeepSeek__DeepSeek-V3.2-build-linux-kernel-qemu-ea803cf1 | no | agent_failure_analysis | 31 | 31 | 31 | 1 | 3 | 12,21,31 | 31 | 31:blindHit |
| miniswe-DeepSeek__DeepSeek-V3.2-merge-diff-arc-agi-task-cb5aafdd | no | agent_failure_analysis | 21 | 6 | - | 1 | 6 | 10,12,14,16,18,20 | - | 6:far |
| miniswe-DeepSeek__DeepSeek-V3.2-merge-diff-arc-agi-task-cb5aafdd | no | agent_failure_analysis | 21 | 6 | - | 0 | 3 | 18,19,20 | - | 6:far |
| miniswe-DeepSeek__DeepSeek-V3.2-protein-assembly-472264a0 | no | agent_failure_analysis | 24 | 24 | 24 | 0 | 6 | 17,18,19,20,21,22 | - | 24:blind |
| miniswe-DeepSeek__DeepSeek-V3.2-protein-assembly-472264a0 | no | agent_failure_analysis | 24 | 24 | 24 | 1 | 5 | 13,17,18,21,22 | - | 24:blind |
| miniswe-OpenAI__GPT-5-django__django-14999-5d6ca542 | yes | merged_cleaned_step20_three_waves | 20 | 7,8,19 | 19 | 0 | 0 | - | - | 7:silent 8:silent 19:blind |
| miniswe-OpenAI__GPT-5-django__django-14999-5d6ca542 | yes | merged_cleaned_step20_three_waves | 20 | 7,8,19 | 19 | 1 | 1 | 7 | 7 | 7:hit 8:near 19:blind |
| miniswe-OpenAI__GPT-5-facebook__zstd-2094-7f31a0cb | yes | merged_cleaned_step25 | 28 | 27 | 27 | 0 | 5 | 17,22,23,24,25 | - | 27:blind |
| miniswe-OpenAI__GPT-5-facebook__zstd-2094-7f31a0cb | yes | merged_cleaned_step25 | 28 | 27 | 27 | 1 | 10 | 17,18,19,20,21,22,23,24,25,28 | - | 27:blind |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-databind-4641-989d1554 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 1 | 3 | 19,20,21 | - | 22:blind |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-databind-4641-989d1554 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 0 | 3 | 19,20,21 | - | 22:blind |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-dataformat-xml-638-5311424b | yes | merged_cleaned_step20_three_waves | 24 | 18 | - | 1 | 3 | 18,19,20 | 18 | 18:hit |
| miniswe-OpenAI__GPT-5-fasterxml__jackson-dataformat-xml-638-5311424b | yes | merged_cleaned_step20_three_waves | 24 | 18 | - | 0 | 5 | 18,19,20,21,22 | 18 | 18:hit |
| miniswe-OpenAI__GPT-5-fmtlib__fmt-4286-f5dcb102 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 2 | 12,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-fmtlib__fmt-4286-f5dcb102 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 2 | 12,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-0fd88717c953b92ed8a50495d55e630eb5d59166-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-09135d56 | yes | merged_cleaned_step20_three_waves | 21 | 20 | 20 | 0 | 2 | 12,13 | - | 20:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-0fd88717c953b92ed8a50495d55e630eb5d59166-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-09135d56 | yes | merged_cleaned_step20_three_waves | 21 | 20 | 20 | 1 | 6 | 2,5,12,13,14,15 | - | 20:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1a4644ff15355fd696ac5b9d074a566a80fe7ca3-v30a923fb5c164d6cd18280c02422f75e611e8fb2-e1edb594 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 8 | 10,11,12,13,14,15,16,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1a4644ff15355fd696ac5b9d074a566a80fe7ca3-v30a923fb5c164d6cd18280c02422f75e611e8fb2-e1edb594 | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 1 | 10 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1b70260d5aa2f6c9782fd2b848e8d16566e50d85-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-0b674c2a | no | merged_cleaned_step25 | 38 | 37 | 37 | 0 | 1 | 36 | - | 37:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-1b70260d5aa2f6c9782fd2b848e8d16566e50d85-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-0b674c2a | no | merged_cleaned_step25 | 38 | 37 | 37 | 1 | 2 | 18,27 | - | 37:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-5640093f1ca63fd6af231cc8a7fb7d40e1907b8c-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-21500546 | yes | merged_cleaned_step20_three_waves | 24 | 21,23 | 23 | 1 | 3 | 21,22,24 | 21 | 21:hit 23:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-5640093f1ca63fd6af231cc8a7fb7d40e1907b8c-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-21500546 | yes | merged_cleaned_step20_three_waves | 24 | 21,23 | 23 | 0 | 2 | 6,21 | 21 | 21:hit 23:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-9142be2f6cabbe6597c9254c5bb9186d17036d55-v0f01c69f1e2528b935359cfe578530722bca2c59-48b421ba | no | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 3 | 12,13,20 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-9142be2f6cabbe6597c9254c5bb9186d17036d55-v0f01c69f1e2528b935359cfe578530722bca2c59-48b421ba | no | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 2 | 13,18 | - | 19:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-949c503f2ef4b2c5d668af0492a5c0db1ab86140-v0f01c69f1e2528b935359cfe578530722bca2c59-3a45c2a2 | no | merged_cleaned_step25 | 27 | 26 | 26 | 1 | 1 | 22 | - | 26:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-949c503f2ef4b2c5d668af0492a5c0db1ab86140-v0f01c69f1e2528b935359cfe578530722bca2c59-3a45c2a2 | no | merged_cleaned_step25 | 27 | 26 | 26 | 0 | 1 | 22 | - | 26:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-bec27fb4c0a40c5f8bbcf26a475704227d65ee73-v30a923fb5c164d6cd18280c02422f75e611e8fb2-1af9d682 | no | merged_cleaned_step25 | 36 | 35 | 35 | 0 | 11 | 24,25,26,27,28,29,30,31,32,33,34 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-bec27fb4c0a40c5f8bbcf26a475704227d65ee73-v30a923fb5c164d6cd18280c02422f75e611e8fb2-1af9d682 | no | merged_cleaned_step25 | 36 | 35 | 35 | 1 | 1 | 24 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-cb94c0cc550df9e98f1247bc71d8c2b861c75049-v1055803c3a812189a1133297f7f5468579283f86-6c8d52c0 | no | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 0 | 2 | 14,16 | - | 22:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-cb94c0cc550df9e98f1247bc71d8c2b861c75049-v1055803c3a812189a1133297f7f5468579283f86-6c8d52c0 | no | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 1 | 1 | 14 | - | 22:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-f8ef34672b961a95ec7282643679492862c688ec-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-f91ad040 | yes | merged_cleaned_step25 | 36 | 35 | 35 | 0 | 6 | 15,26,27,28,33,34 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_ansible__ansible-f8ef34672b961a95ec7282643679492862c688ec-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5-f91ad040 | yes | merged_cleaned_step25 | 36 | 35 | 35 | 1 | 4 | 15,26,27,28 | - | 35:blind |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-5dfde12c1c1c0b6e48f17e3405468593e39d9492-vnan-15dbf87c | yes | merged_cleaned_step25 | 33 | 32 | 32 | 0 | 4 | 22,23,25,31 | - | 32:blind |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-5dfde12c1c1c0b6e48f17e3405468593e39d9492-vnan-15dbf87c | yes | merged_cleaned_step25 | 33 | 32 | 32 | 1 | 10 | 22,23,24,25,26,27,28,29,30,31 | - | 32:blind |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-aeabf3b18896ac1eb7ae9757e66ce886120f8309-vnan-dc9947f9 | yes | merged_cleaned_step25 | 30 | 21,22,29 | 29 | 1 | 4 | 21,28,29,30 | 21,29 | 21:hit 22:near 29:blindHit |
| miniswe-OpenAI__GPT-5-instance_element-hq__element-web-aeabf3b18896ac1eb7ae9757e66ce886120f8309-vnan-dc9947f9 | yes | merged_cleaned_step25 | 30 | 21,22,29 | 29 | 0 | 3 | 21,22,28 | 21,22 | 21:hit 22:hit 29:blind |
| miniswe-OpenAI__GPT-5-instance_internetarchive__openlibrary-bb152d23c004f3d68986877143bb0f83531fe401-ve8c8d62a2b60610a3c4631f5f23ed866bada9818-78872a1e | no | merged_cleaned_step25 | 30 | 29 | 29 | 1 | 3 | 19,20,21 | - | 29:blind |
| miniswe-OpenAI__GPT-5-instance_internetarchive__openlibrary-bb152d23c004f3d68986877143bb0f83531fe401-ve8c8d62a2b60610a3c4631f5f23ed866bada9818-78872a1e | no | merged_cleaned_step25 | 30 | 29 | 29 | 0 | 3 | 19,20,21 | - | 29:blind |
| miniswe-OpenAI__GPT-5-instance_qutebrowser__qutebrowser-f8e7fea0becae25ae20606f1422068137189fe9e-b08f9fd3 | no | merged_cleaned_step20_three_waves | 22 | 21,22 | 21,22 | 1 | 1 | 14 | - | 21:blind 22:blind |
| miniswe-OpenAI__GPT-5-instance_qutebrowser__qutebrowser-f8e7fea0becae25ae20606f1422068137189fe9e-b08f9fd3 | no | merged_cleaned_step20_three_waves | 22 | 21,22 | 21,22 | 0 | 1 | 14 | - | 21:blind 22:blind |
| miniswe-OpenAI__GPT-5-keras-team__keras-19484-2bd0f0db | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 1 | 7 | 11,12,13,14,15,16,17 | - | 19:blind |
| miniswe-OpenAI__GPT-5-keras-team__keras-19484-2bd0f0db | yes | merged_cleaned_step20_three_waves | 20 | 19 | 19 | 0 | 2 | 14,20 | - | 19:blind |
| miniswe-OpenAI__GPT-5-keras-team__keras-19636-0123c279 | yes | merged_cleaned_step25 | 27 | 23 | - | 1 | 2 | 23,24 | 23 | 23:hit |
| miniswe-OpenAI__GPT-5-keras-team__keras-19636-0123c279 | yes | merged_cleaned_step25 | 27 | 23 | - | 0 | 5 | 23,24,25,26,27 | 23 | 23:hit |
| miniswe-OpenAI__GPT-5-matplotlib__matplotlib-24627-ee685446 | yes | merged_cleaned_step20_three_waves | 22 | 14 | - | 0 | 3 | 14,16,18 | 14 | 14:hit |
| miniswe-OpenAI__GPT-5-matplotlib__matplotlib-24627-ee685446 | yes | merged_cleaned_step20_three_waves | 22 | 14 | - | 1 | 3 | 16,17,18 | - | 14:near |
| miniswe-OpenAI__GPT-5-mockito__mockito-3220-ce8a6968 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 1 | 9 | 9,10,11,12,13,14,15,16,17 | - | 21:blind |
| miniswe-OpenAI__GPT-5-mockito__mockito-3220-ce8a6968 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 0 | 9 | 9,10,11,12,13,14,15,16,17 | - | 21:blind |
| miniswe-OpenAI__GPT-5-nushell__nushell-13357-4bd10bdc | yes | merged_cleaned_step25 | 31 | 28,30 | 30 | 0 | 3 | 24,27,28 | 28 | 28:hit 30:blind |
| miniswe-OpenAI__GPT-5-nushell__nushell-13357-4bd10bdc | yes | merged_cleaned_step25 | 31 | 28,30 | 30 | 1 | 1 | 27 | - | 28:near 30:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2205-2a662253 | yes | merged_cleaned_step25 | 32 | 27,28,31 | 31 | 0 | 8 | 3,4,5,6,8,27,28,32 | 27,28 | 27:hit 28:hit 31:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2205-2a662253 | yes | merged_cleaned_step25 | 32 | 27,28,31 | 31 | 1 | 3 | 27,28,32 | 27,28 | 27:hit 28:hit 31:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2247-a9fb6037 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 1 | 1 | 18 | - | 21:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-2247-a9fb6037 | yes | merged_cleaned_step20_three_waves | 22 | 21 | 21 | 0 | 0 | - | - | 21:blind |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-3973-6087c41b | yes | merged_cleaned_step20_three_waves | 23 | 20 | - | 1 | 1 | 20 | 20 | 20:hit |
| miniswe-OpenAI__GPT-5-ponylang__ponyc-3973-6087c41b | yes | merged_cleaned_step20_three_waves | 23 | 20 | - | 0 | 4 | 20,21,22,23 | 20 | 20:hit |
| miniswe-OpenAI__GPT-5-simdjson__simdjson-2016-953561fe | yes | merged_cleaned_step25 | 41 | 24,26,40,41 | 40,41 | 0 | 7 | 24,26,29,31,34,37,39 | 24,26 | 24:hit 26:hit 40:blind 41:blind |
| miniswe-OpenAI__GPT-5-simdjson__simdjson-2016-953561fe | yes | merged_cleaned_step25 | 41 | 24,26,40,41 | 40,41 | 1 | 4 | 24,29,30,31 | 24 | 24:hit 26:near 40:blind 41:blind |
| miniswe-OpenAI__GPT-5-sphinx-doc__sphinx-11445-fa910280 | no | merged_cleaned_step20_three_waves | 26 | 17,19,20,25 | 25 | 0 | 6 | 4,5,11,16,19,21 | 19 | 17:near 19:hit 20:near 25:blind |
| miniswe-OpenAI__GPT-5-sphinx-doc__sphinx-11445-fa910280 | no | merged_cleaned_step20_three_waves | 26 | 17,19,20,25 | 25 | 1 | 6 | 4,5,15,17,19,21 | 17,19 | 17:hit 19:hit 20:near 25:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-11913-1fe8a1b7 | yes | merged_cleaned_step20_three_waves | 22 | 19,21 | 21 | 0 | 4 | 19,20,21,22 | 19,21 | 19:hit 21:blindHit |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-11913-1fe8a1b7 | yes | merged_cleaned_step20_three_waves | 22 | 19,21 | 21 | 1 | 1 | 19 | 19 | 19:hit 21:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-13097-f6faf669 | yes | merged_cleaned_step20_three_waves | 22 | 22 | 22 | 1 | 3 | 12,16,18 | - | 22:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-13097-f6faf669 | yes | merged_cleaned_step20_three_waves | 22 | 22 | 22 | 0 | 7 | 12,13,14,15,16,17,18 | - | 22:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-9962-571c4e95 | yes | merged_cleaned_step25 | 27 | 21,22,26 | 26 | 0 | 1 | 22 | 22 | 21:near 22:hit 26:blind |
| miniswe-OpenAI__GPT-5-sveltejs__svelte-9962-571c4e95 | yes | merged_cleaned_step25 | 27 | 21,22,26 | 26 | 1 | 2 | 21,22 | 21,22 | 21:hit 22:hit 26:blind |
| miniswe-OpenAI__GPT-5-vuejs__core-9213-5aade8e3 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 1 | 5 | 13,17,18,19,21 | - | 22:blind |
| miniswe-OpenAI__GPT-5-vuejs__core-9213-5aade8e3 | yes | merged_cleaned_step20_three_waves | 23 | 22 | 22 | 0 | 5 | 11,12,13,17,18 | - | 22:blind |
