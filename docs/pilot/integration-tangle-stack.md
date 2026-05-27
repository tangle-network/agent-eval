# Integration — Tangle Intelligence on the Tangle stack (sandbox + tcloud)

Step-by-step. This is what we run with you on the onboarding call.

## Zero-setup demo first (30 seconds, no install)

```sh
npx @tangle-network/intelligence demo
```

End-to-end loop against synthetic data — agent + judge + scenarios + selfImprove. Prints the `InsightReport` shape you'll get on your real data. Useful to confirm the output is what you want before any integration. Hosted equivalent: open **[staging-intelligence.tangle.tools](https://staging-intelligence.tangle.tools)**.

## Prerequisites you already have

- `@tangle-network/sandbox` running your agent in a session
- `@tangle-network/tcloud` for LLM routing (or any OpenAI-compat router)
- Your scenarios (the inputs your agent handles) listed somewhere — even as YAML or a TS array
- A judge function for scoring outputs — LLM-as-judge is fine for v1

## Install

The CLI scaffolds and runs everything; you only add the substrate package if your code calls primitives directly:

```sh
# CLI (zero-install via npx, or add to your repo as a dev-dep)
npx @tangle-network/intelligence init

# Optional — only if your code imports analyzeRuns / selfImprove directly
pnpm add @tangle-network/agent-eval
# or for Python customers:
pip install agent-eval-rpc
```

`@tangle-network/intelligence` is the customer-facing CLI + hosted product (binary `tangle-intel`). `@tangle-network/agent-eval` is the substrate it wraps — install only if you want to script directly against the primitives.

## Step 1 — Ingest your trace stream

You already emit traces via sandbox sessions. Pull them into canonical `RunRecord[]`:

```ts
import { fromTangleSandbox } from '@tangle-network/agent-eval/adapters/sandbox'

const runs = await fromTangleSandbox({
  sessionIds: ['session_abc', 'session_def'],   // your current week
  fromMs: lastReportTime,
  toMs: Date.now(),
})
// runs is RunRecord[] — canonical wire shape, ready for any downstream substrate primitive
```

If your agent emits OTel directly instead of going through `@tangle-network/sandbox`:

```ts
import { fromOtelSpans } from '@tangle-network/agent-eval'

const runs = fromOtelSpans({ spans: yourOtelSpans })
```

## Step 2 — Get the decision packet (no LLM cost)

```ts
import { analyzeRuns } from '@tangle-network/agent-eval/contract'

const report = await analyzeRuns({
  runs: thisWeek,
  baselineRuns: lastWeek,          // optional — gives you the "did my change help?" answer
  baselineLabel: 'vs prior 7 days',
})

console.log(report.composite.mean)                       // overall score
console.log(report.composite.tailRuns)                   // worst 5 runs by name
console.log(report.priorPeriodComparison?.improvedMetrics)  // ['composite'] if significantly better
console.log(report.priorPeriodComparison?.regressedMetrics) // ['cost'] if cost went up significantly
console.log(report.recommendations)                      // priority-ranked actions
```

That's the **full deterministic flow** — no LLM, $0 cost, runs in ms.

Render in your dashboard or pipe to Slack:

```ts
for (const rec of report.recommendations) {
  if (rec.priority === 'critical') {
    await slack.post(`🔴 ${rec.title}\n${rec.detail}`)
  }
}
```

## Step 3 — Wire the closed loop (real LLM cost — opt-in)

Pick the surface you want to optimize. For most customers this is the agent's system-prompt addendum:

```ts
import { selfImprove, gepaDriver } from '@tangle-network/agent-eval/contract'

const result = await selfImprove({
  scenarios: yourScenarios,         // 20-50 representative inputs
  agent: async (surface, scenario) => {
    // Your existing agent invocation, with the substrate-proposed surface
    // injected as the system-prompt addendum.
    return await runYourAgent({
      ...scenario,
      systemPromptAddendum: surface as string,
    })
  },
  judge: yourJudge,                  // function (artifact) → { composite, dimensions }
  baselineSurface: currentAddendum,  // the production string today
  driver: gepaDriver({
    llm: { apiKey: tcloudKey, baseUrl: 'https://router.tangle.tools/v1' },
    model: 'anthropic/claude-sonnet-4.6',
    target: 'agent system-prompt addendum',
  }),
  budget: {
    generations: 3,
    populationSize: 4,
    holdoutFraction: 0.3,
    maxUsd: 25,                      // hard ceiling — refuses to overspend
  },
})

console.log(`gate: ${result.gateDecision.kind}`)
console.log(`lift: ${result.lift.delta.toFixed(3)} CI=[${result.lift.ci95.join(', ')}]`)
console.log(`cost spent: $${result.totalCostUsd.toFixed(2)}`)
```

`result.gateDecision` is one of:
- `ship-substrate` — winner statistically beats baseline; safe to deploy
- `inconclusive` — CI straddles zero; either run more rollouts or expand corpus
- `ship-harness` / `merge` — only when `driftPolicy: 'benchmark-branches'` is on (advanced)

## Step 4 — Auto-PR the winner

