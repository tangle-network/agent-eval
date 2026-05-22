# agent-builder × @tangle-network/agent-eval — Integration Audit

Pinned version: `^0.31.1` (`/home/drew/code/agent-builder/package.json:53`).
Surface: 66 source files, 86 import sites. agent-builder is the meta-system that
generates tax/legal/creative/gtm; its integration sets the bar consumers should converge to.

## 1. Import inventory (per file, by area)

### 1a. Eval entry + canonical campaign (5 files)
- `scripts/eval.ts:85-98` — `FileSystemRawProviderSink`, `FileSystemTraceStore`, `evaluateInterimReleaseConfidence`, `RunRecord`, `RawProviderSink`, `TraceStore`, `detectRewardHacking`, `extractPreferences` (`/rl`), `runEvalCampaign`
- `src/lib/.server/eval/canonical-campaign.ts:28-38` — `InMemoryRawProviderSink`, `InMemoryTraceStore`, `runEvalCampaign`, `CampaignRunContext`, `CampaignRunOutcome`, `EvalCampaignOptions`, `EvalCampaignResult`, `RawProviderSink`, `TraceStore`
- `src/lib/.server/eval/scenario-registry.ts` — pure local registry (no eval import)
- `src/lib/.server/eval/canonical-trace-analyst.ts:44-57` — `FileSystemTraceStore`, `exportRunAsOtlp`, `OtlpExport`, `OtlpSpan`, `Run`, `RunRecord`, `TraceStore`, `OtlpFileTraceStore` (`/traces`), `analyzeTraces`, `AnalyzeTracesResult`
- `scripts/run-canonical-analyst-loop.ts:32-39` — `AnalystRegistry`, `DEFAULT_TRACE_ANALYST_KINDS`, `FindingsStore`, `createTraceAnalystKind`, `OtlpFileTraceStore` (`/traces`)

### 1b. Judges + composite math (4 files)
- `src/lib/.server/eval/forge-chat-judge.ts:31-37` — `callLlmJson`, `interRaterReliability`, `JudgeScore`, `JudgeScoresRecord`, `LlmClientOptions`
- `src/lib/.server/eval/forge-builder-sim.ts:37-64` — `createLlmReviewer`, `LlmClient`
- `src/lib/.server/eval/forge-subagents.ts:40-41` — `LlmClient`, `KnowledgeRequirement`
- `src/lib/.server/eval/reviewer-llm.ts:21` — `createLlmReviewer`, `ReviewFn`
- `src/lib/.server/eval/harness-eval-judge.ts:25`, `forge-trace-critique.ts:32` — `LlmClient`

### 1c. Trace persistence + D1 (6 files)
- `src/lib/.server/eval/trace-store-d1.ts:12-23` — implements `TraceStore` over D1 (`Artifact`, `BudgetLedgerEntry`, `EventFilter`, `Run`, `RunFilter`, `RunStatus`, `Span`, `SpanFilter`, `TraceEvent`, `TraceStore`)
- `src/lib/.server/eval/d1-trace-analysis-store-adapter.ts:36-53` — implements `TraceAnalysisStore` over D1 (`Span`, plus `/traces` subset)
- `src/lib/.server/eval/session.ts:12,21` — `redactValue`, `SandboxDriver`, `/builder-eval`: `BuilderSession`, `correlateLayers`, `ProjectRegistry`, `resumeBuilderSession`, `scoreAllProjects`, `scoreProject`, `ThreeLayerProjectReport`
- `src/lib/.server/eval/run-record-store.ts:26` — `validateRunRecord`, `RunRecord`
- `src/lib/.server/marketplace-gateway.ts:58-66` — `D1DurableRunStore` (via `@tangle-network/agent-runtime`)
- `src/lib/.server/eval/outcome-store-d1.ts` — implements `OutcomeStore`

### 1d. Runtime + tracing (5 files)
- `src/lib/.server/runtime/trace-runtime.ts:39-40` — `TraceEmitter`, `Run`, `SpanHandle`, `ToolSpan`
- `src/lib/.server/runtime/forge-agent-task.ts:50-56` — `KnowledgeReadinessReport`, `ProposeReviewConfig`, `ProposeReviewReport`, `TraceStore`, `runProposeReview`
- `src/lib/.server/runtime/forge-chat.ts:38-39` — `ScoreKnowledgeReadinessOptions`, `scoreKnowledgeReadiness`
- `src/lib/.server/runtime/kb-retrieval.ts:29` — `TraceEmitter`, `ToolSpan`
- `src/lib/.server/runtime/events.ts:48` — `KnowledgeReadinessReport`, `TraceEvent`, `TraceStore`
- `src/lib/.server/runtime/responsible-surfaces.ts:28` — `FailureClass`

