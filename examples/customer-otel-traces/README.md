# Customer OTel traces — production logs → decision packet

The journey for teams running agents in prod with observability but **no eval discipline yet**. You have OTel spans piped to your collector. You want to know: which agent steps are unreliable, what's breaking and where, what's the cost-quality profile, where to fix next.

```sh
pnpm tsx examples/customer-otel-traces/index.ts
```

## What this example does

Synthesises 40 production runs as OTel `TraceSpanEvent[]`. Some succeed; some fail. Each carries the usual GenAI attributes — `tangle.model`, `tangle.cost.usd`, `gen_ai.usage.{input,output}_tokens`, `tangle.score`. Failed runs have `status.code: 'ERROR'`. Then:

1. Pipes the spans through `fromOtelSpans()` to get `RunRecord[]`.
2. Calls `analyzeRuns({ runs })`.
3. Prints the decision packet — composite + cost distribution, Pareto, failure surfacing, recommendations.

No agent invocation, no scenarios, no closed loop. **Just analysis of what already happened.** This is the day-1 product for teams without eval discipline.

## What you'll see

```
═══ Production OTel corpus — decision packet ═══

Runs analyzed:     40
Composite mean:    0.638 (p50: 0.715, p95: 0.910, stddev: 0.252)
Cost mean:         $0.084 (p95: $0.142)

── Failures ──
6 runs with status=ERROR or failureMode set:
  agent.turn  (5x)
  tool.search (1x)

── Cost-quality Pareto ──
2 candidates plotted; 1 on the frontier
  otel-default: cost=$0.084 quality=0.638  (frontier)

── Recommendations ──
[medium] expand-corpus — Mean composite 0.638 has room
  Composite distribution sits below 0.80; investigate the 6 failures and
  the lower-tail tail of the histogram before claiming the agent is healthy.

═══ end ═══
```

## What to do with the output

1. **Read the failure surface first.** Which span names appear repeatedly under `status.code: ERROR`? That's where to dig.
2. **Inspect the Pareto.** If multiple candidates appear (different models / prompts in prod), the frontier tells you which is cost-optimal at each quality level.
3. **Wire an `AnalystRegistry`.** Pass `{ analyst }` to `analyzeRuns()` to cluster failures by root cause via LLM-driven analysis. The report's `failureClusters` section fills in.
4. **Add `outcomeSignal`.** When you have downstream engagement / approval / pass-rate data, pass it as `outcomeSignal` and the report surfaces a Pearson + Spearman correlation between the judge composite and the real-world outcome, plus a fitted linear reward model. That's how you find out if your judge tastes match the customer's.

## Files

- `index.ts` — the runnable script
