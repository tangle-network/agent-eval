# legal-agent ↔ @tangle-network/agent-eval@^0.31.1 — Integration Audit

Audit date 2026-05-22. Pinned `^0.31.1` at `/home/drew/code/legal-agent/package.json:81`. Pinned again via `pnpm.overrides` (`package.json:101,106`). Smoke test asserts the installed version is exactly `0.31.1` at `tests/eval/lib/agent-eval.smoke.test.ts:34`.

## 1. Import inventory (per file)

| File | Symbols pulled from `@tangle-network/agent-eval` (or sub-paths) |
| --- | --- |
| `tests/eval/canonical.ts:96-109` | `FileSystemRawProviderSink, FileSystemTraceStore, TraceEmitter, assertLlmRoute, assertRunCaptured, callLlmJson`; types `LlmClientOptions, RawProviderEvent, RawProviderSink, RunRecord, RunIntegrityReport, TraceStore` |
| `tests/eval/canonical.ts:122-140` | dynamic `import('@tangle-network/agent-eval')` for optional `extractPreferences` + `extractVerifiableRewardsFromRecords` (RL bridge — typeof-checked, degrades to `null`) |
| `tests/eval/analyst-loop.ts:33-40` | `AnalystRegistry, DEFAULT_TRACE_ANALYST_KINDS, FindingsStore, createTraceAnalystKind`; type `FindingSubject`. Sub-path `@tangle-network/agent-eval/traces` for `OtlpFileTraceStore` |
| `tests/eval/agent.config.ts:23` | `DEFAULT_TRACE_ANALYST_KINDS` |
| `tests/eval/run-prompt-evolution.ts:57-78` | `FileSystemRawProviderSink, FileSystemTraceStore, InMemoryTrialCache, TraceEmitter, assertLlmRoute, callLlmJson, discoverPersonas, pairedEvalueSequence, runPromptEvolution, withJudgeRetry`; types `EvolvableVariant, LlmClientOptions, MutateAdapter, Objective, PairedEvalueSequence, RawProviderEvent, RawProviderSink, ScoreAdapter, TrialResult, VariantAggregate` |
| `tests/eval/lib/autoresearch.ts:30-34` | `evaluateInterimReleaseConfidence`; type `InterimReleaseConfidence, RunRecord`. Dynamic load (`autoresearch.ts:89-110`) for `analyzeTraces, detectRewardHacking, OtlpFileTraceStore` |
| `tests/eval/lib/document-review-multishot.test.ts:2-7` | `defaultMultiShotObjectives, runMultiShotOptimization`; types `ActionableSideInfo, MultiShotVariant` |
| `tests/eval/lib/trace-sync.ts:14-21` | `FileSystemTraceStore, TraceEmitter, validateRunRecord`; types `LlmSpan, RunRecord, TraceStore` |
| `tests/eval/lib/trace-sync.test.ts:2` | `InMemoryTraceStore, isJudgeSpan` |
| `tests/eval/lib/agent-eval-runtime.ts:13-20` | `FileSystemTraceStore, InMemoryTraceStore, TraceEmitter`; types `FailureClass, Run, TraceStore` |
| `tests/eval/lib/metrics.ts:14` | `estimateCost, estimateTokens, iqr` |
| `tests/eval/lib/agent-eval.smoke.test.ts:11-24` | `bootstrapCi, defaultMultiShotObjectives, evaluateReleaseConfidence, hashContent, releaseTraceEvidenceFromMultiShotTrials, runMultiShotOptimization, trialTraceFromMultiShotTrial`; types `ActionableSideInfo, DatasetManifest, MultiShotTrialResult, MultiShotVariant, RunRecord` |
| `tests/eval/lib/traces-to-otlp.ts:24` | types `Run, Span, TraceEvent` |
| `scripts/calibrate-judges.ts:37-43` | `callLlmJson, calibrateJudge`; types `CandidateScore, GoldenItem, LlmClientOptions` |
| `scripts/grade-with-ensemble.ts:26` | `callLlmJson`; type `LlmClientOptions` |
| `scripts/harvest-candidate-outputs.ts:25` | `discoverPersonas` |
| `scripts/analyze-agent-eval-evidence.ts:3-13` | `FileSystemFeedbackTrajectoryStore, FileSystemTraceStore, budgetBreachView, failureClusterView, feedbackTrajectoriesToOptimizerRows, judgeAgreementView, summarizePreferenceMemory, toolWasteView`; type `FeedbackTrajectory` |
| `src/lib/.server/production-loop/index.ts:35-49` | `FileSystemTraceStore, FileSystemFeedbackTrajectoryStore, httpGithubClient, runProductionLoop`; types `FailureClusterConfig, MultiShotMutateAdapter, MultiShotRunner, MultiShotScorer, ProductionEvolveConfig, ProductionLoopResult, ProductionShipConfig, RunProductionLoopOptions, Scenario` |
| `src/lib/.server/agent-runtime/chat.ts:40` | `TraceEmitter` |
| `src/lib/.server/eval-evidence.ts:18` | type `FeedbackTrajectory` |
| `src/routes/api.vault.review.ts:2` | `ValidationError` |

