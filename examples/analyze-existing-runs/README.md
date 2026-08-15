# Get A Report From Runs You Already Have

## When to use this

Use this example when the runs already happened.
You have logs, a feedback table, or exported rows, and you must know what they say.
No agent is invoked and no model is called.

Use a different front door when you want to run the agent again: [`evaluate-a-change`](../evaluate-a-change/).

## How to run it

```sh
pnpm tsx examples/analyze-existing-runs/index.ts
```

No API key is required.

## What it does

1. Twelve `RunRecord` rows describe two candidates answering the same six cases.
2. `analyzeRuns()` reads them and returns one `InsightReport`.
3. The report carries score distributions, paired lift with an interval, judge agreement, cost, failure clusters, contamination checks, and recommendations.

The output is:

```text
runs analyzed:   12
mean score:      0.5975
paired lift:     0.1283333333333333
lift interval:   [ 0.10666666666666663, 0.15333333333333335 ]
paired n:        6
recommendations: 2
```

## Why it is built this way

`baselineCandidateId` and `candidateCandidateId` make the lift paired.
Rows match on `(experimentId, scenarioId, seed)`, so each case is compared with itself, not with the mean of the other arm.
A row that finds no partner stays visible in the result instead of being dropped.

Every field of the report is defined in [`docs/insight-report.md`](../../docs/insight-report.md).

## Where the rows come from

If your data is not already in `RunRecord` shape, convert it first:

| Source | Adapter |
|---|---|
| Approvals and rejections in a table | `fromFeedbackTable` — see [`customer-feedback-loop`](../customer-feedback-loop/) |
| OpenTelemetry spans | `fromOtelSpans` — see [`customer-otel-traces`](../customer-otel-traces/) |

## Next

- Cluster the failures with a trace analyst: [`custom-trace-analyst`](../custom-trace-analyst/).
