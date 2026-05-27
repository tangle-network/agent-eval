# Statistical self-improvement for your agent — one-pager

**For:** teams running an agent on the Tangle stack (sandbox + tcloud), OR any agent emitting OTel traces, OR LangChain / LlamaIndex / Anthropic SDK / OpenAI Assistants / OpenRouter / custom — we meet you where you are.
**The pitch:** every week, get a statistically-rigorous answer to *"did my last change help?"* + a closed loop that proposes the next improvement + a held-out gate that refuses to ship regressions.

## What you get

| Deliverable | Cadence | LLM cost |
|---|---|---|
| **Decision packet** — composite distribution, per-dimension judges, cost-quality Pareto, failure clusters, named worst-N runs, ranked recommendations | Whenever you want it. Hosted runs on a 15-min schedule by default. | $0 (deterministic) |
| **Prior-period comparison** — Welch CI on composite / cost / duration / per-dimension deltas vs your prior week, with regressed + improved metrics named | Same cadence | $0 |
| **Closed-loop improvement** — `selfImprove()` proposes prompt edits, runs scenarios, gates on paired-bootstrap CI, auto-PRs the winner | On-demand, opt-in | Real $; you set a `maxUsd` ceiling |

Every claim is falsifiable: `n=`, `CI95=[a, b]`, `p=`, `Cohen's d=`. No vibes, no "score went up." Where the data doesn't support a section, the report says so explicitly instead of inventing signal.

## Why this is different

| | LangSmith / Braintrust / Phoenix | Hermes / Claude Code skills | **Tangle** |
|---|---|---|---|
| Trace ingest | proprietary | own runtime | universal (sandbox + tcloud + OTel + any custom) |
| Decision packet | scorecards (no CI) | none | **paired-bootstrap CI on every claim** |
| Closed loop | none | heuristic, no gate | **statistically-gated; refuses regressions** |
| Prior-period delta | none | none | **Welch CI on every metric** |
| Sample-size guidance | none | none | **MDE-aware** |
| Auto-PR promotion | none | none | **opt-in, on green gate only** |

## Integration paths — pick your stack

| Your stack | Intake adapter | LLM provider for closed loop |
|---|---|---|
| **Tangle (sandbox + tcloud)** | `fromTangleSandbox` | tcloud (already wired) |
| Any OTel exporter (Datadog APM, Honeycomb, NewRelic, OpenInference) | `fromOtelSpans` | any OpenAI-compat |
| LangChain (LangSmith) | LangSmith → OTel export → `fromOtelSpans` today; `fromLangChain` queued 0.55.0 | OpenAI, Anthropic, OpenRouter, tcloud |
| LlamaIndex | `OpenInferenceCallbackHandler` → OTel → ingest | any OpenAI-compat |
| Anthropic SDK direct | OTel wrapping (~20 LOC) → `fromOtelSpans`; `fromAnthropicSDK` queued | Anthropic, OpenRouter |
| OpenAI Assistants API | Custom mapper (~20 LOC) today; `fromOpenAIAssistants` queued | OpenAI, OpenRouter |
| OpenRouter (any model on any path) | Whatever you already use for tracing | OpenRouter (OpenAI-compat baseUrl) |
| vLLM / Ollama / LMStudio / self-hosted | OTel wrap | Your local OpenAI-compat endpoint |
| Multi-rater human feedback (no automated judge yet) | `fromFeedbackTable` | n/a — gives you κ + disagreement triage |
| Custom logs / DB rows | ~20-line mapper to `RunRecord` | any OpenAI-compat |

Full integration walkthroughs:
- **Tangle stack** → [`integration-tangle-stack.md`](./integration-tangle-stack.md)
- **Everything else** → [`integration-foreign-stack.md`](./integration-foreign-stack.md)

## Zero-setup demo first — 30 seconds

Before any integration, run the demo against synthetic data so you see the output shape live:

```sh
npx @tangle-network/intelligence demo
```

No install, no key, no data. Synthetic agent runs through synthetic scenarios; the CLI prints a real `InsightReport` with composite distribution + Pareto + prior-period delta + ranked recommendations. Same output shape you'll get on your real data once we integrate.

When you're ready to integrate, the same CLI scaffolds your repo:

