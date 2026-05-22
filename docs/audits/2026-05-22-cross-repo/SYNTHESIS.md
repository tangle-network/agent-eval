# Cross-repo audit synthesis — agent-eval @ 0.31.1 across 5 consumers

Source reports in `/tmp/audit/`: substrate catalog + per-consumer integrations for tax, legal, creative, gtm, agent-builder.

## Headline answer

1. **Substrate is rich and well-curated.** 17 entry points; intentional surface gating (six subpaths had root `export *` removed in 0.24); stability tags emitted into `.d.ts`; a consumer-contract test pins the symbols five product agents import (`tests/consumer-contract.test.ts` since 0.27.1). Post-0.27 added: `JudgeScoresRecord` + backend-integrity guard (0.31); `AnalystRegistry` + streaming events + 4 trace-analyst kinds (0.28-0.29); `corpusInterRaterAgreement` (0.27.2); `withJudgeRetry` / `aggregateTrialsByMode` / `discoverPersonas` (0.27). Almost everything you wanted is there.

2. **Consumers use ~10-25% of it.** All five consumers import only from root + `/traces` + `/rl`. Twelve subpaths are completely untouched by any of them: `/control`, `/optimization`, `/reporting`, `/telemetry`, `/wire`, `/benchmarks`, `/pipelines`, `/meta-eval`, `/prm`, `/governance`, `/knowledge`, and `/builder-eval` (agent-builder is the only consumer that uses `/builder-eval`). Every vertical hand-rolls the same five patterns (cross-family judge enforcement, fetch-capture, composite math, OTLP projection, JudgeScoresRecord side-channel cast). Documentation drift everywhere — three consumers still reference `^0.25.0` in docstrings while pinning `^0.31.1`.

3. **agent-builder embodies the substrate end-to-end for ITS OWN evals but does NOT propagate the surface to scaffolded agents.** Scaffold templates emit ~25% of the integration agent-builder uses internally. Three pieces ship in source but have zero production callers: `evaluateAutoPromote` (C4), the `/api/admin/proposals` PATCH skips the differential gate, `pareto-judges` is orphaned. The meta-system is one or two scaffold-template PRs away from "every newly-built agent inherits the full stack by default."

## Adoption matrix — primitive × consumer

`✅` wired and exercised · `⚠` partial/drift · `❌` gap · `–` not applicable

