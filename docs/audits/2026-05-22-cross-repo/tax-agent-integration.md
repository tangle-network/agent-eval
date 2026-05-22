# tax-agent → @tangle-network/agent-eval integration

Substrate pin: `^0.31.1` (`/home/drew/code/tax-agent/package.json:32,40`), with pnpm override pinning the same version (line 32) so workspace-resolved versions can't drift.

## 1. Imports inventory

Root entry `@tangle-network/agent-eval`:

- `tests/eval/canonical.ts:68-79` — `TraceEmitter, FileSystemTraceStore, FileSystemRawProviderSink, assertLlmRoute, assertRunCaptured, validateRunRecord, type LlmClientOptions, type RawProviderSink, type RawProviderEvent, type RunRecord`
- `tests/eval/analyst-loop.ts:32-38` — `AnalystRegistry, DEFAULT_TRACE_ANALYST_KINDS, type FindingSubject, FindingsStore, createTraceAnalystKind`
- `tests/eval/agent.config.ts:21` — `DEFAULT_TRACE_ANALYST_KINDS`
- `tests/eval/calibrate-judges.ts:40-46` — `callLlmJson, calibrateJudge, type CandidateScore, type GoldenItem, type LlmClientOptions`
- `tests/eval/run-prompt-evolution.ts:66-87` — `FileSystemRawProviderSink, FileSystemTraceStore, InMemoryTrialCache, TraceEmitter, assertLlmRoute, callLlmJson, discoverPersonas, pairedEvalueSequence, runPromptEvolution, withJudgeRetry, type EvolvableVariant, type LlmClientOptions, type MutateAdapter, type Objective, type PairedEvalueSequence, type RawProviderEvent, type RawProviderSink, type ScoreAdapter, type PromptTrialResult, type VariantAggregate`
- `tests/eval/run-production-loop.ts:61-76` — `callLlmJson, TraceEmitter, FileSystemTraceStore, FileSystemRawProviderSink, type EvolvableVariant, type LlmClientOptions, type MultiShotMutateAdapter, type MultiShotRun, type MultiShotRunner, type MultiShotScore, type MultiShotScorer, type RawProviderEvent, type RawProviderSink, type Scenario`
- `tests/eval/optimize.ts:28-35` — `defaultMultiShotObjectives, runMultiShotOptimization, type MultiShotTrialResult, type MultiShotVariant, type RunRecord, type RunSplitTag`
- `tests/eval/harvest-gold-items.ts:60` — `callLlmJson, type LlmClientOptions`
- `tests/eval/lib/production-loop.ts:37-51` — `FileSystemFeedbackTrajectoryStore, FileSystemTraceStore, httpGithubClient, runProductionLoop, type FailureClusterConfig, type MultiShotMutateAdapter, type MultiShotRunner, type MultiShotScorer, type ProductionEvolveConfig, type ProductionLoopResult, type ProductionShipConfig, type RunProductionLoopOptions, type Scenario`
- `tests/eval/lib/agent-eval-runtime.ts:15-22` — `FileSystemTraceStore, InMemoryTraceStore, TraceEmitter, type FailureClass, type Run, type TraceStore`
- `tests/eval/lib/trace-sync.ts:14-21` — `FileSystemTraceStore, TraceEmitter, type LlmSpan, type RunRecord, type TraceStore, validateRunRecord`
- `tests/eval/lib/metrics.ts:11` — `estimateCost, estimateTokens, iqr`
- `tests/eval/lib/live-tax-workflow-runner.ts:6-11` — `estimateTokens, validateRunRecord, type ActionableSideInfo, type RunRecord`
- `tests/eval/lib/deterministic-tax-workflow-runner.ts:6-15` — `defaultMultiShotObjectives, runMultiShotOptimization, type MultiShotRun, type MultiShotTrialResult, type MultiShotVariant, type RunRecord` (etc.)
- `tests/eval/lib/research-report.ts:42-46` — `evaluateInterimReleaseConfidence, type RunRecord, type InterimReleaseConfidence`
- `tests/eval/lib/agent-eval.smoke.test.ts:17-29` — `bootstrapCi, defaultMultiShotObjectives, runMultiShotOptimization, releaseTraceEvidenceFromMultiShotTrials, trialTraceFromMultiShotTrial, type MultiShotTrialResult, type MultiShotVariant` and dataset types
- `tests/eval/lib/document-review-multishot.test.ts:1-7` — multi-shot policy primitives + `ActionableSideInfo`
- `tests/eval/lib/traces-to-otlp.ts:33` (type-only) and `traces-to-otlp.test.ts:19` — `FileSystemTraceStore`, `Run`, `Span`, `TraceEvent`

