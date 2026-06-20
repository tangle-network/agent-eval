# Self-improvement protocol — the world-class architecture

**Status:** Strategic design. The artifact that every roadmap entry maps to.
**Date:** 2026-05-27.

## Thesis

**Self-improvement is a protocol, not a product.** We define the wire formats, surface abstractions, driver interface, gate interface, and insight format. We ship reference implementations. Customers plug in whatever framework, model, or runtime they already use — our infrastructure handles the rigorous middle (analysis, gating, version-safe deployment).

No competitor ships this combination. LangSmith / Braintrust / Phoenix / LangFuse ship tracing. Hermes ships an agent. SkillOpt ships an academic optimizer. Anthropic's Claude Code ships skill-creation. **Nobody ships the protocol.**

## The pipeline as a single abstract flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  WHATEVER YOU ALREADY USE                                            │
│  LangChain · LlamaIndex · Anthropic SDK · OpenAI Assistants ·        │
│  Hermes · Claude Code · Codex · agent-runtime · your own stack       │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ traces (any format)
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  INGEST — universal trace adapters                                   │
│  fromOtelSpans · fromFeedbackTable · fromLangChain · fromLlamaIndex ·│
│  fromAnthropicSDK · fromOpenAISDK · fromHermesProfileLog · BYO       │
│  → canonical RunRecord[]                                             │
└─────────────────────────────────┬────────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ANALYZE — analyzeRuns({ runs, baselineRuns?, userFeedback? })       │
│  paired-bootstrap CI · Pareto · failure clusters · prior-period      │
│  delta · user-corrective-signal extraction · recommendations         │
│  ← THE STATISTICAL EDGE NOBODY ELSE SHIPS                            │
└─────────────────────────────────┬────────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  IMPROVE — selfImprove() closed loop                                 │
│  gepaDriver · evolutionaryDriver · BYO SurfaceProposer               │
│  → ProfileDiff (versioned, hashed, content-addressable)              │
└─────────────────────────────────┬────────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  GATE — defaultProductionGate (paired-CI) · BYO gate                 │
│  ship-substrate / ship-harness / merge / inconclusive                │
│  ← STATISTICALLY STRICTER THAN ANY COMPETITOR                        │
└─────────────────────────────────┬────────────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DEPLOY — back into WHATEVER YOU ALREADY USE                         │
│  agent-runtime · Hermes profile log · LangChain config · custom hook │
└──────────────────────────────────────────────────────────────────────┘
```

## The integration promise

Customers pick one of three integration shapes. All three work today (some are aspirational on adapter coverage). Every shape uses the same canonical types underneath.

### Shape A — offline analysis only

You have traces, you want a decision packet. Zero LLM cost. Zero closed loop.

```typescript
import { fromOtelSpans, analyzeRuns } from '@tangle-network/agent-eval'

const runs = fromOtelSpans({ spans: mySpans })
const report = await analyzeRuns({ runs })
// → InsightReport with composite, recommendations, Pareto, ...
```

Use case: dashboards, weekly post-mortems, "did anything regress" checks. The intelligence-kernel ships this.

### Shape B — closed loop, your runtime

You have an agent, you want to improve it. We provide drivers + gate + insight. You decide when to deploy.

```typescript
import { selfImprove, gepaDriver } from '@tangle-network/agent-eval'

const result = await selfImprove({
  scenarios,
  agent: yourAgent,           // any function (surface, scenario) → artifact
  judge: yourJudge,           // any function (artifact) → JudgeScore
  baselineSurface,
  driver: gepaDriver({ llm, model, target }),
  budget: { generations: 3, populationSize: 4, holdoutFraction: 0.3 },
})
// → SelfImproveResult { baselineHash, diff, winningHash, lift, gateDecision, insight }
```

Use case: every product agent we ship. Hermes-on-our-sandbox. Claude Code with skills. Anyone wanting "ship if statistically better, else hold."

### Shape C — hosted, cross-language

You stream traces from anywhere, get InsightReports + selfImprove orchestration. Bills usage-based.

```sh
# Stream traces
curl https://api.tangle.tools/v1/ingest/otel \
  -H "Authorization: Bearer ${TANGLE_KEY}" \
  --data-binary @traces.jsonl

