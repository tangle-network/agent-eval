# Analyze Production OpenTelemetry Traces

Use this example when your agent already emits OpenTelemetry spans.
It converts completed traces into failure, score, and cost summaries without running the agent again.

```sh
pnpm tsx examples/customer-otel-traces/index.ts
```

## What this example does

Synthesises 40 production runs as OTel `TraceSpanEvent[]`. Some succeed; some fail. Each carries the usual GenAI attributes: `tangle.model`, `tangle.cost.usd`, `gen_ai.usage.{input,output}_tokens`, `tangle.score`. Failed runs have `status.code: 'ERROR'`. Then:

1. Pipes the spans through `fromOtelSpans()` to get `RunRecord[]`.
2. Calls `analyzeRuns({ runs })`.
3. Prints score and cost distributions, the error-span count, cost-quality tradeoffs, and recommended next actions.

This path analyzes completed runs and does not invoke an agent.

## What you'll see

```
Production trace report

Runs analyzed:     40
Composite mean:    0.721 (p50: 0.717, p95: 0.925, stddev: 0.210)
Cost mean:         $0.103 (p95: $0.131)

Runs with error spans: 6

Cost and quality
1 candidate(s) plotted; 1 on the frontier
  otel-default: cost=$0.103 quality=0.721  (frontier)

Recommendations
[medium] investigate: 'unknown' is the dominant failure class — 6 runs (15% of the corpus)
  The mean composite can look acceptable while one failure class dominates the
  lower tail. 6 of 40 runs failed with 'unknown'. Fix this cause first.

End
```

## What to do with the output

1. Inspect the runs whose spans end with `status.code: ERROR`; the intake counts them per run in `outcome.raw.error_span_count`.
2. When the data contains several models or prompts, compare their cost and quality points.
3. Pass an `AnalystRegistry` as `{ analyst }` when you want model-based failure clustering.
4. Pass downstream results as `outcomeSignal` to test whether eval scores predict the product metric you care about.

## Files

- `index.ts`: the runnable script
