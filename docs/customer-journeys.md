# Customer journeys

Three end-to-end journeys covering the surface of `@tangle-network/agent-eval`. Each one is a runnable example under `examples/` — clone the repo and `pnpm tsx examples/<journey>/index.ts` to see the actual output.

The three journeys map to three customer-maturity stages:

1. **Logs but no eval discipline** → [Production traces journey](#1-production-traces-journey-customer-otel-traces)
2. **Ratings but no closed loop** → [Feedback corpus journey](#2-feedback-corpus-journey-customer-feedback-loop)
3. **Scenarios, judge, agent — full closed loop** → [Closed-loop journey](#3-closed-loop-journey-selfimprove-quickstart)

Each section: what the customer has, what they want, the code, what the report looks like.

---

## 1. Production traces journey — `customer-otel-traces`

**The customer:** an agentic GTM-as-a-service company. Multiple agent steps in prod (social media posting, image generation, translation). OTel observability piped to their collector. Doesn't run formal evals. CTO hand-rolled their tracing.

**The frustration:** "Which step is unreliable? What's our cost-quality profile? Where do we fix next?" They have the data; they don't have the answer.

**What they need from agent-eval:** day-1 analysis of their existing logs. No scenarios, no judges, no closed loop. Just turn the trace stream into a decision packet.

### The code

```ts
import { analyzeRuns, fromOtelSpans } from '@tangle-network/agent-eval/contract'

const runs = fromOtelSpans({ spans: yourOtelStream })
const report = await analyzeRuns({ runs })

// report.failureClusters → root causes
// report.costQuality.pareto → cost-vs-quality scatter
// report.composite → distribution
// report.recommendations → top-3 actions
```

### What the report shows

```
Runs analyzed:     40
Composite mean:    0.721 (p50: 0.717, p95: 0.925, stddev: 0.210)
Cost mean:         $0.103 (p95: $0.131)

── Failures ──
6 runs with status=ERROR or failureMode set:
  tool.search  (3x)
  agent.turn   (3x)

── Cost-quality Pareto ──
1 candidate(s) plotted; 1 on the frontier
  otel-default: cost=$0.103 quality=0.721  (frontier)

── Recommendations ──
[medium] expand-corpus — Mean composite 0.721 has room
```

### Next steps for this customer

1. Wire an `AnalystRegistry` to cluster the 6 failures by root cause via LLM analysis.
2. Add `outcomeSignal` once they have downstream conversion / engagement / post-engagement data, and the report fits a reward model showing whether their score predicts the customer outcome.
3. Once they identify a step worth optimizing (translation, say), graduate to journey #3 — wrap that step as an `agent(surface, scenario)` and call `defineAgentEval()`.

**Runnable:** [`examples/customer-otel-traces/`](../examples/customer-otel-traces/)

---

## 2. Feedback corpus journey — `customer-feedback-loop`

**The customer:** a research-validation team. A GitHub Action fires `claude -p` against the next claim, writes the research output to Obsidian. Three reviewers (Alice, Bob, Carol) tag results `#approved` or `#rejected`. Outputs feed a knowledge base. Knowledge feeds content. Content feeds engagement. The founder wants more engagement faster.

**The frustration:** "We disagree on what's good. We don't know if our 'good' actually drives engagement. Reviewing every claim is slow."

**What they need from agent-eval:** turn the approve/reject corpus into actionable signal:
- Where do reviewers disagree? (triage list)
- Can we synthesize each reviewer's taste into an LLM judge? (auto-grade)
- Does the taste actually predict downstream engagement? (close the loop)

### The code

```ts
import { analyzeRuns, fromFeedbackTable } from '@tangle-network/agent-eval/contract'

// 1. Parse Obsidian #approved / #rejected tags into a flat table:
const ratings = parseObsidianVault('./research-vault')
// [{ runId: 'claim-1', rater: 'alice', rating: true }, ...]

// 2. Pipe through the adapter:
const { runs, raterScores } = fromFeedbackTable({ ratings })

// 3. Analyze:
const report = await analyzeRuns({
  runs,
  raterScores,
  // Optional: close the loop with engagement data once you have it.
  outcomeSignal: { metric: 'engagement_rate', valueByRunId: enrichedFromProd },
})

// report.interRater.disagreementCases → top 20 claims worth a meeting
// report.outcomeCorrelation → does team taste predict engagement?
// report.recommendations → action list
```

### What the report shows

```
Runs analyzed:     30
Composite mean:    0.756 (approve rate ~76%)

── Inter-rater agreement ──
Raters:               3 (alice, bob, carol)
Jointly rated runs:   30
Pairwise pearson κ:
  alice::bob     0.53
  alice::carol   0.55
  bob::carol     0.21
Mean κ:               0.43

── Top 5 disagreement cases ──
  claim-1   range=1.00  ratings: alice=0, bob=0, carol=1
  claim-7   range=1.00  ratings: alice=0, bob=1, carol=0
  ...

── Recommendations ──
[high] recalibrate — Inter-rater agreement κ=0.43 is below 0.5
  Raters disagree on what 'good' looks like. Refine the rubric or triage the disagreement cases.
```

### Next steps for this customer

1. **Triage meeting on the disagreement cases.** Mean κ=0.43 means the rubric is ambiguous; clarify it on the cases that split.
2. **Calibrate one LLM judge per reviewer.** Each reviewer's history is the gold signal — substrate primitive `calibrateJudge` against `raterScores` filtered to that reviewer.
3. **Add engagement as `outcomeSignal`** once the content downstream is instrumented. The `outcomeCorrelation` section tells the team whether their taste predicts the founder's token-max goal — and if not, the linear reward model says how to retarget.
4. **Graduate to journey #3** — wrap the research-generation Claude-P call as an `agent(surface, scenario)`, use the calibrated judges, run `evalKit.improve()` nightly. Open a PR against the GitHub Action when the holdout approval rate beats baseline.

**Runnable:** [`examples/customer-feedback-loop/`](../examples/customer-feedback-loop/)

---

## 3. Closed-loop journey — `selfimprove-quickstart`

**The customer:** a team with a scenario corpus, a judge, and an agent. Wants to improve the prompt under statistical confidence — propose better candidates, gate on holdout lift, ship the winner.

**The frustration:** "We can run an A/B by hand but we don't know if the improvement is real. We don't have time to run paired bootstrap by hand. We want a function that decides."

**What they need from agent-eval:** one reusable eval definition — propose, score, gate, ship — with the full rigor packet on the way out.

### The code

```ts
import { defineAgentEval } from '@tangle-network/agent-eval/contract'

const evalKit = defineAgentEval({
  scenarios,
  agent: async (surface, scenario) =>
    await myAgent.run({ systemPrompt: (surface as { systemPrompt: string }).systemPrompt, scenario }),
  judge: {
    name: 'rubric',
    dimensions: [{ key: 'clarity', weight: 1 }, { key: 'concision', weight: 1 }],
    score: async ({ artifact }) => myJudgeFn(artifact),
  },
  baselineSurface: { kind: 'prompt', systemPrompt: 'You write marketing copy...' },
  budget: { generations: 3, populationSize: 2 },
})

const result = await evalKit.improve()

result.gateDecision   // 'ship' | 'hold' | ...
result.insight        // full decision packet
```

### What the report shows

```
═══ selfImprove() decision packet ═══

Gate decision:        ship
Raw lift:             +0.361

── Statistical lift (paired bootstrap) ──
delta:    +0.359
CI95:     [0.311, 0.408]
pValue:   0.0013
Cohen's d: 8.58
MDE @ 80% power: 1.401
required n at observed effect: 122

── Recommendations ──
[critical] ship — Ship — lift 0.359 (95% CI 0.311..0.408)
```

### Next steps for this customer

1. **Ship the winner.** Either accept `result.winner.surface` programmatically and roll it out, or pass `autoOnPromote: 'pr'` + a GitHub repo to have selfImprove open a PR for you.
2. **Wire `hostedTenant`** to ship the decision packet to a dashboard (the hosted Intelligence orchestrator, or your own implementation of the wire spec).
3. **Add `canaryScenarios`** to guard against the holdout leaking into the candidate prompt.
4. **Add `outcomeSignal`** in `analyzeRuns()` for any post-deploy reruns to verify the predicted lift actually shows up in real outcomes.

**Runnable:** [`examples/selfimprove-quickstart/`](../examples/selfimprove-quickstart/)

---

## How the three journeys compose

Journey #1 + #2 + #3 are **maturity stages**, not exclusive products. A team typically:

1. Starts with **#1** (analyze production logs) to find what's broken.
2. Adds **#2** (feedback corpus) once they have a sense of where to improve, to calibrate what "good" means.
3. Graduates to **#3** (closed loop) once they have scenarios + judges, to automate the improvement.

Same substrate, same `InsightReport` shape, no rip-and-replace between stages. The data you collect in #1 informs the scenarios you derive in #2 which feed the loop in #3.