```sh
npx @tangle-network/intelligence init           # creates eval/scenarios.json + judges.ts + pnpm scripts + .runs/
npx @tangle-network/intelligence report          # renders InsightReport from your latest traces
npx @tangle-network/intelligence improve --max-usd 25    # runs selfImprove with cost ceiling, opens auto-PR on green gate
```

Hosted equivalent: **[staging-intelligence.tangle.tools](https://staging-intelligence.tangle.tools)** — open in your browser, ingest your traces, see the dashboard render the same packet your CLI produces.

## How you integrate (Tangle stack — 4 steps)

```ts
import { fromTangleSandbox } from '@tangle-network/agent-eval/adapters/sandbox'
import { analyzeRuns, selfImprove, gepaDriver } from '@tangle-network/agent-eval/contract'

// 1. You already emit traces via @tangle-network/sandbox + tcloud.
//    Pull them into canonical RunRecord[]:
const runs = fromTangleSandbox({ sessionId, sinceMs: lastReportTime })

// 2. Get the decision packet — no LLM cost.
const report = await analyzeRuns({ runs, baselineRuns: priorWeekRuns })
//    → report.composite + .priorPeriodComparison + .recommendations

// 3. When you want to actually improve, run the closed loop.
const result = await selfImprove({
  scenarios: yourScenarios,                     // we help you build these
  agent: (surface, scenario) => runYourAgent(scenario, surface),
  judge: yourJudge,                              // any function (artifact) → JudgeScore
  baselineSurface: currentSystemPrompt,
  driver: gepaDriver({ llm: tcloud, model: 'claude-sonnet-4.6', target: 'agent prompt' }),
  budget: { generations: 3, populationSize: 4, holdoutFraction: 0.3, maxUsd: 25 },
})

// 4. Result is a verifiable diff with statistical evidence.
//    Auto-PR if result.gateDecision === 'ship-substrate'.
```

That's it. ~30 lines of integration code; the rest is your existing agent + tcloud setup.

## What we need from you

- API key for tcloud (you already have this)
- Read access to your sandbox session traces
- A list of 20-50 representative scenarios your agent should handle
- A judge function — even a simple LLM-as-judge gets you 80% of the value
- An LLM-cost budget for the closed loop (default: $25/campaign)

## What you ship back to your customers

The substrate produces a single JSON `InsightReport` your dashboard renders. Live demo embedded in the Tangle Intelligence dashboard. Example below — every section optional based on what your data supports.

```json
{
  "n": 36,
  "composite": {
    "mean": 0.823, "p50": 0.85, "p95": 0.96, "stddev": 0.11,
    "tailRuns": [
      { "runId": "scenario::checkout-bug", "score": 0.41 },
      { "runId": "scenario::refund-policy", "score": 0.48 }
    ]
  },
  "priorPeriodComparison": {
    "baselineN": 34,
    "currentN": 36,
    "windowLabel": "vs prior 7 days",
    "metrics": {
      "composite": {
        "current": 0.823, "baseline": 0.731, "delta": 0.092,
        "ci95": [0.041, 0.143], "pValue": 0.0008,
        "cohensD": 0.84, "significant": true
      }
    },
    "improvedMetrics": ["composite"],
    "regressedMetrics": []
  },
  "recommendations": [
    {
      "priority": "low",
      "kind": "ship",
      "title": "composite improved from 0.731 → 0.823 vs prior 7 days",
      "detail": "Welch CI95=[0.041, 0.143], p=0.0008, Cohen's d=0.84 (n_current=36, n_baseline=34). Statistically significant improvement worth flagging."
    },
    {
      "priority": "high",
      "kind": "investigate",
      "title": "Top failure cluster: refund-policy (12% of failures)",
      "detail": "4 runs failed. Largest cluster groups by intent — agent missed compliance flag in 3 of 4."
    }
  ]
}
```

## Pricing for the pilot

- Free for the first 30 days
- Hosted decision-packet generation: included
- LLM cost on closed-loop campaigns: pass-through to your tcloud account
- Post-pilot: per-campaign pricing tied to budget cap + per-decision-packet billed monthly

## Next step

Reply with: which agent + which week you want to start, and we'll set up the integration on a shared call. ~1 hour to first running report.

—
*Tangle Network · @tangle-network/agent-eval @0.53.0 · MIT · Self-hostable*