| Primitive (substrate 0.31.1) | tax | legal | creative | gtm | agent-builder |
|---|:-:|:-:|:-:|:-:|:-:|
| **`validateRunRecord` boundary** | ✅ | ✅ | ✅ | ⚠ (no cost/tokens) | ✅ |
| **`JudgeScoresRecord` typed field on `RunOutcome`** (0.31.0) | ❌ string cast | ❌ string cast | ❌ string cast | ❌ string cast | ✅ |
| **`runEvalCampaign` / `CampaignRunner`** | ❌ hand-rolled | ❌ runDurable | ❌ hand-rolled | ❌ hand-rolled | ✅ |
| **`assertLlmRoute` + `assertRunCaptured`** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`assertRealBackend` / `BackendIntegrityReport`** (0.31.0) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **`withJudgeRetry` + `aggregateTrialsByMode`** (0.27.0) | ✅ via local | ✅ | ✅ | ✅ via local | ⚠ partial |
| **`calibrateJudge` (κ + Pearson + MAE)** | ✅ | ✅ | ✅ | ✅ | ⚠ scaffold UI only |
| **`corpusInterRaterAgreement` / `…FromJudgeScores`** (0.27.2) | ❌ never run | ❌ | ❌ | ❌ | ✅ via `interRaterReliability` |
| **`AnalystRegistry` + `createTraceAnalystKind`** (0.28-0.29) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`FindingsStore` JSONL** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **D1-backed findings mirror** | ❌ | ❌ | ❌ (D1 in app) | ❌ (D1 in app) | ✅ unique |
| **`OtlpFileTraceStore` + `analyzeTraces`** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`pairedEvalueSequence` (anytime-valid e-value)** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **`pairedWilcoxon` + `pairedBootstrap` + Cliff's δ** | ❌ | ❌ | ❌ | ❌ | ✅ unique |
| **`HeldOutGate` / publish-time hard gate** | ⚠ via prod-loop config | ⚠ dead config | ✅ in prod-loop | ✅ in prod-loop | ✅ at publish |
| **`evaluateInterimReleaseConfidence`** | ✅ | ❌ | ✅ | ❌ | ✅ |
| **`/evolve` unfreeze gate (Pearson + adversarial + days)** | ❌ | ❌ | – (no evolve) | ❌ | ✅ unique |
| **Cost-aware Pareto judge selection** | ❌ | ❌ | ❌ | ❌ | ⚠ orphaned |
| **Tool-call fidelity rubric (deterministic matchers)** | ❌ | ❌ | ❌ | ❌ | ✅ unique |
| **Multi-turn scenarios** (substrate type does NOT exist) | ⚠ ad-hoc | ⚠ ad-hoc | ✅ native turns | ✅ `multiTurnFlow` | ✅ local `MultiTurnScenarioPayload` |
| **Streaming-quality dim (TTFT/stall/P95)** | ❌ | ❌ | ❌ | ❌ | ✅ unique |
| **Adversarial / red-team primitives (`redTeamReport`)** | ❌ | ❌ labelled only | ❌ | ❌ | ✅ local 20-probe suite |
| **Knowledge-authoring rubric** | ❌ scored | ❌ scored | ⚠ wired empty | ❌ scored | ✅ unique |
| **Integration-grant rubric** | ❌ | ❌ | ❌ | ⚠ partial | ✅ unique |
| **`scoreProject` three-layer / `correlateLayers`** | ❌ | ❌ | ❌ | ❌ | ✅ at publish |
| **`runProductionLoop` weekly cron** | ⚠ scaffolded, no trace harvest | ❌ DEAD MODULE | ✅ live cron | ⚠ scheduled, no trace ingest | ✅ at 15:00 UTC |
| **Prod-trace harvest cron (durable_runs → samples)** | ❌ | ❌ | ❌ | ❌ | ✅ unique |
| **`extractPreferences` / `detectRewardHacking` RL bridge** | ✅ | ✅ optional | ✅ | – | ✅ |
| **Patch proposer queue (proposeFromFindings → review UI)** | ⚠ no queue | ⚠ no queue | ⚠ custom | ⚠ ad-hoc | ✅ unique |
| **Calibration ingest D1 + admin UI + `pearson`** | ❌ | ❌ | ❌ | ❌ | ✅ unique |
| **Subpaths used (of 16)** | 3 | 3 | 3 | 3 | 4 (+ `/builder-eval`) |

## Five patterns every vertical hand-rolls — lift candidates for substrate

1. **Cross-family judge enforcement** (`judgeFamily` regex map → blocks same-family judges in the ensemble). Identical logic in tax `lib/judge-ensemble.ts`, legal `run-prompt-evolution.ts:333-395`, gtm `eval/lib/judge-ensemble.ts:51-125`, creative `eval/lib/judge-ensemble.ts:87-119`. agent-builder uses substrate's `JudgeScoresRecord.failedJudges[]` pattern instead. **Universal policy; should ship as `assertCrossFamily(judges, opts)` + `judgeFamily(modelId)` in substrate.**

2. **`captureFetchFor` raw-event wrapping.** Tax/legal/gtm/creative each hand-roll a fetch shim that wraps the SSE response, decodes deltas, builds `RawProviderEvent`s, and pushes to `FileSystemRawProviderSink`. Legal has TWO copies of this in one repo. Substrate ships `defaultProviderRedactor` + `providerFromBaseUrl` + the sink — missing piece is the packaged wrapper.

3. **Composite formula open-coded in two-plus places per repo.** Tax `lib/production-loop.ts:73-77`, gtm `canonical.ts:1209` and `run-prompt-evolution.ts:460-464`, creative `canonical-runner.ts`, agent-builder `canonical-campaign.ts:612-627`. None use a substrate composite helper because none exists — substrate should ship `weightedComposite({ dims, weights, threshold? })`.

4. **`JudgeScoresRecord` side-channel cast.** Tax `run-prompt-evolution.ts:885-902`, legal `run-prompt-evolution.ts:809-815` (with self-acknowledging drift comment), gtm same. All four verticals stuff per-judge scores into `metrics.judgeScores` via a `Record<string, ...> as unknown as number` cast. The typed `RunRecord.outcome.judgeScores: JudgeScoresRecord` field has been live since 0.31.0; nobody migrated.