```ts
if (result.gateDecision.kind === 'ship-substrate') {
  await openAutoPr({
    title: `eval: auto-improve ${target} (composite +${result.lift.delta.toFixed(3)})`,
    body: `${result.gateDecision.reason}\n\n${formatInsight(result.insight)}`,
    filePath: 'src/lib/.server/production-loop/prompt-addendum.ts',
    newContent: result.diff.kind === 'replace' ? result.diff.content : applyDiff(currentAddendum, result.diff),
  })
}
```

We ship `openAutoPr` from `@tangle-network/agent-eval/contract`. It wraps the GitHub PR flow with your existing token.

## The full canonical flow (script you copy and run)

```ts
// scripts/weekly-improvement.ts — run from a cron / GitHub Action

import { fromTangleSandbox } from '@tangle-network/agent-eval/adapters/sandbox'
import {
  analyzeRuns,
  gepaDriver,
  openAutoPr,
  selfImprove,
} from '@tangle-network/agent-eval/contract'
import { scenarios } from './eval/scenarios'
import { judge } from './eval/judges'
import { runYourAgent } from './src/agent'
import { PRODUCTION_ADDENDUM } from './src/lib/.server/production-loop/prompt-addendum'

const lastWeek = Date.now() - 7 * 24 * 60 * 60 * 1000
const twoWeeksAgo = lastWeek - 7 * 24 * 60 * 60 * 1000

const thisWeekRuns = await fromTangleSandbox({ fromMs: lastWeek, toMs: Date.now() })
const lastWeekRuns = await fromTangleSandbox({ fromMs: twoWeeksAgo, toMs: lastWeek })

// 1. Deterministic packet — always
const report = await analyzeRuns({
  runs: thisWeekRuns,
  baselineRuns: lastWeekRuns,
  baselineLabel: 'vs prior 7 days',
})

// 2. Closed loop — only if composite regressed OR we haven't tried in a while
const shouldRun =
  report.priorPeriodComparison?.regressedMetrics.includes('composite') ||
  daysSinceLastImprovement() > 7

if (!shouldRun) {
  console.log('No regression + recent run; skipping.')
  process.exit(0)
}

const result = await selfImprove({
  scenarios,
  agent: (surface, scenario) =>
    runYourAgent({ ...scenario, systemPromptAddendum: surface as string }),
  judge,
  baselineSurface: PRODUCTION_ADDENDUM,
  driver: gepaDriver({
    llm: { apiKey: process.env.TANGLE_KEY!, baseUrl: 'https://router.tangle.tools/v1' },
    model: 'anthropic/claude-sonnet-4.6',
    target: 'production agent system-prompt addendum',
  }),
  budget: { generations: 3, populationSize: 4, holdoutFraction: 0.3, maxUsd: 50 },
})

if (result.gateDecision.kind === 'ship-substrate') {
  await openAutoPr({
    title: `eval: auto-improve addendum (composite +${result.lift.delta.toFixed(3)})`,
    body: renderInsightAsPrBody(result.insight),
    filePath: 'src/lib/.server/production-loop/prompt-addendum.ts',
    newContent: result.diff.kind === 'replace' ? result.diff.content : '...',
  })
}
```

## What we'll do together on the onboarding call

1. **Map your existing setup** — where do your traces emit? which sandbox sessions? which scenarios exist already?
2. **Stub the judge** — even a single dimension is enough to start
3. **Run a deterministic `analyzeRuns()` against your live data** — first decision packet rendered live
4. **Wire one selfImprove cycle** — small budget, single generation, see the loop fire
5. **Schedule the cron + auto-PR target** — the loop runs autonomously thereafter

Time budget: ~90 minutes. By the end you have a working pilot.

## What our hosted tier adds on top

- Decision packet rendered weekly in the Intelligence dashboard — no code changes needed
- Slack / email digest on `regressedMetrics`
- Pareto chart, judge calibration, failure-cluster drilldown in the UI
- Multi-week trend lines
- Stripe-billed usage tracking

If you want self-hosted only, every primitive above works locally. The hosted tier is a convenience.

## FAQ

**Q: What's the smallest scenario corpus that gives useful results?**
A: ~15 scenarios for the deterministic packet (you get distributional stats + recommendations). For `selfImprove`'s held-out gate you want ≥20 since `holdoutFraction: 0.3` reserves 6 for the gate. Below that, the gate often returns `inconclusive`.

**Q: What if my judge isn't reliable yet?**
A: That's normal. Use multi-rater intake (`fromFeedbackTable`) to get inter-rater agreement (κ) first, then iterate on the judge until raters agree. Substrate has an `interRater` block in InsightReport showing exactly which scenarios raters disagree on.

**Q: What if a `selfImprove` campaign returns `inconclusive`?**
A: It refused to claim improvement because the CI straddles zero. Either expand the corpus, raise `holdoutFraction`, or run more generations. Better than shipping noise.

**Q: Can I use a non-tcloud LLM provider?**
A: Yes — `gepaDriver` accepts any `LlmClientOptions` (any OpenAI-compatible endpoint). We default to tcloud because we already have your auth.

**Q: How do I see what changed when the gate ships?**
A: `result.diff` is a structured patch. We also ship `diffRuns()` separately if you want to compare two campaign outputs.

**Q: What if my agent self-modifies (Hermes / Claude Code skills)?**
A: This is the offline/online drift case. We have the architecture spec ready (`docs/specs/profile-versioning.md`) but the implementation is gated on a forcing-function experiment. For v0.5x pilots we assume the substrate is the only writer to your agent's optimizable surface.