### 1e. Gates + statistics (4 files — all NEW in PR #189)
- `src/lib/.server/eval/differential-eval.ts:25` — `pairedWilcoxon`, `pairedBootstrap` (B3)
- `src/lib/.server/eval/evolve-gate.ts` — local-only, no eval import (B4)
- `src/lib/.server/eval/auto-promote.ts` — local-only, no eval import (C4)
- `src/lib/.server/eval/pearson.ts` — local-only (B1)
- `src/lib/.server/eval/promotion.ts:30-31` — `HeldOutGate` and related
- `src/lib/.server/eval/publish-gate.ts:29` — `GateDecision`, `RunRecord` (hard gate at publish)

### 1f. Loop + analyst infra (8 files)
- `src/lib/.server/eval/auto-research-runner.ts:52-84` — ensemble of types + `renderPreferenceMemoryMarkdown`, `summarizePreferenceMemory`, `analyzeOptimizationResult` (`/rl`)
- `src/lib/.server/eval/forge-deep-analyst.ts:38-43` — `JudgeSpan`, plus `/traces` analyst surface; uses local `D1TraceAnalysisStore`
- `src/lib/.server/eval/canonical-trace-analyst.ts` (above) — campaign-level analyst
- `src/lib/.server/eval/canary-cron.ts:25` — `runCanaries`, `CanaryReport`, `RunRecord`
- `src/lib/.server/eval/production-loop/index.ts:50` — ensemble of feedback + cluster + steering types
- `src/lib/.server/eval/feedback-capture.ts`, `feedback-store.ts`, `feedback-replay-runner.ts` — feedback trajectory primitives
- `src/lib/.server/eval/prompt-mutator.ts`, `tangle-ax-gepa.ts`, `code-mutator.ts`, `multi-shot-adapter.ts`, `evolution-runner.ts`, `decide-repair-action.ts`, `heuristic-researcher.ts`, `code-runner.ts`, `data-acquisition-engine.ts`, `onboarding.ts`, `reviewer-memory.ts`, `failure-inspector.ts`, `research-cycle-store.ts`, `forge-refinement.ts`, `repair-engines.ts` (via index.ts), `findings-d1-store.ts`, `proposals-store.ts`, `kb/optimization.ts`, `marketplace-listing.ts`

### 1g. Admin surfaces + routes (8 files)
- `src/routes/api.admin.findings.ts` — D1 mirror writer of substrate `FindingsStore` JSONL
- `src/routes/api.admin.proposals.ts` — proposal queue (manual gate trigger deferred)
- `src/routes/api.admin.calibration.ts` — human-judgement ingest for Pearson
- `src/routes/api.admin.e2e-report.ts:28` — eval report surface
- `src/routes/api.admin.decide-repair-action.ts:54` — `MultiShotOptimizationResult`
- `src/routes/api.agents.$agentId.governance.ts:30`, `.feedback.ts:24`, `.publish.ts:9` — agent runtime governance + `scoreProject`
- `src/routes/app.$agentId.research.$cycleId.tsx:20` — research-cycle viewer

### 1h. Scaffold templates emitted to NEW agents (4 files)
- `src/lib/.server/scaffold/templates/judges.ts:55` — `withJudgeRetry`
- `src/lib/.server/scaffold/templates/canonical-eval.ts:47` — `FileSystemTraceStore`, `TraceEmitter`, `RunRecord`
- `src/lib/.server/scaffold/templates/agent-config.ts:49,160-161` — `DEFAULT_TRACE_ANALYST_KINDS`; rendered output includes `AnalystRegistry`, `FindingsStore`, `createTraceAnalystKind`, `OtlpFileTraceStore`
- `src/lib/.server/scaffold/templates/prompt-evolution.ts:59` — `FileSystemRawProviderSink`, `FileSystemTraceStore`, `InMemoryTrialCache`, `TraceEmitter`, `runPromptEvolution`, plus types

## 2. Integration shape — end-to-end

