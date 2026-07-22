# Analyze Multi-Rater Feedback

Use this example when two or more people score the same AI outputs.
It shows where reviewers disagree and whether the scoring rules are consistent enough to automate.

```sh
pnpm tsx examples/customer-feedback-loop/index.ts
```

## What this example does

Synthesises a realistic 30-claim research corpus with three reviewers (Alice, Bob, Carol). Reviewers agree most of the time but split 50/50 on ~15% of claims. Then:

1. Pipes the raw `(runId, rater, rating)` rows through `fromFeedbackTable()` to get `RunRecord[] + raterScores`.
2. Calls `analyzeRuns({ runs, raterScores })`.
3. Prints score distributions, inter-rater agreement, the largest disagreements, and recommended next actions.

## What you'll see

```
Customer feedback report

Runs analyzed:     30
Composite mean:    0.756 (p50: 1.000, p95: 1.000)
Approve rate:      ~76%

Inter-rater agreement
Raters:               3 (alice, bob, carol)
Jointly rated runs:   30
Pairwise weighted kappa:
  alice::bob     0.53
  alice::carol   0.47
  bob::carol     0.19
Weighted kappa:       0.40
ICC(2,1):             0.42
Pearson correlation:  0.43

Top 5 disagreement cases
  claim-1  range=1.00  ratings: alice=0, bob=0, carol=1
  claim-4  range=1.00  ratings: alice=0, bob=1, carol=1
  ...

Recommendations
[high] recalibrate: Inter-rater weighted kappa 0.40 is below 0.5
  Raters disagree on what good looks like. Review the largest disagreement
  cases and refine the rubric before automating these decisions.

End
```

## What to do with the output

1. Review the largest disagreement cases and clarify the scoring rules.
2. Test any model-based judge against human labels that were not used to tune it.
3. Once the judge is reliable enough for your risk level, use it in `defineAgentEval()` to compare or improve the underlying agent.

## Files

- `index.ts`: the runnable script
