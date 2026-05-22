# creative-agent × @tangle-network/agent-eval@^0.31.1 — Integration Audit

Pin: `^0.31.1` (matches substrate HEAD). Installed: `0.31.1` (asserted by `tests/agent-eval.smoke.test.ts:43-45`).

## 1. Imports inventory (file → symbols)

Eval scripts:
- `eval/run.ts:50` → `ValidationError`
- `eval/agent.config.ts:19` → `DEFAULT_TRACE_ANALYST_KINDS`
- `eval/canonical-runner.ts:36-48` → `FileSystemRawProviderSink, FileSystemTraceStore, FindingsStore, RunIntegrityError, TraceEmitter, ValidationError, assertLlmRoute, assertRunCaptured, AnalystFinding, LlmClientOptions, RunRecord`; `:49-53` → `/rl` subpath: `detectRewardHacking, extractPreferences, extractVerifiableRewardsFromRecords`
- `eval/analyst-loop.ts:34-41` → `AnalystRegistry, DEFAULT_TRACE_ANALYST_KINDS, FindingSubject, FindingsStore, createTraceAnalystKind`; `:41` → `/traces` subpath: `OtlpFileTraceStore`
- `eval/calibrate-judges.ts:43-50` → `callLlmJson, calibrateJudge, CalibrationResult, CandidateScore, GoldenItem, LlmClientOptions`
- `eval/run-prompt-evolution.ts:51-71` → `FileSystemRawProviderSink, FileSystemTraceStore, InMemoryTrialCache, TraceEmitter, ValidationError, assertLlmRoute, callLlmJson, pairedEvalueSequence, runPromptEvolution, EvolvableVariant, LlmClientOptions, MutateAdapter, Objective, PairedEvalueSequence, RawProviderEvent, RawProviderSink, ScoreAdapter, TrialResult, VariantAggregate`
- `eval/trace-analyst-runner.ts:46-50` → `exportRunAsOtlp, FileSystemTraceStore, RunRecord`; `:54` → `/traces`: `analyzeTraces, AnalyzeTracesResult`
- `eval/lib/creative-judges.ts:12` → `callLlmJson, withJudgeRetry, LlmClientOptions`
- `eval/lib/judge-score-persistence.test.ts:20-25` → `aggregateTrialsByMode, interRaterReliability, JudgeScore, TrialResult`

Eval control flows (synthetic adapter-driven):
- `eval/control/creative-onboarding.ts:1-18` → `InMemoryFeedbackTrajectoryStore, InMemoryTraceStore, controlRunToFeedbackTrajectory, feedbackTrajectoriesToDatasetScenarios, feedbackTrajectoriesToOptimizerRows, objectiveEval, runAgentControlLoop, subjectiveEval, …`
- `eval/control/creative-workflow-optimization.ts:1-18` → same set plus `bootstrapCi`
- `eval/control/creative-feedback-optimization.ts:1-17` → `NotFoundError, ValidationError, feedbackTrajectoriesToDatasetScenarios, feedbackTrajectoriesToOptimizerRows, createFeedbackTrajectory, defaultMultiShotObjectives, estimateTokens, runMultiShotOptimization, FeedbackTrajectory, MultiShotOptimizationResult, MultiShotRun, MultiShotScorer, MultiShotVariant, RunRecord, RunSplitTag`
- `eval/control/creative-multishot-optimization.ts:1-16` → `NotFoundError, ValidationError, defaultMultiShotObjectives, estimateTokens, runMultiShotOptimization, ActionableSideInfo, MultiShotOptimizationResult, MultiShotRun, MultiShotScorer, MultiShotVariant, RunRecord, RunSplitTag`