Subpath `/rl`:

- `tests/eval/canonical.ts:80-87` — `extractPreferences, extractVerifiableRewardsFromRecords, detectRewardHacking, type PreferenceExtractionReport, type RewardHackingReport, type VerifiableReward`
- `tests/eval/lib/research-report.ts:53-59` — `detectRewardHacking, extractPreferences, extractVerifiableRewardsFromRecords, type RewardHackingReport, type PreferenceExtractionReport, type VerifiableReward`

Subpath `/traces`:

- `tests/eval/analyst-loop.ts:39` — `OtlpFileTraceStore`
- `tests/eval/lib/research-report.ts:47-51` — `analyzeTraces, OtlpFileTraceStore, type AnalyzeTracesResult`

**Not imported from anywhere**: `/control`, `/optimization`, `/reporting`, `/telemetry`, `/wire`, `/benchmarks`, `/pipelines`, `/meta-eval`, `/prm`, `/builder-eval`, `/governance`, `/knowledge` (verified via `grep -rEh` over `tests/eval`, `apps`, `server`, `packages`).

## 2. Integration shape

**Eval entry.** `tests/eval/canonical.ts` is canonical (`pnpm eval`, `package.json:11-13`). It iterates `tests/eval/personas/*.yaml`, drives each through `runChatThroughRuntime` from `packages/api-worker/src/services/agent-runtime/chat.ts` (real production chat handler), and writes a self-contained `tests/eval/.runs/<run-id>/` bundle with `raws.jsonl`, `traces.jsonl` (sharded per persona), `records.jsonl`, `scores.json`, `rl-bridge.json`, `manifest.json`, plus `research-report.md`. Three more entries layer on: `optimize.ts` (multi-shot canned variants), `run-prompt-evolution.ts` (`pnpm eval:evolve`, reflective addendum mutation through `runPromptEvolution`), `run-production-loop.ts` + `lib/production-loop.ts` (`pnpm eval:production-loop`, weekly `runProductionLoop` with `httpGithubClient` PR), `analyst-loop.ts` (`pnpm eval:improve`, `runAnalystLoop` from agent-runtime, ledger via `FindingsStore`), `calibrate-judges.ts` (`pnpm eval:calibrate`, `calibrateJudge`), `harvest-gold-items.ts` (`pnpm eval:harvest`, populates `tests/eval/gold/tax-calibration.json`).

**Campaign shape.** `canonical.ts:150-169` defines `CanonicalEvalConfig` (persona filters, backend kind, model, prompt variants, comparator, max-turns, seed, turn-timeout, runs root). Two default `PromptVariant`s at `canonical.ts:239-257`: `baseline-generic` and `source-grounded-v1`. Per-persona × variant × seed=0 cell → `runRecord` validated with `validateRunRecord` (`canonical.ts:817`). It does NOT use the substrate's `EvalCampaign`/`runCampaign` orchestrator — campaign logic is hand-rolled in `runPersona` / `runPersonaVariant` (`canonical.ts:580-829`).

**Judges.** Two paths:
- Verifiable rubric (canonical default): `lib/tax-ground-truth.ts` keyword-scores transcript across 8 dims (filing_status, jurisdiction, prior-return-forms, authority-citation, risk-tier, multi-state-awareness, shelter-refusal, circular-230). Deterministic, no LLM. `canonical.ts:742`.
- LLM ensemble: `lib/judge-ensemble.ts` provides `DEFAULT_CLI_BRIDGE_JUDGES = ['kimi-code/kimi-k2.6', 'opencode/zai-coding-plan/glm-5.1', 'opencode/deepseek/deepseek-v4-pro']` (line 20-24) with self-judging exclusion (line 100-132). Used by `calibrate-judges.ts`, `run-prompt-evolution.ts:scoreWithLlmJudge`, `harvest-gold-items.ts`, and `lib/production-loop.ts`. Composite = mean across ALL judges per dimension, then weighted by `OBJECTIVE_WEIGHTS = { filing_status: 0.5, forms: 0.3, jurisdiction: 0.2 }` (`production-loop.ts:73-77`). 3-judge ensemble is real; uses `withJudgeRetry` (`run-prompt-evolution.ts:87`).