## 2. Entry shape — `pnpm eval` → `tests/eval/canonical.ts`

The product ships **four** orchestrated entries (`package.json:30-34`):

- `pnpm eval` → `tests/eval/canonical.ts` (canonical matrix walker)
- `pnpm eval:evolve` → `tests/eval/run-prompt-evolution.ts` (prompt-evolution + ship-gate)
- `pnpm eval:calibrate` → `scripts/calibrate-judges.ts` (κ + Pearson + MAE vs human gold)
- `pnpm eval:harvest` → `scripts/harvest-candidate-outputs.ts` (raw agent outputs → gold corpus)
- `pnpm eval:improve` → `tests/eval/analyst-loop.ts` (analyst→knowledge+improvement adapters)

`canonical.ts` is built directly on the **live product runtime** (`runChatThroughRuntime` from `~/lib/.server/agent-runtime/chat`, `canonical.ts:156-159, 959-977`), not on a synthetic probe. Backend selection (`canonical.ts:189, 717-749`) is tri-modal — `tcloud`, `cli-bridge`, `sandbox` — feeding **one** `EvalBackendConfig` that powers both agent and judge with **no `TANGLE_API_KEY` fallback** for the judge (`canonical.ts:785-795`).

Capture wiring is **textbook substrate-correct**: `FileSystemRawProviderSink` per run dir (`canonical.ts:1327`), per-persona `FileSystemTraceStore` + `TraceEmitter` (`canonical.ts:1410-1411`), `assertLlmRoute` preflight (`canonical.ts:1296-1305`), and `assertRunCaptured(... requireRawCoverageOfLlmSpans: true, requireOutcome: true ...)` per persona (`canonical.ts:1048-1053`). The sandbox backend even synthesises paired raw events so the integrity invariant holds (`canonical.ts:646-689, 985-998`).

**Campaign-build**: legal does **not** use `runEvalCampaign` / `CampaignRunner`. Instead it spins its own durable persona loop via `@tangle-network/agent-runtime`'s `runDurable` + `FileSystemDurableRunStore` (`canonical.ts:1371-1464`), with a stable runId hashed from `commit+personas+backend+model+judge` (`canonical.ts:344-362`) so a crashed eval resumes from the last completed persona. Also includes a stale-lease reclaim path (`canonical.ts:373-388`) and an opt-in `LEGAL_EVAL_CRASH_AFTER_PERSONA` test hook (`canonical.ts:1454-1457`). This is the **most rigorous durability story across the four agent consumers** — gtm/tax/creative don't have it.

**Judges**: deterministic stub by default; `--judge llm` rebuilds the LLM judge against the same backend (`canonical.ts:805-860`). The judge prompt is compile-time-pinned to `LEGAL_RUBRIC` (`canonical.ts:801-815`) — adding a dimension fails type-check, not silently dropped.

**RunRecord persistence**: per persona, with rubric dimensions projected into `outcome.raw` (`canonical.ts:1087-1121, 1146-1154`).

**Trace persistence**: per-persona shards collected into one `traces.jsonl` (`canonical.ts:1126-1136, 1530-1533`). `raws.jsonl` is dumped from the sink (`canonical.ts:1535-1542`).

**RL bridge**: best-effort. `extractPreferences` / `extractVerifiableRewardsFromRecords` are dynamically loaded and degrade to `null` with an explicit "unavailable" note when absent (`canonical.ts:1506-1528`). Same pattern for `analyzeTraces` / `detectRewardHacking` in `lib/autoresearch.ts:89-111`.

**Analyst loop**: `tests/eval/analyst-loop.ts` projects per-persona traces to one OTLP file via the local `convertTraceStoresToOtlp` helper (`analyst-loop.ts:138-152`), builds an `AnalystRegistry` over `DEFAULT_TRACE_ANALYST_KINDS` (`analyst-loop.ts:167-172`), persists findings in a `FindingsStore` JSONL ledger (`analyst-loop.ts:175-177`), and drives `runAnalystLoop` (from `agent-runtime/analyst-loop`) with both `createSurfaceKnowledgeAdapter` and `createSurfaceImprovementAdapter`. Manifest `tests/eval/agent.config.ts:60-131` is the substrate's `defineAgent` declaration — surfaces validated against disk at module load.