5. **Manual OTLP flat-projection.** Creative `trace-analyst-runner.ts:147-205`, gtm `auto-research.ts:154-179`, legal `analyst-loop.ts:138-152` ("convertTraceStoresToOtlp"). All three flatten `OtlpSpan` arrays into the line shape `OtlpFileTraceStore` expects. Substrate should ship `flattenOtlpExportToNdjson(export)` so this is one import, not three reimplementations.

**Bonus — legal-only patterns worth absorbing:** durable persona loop with stale-lease reclaim + `buildPersonaErrorResult` checkpointing (legal `canonical.ts:344-388,1171-1223`); compile-time-pinned judge prompt schema so rubric-dim additions fail type-check; `EvalBackendConfig` no-fallback contract (`assertSingleBackend(agent, judge)` shape).

## Three execution gaps inside agent-builder itself

These are NOT scaffold gaps — they're shipped code in `agent-builder/src` that has zero production callers despite being unit-tested:

1. **`evaluateAutoPromote` (Wave C4) has zero callers.** `src/lib/.server/eval/auto-promote.ts` composes B3 differential verdict + B4 evolve-gate cleanly, but no script, route, or cron invokes it. The gate exists in code but not in execution.

2. **`/api/admin/proposals` PATCH skips the differential gate.** File header explicitly admits the deferral: "For now the gate-run is deferred — the PATCH stores the decision intent + reviewer; a follow-up CLI / cron actually runs the differential." That follow-up isn't in the cron. Result: a proposal can be PATCHed to `promoted` without the gate firing.

3. **`pareto-judges.ts` (Wave B2) is orphaned.** Designed to switch `DEFAULT_FORGE_JUDGE_MODELS` by `JUDGE_BUDGET_TIER` env. No caller reads it; `forge-chat-judge.ts:41-58` still hard-codes the three-judge list.

These three are the smallest fix per leverage — composing gates that already exist.

## The scaffold-template gap — the big finding

Today `src/lib/.server/scaffold/templates/` emits a `defineAgent` manifest + `analyst-loop.ts` CLI + a `canonical-eval.ts` per-persona loop + a TWO-judge default (`'anthropic/claude-sonnet-4,openai/gpt-5.4'`). That's ~25% of agent-builder's own integration.

**What new agents do NOT inherit by default:**

