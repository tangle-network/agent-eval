# Dogfood pass — `analyzeRuns()` on real consumer data
Date: 2026-05-27
Substrate: agent-eval 0.50.1 (pre-fix) → 0.50.2 (post-fix)

## Goal

Close the gap flagged by two consecutive reflections (2026-05-24, 2026-05-27): the substrate has shipped a decision-packet shape (`InsightReport`) but no real customer has read one. Until that happens, the customer-mapping is a hypothesis, not a tested artifact.

## Method

1. Enumerate `records.jsonl` files across the six consumer repos (gtm-agent, creative-agent, legal-agent, tax-agent, agent-builder, physim).
2. Rank by record count to find the richest single datasets and the best multi-experiment combination.
3. Run `analyzeRuns({ runs })` directly on the real `RunRecord[]` from each.
4. Read the `InsightReport` like a customer would — would I act on it?

## Datasets used

| Source | n | Shape | Why |
|---|---|---|---|
| legal-agent canonical 2026-05-20 | 36 | Single experiment, single candidate, 15-dim rubric in `outcome.raw`, no `judgeScores`, holdout split | Real broken agent — composite mean = 0.002. The worst case. |
| agent-builder concat (16 campaigns) | 32 | 13 distinct experimentIds, single candidate ("canonical"), binary `holdoutScore`, some `judgeScores` present | Multi-experiment, healthy mean — tests the report on a "looks fine" corpus. |
| gtm-agent golden run | 32 | Custom shape (NOT RunRecord) — `personaId, backend, score, pass, grader, judges, notes` | Exposed an inventory gap: substrate has no adapter for golden-record JSONL. |

## Findings (substrate)

### F1 — Recommendations empty on broken corpora (`critical`)

`buildRecommendations` only fired on `lift`, `contamination`, `interRater`, `failureClusters`, `outcomeCorrelation`. **It did not fire on composite distribution itself.** Legal-agent (composite=0.002, release.status='fail') returned `recommendations: []`. The customer's first-touch artifact was empty when it should have been screaming.

Fix in 0.50.2: composite-distribution branch in `buildRecommendations`. Critical below 0.3 with worst-5 runIds; high below 0.5 with worst-3.

### F2 — No worst-run enumeration (`critical`)

Report told the customer "investigate the failures" anonymously. Without runIds, the recommendation is unactionable — you can't drill into "the lower tail" without names.

Fix in 0.50.2: `ScalarDistribution.tailRuns?: Array<{runId, score}>` populated for the composite distribution.

### F3 — Silent single-point Pareto (`high`)

When only one candidate is present (typical for prod observability — every span is from the same model), `paretoChart` returned a one-point figure with `onFrontier: true`. The customer reading the report sees "1 candidate plotted; 1 on the frontier" and might think this is signal. It isn't.

Fix in 0.50.2: `costQuality.degraded?: {cost?, pareto?}` with explicit reason strings.

### F4 — Cost mean of zero silently treated as signal (`medium`)

When `costUsd` is absent or always zero (legal-agent + agent-builder both have this), the cost distribution renders as `mean=0, p95=0, histogram=[{lo:0, hi:0, count:36}]`. The customer might read this as "the agent is free." It isn't — it's "we have no cost data."

Fix in 0.50.2: same `degraded.cost` field.

### F5 — Missing-judges produces empty `perDimension` + `judges` with no explanation (`medium`)

Legal-agent stores rubric in `outcome.raw` (15 named dimensions). `analyzeRuns` reads dimensions ONLY from `outcome.judgeScores.perDimMean`, so `perDimension: {}` for legal. The customer sees a report with the per-dimension section empty and doesn't know why.

Fix in 0.50.2: when `judges` is empty across the corpus, emit a `medium/expand-corpus` recommendation pointing at `outcome.judgeScores.perJudge` enrichment.

(A deeper fix — automatically inferring per-dimension from `outcome.raw` numeric scalars — is deferred. The current fix at least tells the customer *why* the section is empty.)

### F6 — Gtm "golden" records aren't RunRecord (`low`)

Gtm-agent stores `{personaId, backend, score, pass, grader, judges, notes}` not `RunRecord`. Substrate has no adapter for this shape; substituting it into `analyzeRuns({ runs })` would require a consumer-side mapping.

Deferred — substrate is correct to refuse a non-RunRecord shape. Open question: does gtm migrate to RunRecord, or does substrate ship a `fromGoldenTable` adapter? Defer until gtm bumps to 0.50.2.

## Findings (consumer ecosystem)

### C1 — Six consumers still on 0.49

None of the consumer repos have bumped to 0.50 (decision packet) or 0.50.2 (actionability fixes). They still emit bespoke summaries. The win of `analyzeRuns()` only lands when consumers actually call it.

Next action: Wave 1 = bump gtm-agent + creative-agent to 0.50.2, replace bespoke summary code with `analyzeRuns()`.

### C2 — Creative-agent has 8,586 substrate-native spans across 82 unique runs

Real data, ready to aggregate. But there's no `fromRunSpans()` adapter to turn substrate spans → RunRecord[]. Consumer would need to write a custom aggregator, or substrate could ship one.

Deferred until a consumer needs it — speculative API design.

## Post-fix re-dogfood

Re-ran `analyzeRuns()` on legal-agent canonical (n=36) with the 0.50.2 substrate.

Before:
```json
{ "recommendations": [], "composite": { "mean": 0.002, ... } }
```

After:
```json
{
  "composite": {
    "mean": 0.002,
    "tailRuns": [
      {"runId": "legal-canonical-...::restaurant-formation", "score": 0},
      {"runId": "legal-canonical-...::crypto-exchange-licensing", "score": 0},
      {"runId": "legal-canonical-...::nuclear-startup-nrc", "score": 0},
      {"runId": "legal-canonical-...::cannabis-dispensary", "score": 0},
      {"runId": "legal-canonical-...::existing-business-audit", "score": 0}
    ]
  },
  "costQuality": {
    "degraded": {
      "cost": "no costUsd values recorded — cost axis carries no signal",
      "pareto": "single candidate — Pareto is a single point, not a frontier"
    }
  },
  "recommendations": [
    {
      "priority": "critical",
      "kind": "investigate",
      "title": "Composite mean 0.002 is below the 0.3 floor — the agent is broken on this corpus",
      "detail": "Worst 5 runs to inspect first: restaurant-formation=0.000, crypto-exchange-licensing=0.000, ..."
    },
    {
      "priority": "medium",
      "kind": "expand-corpus",
      "title": "No judge scores recorded — per-dimension + calibration insights unavailable"
    }
  ]
}
```

**Actionability test:** would I act on this? Yes — the customer reading this immediately knows (a) the agent is broken, (b) which five scenarios to open first, (c) they should attach judges to unlock per-dimension breakdown, and (d) the cost/Pareto sections are degraded, don't read signal into them.

## Next actions

1. **Ship 0.50.2** — DONE (this PR).
2. **Bump gtm-agent and creative-agent to 0.50.2** — collapse bespoke summary code into `analyzeRuns()`. The win is N bespoke summaries → 1 substrate call.
3. **Ship a `fromRunSpans()` adapter** when a consumer actually needs it (creative has 8,586 spans across 82 runs that could be aggregated). Defer until requested.
4. **Open question to revisit when a real Customer B OTel batch arrives:** does the report need a `failureCluster` section even without `AnalystRegistry`? A naive heuristic (group by `failureMode` or by span.name when `status='ERROR'`) might be enough for day-1 customers — defer pending a real batch.