**Promotion gate**: `run-prompt-evolution.ts:1090-1224` wires `pairedEvalueSequence` (anytime-valid e-value) as a ship gate with α=0.05, decisive SHIP/REJECT/INCONCLUSIVE verdicts, gate-driven replication when seeded pairs don't decide, and an auto-PR helper at `run-prompt-evolution.ts:1249-1276`. Gate trajectory persisted to `ship-gate.jsonl`.

**Calibration**: `scripts/calibrate-judges.ts` uses `calibrateJudge` to produce κ + Pearson + MAE + worst-5 miscalibrations per (judge × dimension), with N_MIN=8 hand-graded items per dim before trusting Pearson (`calibrate-judges.ts:50`). `scripts/grade-with-ensemble.ts` is the harvest companion that fills in ensemble grades on items missing `human_grade`.

**Production-loop wiring**: `src/lib/.server/production-loop/index.ts` builds a full weekly cron with `runProductionLoop`, multi-judge ensemble, cluster gate, holdout, e-value, auto-PR. **However** — `runWeekly` is **never invoked**: no `wrangler.toml` cron handler, no `server.ts` import, no scheduled binding. The module is dead code today.

## 3. Gaps vs the 0.31.1 substrate surface

| Substrate primitive (0.31.x) | Legal-agent status |
| --- | --- |
| `IntentMatchJudge` / `createIntentMatchJudge` (tool-call fidelity) | **Missing.** No tool-call shape rubric; legal exclusively scores final-text. |
| Multi-turn scenarios (`MultiShotVariant`/`MultiShotRun` w/ conversation_flow) | **Partial.** Personas have `conversation_flow` (`canonical.ts:182-185, 432-438`) and the eval iterates turns, but legal doesn't use the substrate's `MultiShotOptimizationResult` multi-turn primitives — only the document-review *test* (`document-review-multishot.test.ts`) hits `runMultiShotOptimization`. |
| Adversarial / red-team probe suite (`redTeamReport`, `DEFAULT_RED_TEAM_CORPUS`, `scoreRedTeamOutput`, 0.95 pass-rate gate) | **Missing.** Personas 11-15 are labelled `eval_type: adversarial_resilience` (file-named only), but the substrate's red-team primitives are not imported anywhere. No 0.95-pass-rate gate. |
| Streaming-quality dim (TTFT/stall/P95 via `MetricSamples`/`MetricVerdict`) | **Missing.** No latency-quality dim recorded. `costUsd: 0, tokenUsage: { input: 0, output: 0 }` in every legal RunRecord (`canonical.ts:1103-1104, 1207`). |
| Knowledge-authoring rubric | **Partial.** `createSurfaceKnowledgeAdapter` writes wiki pages (`analyst-loop.ts:180-197`); no dedicated *scoring* rubric of authored knowledge quality. |
| Integration-grant rubric (`integrationGateEvals`, `IntegrationGateSurface`) | **Missing.** Legal is OAuth-grant heavy (`@tangle-network/agent-integrations@^0.28.0` from `package.json:74`) but no integration-grant evals. |
| Differential A/B (`pairedWilcoxon`, `pairedBootstrap`, Cliff's δ) | **Missing.** `pairedEvalueSequence` is wired in evolve, but `pairedWilcoxon` / `pairedBootstrap` / Cliff's delta are *not* used. `bootstrapCi` is only smoke-tested (`agent-eval.smoke.test.ts:97-120`), never on real legal data. |
| `/evolve` unfreeze gate (`HoldoutAuditor` / `HeldOutGate`) | **Missing.** `HeldOutGate` not imported. `production-loop/index.ts:134-139` uses an inline `gate: { ... pairedDeltaThreshold, overfitGapThreshold }` config but the loop itself is dead code (never invoked). |
| Cost-aware Pareto judge selection | **Missing.** `OBJECTIVES` (`run-prompt-evolution.ts:976-997`) is a 4-axis Pareto over score + 3 rubric dims; **cost is not an axis**. `MODEL_PRICING` not imported anywhere. |
| D1-backed `FindingsStore` / `D1ExperimentStore` | **Missing.** Findings persisted to local `.evolve/findings/findings.jsonl` (`analyst-loop.ts:175-177`). Acceptable for laptop runs; not deployable as is. |
| Patch proposer queue | **Wired but local.** `createSurfaceImprovementAdapter` (`analyst-loop.ts:199-207`) drafts patches via LLM and auto-opens PRs at ≥0.9 confidence. Not queued — every loop run proposes against `HEAD`. |
| Prod trace harvest cron | **Schema only.** `production-loop/index.ts:124-125` consumes `FileSystemTraceStore` and `FileSystemFeedbackTrajectoryStore` but the cron handler is unwired (see §2). `recordFeedbackTrajectory` calls in `src/lib/.server/eval-evidence.ts:251-276` *do* persist trajectories at chat time, but no scheduled job ever ingests them. |
| `runEvalCampaign` / `CampaignRunner` | **Missing.** Legal uses its own `runDurable` loop instead. |
| `JudgeScoresRecord` on `RunOutcome` (new in 0.31.0) | **Missing.** Per-judge raw scores are stuffed into `metrics.judgeScores` via a `Record<string, RecordOfNumber> as unknown as number` cast (`run-prompt-evolution.ts:809-815`) instead of riding `outcome.judgeScores`. Drift comment at `:810` explicitly admits this. |
| Backend-integrity guard (`BackendIntegrityReport`, 0.31.0) | **Missing.** Not imported. Capture invariants are enforced via `assertRunCaptured`; backend-integrity report is the newer broader check. |

## 4. Drift — open-coded patterns shadowing substrate primitives

1. **Hand-rolled `captureFetchFor` + `buildRawEvent`** at `canonical.ts:456-572` (HTTP request/response → `RawProviderEvent`) and the **duplicated** copy at `run-prompt-evolution.ts:477-520`. Substrate ships `defaultProviderRedactor` + `providerFromBaseUrl` + the `FileSystemRawProviderSink` already; what's missing here is a packaged "wrap fetch → sink" helper, so the open-code is partly the substrate's fault. **Still — two copies in one repo is drift.**
2. **Hand-rolled `objectiveComposite` + `clamp01`** at `run-prompt-evolution.ts:116-139`. Substrate exports `clamp01` and `weightedMean`.
3. **Hand-rolled `judgeFamily` self-judging guard** at `run-prompt-evolution.ts:333-395`. Genuinely unique policy logic, but worth lifting into the substrate (cross-pollination opp — see below).
4. **Hand-rolled `aggregateEnsemble`** in `tests/eval/lib/scoring.ts:464+` for ensemble-of-judges → per-judge + max-disagreement. Substrate ships `corpusInterRaterAgreementFromJudgeScores` and `ContinuousAgreement` — explicit `continuousAgreement` TODO comment at `run-prompt-evolution.ts:810` confirms drift.
5. **Hand-rolled `unifiedDiff`** at `run-prompt-evolution.ts:1013-1028`. Not in the substrate, but worth noting it's open-coded.
6. **Hand-rolled `hashHex`** at `canonical.ts:1229-1243` because `RunRecord.promptHash` requires `/^[0-9a-f]{64}$/`. Substrate's `hashContent` returns 12 hex chars (`agent-eval.smoke.test.ts:90`), not 64 — substrate gap, not consumer drift.
7. **`saveMetricsToTraceStore` dual-write** at `tests/eval/lib/metrics.ts:164-171` — best-effort sync from legacy metrics file to `FileSystemTraceStore`. The legacy `metrics/runs.jsonl` channel is the canonical metric (`metrics.ts:161-163`); the trace store gets a dual-write copy with a `try/catch{}` that **violates the project's no-fallback doctrine** (silent catch around `saveMetricsToTraceStore` in `metrics.ts:169-171`).
8. **Dead `src/lib/.server/production-loop/index.ts`** — entire module references `^0.25.0` in the file header (`production-loop/index.ts:4`) but the package is at `^0.31.1`. The cron is never bound. Either delete or wire.
9. **Lazy dynamic-import shim for `extractPreferences` / `analyzeTraces` / `OtlpFileTraceStore`** (`canonical.ts:122-140`, `lib/autoresearch.ts:89-111`) — these have been in the substrate's public entry since 0.27/0.29. The "graceful degrade to null" is no longer needed at 0.31.1; the static import works.

## 5. Verdict + top 5 upgrades

**Verdict: A−.** Legal is the **most substrate-disciplined of the four agent consumers** — full capture-integrity directive chain (raw sink + assertLlmRoute + assertRunCaptured + per-persona sharding), durable resume across crashes, unified backend (agent+judge), cross-family judge enforcement, real LLM rubric + κ-calibrated gold corpus, anytime-valid e-value ship gate. Real product code (`api.vault.review.ts` consumes `ValidationError`, `chat.ts` consumes `TraceEmitter`). Where the other consumers stop at "we wrote an eval", legal has the eval **and** the analyst-loop **and** the calibration **and** the ship gate, all hitting the live product runtime.

Loses points for: (a) dead production-loop module pinned to `^0.25.0`; (b) duplicate `captureFetchFor` between canonical.ts and run-prompt-evolution.ts; (c) no adversarial / red-team suite despite labelling 5 personas `adversarial_resilience`; (d) zero cost/token accounting (`costUsd: 0` hard-coded everywhere); (e) `JudgeScoresRecord` not adopted at the `RunOutcome` level.

**Five highest-leverage upgrades:**

1. **Adopt the red-team suite + 0.95 pass-rate gate.** Personas 11-15 already exist (`tests/eval/personas/11-entity-type-change.yaml` ... `15-contradictory-info.yaml`). Wire `DEFAULT_RED_TEAM_CORPUS` + `redTeamReport` + `scoreRedTeamOutput`. Add a gate to `runShipGate` that REJECTS if red-team pass rate < 0.95 — partner-tier legal advice cannot soft-fail adversarial.
2. **Add cost as a Pareto axis + populate `costUsd`/`tokenUsage`.** Today `RunRecord.costUsd: 0` (`canonical.ts:1103-1104, 1207`) and `tokenUsage: { input: 0, output: 0 }`. Capture from the raw response in the fetch wrapper, push through to `outcome`, and add `{ name: 'costUsd', direction: 'minimize' }` to `OBJECTIVES` (`run-prompt-evolution.ts:976`). Pareto then dominates the "spend 8× tokens for 1pp gain" failure mode.
3. **Move per-judge scores onto `outcome.judgeScores: JudgeScoresRecord` (0.31.0 surface).** Current `Record<string, ...> as unknown as number` cast in `run-prompt-evolution.ts:809-815` is documented drift; fixing it unblocks downstream queries via `corpusInterRaterAgreementFromJudgeScores` and removes the type-cast hack.
4. **Wire `pairedBootstrap` + Cliff's δ alongside `pairedEvalueSequence`.** The e-value gate is anytime-valid but α=0.05; pairing it with `pairedBootstrap` gives both a fixed-n confidence interval and an effect-size verdict. Same input data — `trialsLog` paired by `(scenarioId, rep)` — already available at `run-prompt-evolution.ts:1066-1088`.
5. **Either wire `production-loop/runWeekly` to a real cron or delete the module.** It's the substrate's single-call full automation primitive (cluster → evolve → gate → auto-PR), uses `httpGithubClient`, and is the *exact* shape `legal-agent` says it wants weekly. Wire it to a Cloudflare cron in `wrangler.toml` (`0 6 * * MON`) and bind `GITHUB_TOKEN`; or remove the dead file.

## Bonus — UNIQUE patterns worth pollinating sideways

1. **Durable persona loop with stale-lease reclaim** (`canonical.ts:344-388, 1371-1464`). A crashed eval resumes from the first incomplete persona; persona-level runtime failures are checkpointed as deterministic failure results so resume doesn't re-bill them. Includes a `LEGAL_EVAL_CRASH_AFTER_PERSONA` test hook (`canonical.ts:1454-1457`). **Tax/creative/gtm have none of this** — all three rebuild the matrix on every invocation. Lift the helper into the substrate as `runDurableEval` or similar.
2. **Cross-family judge enforcement** (`run-prompt-evolution.ts:333-395`) — `judgeFamily` maps judge model id → family slug, default ensemble drops same-family judges, `--allow-self-judging` is the only escape. Currently legal-specific code but the policy is universal (self-preference is the #1 ensemble failure mode). **Lift to the substrate.**
3. **Compile-time-pinned judge prompt schema** (`canonical.ts:801-815`) — `Record<LegalRubricDimension, number>` projection so adding a rubric dim fails type-check rather than silently dropping. Pattern generalises to any closed-set rubric.
4. **Single `EvalBackendConfig` for agent+judge with no-fallback policy** (`canonical.ts:702-795`) — explicit ban on `TANGLE_API_KEY` fallback when the agent runs on cli-bridge. This is the kind of pattern the substrate's `assertLlmRoute` is meant to catch but doesn't enforce per-site; codify as `assertSingleBackend(agent, judge)`.
5. **`buildPersonaErrorResult`** (`canonical.ts:1171-1223`) — turning a persona-level runtime crash into a checkpointed *failure* `PersonaStepResult` so `runDurable` resumes past it rather than re-running. Generalisable to any per-scenario step in any substrate-driven loop.