- The six-EvalKind canonical campaign through `runEvalCampaign` (`buildCanonicalCampaign` shape)
- D1-backed `TraceStore` + `TraceAnalysisStore` + `OutcomeStore` adapters
- D1-mirrored findings store + `/api/admin/findings` + `/app/admin/findings` review UI
- Differential A/B harness (`pairedWilcoxon` + `pairedBootstrap` + Cliff's δ)
- `/evolve` unfreeze gate (Pearson + adversarial + baseline-days)
- Auto-promote composition
- Prod-trace harvest cron
- Tool-fidelity deterministic rubric folded into the composite
- Streaming-quality dim (TTFT / max-stall / P95)
- Adversarial-probe registry slot
- Calibration ingest D1 + admin UI + `pearson`
- 3-judge ensemble + IRR + `JudgeScoresRecord` shape

**The single biggest lever in the entire push:** expand the scaffold templates so tax/legal/creative/gtm acquire the full stack via re-scaffold, not hand-port. That's what makes agent-builder a meta-system that delivers value, not a one-off integration.

## Substrate surfaces nobody is using (12 of 16 subpaths)

`/control` (action policy, control-runtime, propose/review) · `/optimization` (multi-shot, prompt-evolution, reflective-mutation, researcher, feedback-trajectory) · `/reporting` (promotion-gate, paired stats, release confidence, sequential e-values, summary reports — consumers reach for these via root re-export when they reach for them at all) · `/telemetry` (Workers-safe telemetry sinks + file sink) · `/wire` (HTTP/RPC server, Zod schemas, OpenAPI emitter, builtin rubrics) · `/benchmarks` (BenchmarkAdapter contract, deterministic split, routing synthetic benchmark) · `/pipelines` (`failureClusterView`, `regressionView`, `judgeAgreementView`, `toolWasteView`, `stuckLoopView`, `firstDivergenceView`, `budgetBreachView` — these are powerful diagnostic lenses, zero adoption) · `/meta-eval` (calibration curves, correlation studies, deployment-outcome store, rubric-predictive-validity) · `/prm` (process reward model + best-of-N) · `/governance` (EU AI Act / NIST AI RMF / SOC2 templates) · `/knowledge` (knowledge-readiness scoring + blocking-knowledge-eval)

Three of these are probably the highest-ROI to start using:
- **`/pipelines`** — the views are exactly the diagnostic surfaces every eval needs. Free if you have a `TraceStore`.
- **`/governance`** — every paid-tier agent needs compliance scaffolding eventually. Substrate ships the templates.
- **`/meta-eval`** — `rubricPredictiveValidity` answers the question every consumer is implicitly asking ("does our rubric predict deployment outcomes?"). Nobody asks it.

## Are we building something useful? — verdict

**Yes, on the substrate side.** It's rich, intentional, well-curated, and the consumer-contract test prevents accidental breakage. The post-0.27 additions (analyst registry + kinds + IRR + `JudgeScoresRecord` + backend-integrity) form a coherent layer.

**Partially, on the consumer side.** All five consumers genuinely exercise the live product runtime through real transports (no synthetic-transcript theater). All five wire the analyst loop end-to-end. But each one stops at "we wrote an eval + analyst" and never reaches for the full stack (gates, IRR, cost-Pareto, prod-trace harvest, streaming dim, adversarial primitives, D1 mirroring, three-layer correlation).

**Half, on the meta-system side.** agent-builder pioneered the full stack for its own evals but doesn't ship those patterns into the scaffolds it generates. That's the bottleneck for compounding value across the verticals.

## Concrete actions, ranked by leverage

1. **(highest leverage) Expand scaffold templates to emit the full stack.** Render: multi-EvalKind campaign builder, D1-backed trace/analysis/findings stores, differential gate, evolve gate, auto-promote, proposals queue + UI, calibration store + UI, prod-trace harvest cron, tool-fidelity + stream-quality scorers, 3-judge ensemble + IRR + `JudgeScoresRecord`, adversarial probe slot. Then re-scaffold tax/legal/creative/gtm. One push, four agents level-up, every future agent inherits.

2. **Close agent-builder's three execution gaps.** Wire `evaluateAutoPromote` into the proposals PATCH path. Resolve `JUDGE_BUDGET_TIER` env in `forge-chat-judge.ts`. Run cost-aware Pareto on calibration data once that data exists. Cheapest fixes per leverage in the entire push.

3. **Lift the five universal hand-rolled patterns into substrate.** `assertCrossFamily(judges)` + `judgeFamily(modelId)`; `captureFetchToRawSink(fetch, sink, opts)`; `weightedComposite({ dims, weights, threshold? })`; `flattenOtlpExportToNdjson(export)`. Plus codify `assertSingleBackend(agent, judge)` from legal. **One substrate release deletes ~500 lines of duplicated drift across the four verticals.**

4. **Migrate per-judge scores to `RunRecord.outcome.judgeScores: JudgeScoresRecord` everywhere.** Eliminates the four `Record<string, ...> as unknown as number` casts. Unblocks `corpusInterRaterAgreementFromJudgeScores`, which directly answers the "is the 3-judge ensemble really three opinions" question every consumer is dodging.

5. **Adopt `/pipelines` views universally.** `failureClusterView`, `regressionView`, `judgeAgreementView`, `toolWasteView`, `stuckLoopView` are pure functions over a `TraceStore`. Zero new infra; new dashboards per consumer.

6. **Resurrect legal's dead `production-loop` module + tax's idle weekly cron** OR delete both. They reference `^0.25.0` in docstrings while the package is at `^0.31.1` — drift indicator.

7. **Two cross-pollination lifts to substrate**: legal's durable-persona loop with stale-lease reclaim + `buildPersonaErrorResult` checkpointing; gtm's unified `EvalBackendConfig` no-fallback contract. Both are universal patterns currently locked in one repo each.

8. **Adversarial-probe suite for every consumer.** Legal already labels 5 personas `adversarial_resilience` but never wires substrate's red-team primitives. Tax has zero. gtm has zero. Creative has FTC-compliance / mediation / pivot personas that are ideal red-team targets. agent-builder ships a local 20-probe suite (Wave A2) that could lift to substrate as `DEFAULT_FORGE_RED_TEAM_CORPUS`.

9. **Backend-integrity guard everywhere.** Nobody calls `assertRealBackend`. It's the 0.31.0 surface that distinguishes "agent failed" from "ran blind against stub." Every canonical eval should land it.

10. **Documentation drift sweep.** Tax + legal + gtm all reference `^0.25.0` in docstrings while pinning `^0.31.1`. One PR fixes all of them.