### 2a. Entry: `pnpm eval` (`scripts/eval.ts`)
1. Parses `--kind / --scenario / --seeds / --backend` (`scripts/eval.ts:128-191`).
2. Calls `buildCanonicalCampaign({ scenarioOpts, seeds, builderSim, customerSim, forgeChat, storeFactory, rawSinkFactory })` and feeds it to `runEvalCampaign` (`scripts/eval.ts:613`).
3. Wires four capture-integrity directives by construction: per-cell `FileSystemRawProviderSink` + `FileSystemTraceStore`, route assertion via `assertLlmRoute`, `assertRunCaptured` after every cell, optional analyst hook (`scripts/eval.ts:17-32`).
4. Persists per-run artifact bundle at `eval/.runs/<runId>/`: `raws.jsonl`, `traces.jsonl`, `records.jsonl`, `scores.json`, `rl-bridge.json`, `manifest.json` (`scripts/eval.ts:23-31`).

### 2b. Campaign dispatch (`src/lib/.server/eval/canonical-campaign.ts`)
ONE candidate variant `canonical`; scenarios × seeds matrix (`canonical-campaign.ts:192-200`).
Six EvalKinds dispatched in `makeCanonicalRunner` (`canonical-campaign.ts:306-353`):
- `builder-sim` → `runForgeBuilderSim` (`canonical-campaign.ts:355-414`)
- `customer-sim` → `runCustomerSim` (`canonical-campaign.ts:416-465`)
- `forge-chat` → `runForgeChatThroughRuntime` + judge ensemble + tool-fidelity + stream-quality (`canonical-campaign.ts:467-698`)
- `forge-chat-multi-turn` → multi-turn loop with `composeMultiTurnOutcome` (`canonical-campaign.ts:708-840`) — Wave A3
- `knowledge-authoring` → `scoreAuthoredKnowledge` deterministic rubric (`canonical-campaign.ts:850-943`) — Wave A4
- `integration-grant` → `scoreIntegrationGrantFlow` against manifest (`canonical-campaign.ts:953-1075`) — Wave A5

Composite for forge-chat: `0.6 * judgeScores.composite + 0.4 * toolFidelity.score`; fail threshold 0.5 (`canonical-campaign.ts:612-627`). Stream-quality recorded but NOT in composite weight (`canonical-campaign.ts:592-605`) — Wave A6.

Registry single-source-of-truth: `src/lib/.server/eval/scenario-registry.ts:173-255` — `buildCanonicalScenarios` is the only producer; admin route + cron + local sweep all read from it.

### 2c. Judges: 3-judge ensemble
`forge-chat-judge.ts:39-43`: `DEFAULT_FORGE_JUDGE_MODELS = ['claude-code/sonnet', 'opencode/zai-coding-plan/glm-5.1', 'kimi-code/kimi-k2.6']` × 3 dims (`helpfulness`, `clarity`, `on_topic`). Parallel `Promise.allSettled`; `EnsembleAllFailedError` when every judge fails; IRR via `interRaterReliability` prepended onto notes (`forge-chat-judge.ts:24-28, 48-58, 208-214`). Returns substrate-shaped `JudgeScoresRecord`.

### 2d. Trace persistence: D1-backed
- `D1TraceStore` (`trace-store-d1.ts:27`) implements substrate `TraceStore`. Idempotent appendRun via `ON CONFLICT(run_id)` (`trace-store-d1.ts:30-43`).
- `D1TraceAnalysisStore` (`d1-trace-analysis-store-adapter.ts:94`) implements `TraceAnalysisStore` for `forge-deep-analyst` (`forge-deep-analyst.ts:155`).
- `D1DurableRunStore` from `@tangle-network/agent-runtime` used in marketplace gateway (`marketplace-gateway.ts:819`).
- `D1OutcomeStore` (`outcome-store-d1.ts`) closes the three-layer correlation loop in `getProjectSummary` (`session.ts:99-111`).

### 2e. Analyst loop wiring (Wave C1)
`scripts/run-canonical-analyst-loop.ts:127-161` builds an `AnalystRegistry` over `DEFAULT_TRACE_ANALYST_KINDS` (failure-mode / knowledge-gap / knowledge-poisoning / improvement), runs `runAnalystLoop` from `@tangle-network/agent-runtime/analyst-loop` against the OTLP `traces.jsonl`, persists findings to JSONL ledger + mirrors via `POST /api/admin/findings` to D1 (`scripts/run-canonical-analyst-loop.ts:186-220`).

