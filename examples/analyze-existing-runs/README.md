# Analyze captured runs

This example constructs twelve synthetic `RunRecord` rows for two candidates answering six shared cases.
`analyzeRuns()` returns score distributions, cost, paired lift, and recommendations without rerunning the agent.
No API key or model call is required.

## Run

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx examples/analyze-existing-runs/index.ts
```

The output is:

```text
runs analyzed:   12
mean score:      0.5975
paired lift:     0.1283333333333333
lift interval:   [ 0.10666666666666663, 0.15333333333333335 ]
paired n:        6
recommendations: 2
```

The positive interval is descriptive at six pairs.
The report requests more evidence because this bootstrap comparison requires at least 20 paired observations for decision eligibility.
The example supplies no judge details, rater scores, analyst, canaries, or downstream outcomes.
Their optional insights are therefore unavailable.

## Use your own evidence

Replace the synthetic rows in [index.ts](./index.ts) with captured records.
For an installed package, import `analyzeRuns` from `@tangle-network/agent-eval/contract`.
Import `RunRecord` from the package root.

Pass both `baselineCandidateId` and `candidateCandidateId` to declare the direction of the comparison.
Rows pair on `(experimentId, scenarioId, seed)`.
Unmatched scored rows remain visible in `lift.unpairedBaseline` and `lift.unpairedCandidate` and are excluded from the paired statistics.
Missing or duplicate pairing identities fail validation.

Declare `independentUnitByScenarioId` when repeated cases share a task, document, user, or other sampling unit.
Repetitions do not create more independent tasks.
Inspect the [InsightReport guide](../../docs/insight-report.md) for denominators, missing data, and diagnostic limits.

| Existing data | Starting point |
|---|---|
| Approvals and rejections | [`fromFeedbackTable`](../customer-feedback-loop/) |
| OpenTelemetry spans | [`fromOtelSpans`](../customer-otel-traces/) |
| Captured execution without quality labels | `summarizeExecution({ runs })` from `/contract` |
| Failures requiring an analyst | [Custom trace analyst](../custom-trace-analyst/) |

Use [evaluate a change](../evaluate-a-change/) when you need new agent executions.
