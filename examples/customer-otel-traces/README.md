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
3. Prints score and cost distributions, failures grouped by span name, cost-quality tradeoffs, and recommended next actions.

This path analyzes completed runs and does not invoke an agent.

## What you'll see

```
Production trace report

Runs analyzed:     40
Composite mean:    0.721 (p50: 0.717, p95: 0.925, stddev: 0.210)
Cost mean:         $0.103 (p95: $0.131)

Failures
6 runs with status=ERROR or failureMode set:
  tool.search  (3x)
  agent.turn   (3x)

Cost and quality
1 candidate plotted; 1 on the frontier
  otel-default: cost=$0.103 quality=0.721  (frontier)

Recommendations
[medium] expand-corpus: Mean composite 0.721 has room
  Composite distribution sits below 0.80; investigate the failures and the
  lower tail of the histogram before claiming the agent is healthy.

End
```

## What to do with the output

1. Inspect the span names that repeatedly end with `status.code: ERROR`.
2. When the data contains several models or prompts, compare their cost and quality points.
3. Pass an `AnalystRegistry` as `{ analyst }` when you want model-based failure clustering.
4. Pass downstream results as `outcomeSignal` to test whether eval scores predict the product metric you care about.

## Files

- `index.ts`: the runnable script