Production wiring (NOT just eval — runs in the actual app/cron):
- `src/lib/.server/agent-runtime/chat.ts:36, 332-337` → `TraceEmitter` opens a real run per chat with onRunComplete hook (D4 in prod)
- `src/lib/.server/production-loop/index.ts:31-45` → `InMemoryFeedbackTrajectoryStore, InMemoryTraceStore, httpGithubClient, runProductionLoop, ValidationError, FeedbackTrajectoryStore, LlmClientOptions, MultiShotMutateAdapter, MultiShotRunner, MultiShotScorer, ProductionLoopResult, Scenario, TraceStore`
- `src/lib/.server/production-loop/judges.ts:25-29` → `callLlmJson, JudgeError, LlmClientOptions`
- `src/lib/.server/production-loop/scenarios.ts:15` → `Scenario`
- `src/lib/experiments/ab-design.ts:20`, `src/lib/experiments/geo-holdout.ts:22` → `pairedEvalueSequence, PairedEvalueSequence` (real anytime-valid A/B)

Tests: `tests/agent-eval.smoke.test.ts` (substrate floor), `tests/creative-product-harness.test.ts`, `tests/creative-{feedback,workflow,onboarding-control,multishot}-optimization.test.ts`, `tests/sequence-creation-completion-eval.test.ts`, `tests/production-loop.test.ts`.

## 2. Integration shape

**Eval entry**: `pnpm eval` → `eval/run.ts:96`. Three backends (`sandbox`|`tcloud`|`cli-bridge`) with a per-backend allow-listed `assertLlmRoute` at preflight (`canonical-runner.ts:205-225`). Same eval surface runs through prod `runChatThroughRuntime` (`canonical-runner.ts:681-697`) — eval and production share the chat handler, only the backend swaps.

**Campaign build / runner**: `runCanonicalEval` (`canonical-runner.ts:212-561`). Per persona: per-run `FileSystemTraceStore` + `FileSystemRawProviderSink` (D1) wired through a fetch-shim (`makeCaptureFetch`, lines 918-1012); `TraceEmitter.startRun → llm spans → endRun` (D3) with explicit `assertRunCaptured` after each persona (lines 741-754); `onRunComplete` no-op hook left as the analyst extension point (D4, lines 619-628). Outputs the canonical six artifacts (`raws.jsonl, traces.jsonl, records.jsonl, scores.json, rl-bridge.json, manifest.json`) plus `ship-gate.jsonl` (lines 388-393) and `otlp-spans.jsonl` (emitted by the trace-analyst step, lines 220-221 of `trace-analyst-runner.ts`).

**Judges**: ten-dim rubric in `eval/lib/creative-rubric.ts` (5 foundation + 5 director-tier, weights sum to 1, lines 20-74). Ensemble in `eval/lib/creative-judges.ts:69-182` via `withJudgeRetry` + `callLlmJson` (jsonMode, temp 0, 3 attempts). Family-aware ensemble resolver `eval/lib/judge-ensemble.ts:87-119` blocks self-judging by default. Production-loop has a parallel ensemble for the two-dim safety floor (`src/lib/.server/production-loop/judges.ts:111-190`, uses `JudgeError` for fail-loud when all judges error).

**Trace persistence**: dual-write. Eval = on-disk `FileSystemTraceStore` per-run dir; prod = pluggable sink wired through `chat.ts:332-337` with `onRunComplete` ProductionRunRecord build (callsite). OTLP export materialised by `trace-analyst-runner.ts:139-221` (manual flat-OTLP projection because the runner ships a 0.25+ shape).

**Analyst loop**: `pnpm eval:improve` → `eval/analyst-loop.ts`. Reads the canonical run's OTLP file via `OtlpFileTraceStore` (lines 140-150, 208). Builds `AnalystRegistry` from `creativeAgent.analystKinds` (defaulting to `DEFAULT_TRACE_ANALYST_KINDS`, lines 165-170). Uses the substrate-shipped surface adapters (`createSurfaceImprovementAdapter`, `createSurfaceKnowledgeAdapter`, lines 177-206) with a LLM-drafted unified-diff patch proposer (lines 287-351). Findings persisted to `.evolve/findings/findings.jsonl` via `FindingsStore`.

