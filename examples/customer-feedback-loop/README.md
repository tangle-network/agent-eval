# Customer feedback loop — multi-rater approve/reject corpus → decision packet

The journey for teams who already review AI outputs by hand: an Obsidian vault with `#approved` / `#rejected` tags, a Google Sheet of ratings, a Postgres feedback table. You have the corpus; you want to **compress that taste into LLM judges**, find where raters disagree, and (eventually) close the loop.

```sh
pnpm tsx examples/customer-feedback-loop/index.ts
```

## What this example does

Synthesises a realistic 30-claim research corpus with three reviewers (Alice, Bob, Carol). Reviewers agree most of the time but split 50/50 on ~15% of claims. Then:

1. Pipes the raw `(runId, rater, rating)` rows through `fromFeedbackTable()` to get `RunRecord[] + raterScores`.
2. Calls `analyzeRuns({ runs, raterScores })`.
3. Prints the decision packet — distributional summary, inter-rater agreement, the disagreement triage list, and the recommendations.

## What you'll see

```
═══ Customer feedback corpus — decision packet ═══

Runs analyzed:     30
Composite mean:    0.683 (p50: 0.667, p95: 1.000)
Approve rate:      ~68%

── Inter-rater agreement ──
Raters:               3 (alice, bob, carol)
Jointly rated runs:   30
Pairwise pearson κ:
  alice::bob:   0.78
  alice::carol: 0.65
  bob::carol:   0.69
Mean κ:               0.71

── Top 5 disagreement cases (worth a triage meeting) ──
  claim-7  range=1.00  ratings: alice=1, bob=1, carol=0
  claim-13 range=1.00  ratings: alice=0, bob=0, carol=1
  ...

── Recommendations ──
[medium] recalibrate — Top inter-rater range cases worth a review
  Surface the 5 claims with highest disagreement at the next triage meeting.

═══ end ═══
```

## What to do with the output

1. **Skim the disagreement cases first.** They're your team's calibration boundary — where the rubric is ambiguous.
2. **Capture each member's taste.** The per-rater scores let you train a calibrated LLM-as-judge per member; once the LLM-judge agrees with the human ≥85% of the time, you can auto-grade in real time and only escalate close calls.
3. **Close the loop.** Once you have judges, wrap the underlying research generation in a `Dispatch` and call `selfImprove()` — propose better research prompts gated on holdout approval rate.

## Files

- `index.ts` — the runnable script