**Trace persistence.** `FileSystemTraceStore` ONLY — one per persona×variant cell under `.runs/<id>/personas/<persona>/<variant>/` (canonical.ts), and one root store under `.production-loop/<id>/traces/` (production-loop). Plus `FileSystemFeedbackTrajectoryStore` for production-loop feedback (`lib/production-loop.ts:123`). `OtlpFileTraceStore` is used as a read-projection target in `lib/traces-to-otlp.ts` for the analyst path. NO D1 / DurableObject backing. `FindingsStore` is filesystem (`.evolve/findings/findings.jsonl`, `analyst-loop.ts:172-174`).

**Analyst loop.** Wired and idiomatic. `analyst-loop.ts:32-242` uses `AnalystRegistry`, `createTraceAnalystKind`, `DEFAULT_TRACE_ANALYST_KINDS`, `FindingsStore`, `OtlpFileTraceStore`, plus `runAnalystLoop` from `agent-runtime/analyst-loop`. Both `createSurfaceImprovementAdapter` (mode `open-pr`, conf ≥ 0.9) and `createSurfaceKnowledgeAdapter` (mode `write`, conf ≥ 0.85) are wired from `taxAgent.autoApply` (`agent.config.ts:154-157`). The manifest at `agent.config.ts:33-158` validates surfaces against disk at module-load via `defineAgent`.

**Promotion gate.** `pairedEvalueSequence` (anytime-valid e-value) is wired in `run-prompt-evolution.ts:1244,1288` as the ship gate after GA selects a winner. `runPromptEvolution` provides held-out gating internally (substrate). `HeldOutGate` config inside `production-loop.ts:132-137`. `pairedWilcoxon` and `pairedBootstrap` are NOT used. `bootstrapCi` is only used in the smoke test (`lib/agent-eval.smoke.test.ts:104,114`), not on hot promotion paths. The RL bridge in `canonical.ts:931-948` computes paired deltas manually (lines 950-974) rather than calling a substrate stat primitive.

**Calibration.** Real and idiomatic. `calibrate-judges.ts` runs `calibrateJudge` (substrate) per (judge × dimension), pulls Pearson + κ + MAE, and warns when r < 0.6 (line 372-389). Gold dataset at `tests/eval/gold/tax-calibration.json` with `human_grade` items consumed by `calibrate-judges.ts:216-228`. `corpusInterRaterAgreement` / `corpusInterRaterAgreementFromJudgeScores` are NOT used — calibration is per-judge against humans, never judge-vs-judge IRR.

**Real-product surface.** Yes — three rungs:
1. `canonical.ts` default `--backend sandbox` calls `createSandboxPromptBackend` against the deployed sandbox (`canonical.ts:1142-1185`) — production-shape, the exact path `/api/chat` drives.
2. `--backend tcloud` rides router.tangle.tools/v1 via `createOpenAICompatibleBackend` (`canonical.ts:1010-1031`).
3. `lib/live-tax-workflow-runner.ts` shells out to `tests/integration/run_tax_e2e_sdk.mts` (line 48) — a full e2e through the deployed product including form generation + validation + download. Invoked from `optimize.ts:389`. This is the most authentic production surface — it exercises real artifacts, not just chat-stream text.

All paths wrap raw HTTP through `FileSystemRawProviderSink` via `captureFetchFor` (`canonical.ts:436-509`) and gate runs with `assertLlmRoute` + `assertRunCaptured` (capture-integrity directives — `canonical.ts:756-771`).

## 3. Gaps relative to substrate's 0.31.1 surface