# Get the decision packet
curl https://api.tangle.tools/v1/insight/${runId}

# Or run a closed-loop campaign
curl https://api.tangle.tools/v1/improve \
  -d '{"scenarios": ..., "baselineHash": "...", "budget": {...}}'
```

Use case: Python customers, Go customers, customers behind firewalls, customers who don't want to operate the substrate.

## The five non-negotiables

The protocol claim only holds if all five of these survive integration. Customers shouldn't have to compromise on any.

1. **Universal ingest.** Any trace format → canonical RunRecord. Coverage: OTel ✓, multi-rater feedback ✓, LangChain ⏳, LlamaIndex ⏳, Anthropic SDK ⏳, OpenAI Assistants ⏳, Hermes profile log ⏳.
2. **Statistical rigor.** Every claim falsifiable. Paired bootstrap CI on lift, Cohen's d on effect size, MDE-aware sample-size recommendations, p-values. **SkillOpt's gate is literal `cand > current`. Hermes has no gate. Ours has all of the above.** This is the moat.
3. **Plug-in everything.** Driver, judge, gate, intake adapter, storage all swappable. Customer brings their LLM, their judge, their scenarios. We bring the rigor.
4. **Version-safe deployment.** AgentProfile is content-addressable. Two writers (harness + substrate) can both mutate without lost-update. Gate verdicts are scoped to baseline hash, not absolute. Tracked as #98.
5. **Cross-language wire format.** Python client at parity with TypeScript. Hosted ingest spec versioned. Customers in any language consume the same shape.

## Where we are honest about gaps

| Component | Status | Customer impact when missing |
|---|---|---|
| `fromOtelSpans` ingest adapter | ✓ shipped 0.50.0 | — |
| `fromFeedbackTable` multi-rater intake | ✓ shipped 0.50.0 | — |
| `analyzeRuns` decision packet | ✓ shipped 0.50.0 / 0.50.2 actionability | — |
| `selfImprove` closed loop | ✓ shipped 0.50.0 | — |
| Paired-bootstrap gate | ✓ shipped early; still our edge | — |
| `gepaDriver` reflection (not full Pareto — task #101) | ⚠ partial | OK; customers don't need Pareto until plateau hit |
| **Prior-period comparison** in `analyzeRuns` | ✗ MISSING | "Did my last change help?" — the #1 customer question — has no rigorous answer today |
| **User-corrective-feedback signal extraction** | ✗ MISSING | Hermes' first-class skill signal. We have the trace data. We don't mine it. |
| **`init` CLI** scaffolding canonical eval/ layout | ✗ MISSING | Every new consumer wires it by hand; the skill describes 80 lines they have to copy |
| **Framework-specific intake adapters** (LangChain, LlamaIndex, Anthropic SDK, OpenAI Assistants) | ✗ MISSING | Customers using these frameworks can't ingest without writing custom adapter code |
| **Profile versioning** (task #98) | ✗ MISSING | Offline/online drift; gate verdicts can be stale by the time they're applied |
| **Composite driver** (optimize all surfaces against one gate) | ✗ MISSING | Customers can optimize prompts OR skills, not both jointly |
| **Empirical proof drivers work** | ✗ MISSING | We've never published "we ran gepaDriver on real customer data, here's the lift CI" |
| Hosted-tier production launch | ⚠ in scaffolding (intelligence-kernel) | Customers must self-host today |

## The roadmap — what closes each gap

Mapping every roadmap entry back to a concrete protocol gap.

### 0.53.0 (this session-or-next) — answer "did my last change help?"

- **`analyzeRuns({ runs, baselineRuns? })`** — when `baselineRuns` is provided, the report includes a `priorPeriodComparison?` block: per-metric delta with paired-bootstrap CI, MDE-aware significance judgment, "regressed metrics" surfaced in `recommendations`.
- Built on top of existing `diffRuns()` primitive (already shipped 0.48.0).
- 1 PR. Pure additive surface.
- **Customer impact**: this is the conversion question for every prospect.

### 0.54.0 — extract Hermes' missing signal

- **`extractUserCorrections(runs)`** — new substrate primitive. Mines user messages in traces for corrective markers (regex pass + LLM classifier for nuance). Returns `UserCorrectionEvent[]` keyed by runId.
- `analyzeRuns({ runs, userFeedback? })` includes a "common corrections" cluster in `recommendations`.
- Bridge to Hermes-style signal without adopting Hermes' runtime.
- **Customer impact**: distinctive — no competitor mines this signal.

### 0.55.0 — framework-specific intake adapters

- **`fromLangChain(traces)`**, **`fromLlamaIndex(traces)`**, **`fromAnthropicSDK(traces)`**, **`fromOpenAIAssistants(traces)`**.
- Each maps the framework's native trace shape to RunRecord.
- Top 4 frameworks = 80% of agent-builder market coverage.
- **Customer impact**: removes "we don't support your framework" friction.

### 0.56.0 — `init` CLI + worked examples

- `pnpm dlx @tangle-network/agent-eval init` scaffolds the canonical `eval/scenarios.json` + 3 pnpm scripts + judges template + `.runs/` directory.
- Adds 5+ end-to-end runnable examples covering Shapes A/B/C across the 4 framework adapters.
- **Customer impact**: time-to-first-eval drops from 4 hours to 5 minutes.

### 1.0.0 — profile versioning (#98) + composite driver

- Content-addressable `AgentProfileVersion` + `ProfileDiff` + 3-way merge + 4-way `DriftGateDecision`.
- `compositeDriver` — optimize all surfaces of one AgentProfile against one gate.
- Hermes-on-sandbox forcing function validates the work before commit.
- **Customer impact**: production-safe; the moat is locked.

### 1.1.0 — empirical-proof publication

- Pick one named customer or one synthetic-realistic corpus (legal-agent canonical).
- Run gepaDriver end-to-end with real LLM cost.
- Publish: "n=, lift=, CI=, p=, $cost=, vs no-driver baseline."
- One blog post, one demo video, one runnable repro.
- **Customer impact**: every other claim becomes credible because this one is verified.

## Why this design is 100x

Not a 10% improvement over LangSmith. A category change.

| Capability | LangSmith / Braintrust / Phoenix | Hermes / Claude Code | Tangle (target) |
|---|---|---|---|
| Trace ingest | ✓ proprietary | ✓ own runtime | ✓ universal |
| Decision packet | ⚠ scorecards (no CI) | ✗ | ✓ paired-bootstrap |
| Closed loop | ✗ | ✓ heuristic | ✓ statistically rigorous |
| Plug-in drivers | ✗ | ✗ | ✓ |
| Profile versioning | ✗ | ✗ | ✓ (1.0.0) |
| Composite multi-surface | ✗ | ✗ | ✓ (1.0.0) |
| Cross-language | ✗ | ✗ | ✓ (Python at parity) |
| Empirical-proof publication | ✗ | ✗ | ✓ (1.1.0) |

Eight rows. Nobody else has eight. We can be the only one. The work is named, scoped, and queued.

## What's NOT on the roadmap (and why)

- **Building our own agent runtime.** Hermes / agent-runtime / Claude Code cover that. We are infrastructure, not a runtime.
- **Single-vendor LLM.** Substrate stays model-agnostic.
- **UI-first product.** API-first. UIs are downstream.
- **LangChain replacement.** Wrong layer.
- **"Self-improvement" without a held-out gate.** Hermes and SkillOpt both ship this; we explicitly refuse — every selfImprove() requires a holdout.

## Decision log — what we committed to in 0.52.0 → 1.0.0

1. **`skillOptDriver` removed; behavior in `gepaDriver({ constraints })`** — 0.52.0 ✓ shipped
2. **Honest spec docs** — 0.52.0 ✓ shipped
3. **Profile-versioning spec with symmetric-fork framing** — 0.52.0 ✓ shipped
4. **No V2 names anywhere** — enforced
5. **Forcing-function gate on profile-versioning work** — Hermes-on-sandbox experiment required before phases 1-5 commit
6. **Single-PR-per-repo discipline** — enforced 0.52.0 onwards
7. **Prior-period comparison as 0.53.0** — committed; the customer-conversion primitive
8. **User-feedback extraction as 0.54.0** — committed; the Hermes-signal bridge
9. **Framework intake adapters as 0.55.0** — committed; 80% market coverage
10. **Empirical-proof publication as 1.1.0** — committed; the credibility lock