**Promotion gate**: layered.
- Per-run `ship-gate` in canonical (lines 564-596): persona pass-rate ≥ env-configurable floor; CLI exits non-zero.
- Prompt-evolution `pairedEvalueSequence` ship-gate (`run-prompt-evolution.ts:60, 1146-1170`) — anytime-valid e-value, ROPE-aware.
- `evaluateReleaseConfidence` exercised in smoke (`agent-eval.smoke.test.ts:100-110`).
- Production-loop gate via `runProductionLoop`'s `releaseThresholds` + paired-Δ (`index.ts:127-146`) shipping PRs through `httpGithubClient`.
- Calibration gate (`calibrate-judges.ts:333-373`) — fails on any (judge × dim) cell below Pearson floor or above MAE ceiling, env-configurable.

**Calibration**: real, hand-graded. `eval/gold/creative-calibration.json` drives `calibrateJudge` across the full 10-dim rubric per (judge × dim). Self-judging block via `resolveJudgeEnsemble`.

**Real-product vs synthetic split**: BOTH wired.
- *Real:* `pnpm eval` actually runs `runChatThroughRuntime` against `sandbox`/`tcloud`/`cli-bridge` — production-shaped traffic. `chat.ts:332` emits the same trace shape in prod. `production-loop/index.ts` is a real Cloudflare-Worker cron handler (`server.ts:41-72`).
- *Synthetic:* the four control flows (`eval/control/creative-*-optimization.ts`) drive `runAgentControlLoop` + `runMultiShotOptimization` against in-memory adapters, used by `tests/creative-*-optimization.test.ts` for deterministic offline regression.

Unique-to-creative artefacts: separate `eval/canonical-runner.ts` reward-hacking encoder (lines 1053-1066) that stamps the verdict numerically onto `outcome.raw` for downstream join.

## 3. Gaps vs substrate 0.31.1