| Substrate primitive | tax-agent status |
| --- | --- |
| `JudgeScoresRecord` typed field on `RunRecord.outcome.judgeScores` (0.31.0) | **MISSING** — tax-agent stuffs per-judge scores as a JSON-encoded string into `trial.metrics.judgeScores` (`run-prompt-evolution.ts:891-902`). Substrate added a typed field; tax-agent is still on the side-channel pattern with a deliberate `as unknown as Record<string, number>` cast (line 902). Drift. |
| `corpusInterRaterAgreement` / `corpusInterRaterAgreementFromJudgeScores` | **MISSING**. Judge calibration measures judge↔human, never judge↔judge across the corpus. The 3-judge ensemble's IRR is unknown. |
| `pairedWilcoxon`, `pairedBootstrap` | **MISSING**. Manual paired delta math at `canonical.ts:950-974`. |
| `bootstrapCi` on promotion path | **MISSING in prod path** — only the smoke test exercises it. `pairedEvalueSequence` covers the sequential-anytime case but two-sample CI is unused. |
| Tool-call-fidelity rubric (deterministic args/order matchers) | **MISSING**. Tax workflow has structured tool calls (`PROPOSED_FORM`, form generators, download endpoints) but no fidelity scoring — `scoreVerifiableRubric` is keyword-only over transcript text. |
| Multi-turn harness | **PARTIAL**. canonical.ts uses 2 turns (intake + clarifying — `canonical.ts:359-362,387-399`); deterministically scripted from YAML, not adversarial multi-turn. |
| Adversarial probes | **MISSING**. `document-review-multishot.test.ts:52` mentions "adversarial document flows" but only tests three deterministic scenarios. No prompt-injection, no jailbreak, no contradictory documents probes wired to the canonical sweep. |
| Streaming quality dim (TTFT / stall / P95) | **MISSING**. `drainStream` (`canonical.ts:832-859`) does turn-timeout only — no TTFT or inter-token-latency capture. Raw events do carry `durationMs`, but no dim consumes it. |
| Knowledge-authoring rubric | **MISSING**. Knowledge is consumed (the analyst loop *writes* knowledge via `createSurfaceKnowledgeAdapter`) but never scored. |
| Integration-grant rubric | **MISSING**. tax-agent uses `@tangle-network/agent-integrations` (per `package.json:46`) but there's no grant rubric in eval. |
| Differential A/B harness | **MISSING**. Variant comparison is paired-by-(scenario,seed), not A/B with traffic split — no `runDifferentialAB` style primitive. |
| `/evolve` unfreeze gate (Pearson + adversarial + baseline-days) | **MISSING**. Calibration warns but doesn't freeze/unfreeze the loop. |
| Cost-aware Pareto judge selection | **MISSING**. The 3-judge ensemble is fixed; no cost-aware reduction. |
| D1-backed FindingsStore / TraceStore | **NOT WIRED**. Filesystem only. (Substrate exposes the abstract `TraceStore` interface; tax-agent's `agent-eval-runtime.ts:48-74` only instantiates `FileSystemTraceStore`.) |
| Patch proposer queue | **PARTIAL**. The analyst loop's `improvementAdapter` (`analyst-loop.ts:196-204`) drafts patches LLM-side and opens PRs at conf ≥ 0.9. No persistent queue of pending patches the operator can groom across runs. |
| Prod trace harvest cron | **PARTIAL**. `runWeekly` cron is scaffolded (`production-loop.ts:118-167`) but the trace ingestion side (production traffic → TraceStore) currently expects manually populated dirs — the wrangler cron is a "surface signal" per the docstring at `run-production-loop.ts:28-35`. |
| `releaseTraceEvidenceFromMultiShotTrials` / `trialTraceFromMultiShotTrial` | **TEST-ONLY** — exercised in `agent-eval.smoke.test.ts:86,176` but not in any production code path. |
| `EvalCampaign` / `runCampaign` orchestrator | **NOT USED**. Per-persona loop is hand-rolled in canonical.ts. Acceptable for the bespoke verifiable rubric but means new substrate orchestrator features (cohort retries, fingerprint inheritance) don't apply. |

## 4. Drift / staleness

- `run-prompt-evolution.ts:885-902` open-codes judge-score persistence as a JSON-encoded blob inside a `Record<string, number>` cast. Substrate 0.31.0 shipped `RunRecord.outcome.judgeScores: JudgeScoresRecord` (`/home/drew/code/agent-eval/src/run-record.ts:66`); tax-agent didn't migrate. The cast comment (line 889-891) acknowledges the boundary violation.
- `canonical.ts:950-974` (`collectPairedDeltas`) manually computes paired deltas via map-join + difference. Substrate has `pairedWilcoxon` + `pairedBootstrap` (`/home/drew/code/agent-eval/src/paired-stats.ts:62,128`) and `bootstrapCi` (`/home/drew/code/agent-eval/src/promotion-gate.ts:65`) — none used.
- `lib/traces-to-otlp.ts:85` carries a comment "`agent-eval ≤0.23.0`'s `FileSystemTraceStore.load()` did NOT merge…" — module hand-reads NDJSON to work around a fixed bug. Worth re-checking whether the workaround is still required against 0.31.1.
- `calibrate-judges.ts:8` claims it returns "κ + Pearson + MAE + worst-5 miscalibrations." Substrate's `calibrateJudge` is invoked correctly; worst-5 is not rendered in the printed table (line 372-389) — slight feature lag, not a bug.
- `run-production-loop.ts:6` and `lib/production-loop.ts:4` reference `@tangle-network/agent-eval@^0.25.0` in the docstring while the actual pin is `^0.31.1`. Stale comment.
- The judge ensemble is hand-rolled (`lib/judge-ensemble.ts`) rather than reaching for any `EnsembleScorer`-style substrate primitive — fine if substrate doesn't ship one, but the family detection (`FAMILY_PATTERNS` at lines 26-37) is tax-agent-local string-matching that other consumers will need to re-implement; candidate for substrate promotion.

## 5. Quality verdict

This is a real eval surface, not theater. It exercises three actual production paths (sandbox-backed `runChatThroughRuntime`, router-backed runtime, and full e2e through `tests/integration/run_tax_e2e_sdk.mts` with form generation/validation/download), captures raw provider HTTP, validates run records, and gates capture integrity per cell. The analyst loop is wired end-to-end with both improvement and knowledge adapters auto-applying at confidence thresholds. The substrate is used for: traces, raw sinks, persona discovery, RL bridge, multi-shot optimization, prompt evolution with sequential e-value gates, weekly production loop with PR-shipping, judge calibration with Pearson/κ/MAE, and analyst findings ledger. Strengths: real production transports, capture-integrity discipline, 3-family judge ensemble with self-judging exclusion, two-tier (verifiable + LLM-judge) scoring keeping deterministic ground truth in the loop. Weaknesses: judge-vs-judge IRR is uncomputed (the 3-judge ensemble could be silently correlated), `bootstrapCi`/`pairedWilcoxon` are unused on the promotion path, no tool-call-fidelity dim despite structured `PROPOSED_FORM` output, no adversarial probes, no D1-backed persistence, and the 0.31.0 typed `JudgeScoresRecord` field is bypassed in favor of a string side-payload. **Single biggest gap**: judge-vs-judge inter-rater-agreement is never measured (`corpusInterRaterAgreement` unused), so the 3-judge ensemble could be a single-judge in trench coat and no signal would fire.

## 6. Concrete next-action list

1. **Wire `corpusInterRaterAgreementFromJudgeScores`** into `lib/production-loop.ts` and `run-prompt-evolution.ts`. Run it after every variant scoring pass; warn when the lowest pairwise κ < 0.5 (the ensemble has collapsed to one opinion). High-leverage — directly invalidates current scores when broken.
2. **Migrate per-judge scores from `metrics.judgeScores` string blob to `RunRecord.outcome.judgeScores: JudgeScoresRecord`** (`run-prompt-evolution.ts:885-902`, all canonical record writes). Eliminates the cast hack, lets downstream tooling consume the typed field, unblocks substrate-level analytics over judge dispersion.
3. **Replace `collectPairedDeltas` + manual baseline math (`canonical.ts:950-974`) with `pairedWilcoxon` + `pairedBootstrap`** and add a `bootstrapCi`-backed advance/keep/inconclusive verdict at the top of the RL bridge artifact. The smoke test already proves the substrate primitive works for the verdict shape.
4. **Add a tool-call-fidelity rubric** matching `PROPOSED_FORM` invocations + line-value structure deterministically. `lib/tax-ground-truth.ts` currently checks text-only keywords; a tool-call matcher catches structural regressions (missing line 25a, wrong form id) that keyword matching glances over.
5. **Add adversarial probes to the canonical sweep**: prompt-injection in persona statements, contradictory documents (one persona's `human_errors` already names a wrong belief — extend to multi-document conflicts and document-vs-instruction conflicts), and shelter-refusal jailbreaks. Score via the existing 3-judge ensemble plus a hard-fail dim for any positive jailbreak response. Pairs with #1 — adversarial coverage is meaningless without IRR confirming the judges agree on the failure.