### 2f. Promotion gate stack
- **Wave B3 differential** (`differential-eval.ts:97-184`): paired Wilcoxon + Cliff's delta + paired bootstrap CI; gate at `p<0.05`, `Cliff>=0.15`, adversarial>=0.95.
- **Wave B4 evolve-gate** (`evolve-gate.ts:68`): blocks `/evolve` unless Pearson≥0.7 per (judge×dim, n≥30), adversarial≥0.95, baseline≥7 days.
- **Wave C4 auto-promote** (`auto-promote.ts:37`): composes B3 verdict + B4 gate → `promote/hold/reject/blocked`.
- **Publish hard gate** (`publish-gate.ts:66`): holdout floor + `HeldOutGate.evaluate` from substrate (`promotion.ts:31`).

### 2g. Calibration surface (Wave B1)
- `pearson.ts:13-40` pure correlation + `computeCalibrationCell:57`.
- `calibration-store.ts` D1 store; `api.admin.calibration.ts` writer; `app.admin.calibrate.tsx` UI.

### 2h. Admin UI
30 admin route files (`src/routes/`). The eval-relevant ones: `findings`, `proposals`, `calibrate`, `e2e-report`, `harness-eval`, `harden-attacks`, `build-spec-eval`, `forge-meta-analysis`, `rl-bridge`, `research-cycles`, `decide-repair-action`, `subjectivity-ratio`, `auto-research.run`, `builder-sim.run`, `data-acquisition.run`.

### 2i. Cron schedule (`server.ts`)
Three crons (`wrangler.toml:30`): `0 13`, `0 14`, `0 15 * * *`.
- `0 13` — subscriptions + canary scan + instance idle-sweep
- `0 14` — auto-research + feedback-generations
- `0 15` — production-loop **+ `runProdTraceHarvest(env.DB, {windowHours:24, topKPerCluster:5})`** (`server.ts:191-211`) — Wave C5+C6.

## 3. Patterns in agent-builder NOT in other consumer agents

Cross-checked tax-agent, legal-agent, creative-agent, gtm-agent. NONE of the
consumer agents import `evolve-gate`, `auto-promote`, `differential-eval`,
`pairedWilcoxon`, `D1TraceAnalysisStore`, `D1DurableRunStore`,
`prod-trace-harvest`, `findings-d1-store`, or expose admin UI for proposals/calibration.
Templates the meta-system should be emitting:

1. **Multi-kind canonical campaign**: `buildCanonicalCampaign` + scenario registry across builder-sim / customer-sim / forge-chat / multi-turn / knowledge-authoring / integration-grant. Consumers ship a single `canonical.ts` per-persona loop; the meta-system runs six kinds through one dispatcher.
2. **D1-backed trace store with `ON CONFLICT` idempotency** (`trace-store-d1.ts`). Consumers store traces only on disk (`tests/eval/.runs`); Worker-deployed consumers have no Worker-readable trace surface.
3. **D1-backed `TraceAnalysisStore` adapter** (`d1-trace-analysis-store-adapter.ts`) for deep analyst over Worker-resident data.
4. **3-judge LLM ensemble with `JudgeScoresRecord` + IRR** (`forge-chat-judge.ts`). Only `creative-agent` has any `interRaterReliability` reference, and only in a test (`eval/lib/judge-score-persistence.test.ts`).
5. **Differential A/B harness with paired Wilcoxon + Cliff's delta + bootstrap CI** (`differential-eval.ts`). Statistically rigorous comparison vs eyeballing deltas.
6. **/evolve unfreeze gate** wired to per-(judge×dim) Pearson + adversarial pass-rate + baseline-days (`evolve-gate.ts`).
7. **Auto-promote** composing B3+B4 into ship-or-not (`auto-promote.ts`).
8. **Tool-fidelity scoring** deterministic against `expectedTools` matchers (`tool-fidelity.ts`) folded into composite at 0.4 weight.
9. **Streaming-quality observation** (TTFT, max stall, P95 gap) (`stream-quality.ts`).
10. **Adversarial-probe registry** as a gate input (`adversarial-scenarios.ts`).
11. **D1-mirrored findings store** + `POST /api/admin/findings` admin endpoint + `/app/admin/findings` review UI. CLI analyst loop reads from disk, mirrors to D1 so the Worker can serve them.
12. **Proposal queue** (`proposals-store.ts` + `/app/admin/proposals`) for human-in-loop disposition.
13. **Calibration ingest** (`calibration-store.ts` + `/app/admin/calibrate` + `pearson.ts`).
14. **Prod-trace harvest cron** sweeping `D1DurableRunStore` into stratified samples for analyst ingestion (`prod-trace-harvest.ts`).
15. **Three-layer correlation via `scoreProject` + `correlateLayers`** at publish time (`session.ts:99-111`, `marketplace-listing.ts:168`).
16. **Pareto-judges cost-aware ensemble selection** (`pareto-judges.ts`) — orphan today, see §4.

