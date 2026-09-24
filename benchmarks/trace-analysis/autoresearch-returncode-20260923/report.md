# Autoresearch result: shell return codes are a narrow analyst signal

**Decision:** Do not use nonzero return codes as a replacement for Agent Eval's recursive CodeTraceBench analyst.
The frozen rule beat an empty predictor on mini-SWE-agent traces, but trailed the recorded analyst and failed completely on SWE-agent traces.

This experiment was proposed and run by the eval-runtime Codex agent.
The candidate family, raw-label checker, selection rule, and analysis plan were committed as `324a18eb` before either evaluation cohort ran.
The experiment spent $0 on provider and Sandbox calls; it replayed retained OTLP files and old analyst receipts.

## What ran

`predict.mjs` read OTLP spans without opening label files or prior model output.
It associated each recorded `<returncode>` with the preceding action span and predicted incorrect steps from nonzero codes.
An absent code stayed unknown.
The registered selection cohort chose `all`, which flags every action with a nonzero code.
The two evaluation predictions used only that frozen rule.

`score.py` independently read the raw incorrect-step labels after predictions were written.
It checked known-good and wrong-step controls and reconstructed all 62 included analyst observations from finding citations.
Every reconstructed analyst F1 matched the recorded score.
It refused missing or duplicated cases, and it excluded task names shared with selection before scoring.

| Cohort | Independent tasks | Gold steps | Rule predictions | Matched steps | Mean task F1 | Micro F1 | Actions with / without code |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Selection, mini-SWE-agent | 32 | 76 | 172 | 34 | 0.1068 | 0.2742 | 993 / 43 |
| Primary, mini-SWE-agent | 31 | 184 | 143 | 67 | 0.3567 | 0.4098 | 902 / 53 |
| Transfer, SWE-agent | 104 | 199 | 0 | 0 | 0.0000 | 0.0000 | 0 / 4,309 |

The primary cohort excluded one task shared with selection; the transfer cohort excluded two.
All 32 primary and 106 transfer trace files were parsed before exclusion, with no unmatched return-code records.
The primary cohort had 29 labeled-positive tasks and two failed label-empty tasks, so it had no trusted negatives for a false-positive rate.
Selection had six trusted negatives; the rule predicted an incorrect step on five.
Transfer had 56 labeled-positive tasks, 36 trusted negatives, and 12 failed label-empty tasks.
Its zero false-positive count reflects zero return-code coverage, not accurate discrimination.

The primary rule's paired mean F1 gain over empty prediction was **+0.3567**, with a task-bootstrap 95% interval of **[+0.2585, +0.4556]**.
The recorded G-winner analyst averaged **0.5495** on the same 31 tasks across two repetitions.
The rule's paired difference against that analyst was **−0.1927**, with interval **[−0.3153, −0.0673]**.
The prior analyst receipts for those 62 observations recorded 885 calls and **$7.7585 estimated** model cost.
Those calls were made earlier; the cost is context, not spend by this experiment or an equal-budget comparison.
The transfer rule's mean F1 was zero, with paired interval **[0, 0]** against empty prediction.
All intervals use 10,000 task resamples with seed 7 and one trajectory per task.

## Interpretation and limits

The primary result shows that a failed shell command sometimes coincides with a labeled incorrect step.
The 117 unmatched primary gold steps and the selection false positives show that return codes alone do not identify root mistakes reliably.
The SWE-agent importer emits ACI observations without `<returncode>` fields, so this rule has no observable signal for that family.
That is a data-format transfer failure, not evidence that SWE-agent made no incorrect moves.

These cohorts were used in earlier analyst research and are not fresh certification sets.
The model comparator is a retained historical run, and this experiment did not rerun it under equal current conditions.
The result supports a cheap diagnostic baseline for mini-SWE-agent traces only.
It does not support a shipping change or a general analyst-quality claim.

## Receipts and reproduction

- Frozen proposal, method, and selection: [`preregistration.md`](./preregistration.md), [`selection.md`](./selection.md), commit `324a18eb`.
- Case-level prediction and score artifacts: `predictions-selection.json`, `selection-score.json`, `predictions-primary.json`, `primary-score.json`, `predictions-transfer.json`, `transfer-score.json`.
- Source manifests: `~/bench-cache/ctb-20260801/{ctb-holdout-labels.json,ctb-holdout2-labels.json,sweagent/ctb-sweagent-labels.json}`.
- Existing model receipts: [`result-holdout2.json`](../codetracebench-glm52-certified-20260801/result-holdout2.json).

From the repository root, rerun each prediction and score pair with these commands:

```sh
dir=benchmarks/trace-analysis/autoresearch-returncode-20260923
cache=$HOME/bench-cache/ctb-20260801
node "$dir/predict.mjs" "$cache/ctb-holdout-traces" "$dir/predictions-selection.json"
python3 "$dir/score.py" "$dir/predictions-selection.json" "$cache/ctb-holdout-labels.json" --out "$dir/selection-score.json"
node "$dir/predict.mjs" "$cache/ctb-holdout2-traces" "$dir/predictions-primary.json" --mode all
python3 "$dir/score.py" "$dir/predictions-primary.json" "$cache/ctb-holdout2-labels.json" --exclude-labels "$cache/ctb-holdout-labels.json" --reference benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/result-holdout2.json --out "$dir/primary-score.json"
node "$dir/predict.mjs" "$cache/sweagent/traces" "$dir/predictions-transfer.json" --mode all
python3 "$dir/score.py" "$dir/predictions-transfer.json" "$cache/sweagent/ctb-sweagent-labels.json" --exclude-labels "$cache/ctb-holdout-labels.json" --out "$dir/transfer-score.json"
```

The scorer's `inputs` records the SHA-256 of each prediction, label, exclusion, and model receipt file.
Every case-level score keeps the trajectory ID, gold and predicted steps, observed signal, and trace SHA-256.
