# Autoresearch: return-code evidence for incorrect-step analysis

Written before scoring either evaluation cohort. The proposer is the Codex agent assigned to the eval-runtime lane. This is one bounded method experiment on Agent Eval's CodeTraceBench incorrect-step task. It is retrospective: these public cohorts were used by earlier analyst research, so this is not fresh release evidence.

## Question and fixed method family

Can a zero-model-cost rule based only on observed nonzero shell return codes identify CodeTraceBench's labeled incorrect steps? A command failure is a useful event, but it need not be the agent's incorrect action; this experiment measures that gap. The predictor reads only OTLP trace files, never labels, final solved status, or a model response. It emits one of three fixed rules per trajectory:

1. `first`: flag the first step followed by a nonzero `<returncode>`.
2. `last`: flag the last such step.
3. `all`: flag every such step.

An absent return code is **unknown**, not success. A trajectory with no observed nonzero code emits no prediction. The predictor records action and return-code coverage, malformed traces, and source hashes. It does not infer incorrectness from text or the final outcome.

## Cohorts and selection

Use the 32 mini-SWE-agent trajectories in `ctb-holdout-labels.json` for method selection. Its SHA-256 is `53af5ffe3962f3378f2d65419b92b8a56fe7d6c8efc619a0bc2b8f0872bc4f83`. Choose the rule with the highest official mean per-row incorrect-step F1. Break ties by fewer total predicted steps, then `first`, `last`, `all` order. Freeze that one rule before scoring either evaluation cohort.

The primary evaluation cohort is the 32 mini-SWE-agent trajectories in `ctb-holdout2-labels.json` (SHA-256 `2db46579b7993edc376acbbcacf67a1d0ddfcdb94e28930c2bb8dfcf1dc32fb2`). The secondary transfer cohort is the 106 SWE-agent trajectories in `sweagent/ctb-sweagent-labels.json` (SHA-256 `399cfed3b9b53dc47e61735ad0dde94acfeb3fcd63cd9879fe96e90df093d6d1`). Exclude any evaluation task name seen in selection before scoring, so repeated tasks cannot act as independent units. Record the exclusions and all missing trace or return-code evidence. Each remaining trajectory is one independent task.

The empty-prediction rule is the zero-cost control. On the primary cohort, compare the selected rule with the existing G-winner analyst receipts in `codetracebench-glm52-certified-20260801/result-holdout2.json` (SHA-256 `e1175425b98956f637fd807fd7775d216cf50223db6fc191fe7852fcec83bf03`). Those analyst calls happened in August and are not new spend. Average its two repetitions per task before paired comparison. Do not compare model costs as if replaying the old calls now.

## Frozen checker and decision

`score.py` reads raw label manifests only after `predict.mjs` has written predictions. It independently computes exact step-set precision, recall, mean per-task F1 (the published CodeTraceBench metric), micro F1, trusted-negative false positives, and coverage. It checks the G-winner's recorded per-observation score by reconstructing predictions from its finding citations. A known-good exact prediction must score 1; a wrong step must score 0. A missing trace or duplicate/misaligned case fails rather than disappearing from the denominator.

Use 10,000 task bootstrap resamples with seed 7 for paired mean F1 differences. Report all three rule results on selection and only the frozen winner on evaluation. A release-quality superiority claim requires the lower 95% paired interval above zero against the comparator, plus at least 30 independent primary tasks and complete trace coverage. If the selected rule fails, report a negative or unresolved result, not a tuned replacement. The transfer cohort has no model comparator. This experiment does not authorize changing the shipping analyst.

No provider or Sandbox calls are planned; external spend is $0. The source files stay in local benchmark cache. Committed predictions and scores include input hashes and case-level evidence, but omit raw trajectory content.