## 4. Awkward / inconsistent / duplicating substrate

1. **`pearson.ts` duplicates substrate's correlation primitive.** Substrate already exports correlation under `summary-report`/`reporting`. Local impl is fine for the dim-specific calibration cell type but the bare `pearson(xs, ys)` should call into substrate (or substrate should re-export this as `pearson(...)`).

2. **`cliffsDelta` is a local 12-line implementation** (`differential-eval.ts:83-95`) with a comment "the substrate doesn't ship one — it's small enough to keep here." Either upstream Cliff's delta into substrate alongside `pairedWilcoxon`/`pairedBootstrap`, or document the policy. Today it's a per-consumer reinvention waiting to happen.

3. **`evaluateAutoPromote` has ZERO production callers** (only a unit test). It composes B3+B4 cleanly but no script or route invokes it. The Wave C4 gate exists in code but not in execution.

4. **`/api/admin/proposals` PATCH defers the differential gate run** (`api.admin.proposals.ts:100-117` + comment in the file header `Wave B3 differential gate before flipping to promoted/approved. ... For now the gate-run is deferred — the PATCH stores the decision intent + reviewer; a follow-up CLI / cron actually runs the differential`). The cron also doesn't invoke it. So a proposal can be PATCHed to `promoted` without the gate firing — the C4 auto-promote is the place this should land but it's an orphan (§4.3).

5. **`pareto-judges.ts` is an orphan.** Designed to switch `DEFAULT_FORGE_JUDGE_MODELS` by `JUDGE_BUDGET_TIER` env. No caller; `forge-chat-judge.ts:41-58` still hard-codes the three-judge list. Either wire the tier resolver or delete the module.

6. **Two parallel analyst entry points doing similar work:**
   - `canonical-trace-analyst.ts` runs `analyzeTraces` over the full campaign corpus (one report).
   - `run-canonical-analyst-loop.ts` runs the substrate `AnalystRegistry` over the same traces (four kinds, findings).
   - `forge-deep-analyst.ts` runs `analyzeTraces` per-build via `D1TraceAnalysisStore`.
   They produce overlapping outputs into different ledgers. Consolidation pass owed.

7. **Campaign-cell raw-coverage integrity is RELAXED** (`canonical-campaign.ts:216-228` — `llmSpansMin:0`, `rawProviderEventsMin:0`, `requireRawCoverageOfLlmSpans:false`). The substrate's raw-sink coverage assertion is the strongest invariant against silent capture-loss, and three of six EvalKinds disable it because their wrappers don't call `callLlm` directly. Reasonable today; long-term the wrappers should route through `callLlm` so raw coverage can be re-enabled.

8. **Forge-chat composite weights are hard-coded** (`canonical-campaign.ts:612-627`: `0.6 * judges + 0.4 * tool_fidelity`, fail threshold 0.5). No env or config surface; tuning requires a code edit. Should live alongside `DEFAULT_FORGE_JUDGE_MODELS` as an env-overridable constant.

9. **`session.ts` re-exports a `summarizeTextForTrace` from `./text-summary`** (`session.ts:25`) — barrel-style re-export hiding the source. Inline import preferred.

10. **No campaign-fingerprint emitted to ANY persistent store.** The scenario registry comment promises a stable SHA-256 fingerprint (`scenario-registry.ts:24-27`) but the campaign options shape doesn't compute or stamp one onto the runs. Fingerprint should land in `manifest.json` AND in `eval_run.code_sha` to make registry drift detectable.

## 5. Recommendation — scaffolded-agent template gaps

Today's `src/lib/.server/scaffold/templates/agent-config.ts` emits a `defineAgent({...})`
manifest + the substrate-driven `analyst-loop.ts` CLI script. That's the analyst
plumbing. It does NOT emit:

1. **A canonical-campaign builder** (`buildCanonicalCampaign`-shaped). Consumers
   today render a hand-rolled persona loop in `canonical-eval.ts`. Add a
   `renderCanonicalCampaign(input)` template that emits a per-agent
   `buildCanonicalCampaign({ scenarioRegistry, ... })` so the consumer gets the
   six-kind dispatcher by default, not just one kind. At minimum: forge-chat +
   multi-turn + knowledge-authoring kinds, leaving builder-sim/customer-sim/
   integration-grant gated on whether the agent declares those surfaces.