| Surface | Status |
|---|---|
| Tool-call fidelity | **Partial.** Raw provider events capture tool_calls (visible in `.evolve/raw-events/*.ndjson`), and `chat.ts` emits separate `openToolSpans` for runtime events (`chat.ts:341-344`), but the canonical runner only scores assistant text — no tool-call success/diversity/redundancy metrics surface to `outcome.raw`. |
| Multi-turn | **Native.** `CanonicalPersona.turns[]` (`scenarios/creative-product-personas.ts:1-20`) drives full multi-turn chat with rolling priorMessages cap-16 (`canonical-runner.ts:714-716`). No `conversation_flow` field exists in this repo. |
| Adversarial / red-team | **Missing.** Substrate `redTeamDataset/redTeamReport` (`agent-eval/src/index.ts:654-661`) is not imported. Director-tier scenarios contain adversarial *content* (mediation, paid pivots) and `creative-workflow-optimization.ts` has `adversarialEvents` for feedback-revision testing, but no substrate red-team primitives are used. |
| Streaming-quality dim | **Missing.** Streaming flows through `runtimeIterable` but no dim measures first-token latency, mid-stream coherence, or stream tear-rate. |
| Knowledge-authoring | **Wired but unused.** `createSurfaceKnowledgeAdapter` is fully wired (`analyst-loop.ts:178-195`) and `agent.config.ts:52` declares the `.agent-knowledge` surface, but `sources.json` is empty (`{"sources":[]}` with epoch 0 timestamp). Auto-apply at 0.85 is configured but the corpus is unseeded — knowledge-poisoning analyst will return zero findings indefinitely. |
| Integration-grant | **Missing.** `@tangle-network/agent-integrations` is in deps but no integration-grant eval primitive is used. The outbound-marketing personas exercise integrations through prompts only. |
| Differential A/B | **Native + extended.** `pairedEvalueSequence` is used in both eval (`run-prompt-evolution.ts:1146-1170`) and prod (`src/lib/experiments/ab-design.ts:150`, `geo-holdout.ts:204`). Geo-holdout uses anytime-valid sequential analysis — uncommon for vertical agents. |
| /evolve unfreeze gate | **N/A — no `/evolve` skill is invoked here.** Closest analogue is `pnpm eval:evolve` (`run-prompt-evolution.ts`) with its built-in paired-evalue ship gate (lines 1146+) — that gate is the unfreeze. |
| Cost-aware Pareto | **Partial.** Pareto frontier is computed per generation (`run-prompt-evolution.ts:1519, 1549`) on rubric dims (`buildObjectives`, lines 1050-1102) — but cost is NOT an objective axis. `costUsd` is tracked per record but not on the Pareto front. |
| D1 FindingsStore | **N/A.** Substrate ships only JSONL `FindingsStore` (no D1 backend exists yet); creative-agent uses it correctly. Despite being a Cloudflare Worker prod app with D1 already wired (drizzle), findings persist to local JSONL — not surfaced to the Worker DB. |
| Patch proposer | **Custom.** `draftPatchWithLlm` (`analyst-loop.ts:287-351`) ships its own JSON-mode LLM patch drafter (substrate's surface adapter takes a `draftPatch` callback — this is the canonical pattern). |
| Prod-trace cron | **Wired.** `server.ts:41-72` + `production-loop/index.ts` route `controller.cron` → `runCreativeProductionLoopFromEnv`. Weekly cadence (`index.ts:162`). |

## 4. Drift / stale patterns

1. **Manual OTLP projection** in `trace-analyst-runner.ts:147-205`: file hand-flattens `OtlpSpan` (resourceSpans → scopeSpans → spans → flat attributes, lines 174-191). Substrate `exportRunAsOtlp` returns OTLP; the runner re-shapes it because `OtlpFileTraceStore` (0.25+) expects flat lines. Worth a substrate helper — every consumer reimplements this.
2. **`outcome.raw.cost_unknown = 1` flag** (`canonical-runner.ts:792`) + crude `Math.floor(body.length/4)` token estimate (line 771): streaming usage isn't extracted from SSE. Substrate's `cost-tracker.ts` is not used. This is the NaN→$0 silent-cost pattern flagged in user MEMORY.
3. **`InMemoryTrialCache`** imported in `run-prompt-evolution.ts:54` — fine for cli runs, but no durable trial cache: identical (variant, scenario, rep) cells re-fire across CLI invocations.
4. **`/traces` subpath import** (`analyst-loop.ts:41`, `trace-analyst-runner.ts:54`) is correct for 0.24+, but the comment in `trace-analyst-runner.ts:51-53` is historical narrative — violates the repo's "no historical comments" rule.
5. **Tangled history-narrative comments** in `analyst-loop.ts:139-150` ("The canonical runner emits OTLP-NDJSON directly during its trace-analyst step. Read it; nothing to project.") — fine.
6. **`production-loop` baseline version `v${PRODUCTION_LOOP_ADDENDUM_VERSION}`** (`index.ts:122,128`) — gate uses a string-versioned baselineKey but no schema for what triggers a version bump.
7. **`bootstrapCi` is imported** by control flow (`creative-workflow-optimization.ts:4`) but only one smoke-test exercises a clear ADVANCE/INCONCLUSIVE pair (`agent-eval.smoke.test.ts:120-135`). The actual prompt-evolution gate uses `pairedEvalueSequence` instead — two different stat backends in the same repo.
8. **Reward-hacking integration**: `extractVerifiableRewardsFromRecords` + `detectRewardHacking` are real wins (`canonical-runner.ts:349-365`), but the `verdict_index` encoding (lines 1053-1066) is a local fork of what should be a substrate helper.

## 5. Verdict + 5 highest-leverage upgrades

**Verdict:** The most substrate-fluent of the verticals. End-to-end real-product wiring (eval, prod chat, weekly cron, A/B), proper D1-D4 capture-integrity directives, anytime-valid stats in prod, family-aware judge ensembles with calibration gates, and a full analyst→PR loop. Two real surface gaps: no cost-aware Pareto and a stub knowledge corpus.

**Top 5 upgrades (impact-ordered):**

1. **Add `costUsd` as a Pareto objective and replace the SSE token-length heuristic with substrate `cost-tracker`.** Today the evolve loop can win composite while silently doubling spend — `outcome.raw.cost_unknown=1` is a smoke alarm with no listener. Strips the NaN→$0 anti-pattern.
2. **Seed `.agent-knowledge/`** with the existing reference corpus in `reference-prompts/` and `knowledge/`. Auto-apply at 0.85 is wired but inert with `sources: []`. One hour of seeding unblocks `knowledge-poisoning` and `wiki` analyst kinds.
3. **Tool-call fidelity dims.** Raw provider events already carry tool_calls (verified in `.evolve/raw-events/*.ndjson`). Add `scoreTurn` heuristics for: tool-call attempted when persona had `expectCreativeOpsPersistence`, tool-call diversity per turn, error-rate per tool. Surface to `outcome.raw` so prompt-evolution sees it.
4. **D1-backed FindingsStore for the Worker prod-loop.** The Worker app already has D1 via drizzle (`drizzle.config.ts`, `drizzle/`). Build a thin `D1FindingsStore` (JSONL contract → SQL rows) and surface findings to the deployed dashboard — JSONL on a Worker is local-disk-only on Node CLI; in CF prod findings vanish.
5. **Substrate red-team integration on outbound-marketing personas.** FTC-compliance + multi-client mediation + paid-pivot personas (`scenarios/outbound-marketing-personas.ts`) are the ideal target for `redTeamDataset/redTeamReport`. Currently they exist but as ordinary multi-turn — no adversarial-attack-tree coverage.

## Multi-turn / `conversation_flow` consolidation question

**Current state in creative-agent:** No `conversation_flow` field exists anywhere — neither in `eval/scenarios/`, `eval/canonical-personas.ts`, nor in any test file. The current shape is a flat `CreativeProductPersona.turns: CreativeProductTurn[]` (`scenarios/creative-product-personas.ts:1-20`), where each turn is `{id, userMessage, expectQuestion?, expectProposal?, expectCreativeOpsPersistence?, rejectFirstPendingProposal?, approveFirstPendingGeneration?, writeVaultFeedback?}`. `CanonicalPersona` extends it with optional `vault` (one of two structurally-compatible shapes) + `loadBearing` + `family` (`canonical-personas.ts:44-52`).

**Current state in substrate:** `MultiTurnScenarioPayload` does NOT exist in `agent-eval/src` (confirmed via `find … MultiTurn`). Substrate's multi-turn touchpoints are `judges.ts` (joining `turns` to text for coherence/groundedness judges) and `driver.ts` (`conversationHistory: { role, content }[]` for persona-driven message generation, `driver.ts:51-179`).

**Consolidation recommendation:** Wait. Two reasons:
1. Substrate has no `MultiTurnScenarioPayload` to consolidate into yet — the user's premise references a type that doesn't ship. Creative-agent's `CreativeProductTurn` carries domain-specific behavioral hooks (`writeVaultFeedback`, `approveFirstPendingGeneration`, `rejectFirstPendingProposal`) that are creative-only and would not survive a generic substrate type.
2. The scoring affordances (`expectQuestion`, `expectProposal`, etc.) are scored deterministically in `scoreTurn` (`canonical-runner.ts:811-865`). A substrate consolidation would either need a generic `expectedBehaviors: string[]` (loses determinism) or a behaviour-DSL hook.

The right substrate move is a `MultiTurnScenarioPayload<TBehavior>` generic that creative-agent + agent-builder both extend, NOT a flattening — and that should land in substrate first. Until it does, the current shape is correct.