2. **D1-backed `TraceStore` + `TraceAnalysisStore` adapters** (`renderTraceStore`,
   `renderTraceAnalysisStore`). The Worker can't read JSONL on disk; without
   D1 mirroring the analyst surfaces have no readable substrate when deployed.

3. **A findings-d1-store + `/api/admin/findings` route + `/app/admin/findings`
   review UI** keyed off `defineAgent({autoApply:{improvement:{mode:'open-pr'}}})`.
   Today only agent-builder has this; consumers see findings as console output.

4. **A differential-eval gate** (`renderDifferentialGate`) emitting the B3
   harness. Without this, prompt-evolution is gradient descent on noise.

5. **An evolve-gate + auto-promote** (or a `gates.ts` template that wires
   them). Even if the consumer doesn't have D1 calibration data on day one,
   the gate logic should be present so adding calibration upgrades the gate
   automatically.

6. **A prod-trace-harvest cron** in `templates/cron.ts` + `templates/server.ts`
   (currently `server.ts:63-77` enqueues a job but doesn't sweep durable runs).

7. **Tool-fidelity + streaming-quality scorers** (`tool-fidelity.ts`,
   `stream-quality.ts`). These are pure modules — copying the file shape into
   the scaffold gives every new agent the deterministic dims.

8. **A pinned 3-judge ensemble in `templates/judges.ts`.** Today the rendered
   `tests/eval/lib/judges.ts` defaults to `'anthropic/claude-sonnet-4,openai/gpt-5.4'`
   (`judges.ts:73`) — two judges, different vendor mix, no IRR. Mirror the
   agent-builder ensemble (`claude-code/sonnet`, `opencode/.../glm-5.1`,
   `kimi-code/kimi-k2.6`) with `interRaterReliability` and `JudgeScoresRecord`.

9. **An adversarial-scenario registry slot** in `personas.ts` template, with
   the Wave A2 adversarial probes pinned so the gate has data to read from
   day one.

10. **Calibration store + admin route + UI** keyed on the judge model list the
    template emits.

## 6. Synthesis — does agent-builder embody the full substrate surface end-to-end?

**Substantially yes — with three execution gaps and a meta-question.**

What's complete and exercised in CI/runtime today:
- Six-EvalKind canonical campaign through `runEvalCampaign`, with capture-integrity
  contract (per-cell stores, route assertion, `assertRunCaptured`).
- D1-backed `TraceStore` + `TraceAnalysisStore` + `OutcomeStore` + `DurableRunStore`
  (latter via agent-runtime).
- 3-judge ensemble with `JudgeScoresRecord` + IRR.
- Analyst loop (Wave C1) running substrate's four kinds with findings mirrored to D1.
- Hard publish-gate via substrate `HeldOutGate`.
- Three-layer scoring via substrate `scoreProject` / `correlateLayers` exposed in publish flow.
- RL-bridge via `extractPreferences` / `detectRewardHacking` / `evaluateInterimReleaseConfidence`.

What exists in source but is NOT actually executed (the execution gaps):
- **`evaluateAutoPromote` (C4)** — composed but uncalled. Wave C4 gate is paper.
- **`/api/admin/proposals` PATCH** flips status without firing the differential
  gate. The composition `proposal-approved → differential-eval → auto-promote →
  apply` is broken at the PATCH boundary.
- **`pareto-judges` (B2)** — designed and unit-tested but `forge-chat-judge.ts`
  still hard-codes the 3-judge list. The cost-aware switch is unwired.

What's missing for the meta-system to fulfill its role:
- **The scaffold templates emit ~25% of the surface agent-builder uses
  internally** (analyst loop, prompt evolution, persona suite, judges, canonical
  eval). The full integration stack (multi-EvalKind dispatcher, D1 stores,
  differential gate, evolve gate, auto-promote, proposals UI, calibration UI,
  prod-trace harvest, tool-fidelity, stream-quality) IS NOT scaffolded. Newly-
  built agents inherit the analyst plumbing but not the gate stack or the
  D1-backed observability.

**The most important question's answer:** agent-builder reaches the substrate's
end-to-end surface for ITS OWN evals, but it does not yet PROPAGATE that surface
to the agents it generates. The meta-system is one or two scaffold-template
PRs away from the "template emits the full integration stack" property — the
biggest single lever for the multi-repo eval push (per the memory note
`project_eval_completion_push_2026_05_17`) is closing that gap, since tax/
legal/creative/gtm acquire the stack by re-scaffolding, not by hand-porting.
The secondary lever is wiring auto-promote + proposals PATCH → differential
gate so the gates that exist actually run.
