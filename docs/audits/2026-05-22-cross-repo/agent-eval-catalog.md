# Agent-eval substrate catalog (v0.31.1)

Source of truth: `/home/drew/code/agent-eval/src/index.ts` (1167 lines) plus
the 12 subpath entries declared in `package.json.exports`. Inspected at HEAD
commit `f7a567f` on branch `main`.

## 1. Entry points

| Subpath | Source | One-line role |
|---|---|---|
| `.` (root) | `src/index.ts` | Everything — types, judges, driver, evaluators, registry, run-record, statistics, RL adapters, trace types, integrity guards. |
| `./control` | `src/control.ts` | Control runtime + action policy + propose/review + RunRecord evidence (`controlRunToRunRecord`). |
| `./optimization` | `src/optimization.ts` | EvalCampaign + multi-shot + prompt-evolution + reflective-mutation + researcher + feedback-trajectory. |
| `./reporting` | `src/reporting.ts` | Promotion-gate, paired stats, release confidence, sequential e-values, research/summary reports. |
| `./rl` | `src/rl/index.ts` | RL bridge: preferences, verifiable rewards, PRM, off-policy, tournaments, contamination probes, compute curves, exporters. |
| `./traces` | `src/traces.ts` | `replay` + `trace` + `trace-analyst` (everything trace-related in one import). |
| `./telemetry` | `src/telemetry/index.ts` | Workers-safe telemetry client + HTTP/InMemory/Null/Fanout sinks. |
| `./telemetry/file` | `src/telemetry/file.ts` | Node-only file sink (kept separate so workers don't pull `node:fs`). |
| `./wire` | `src/wire/index.ts` | HTTP/RPC server, Zod schemas, OpenAPI emitter, builtin rubrics. |
| `./benchmarks` | `src/benchmarks/index.ts` | `BenchmarkAdapter` contract, deterministic split, `routing` synthetic benchmark. |
| `./pipelines` | `src/pipelines/index.ts` | Views over a `TraceStore`: budget-breach, failure-cluster, first-divergence, judge-agreement, regression, stuck-loop, tool-waste. |
| `./meta-eval` | `src/meta-eval/index.ts` | Calibration curves, correlation studies, deployment-outcome store, rubric-predictive-validity. |
| `./prm` | `src/prm/index.ts` | Process reward model: rubric, builtin rubrics, best-of-N inference, training-data export. |
| `./builder-eval` | `src/builder-eval/index.ts` | Builder-of-builders: `BuilderSession`, `ProjectRegistry`, `scoreProject` (three-layer), correlation. |
| `./governance` | `src/governance/index.ts` | EU AI Act / NIST AI RMF / SOC2 templates (also re-exported at root). |
| `./knowledge` | `src/knowledge/index.ts` | Knowledge-readiness scoring + types (also re-exported at root). |
| `./openapi.json` | `dist/openapi.json` | Generated OpenAPI spec for the wire surface. |
| `agent-eval` (bin) | `dist/cli.js` | CLI binary (serve, openapi emit). |

## 2. Primitives by capability area

### Run record + outcome shape (`src/run-record.ts`, root)

- type **`RunRecord`** — canonical eval-record envelope (id, scenarioId, variantId, outcome, integrity, splitTag, timestamps, costs, run-record validation pinned at module boundary).
- type **`RunOutcome`** — composite + scalar (`{ composite, raw?, judgeScores? }`).
- type **`JudgeScoresRecord`** (NEW 0.31) — `{ perJudge[judgeId][dim]: number; perDimMean[dim]: number; composite: number; failedJudges?: string[]; notes?: string }` — substrate-blessed ensemble shape consumed by IRR primitives.
- type **`RunJudgeMetadata`**, **`RunTokenUsage`**, **`RunSplitTag`** (`'search'|'dev'|'holdout'`).
- class **`RunRecordValidationError extends ValidationError`** — fail-loud at the run-record boundary.
- fn **`validateRunRecord(input: unknown): RunRecord`** — throws on NaN, infinite, missing keys; validates `judgeScores` when present.
- fn **`isRunRecord(x): x is RunRecord`** — type guard.
- fn **`parseRunRecordSafe(x): { ok: true; record } | { ok: false; error }`** — non-throwing parse.
- fn **`roundTripRunRecord(record): RunRecord`** — canonical re-serialization (asserts JSON-stable shape).

### Campaign orchestration (`src/eval-campaign.ts`, root and `./optimization`)

- fn **`runEvalCampaign<V>(opts): Promise<EvalCampaignResult>`** — fan out (variant × scenario × trial) cells through `CampaignRunner<V>`, persist `RunRecord[]`, honor `CampaignIntegrityPolicy` (`'throw'|'mark_failed'|'log'`).
- types **`EvalCampaignOptions<V>`**, **`EvalCampaignResult`**, **`CampaignRunContext<V>`**, **`CampaignRunner<V>`**, **`CampaignRunOutcome`** (includes `judgeScores?: JudgeScoresRecord`), **`CampaignVariant<V>`**, **`CampaignScenario`**, **`CampaignFactoryParams`**, **`FailedRun`**, **`CampaignIntegrityPolicy`**.
- trace store contract: see `TraceStore`/`FileSystemTraceStore`/`InMemoryTraceStore` from `./trace` below.
- raw-provider sinks (`src/trace/raw-provider-sink.ts`): interface **`RawProviderSink`**, classes **`InMemoryRawProviderSink`**, **`NoopRawProviderSink`**, **`FileSystemRawProviderSink`**, fn **`defaultProviderRedactor`**, fn **`providerFromBaseUrl`**, type **`RawProviderEvent`**.

### Judge ensemble (`src/judges.ts`, `src/judge-runner.ts`, root)

- fns **`adversarialJudge`**, **`codeExecutionJudge`**, **`coherenceJudge`** — out-of-the-box judges.
- fn **`createCustomJudge(spec)`**, **`createDomainExpertJudge(spec)`**, **`defaultJudges()`** — judge factories.
- class **`JudgeRunner`**, fn **`runJudgeFleet(opts)`** (`./judge-runner`) — multi-judge orchestration with `JudgeFleetOptions`.
- sandbox judges: **`compilerJudge`**, **`linterJudge`**, **`securityJudge`**, **`testJudge`** + types **`SandboxJudgeKind`**, **`SandboxJudgeSpec`**, **`SandboxJudgeResult`**.
- fn **`withJudgeRetry(judgeFn, policy): WrappedJudgeFn`** (0.27) — retry/transient-failure wrapper returning typed outcome `{ succeeded, attempts, value, error }`. Types **`JudgeRetryPolicy`**, **`JudgeRetryOutcome`**.
- fn **`aggregateTrialsByMode(trials, { mode })`** (0.27) — modes `'exclude-failed'|'strict-fail'|'zero-fill'`; types **`AggregatorMode`**, **`TrialAggregate`**.
- types **`JudgeFn`**, **`JudgeConfig`**, **`JudgeRubric`**, **`JudgeScore`**, **`JudgeInput`**, **`RubricDimension`**.
- **No `EnsembleAllFailedError` symbol exists** — failure handling is via `failedJudges[]` on `JudgeScoresRecord` and the `aggregateTrialsByMode('strict-fail')` mode.

### Judge calibration (`src/judge-calibration.ts`)

- fns **`calibrateJudge`**, **`calibrateJudgeContinuous`** (0.26 — ICC + weighted κ), **`continuousAgreement`**, **`positionalBias`**, **`selfPreference`**, **`verbosityBias`**.
- types **`CalibrationResult`**, **`CandidateScore`**, **`ContinuousAgreement`**, **`ContinuousAgreementOptions`**, **`ContinuousCalibrationResult`**, **`GoldenItem`**, **`PositionalBiasResult`**, **`SelfPreferenceResult`**, **`VerbosityBiasResult`**.

### Analyst registry / findings (`src/analyst/*`, root)

- class **`AnalystRegistry`** — register/list/run analysts; `runStream` returns `AsyncIterable<AnalystRunEvent>` (0.29).
- contract **`Analyst<TInput>`** + envelope **`AnalystFinding`** + helper **`makeFinding`** + **`computeFindingId(finding)`** (sha-stable).
- types **`AnalystContext`** (includes `priorFindings` from cross-run runs), **`AnalystCost`**, **`AnalystHooks`**, **`AnalystInputKind`**, **`AnalystRegistryOptions`**, **`AnalystRequirements`**, **`AnalystRunEvent`**, **`AnalystRunInputs`**, **`AnalystRunResult`**, **`AnalystRunSummary`**, **`AnalystSeverity`**, **`BudgetPolicy`**, **`EvidenceRef`**, **`RegistryRunOpts`**.
- fn **`createTraceAnalystKind(spec, opts)`** + types **`CreateTraceAnalystKindOpts`**, **`TraceAnalystKindSpec`**, **`TraceAnalystGolden`** — kind-factory producing registry-ready analysts with Ax structured output.
- four shipping kinds: **`FAILURE_MODE_KIND_SPEC`**, **`KNOWLEDGE_GAP_KIND_SPEC`**, **`KNOWLEDGE_POISONING_KIND_SPEC`**, **`IMPROVEMENT_KIND_SPEC`**; constant **`DEFAULT_TRACE_ANALYST_KINDS`** (canonical run order).
- fn **`renderPriorFindings(findings)`** — prompt-side rendering of cross-run context.
- fn **`buildTraceToolsForGroup(group)`** + type **`TraceToolGroupName`** (`'all'|'discovery'|'discoveryAndRead'|'discoveryAndSearch'|'targeted'`).
- finding schema: **`RawAnalystFinding`**, **`RawAnalystFindingSchema`** (Zod), **`RAW_FINDING_SCHEMA_PROMPT`**, **`ANALYST_SEVERITIES`**, fn **`parseRawFinding`**.
- finding-subject grammar (0.30): **`FindingSubject`**, **`FindingSubjectKind`**, **`FINDING_SUBJECT_GRAMMAR_PROMPT`**, **`FINDING_SUBJECT_KINDS`**, **`FindingSubjectStringSchema`** (Zod), **`KIND_EXPECTED_SUBJECTS`**, fns **`parseFindingSubject`**, **`renderFindingSubject`**.
- adapter factories (`src/analyst/adapters.ts`) lifting existing primitives: **`createJudgeAdapter`**, **`createRunCriticAdapter`**, **`createSemanticConceptJudgeAdapter`**, **`createTraceAnalystAdapter`** (deprecated, replaced by `createTraceAnalystKind`), **`createVerifierAdapter`**, fn **`liftSeverity`**.
- findings store: class **`FindingsStore`**, fn **`diffFindings(prev, cur, { isMaterial })`**, **`defaultIsMaterial`**, types **`DiffPolicy`**, **`FindingsDiff`**, **`PersistedFinding`**.
- chat-client abstraction: fn **`createChatClient(opts)`**, types **`ChatClient`**, **`ChatRequest`**, **`ChatResponse`**, **`ChatTransport`** (`router|sandbox-sdk|cli-bridge|direct-provider|mock`), plus per-transport opts.
- **No `runAnalystLoop` symbol** — orchestration is `AnalystRegistry.run()` / `AnalystRegistry.runStream()`.

### Trace analyst surface (`src/trace-analyst/*`, root and `./traces`)

- fn **`analyzeTraces(input, opts)`** — Ax RLM over OTLP-JSONL traces.
- types **`AnalyzeTracesInput`**, **`AnalyzeTracesOptions`**, **`AnalyzeTracesResult`**, **`AnalyzeTracesTurnSnapshot`**.
- store: contract **`TraceAnalysisStore`**, class **`OtlpFileTraceStore`**, type **`OtlpFileTraceStoreOptions`**, errors **`TraceFileMissingError`**, **`TraceNotFoundError`**, **`SpanNotFoundError`**.
- tools: fns **`buildTraceAnalystTools`**, **`traceAnalystFunctionGroup`**; constants **`DEFAULT_TRACE_ANALYST_BUDGETS`**, **`TRACE_ANALYST_TRUNCATION_MARKER_PREFIX`**.
- prompts: **`TRACE_ANALYST_ACTOR_DESCRIPTION`**, **`TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION`**, **`TRACE_ANALYST_SUBAGENT_DESCRIPTION`**.
- hook: fn **`traceAnalystOnRunComplete(opts)`** — `RunCompleteHook` integration point for emitters.
- insights planner (`./trace-analyst/insights`): fns **`buildTraceInsightContext`**, **`buildTraceInsightPrompt`**, **`defaultTraceInsightPanel`**, **`describeTraceInsightScope`**, **`domainEvidencePattern`**, **`inferDomainKeywords`**, **`planTraceInsightQuestions`**, **`scoreTraceInsightReadiness`**, **`tokenizeDomainWords`**.
- types **`TraceAnalystSpan`**, **`TraceAnalystSpanKind`**, **`TraceAnalystSpanStatus`**, **`TraceAnalystTraceSummary`**, **`TraceAnalystByteBudgets`**, **`TraceAnalystFilters`**, **`DatasetOverview`**, **`QueryTracesPage`**, **`SearchSpanResult`**, **`SearchTraceResult`**, **`SpanMatchRecord`**, **`ViewSpansResult`**, **`ViewTraceOversized`**, **`ViewTraceResult`**.

### Trace chassis (`src/trace/*`, root and `./traces`)

- contract **`TraceStore`** + impls **`InMemoryTraceStore`**, **`FileSystemTraceStore`** + opts type. Filters: **`RunFilter`**, **`SpanFilter`**, **`EventFilter`**.
- schemas: types **`Run`**, **`Span`** (union), **`LlmSpan`**, **`ToolSpan`**, **`RetrievalSpan`**, **`JudgeSpan`**, **`SandboxSpan`**, **`GenericSpan`**, **`TraceEvent`**, **`BudgetSpec`**, **`BudgetLedgerEntry`**, **`Artifact`**, **`Message`**, **`RunStatus`**, **`RunLayer`**, **`SpanKind`**, **`SpanStatus`**, **`EventKind`**, **`FailureClass`**. Type guards **`isLlmSpan`**, **`isToolSpan`**, **`isRetrievalSpan`**, **`isJudgeSpan`**, **`isSandboxSpan`**. Constant **`TRACE_SCHEMA_VERSION`**, **`FAILURE_CLASSES`**.
- emitter: class **`TraceEmitter`** + interface **`SpanHandle`**, **`RunCompleteHookContext`**, **`RunCompleteHook`**, **`TraceEmitterOptions`**; fn **`llmSpanFromProvider`**.
- query helpers: **`runsForScenario`**, **`llmSpans`**, **`toolSpans`**, **`judgeSpans`**, **`groupBy`**, **`argHash`**, **`aggregateLlm`**, **`runFailureClass`**.
- redaction: types **`RedactionRule`**, **`RedactionReport`**; fns **`redactString`**, **`redactValue`**; constants **`DEFAULT_REDACTION_RULES`**, **`REDACTION_VERSION`**.
- OTLP: fn **`exportRunAsOtlp`**, types **`OtlpSpan`**, **`OtlpResourceSpans`**, **`OtlpExport`**, constant **`OTEL_AGENT_EVAL_SCOPE`**.
- integrity: fn **`assertRunCaptured(emitter, expectations): Promise<RunIntegrityReport>`**, **`throwIfRunIncomplete(report)`**, class **`RunIntegrityError`**, types **`RunIntegrityExpectations`**, **`RunIntegrityIssueCode`**, **`RunIntegrityIssue`**, **`RunIntegrityReport`**.

### Integrity / capture (root)

- fn **`assertLlmRoute(opts: LlmClientOptions, req: LlmRouteRequirements = {}): void`** (`src/llm-client.ts:609`) — throws `LlmRouteAssertionError` (extends `CaptureIntegrityError`) when the wired model doesn't satisfy a route requirement.
- class **`LlmRouteAssertionError`** + type **`LlmRouteAssertionReason`** + interface **`LlmRouteRequirements`**.
- fn **`assertRunCaptured`** — see Trace chassis above.
- fn **`assertRealBackend(emitter, opts): BackendIntegrityReport`** (NEW 0.31) + class **`BackendIntegrityError`** + fn **`summarizeBackendIntegrity`** + type **`BackendIntegrityReport`** — distinguishes "agent failed" from "ran blind against a stub backend." Required after every canonical eval.
- error taxonomy (`src/errors.ts`): base **`AgentEvalError`** with stable `code`; subclasses **`CaptureIntegrityError`**, **`ConfigError`**, **`JudgeError`**, **`NotFoundError`**, **`ReplayError`**, **`ValidationError`**, **`VerificationError`** + type **`AgentEvalErrorCode`**.

### Promotion gate / paired stats (root and `./reporting`)

- fn **`judgeReplayGate(args): Verdict`** + types **`JudgeReplayGateArgs`**, **`Verdict`** (`'PROMOTE'|'BLOCK'|'INSUFFICIENT'`).
- fn **`bootstrapCi(samples, opts): BootstrapResult`** + types **`BootstrapOptions`**, **`BootstrapResult`**.
- fn **`pairedWilcoxon(a, b)`**, **`pairedBootstrap(a, b, opts)`**, **`bhAdjust(pvalues)`** + types **`PairedBootstrapOptions`**, **`PairedBootstrapResult`**.
- statistics (`src/statistics.ts`): **`cohensD`**, **`confidenceInterval`**, **`interRaterReliability`**, **`mannWhitneyU`**, **`normalizeScores`**, **`pairedTTest`**, **`partialCredit`**, **`weightedMean`**, **`wilcoxonSignedRank`**.
- sequential (`src/sequential.ts`): fns **`pairedEvalueSequence`**, **`evaluateInterimReleaseConfidence`** + types **`PairedEvalueOptions`**, **`PairedEvalueSequence`**, **`PairedEvalueStep`**, **`SequentialDecision`**, **`InterimReleaseConfidence`**, **`InterimReleaseConfidenceInput`** — anytime-valid e-values.
- release confidence (`src/release-confidence.ts`): fns **`assertReleaseConfidence`**, **`evaluateReleaseConfidence`**, **`releaseTraceEvidenceFromMultiShotTrials`** + types **`ReleaseConfidenceAxis`**, **`ReleaseConfidenceAxisName`**, **`ReleaseConfidenceInput`**, **`ReleaseConfidenceIssue`**, **`ReleaseConfidenceMetrics`**, **`ReleaseConfidenceScorecard`**, **`ReleaseConfidenceStatus`**, **`ReleaseConfidenceThresholds`**, **`ReleaseTraceEvidence`**.
- summary report (`src/summary-report.ts`): fns **`researchReport`**, **`summaryTable`**, **`gainHistogram`**, **`paretoChart`** + constant **`RESEARCH_REPORT_HARD_PAIR_FLOOR`** + many supporting types.
- power-analysis (`src/power-analysis.ts`): fns **`benjaminiHochberg`**, **`bonferroni`**, **`requiredSampleSize`**.
- type **`GenerationReport`** lives on `src/prompt-evolution.ts` (the per-generation aggregate output of `runPromptEvolution`).

### IRR / corpus calibration (`src/statistics.ts`)

- fn **`interRaterReliability(judgeScores: JudgeScore[][])`** — within-item α (one item, multiple judges).
- fn **`corpusInterRaterAgreement(records, opts?)`** (NEW 0.27.2) — corpus-wide ICC(2,1) + κ_w over `{itemId, judgeName, dimension, score}` records.
- fn **`corpusInterRaterAgreementFromJudgeScores(itemsScores, opts?)`** — adapter for consumers that already hold per-item `JudgeScore[]` arrays.
- types **`CorpusScoreRecord`**, **`CorpusAgreementOptions`**, **`CorpusAgreementPerDimension`**, **`CorpusAgreementReport`**.

### Driver / Executor / ProductClient / benchmark (root)

- class **`AgentDriver`** + type **`AgentDriverConfig`** (`src/driver.ts`).
- fn **`executeScenario(config: ExecutorConfig): Promise<ScenarioResult>`** + type **`ExecutorConfig`** (`src/executor.ts`).
- class **`ProductClient`**, fn **`runE2EWorkflow(config)`** + type **`ProductClientConfig`** (`src/client.ts`).
- class **`BenchmarkRunner`** + types **`BenchmarkReport`**, **`BenchmarkRunnerConfig`** (`src/benchmark.ts`).
- class **`ScenarioRegistry`** (`src/registry.ts`).
- reporter fns **`formatBenchmarkReport`**, **`formatDriverReport`**, **`printDriverSummary`** (`src/reporter.ts`).
- core types **`DriverResult`**, **`DriverState`**, **`EvalResult`**, **`Scenario`**, **`ScenarioFile`**, **`ScenarioResult`**, **`Turn`**, **`TurnMetrics`**, **`TurnResult`**, **`TestResult`**, **`ArtifactCheck`**, **`ArtifactResult`**, **`CheckResult`**, **`CollectedArtifacts`**, **`CompletionCriterion`**, **`FeedbackPattern`**, **`PersonaConfig`**, **`RouteMap`** (`src/types.ts`).

### Control runtime + action policy (root and `./control`)

- fn **`runAgentControlLoop(config: ControlRuntimeConfig): Promise<ControlRunResult>`** + helpers **`objectiveEval`**, **`subjectiveEval`**, **`allCriticalPassed`**, **`stopOnNoProgress`**, **`stopOnRepeatedAction`**.
- types **`ControlActionFailureMode`**, **`ControlActionOutcome`**, **`ControlBudget`**, **`ControlContext`**, **`ControlDecision`**, **`ControlEvalResult`**, **`ControlRunResult`** (`runId: string | null`), **`ControlRuntimeConfig`**, **`ControlRuntimeError`**, **`ControlSeverity`**, **`ControlStep`**, **`ControlStopPolicies`**, **`StopDecision`**.
- fn **`evaluateActionPolicy`** + types **`ActionExecutionPolicy`**, **`ActionPolicyDecision`**.
- evidence adapters (`src/run-evidence.ts`): fns **`controlRunToRunRecord`**, **`scoreFromEvals`** + types **`ControlRunToRunRecordOptions`**, **`RunEvidenceMetadata`**.
- propose-review-control (`src/propose-review-control.ts`): fn **`runProposeReviewAsControlLoop`**, fn **`controlFailureClassFromVerification`** + state/result/config types.

### LLM client (root)

- class **`LlmClient`** + fns **`callLlm`**, **`callLlmJson`**, **`probeLlm`**, **`stripFencedJson`** + types **`LlmCallRequest`**, **`LlmCallResult`**, **`LlmClientOptions`**, **`LlmMessage`**, **`LlmUsage`** + class **`LlmCallError`** (`src/llm-client.ts`).
- `assertLlmRoute` + `LlmRouteAssertionError` covered under Integrity.

### Builder-eval surface (`./builder-eval` and `./traces` interplay)

- class **`BuilderSession`** + fn **`resumeBuilderSession`** + types **`BuilderSessionInit`**, **`ShipOptions`**, **`RunAppScenarioOptions`**.
- class **`ProjectRegistry`** + types **`ProjectSummary`**, **`ChatSummary`**, **`ProjectTimelineEntry`**.
- fns **`scoreProject(store, projectId, opts)`**, **`scoreAllProjects(store)`** + type **`ThreeLayerProjectReport`** + type **`ProjectKind`** (`'full'|'scaffold-only'`).
- fn **`correlateLayers(reports)`** + types **`LayerCorrelation`**, **`CorrelationReport`**.

### Multi-layer verification + per-layer (root)

- class **`MultiLayerVerifier`** + fn **`gradeSemanticStatus`** + types **`Finding`**, **`Layer`**, **`LayerResult`**, **`LayerStatus`**, **`Severity`**, **`VerificationReport`**, **`VerifyContext`**, **`VerifyOptions`** (`src/multi-layer-verifier.ts`).
- fn **`multiToolchainLayer(config)`**, **`mergeLayerResults`** + types **`AdapterRun`**, **`MergeOptions`**, **`MultiToolchainLayerConfig`** (`src/multi-toolchain-layer.ts`).
- fn **`deployGateLayer`**, fns **`viteDeployRunner`**, **`wranglerDeployRunner`** + types `Deploy*` (`src/deploy-gate-layer.ts`).
- fn **`flowLayer(input)`** + types `Flow*` (`src/flow-layer.ts`).
- semantic concept judge (`src/semantic-concept-judge.ts`): fns **`createSemanticConceptJudge`**, **`runSemanticConceptJudge`** + constants **`DEFAULT_COMPLEXITY_WEIGHTS`**, **`SEMANTIC_CONCEPT_JUDGE_VERSION`** + types **`ConceptComplexity`**, **`ConceptFinding`**, **`ConceptSpec`**, **`ConceptWeightStrategy`**, **`SemanticConceptJudgeInput`**, **`SemanticConceptJudgeOptions`**, **`SemanticConceptJudgeResult`**.
- intent-match judge (`src/intent-match-judge.ts`): fns **`createIntentMatchJudge`**, **`runIntentMatchJudge`** + constant **`INTENT_MATCH_JUDGE_VERSION`**.
- keyword-coverage judge: fns **`runKeywordCoverageJudge`**, **`runKeywordCoverageJudgeUrl`**, **`extractAssetUrls`**, **`htmlContainsElement`**.
- run-critic (`src/run-critic.ts`): class **`RunCritic`** + types **`RunCriticOptions`**, **`RunTrace`**.

### Run scoring (root)

- fn **`aggregateRunScore(weights, results): RunScore`** + constant **`DEFAULT_RUN_SCORE_WEIGHTS`** + fn **`clamp01`** + types **`RunScore`**, **`RunScoreWeights`** (`src/run-score.ts`).

### Anti-slop / contamination / baseline (root)

- fn **`analyzeAntiSlop(text, config)`**, fn **`createAntiSlopJudge(config)`** + types **`AntiSlopConfig`**, **`AntiSlopIssue`**, **`AntiSlopReport`**, **`SlopCategory`** (`src/anti-slop.ts`).
- fns **`canaryLeakView`**, **`checkBehavioralCanary`**, **`checkCanaries`**, **`runBehavioralCanaries`** + class **`HoldoutAuditor`** + type **`CanaryLeak`** (`src/contamination-guard.ts`).
- baseline (`src/baseline.ts`): fn **`compareToBaseline`**, **`iqr`**, **`welchsTTest`** + types **`BaselineOptions`**, **`BaselineReport`**, **`MetricSamples`**, **`MetricVerdict`**.
- dataset (`src/dataset.ts`): class **`Dataset`**, fn **`hashScenarios`**, class **`HoldoutLockedError`** + types **`DatasetDifficulty`**, **`DatasetManifest`**, **`DatasetProvenance`**, **`DatasetScenario`**, **`DatasetSplit`**, **`SliceOptions`**.
- red-team (`src/red-team.ts`): fns **`redTeamDataset`**, **`redTeamReport`**, **`scoreRedTeamOutput`**, **`toolNamesForRun`** + constant **`DEFAULT_RED_TEAM_CORPUS`** + types **`RedTeamCase`**, **`RedTeamCategory`**, **`RedTeamFinding`**, **`RedTeamPayload`**, **`RedTeamReport`**.

### Benchmark + control runtime + action-policy (root, `./benchmarks`, `./control`)

- See Driver + Control sections above. The `./benchmarks` subpath ships `BenchmarkAdapter`, **`deterministicSplit`**, **`BENCHMARK_SPLIT_SEED`**, and `routing` namespace (synthetic 16-task router benchmark).

### Feedback trajectory + production loop (root and `./optimization`)

- fns **`createFeedbackTrajectory`**, **`assignFeedbackSplit`**, **`controlRunToFeedbackTrajectory`**, **`feedbackTrajectoriesToDatasetScenarios`**, **`feedbackTrajectoriesToOptimizerRows`**, **`feedbackTrajectoryToDatasetScenario`**, **`feedbackTrajectoryToOptimizerRow`**, **`parseFeedbackTrajectoriesJsonl`**, **`replayFeedbackTrajectories`**, **`replayFeedbackTrajectory`**, **`renderPreferenceMemoryMarkdown`**, **`serializeFeedbackTrajectoriesJsonl`**, **`summarizePreferenceMemory`**, **`withAssignedFeedbackSplit`**.
- classes **`FileSystemFeedbackTrajectoryStore`**, **`InMemoryFeedbackTrajectoryStore`** + 13 types.
- fn **`runProductionLoop(opts)`** (`@experimental`) + types **`ProductionLoopRenderContext`**, **`ProductionLoopResult`**, **`ProductionLoopDecision`**, **`ProductionLoopCronConfig`**, **`ProductionEvolveConfig`**, **`ProductionShipConfig`**, **`FailureClusterConfig`**, **`RunProductionLoopOptions`**.
- fn **`proposeAutomatedPullRequest(client, input)`** (`@experimental`) + factories **`ghCliClient`**, **`httpGithubClient`** + types **`AutoPrClient`**, **`FileChange`**, **`GhCliClientOptions`**, **`HttpGithubClientOptions`**, **`ProposeAutomatedPullRequestInput`**, **`ProposeAutomatedPullRequestResult`**, **`RepoRef`**.

### Optimization / mutation / search (root and `./optimization`)

- fn **`runMultiShotOptimization(config)`** + fn **`trialTraceFromMultiShotTrial`** + **`defaultMultiShotObjectives`** + 14 types.
- fn **`runPromptEvolution(config)`** + class **`InMemoryTrialCache`** + types **`EvolvableVariant`**, **`GenerationReport`**, **`MutateAdapter`**, **`PromptEvolutionConfig`**, **`PromptEvolutionEvent`**, **`PromptEvolutionResult`**, **`ScenarioAggregate`**, **`ScoreAdapter`**, **`TrialCache`**, **`TrialResult`** (re-exported as `PromptTrialResult`), **`VariantAggregate`** (`src/prompt-evolution.ts`).
- fns **`buildReflectionPrompt`**, **`parseReflectionResponse`** + constant **`DEFAULT_MUTATION_PRIMITIVES`** + types **`ReflectionContext`**, **`ReflectionProposal`**, **`TrialTrace`** (`src/reflective-mutation.ts`).
- researcher (`src/researcher.ts`): classes **`CallbackResearcher`**, **`NoopResearcher`** + types **`Researcher`**, **`CallbackResearcherOptions`**, **`ExperimentPlan`**, **`ExperimentResult`**, **`FailureMode`**, **`SteeringChange`**.
- steering (`src/steering.ts`, `src/steering-optimizer.ts`): fns **`mergeSteeringBundle`**, **`renderSteeringText`** + classes **`AxGepaSteeringOptimizer`**, **`PairwiseSteeringOptimizer`** + types.
- propose-review (`src/propose-review.ts`): fn **`runProposeReview`**, fn **`createLlmReviewer`**, fns **`inMemoryReviewStore`**, **`jsonlReviewStore`** + 14 types.
- reviewer (`src/reviewer.ts`): fn **`buildReviewerPrompt`**, **`createDefaultReviewer`** + types.

### Sandbox / harness / sandbox pool (root)

- class **`SandboxHarness`** + classes **`DockerSandboxDriver`**, **`SubprocessSandboxDriver`** + parsers **`composeParsers`**, **`jestTestParser`**, **`pytestTestParser`**, **`vitestTestParser`** + types **`HarnessConfig`**, **`SandboxDriver`**, **`SandboxHarnessResult`**, **`SandboxResult`**, **`SubprocessSandboxDriverOptions`**, **`TestOutputParser`** (`src/sandbox-harness.ts`).
- fn **`createSandboxPool(opts)`** + types **`SandboxPool`**, **`PoolSlot`**, **`SlotFactory`**, **`CreateSandboxPoolOpts`** (`src/sandbox-pool.ts`).
- harness-optimizer (`src/harness-optimizer.ts`): fns **`runHarnessExperiment`**, **`selectHarnessVariant`**, **`summarizeHarnessResults`** + constant **`DEFAULT_HARNESS_OBJECTIVES`** + 10 types.
- test-graded scenario (`src/test-graded-scenario.ts`): fn **`runTestGradedScenario`** + types.
- command-runner (`src/command-runner.ts`): fn **`localCommandRunner`** + types **`CommandRunner`**, **`DirEntry`**, **`RunCommandInput`**, **`RunCommandResult`**.

### RL bridge — subpath `./rl` only (per 0.24 surface lockdown)

Star-exported from `src/rl/index.ts`:
- **compute-curves**: fns **`runComputeCurve`**, **`bestOfN`**, **`selfConsistency`**, **`paretoFrontier`** + 7 types.
- **contamination**: fn **`runContaminationProbe`**, perturbations **`renameVariables`**, **`shuffleOrder`**, **`injectIrrelevantClause`** + 4 types.
- **off-policy**: fns **`inverseProbabilityWeighting`**, **`selfNormalizedImportanceWeighting`**, **`doublyRobust`**, **`offPolicyEstimateAll`** + 3 types.
- **preferences**: fns **`extractPreferences`**, **`toTRLFormat`**, **`toAnthropicFormat`** + types **`PreferenceStrategy`**, **`PreferenceTriple`**, **`ExtractPreferencesOptions`**, **`PreferenceExtractionReport`**.
- **run-record-adapters**: fns **`trialToRunRecord`**, **`trialsToRunRecords`**, **`verificationReportToRunRecord`**, **`variantAggregateToRunRecord`** + **`AdapterContext`**.
- **tournament**: fns **`fitBradleyTerry`**, **`applyEloUpdate`**, **`buildPairwiseFromCampaign`** + types **`PairwiseOutcome`**, **`BradleyTerryRating`**, **`BradleyTerryFit`**, **`EloOptions`**, **`BuildPairwiseFromCampaignInput`**.
- **verifiable-reward**: fns **`extractVerifiableReward`**, **`extractVerifiableRewardsFromRecords`**, **`filterDeterministicallyRewarded`** + types.
- **active-curriculum** (`@experimental`): fns **`varianceBasedCurriculum`**, **`thompsonCurriculum`**, **`observationsFromRunRecords`** + types.
- **adaptation-eval** (`@experimental`): fn **`runAdaptationCurve`**, **`compareAdaptationCurves`**, **`firstPassK`** + types.
- **adversarial** (`@experimental`): fn **`adversarialScenarioSearch`** + types.
- **auto-research** (`@experimental`): fn **`analyzeOptimizationResult`** + types.
- **exporters** (`@experimental`): fns **`toDpoRows`/`toDpoJsonl`**, **`toGrpoRows`/`toGrpoJsonl`**, **`toSftRows`/`toSftJsonl`**, **`toPrmRows`/`toPrmJsonl`**, **`stepRewardsToJsonl`** + row/lookup types.
- **predictive-validity-researcher** (`@experimental`): class **`PredictiveValidityResearcher implements Researcher`**.
- **process-reward** (`@experimental`): fn **`extractStepRewards`**, **`runwiseStepRewardSummary`**, **`prmTrainingPairs`** + types **`StepReward`**, **`StepScorer`**, **`PrmTrainingTriple`**.
- **reward-hacking** (`@experimental`): fn **`detectRewardHacking`** + types.
- **rl-campaign** (`@experimental`): fn **`runRLCampaign`** + types (+ re-export of `runEvalCampaign`).

### Pipelines — subpath `./pipelines` only

Views over a `TraceStore`: **`budgetBreachView`**, **`failureClusterView`**, **`firstDivergenceView`**, **`judgeAgreementView`**, **`regressionView`**, **`stuckLoopView`**, **`toolWasteView`** + per-view report/options types. Re-exports `computeToolUseMetrics`.

### Meta-eval — subpath `./meta-eval` only

- fn **`calibrationCurve(store, opts)`** + types **`CalibrationBin`**, **`CalibrationReport`**, **`CalibrationOptions`**.
- fn **`correlationStudy(opts)`** + types **`EvalMetricSpec`**, **`OutcomePair`**, **`CorrelationResult`**, **`CorrelationStudyResult`**, **`CorrelationStudyOptions`**.
- class **`InMemoryOutcomeStore`**, **`FileSystemOutcomeStore`** + contract **`OutcomeStore`** + types **`DeploymentOutcome`**, **`OutcomeFilter`**, **`FileSystemOutcomeStoreOptions`**.
- fn **`rubricPredictiveValidity(input, opts)`** (also re-exported under `./reporting`) + types **`RubricPredictiveValidityInput`**, **`RubricOutcomePair`**, **`RubricRanking`**, **`RubricPredictiveValidityReport`**.

### PRM — subpath `./prm` only

- class **`PrmGrader`**, fn **`isPrmVerdict(judgeSpan)`** + types **`StepRubric`**, **`StepContext`**, **`GradedStep`**, **`PrmGradedTrace`**.
- builtin rubrics: **`outputLengthRubric`**, **`toolSuccessRubric`**, **`toolNonRedundantRubric`**, **`nonRefusalRubric`**, **`toolIntentAlignmentRubric`**.
- fns **`prmBestOfN`**, **`prmEnsembleBestOfN`** + type **`BestOfNResult`**.
- fn **`exportTrainingData`**, **`toNdjson`** + type **`PrmTrainingSample`**.

### Governance — subpath `./governance` (also root via `*`)

- fns **`euAiActReport`**, **`nistAiRmfReport`**, **`soc2Report`**, **`classifyEuAiRisk`**, **`renderMarkdown`**, **`summarize`** + types **`EuRiskClass`**, **`UseCaseSignals`**, **`GovernanceContext`**, **`GovernanceFinding`**, **`GovernanceReport`**.

### Knowledge — subpath `./knowledge` (also root via `*`)

- fns **`scoreKnowledgeReadiness`**, **`blockingKnowledgeEval`**, **`knowledgeReadinessTracePayload`**, **`userQuestionsForKnowledgeGaps`**, **`acquisitionPlansForKnowledgeGaps`** + types **`KnowledgeRequirement`**, **`KnowledgeBundle`**, **`KnowledgeRecommendedAction`**, **`KnowledgeReadinessReport`**, **`UserQuestion`**, **`DataAcquisitionPlan`**, **`KnowledgeRequirementCategory`**, **`KnowledgeAcquisitionMode`**, **`KnowledgeImportance`**, **`KnowledgeFreshness`**, **`KnowledgeSensitivity`**, **`KnowledgeFallbackPolicy`**, **`KnowledgeResponsibleSurface`**.

### Telemetry — subpaths `./telemetry`, `./telemetry/file`

- class **`TelemetryClient`** + fn **`sanitiseArgv`** + constant **`SECRET_FLAGS`** + type **`EmitArgs`**.
- sinks: **`HttpTelemetrySink`**, **`InMemoryTelemetrySink`**, **`NullTelemetrySink`**, **`FanoutTelemetrySink`** + contract **`TelemetrySink`**.
- types **`TelemetryEnvelope`**, **`TelemetryKind`**, **`TelemetryModel`**, **`TelemetrySource`** + constant **`TELEMETRY_SCHEMA_VERSION`**.
- `./telemetry/file` adds Node-only **`FileTelemetrySink`** + **`defaultTelemetryDir`**.

### Wire — subpath `./wire`

- fn **`createApp(opts)`**, **`startServer`** + type **`ServeOptions`** (Hono server, optional bearer auth, optional `IngestionStores`).
- fn **`dispatchRpc`**, **`runRpcOnce`**, **`runRpcBatch`** — stdio JSON-RPC.
- fn **`buildOpenApi()`** — emits the OpenAPI3 spec.
- constants **`BUILTIN_RUBRICS`**, fns **`getBuiltinRubric`**, **`listBuiltinRubrics`**.
- exports every Zod schema from `./schemas` and every handler from `./handlers`.

### Producers / misc (root)

- class **`BudgetGuard`** + class **`BudgetBreachError`** (`src/budget-guard.ts`).
- failure taxonomy (`src/failure-taxonomy.ts`): fn **`classifyFailure`** + constants **`DEFAULT_FAILURE_RULES`**, **`FAILURE_CLASSES`** + types **`FailureClass`**, **`FailureClassification`**, **`FailureContext`**, **`FailureRule`**.
- tool-use metrics (`src/tool-use-metrics.ts`): fn **`computeToolUseMetrics`**.
- trajectory (`src/trajectory.ts`): fn **`buildTrajectory`** + types.
- artifact validator (`src/artifact-validator.ts`): fns **`byteLengthRange`**, **`composeValidators`**, **`containsAll`**, **`jsonHasKeys`**, **`regexMatch`** + types.
- convergence (`src/convergence.ts`): class **`ConvergenceTracker`**.
- cost tracker (`src/cost-tracker.ts`): class **`CostTracker`**.
- metrics (`src/metrics.ts`): class **`MetricsCollector`**, **`TokenCounter`**, fns **`estimateCost`**, **`estimateTokens`**, constant **`MODEL_PRICING`**.
- behavior DSL (`src/behavior-dsl.ts`): fns **`expectAgent`**, **`runExpectations`** + types.
- ci-gate (`src/ci-gate.ts`): fns **`evaluateContract`**, **`renderMarkdownReport`** + types.
- experiment tracker (3 backends): class **`ExperimentTracker`**, **`InMemoryExperimentStore`**, **`D1ExperimentStore`**, **`FileSystemExperimentStore`** + per-store options.
- bisector (`src/bisector.ts`): fns **`bisect`**, **`commitBisect`**, **`promptBisect`** + types.
- counterfactual: fn **`runCounterfactual`**, **`attributeCounterfactuals`** + types.
- cross-trace-diff: fn **`crossTraceDiff`** + types **`AlignmentOp`**, **`CrossTraceDiff`**, **`CrossTraceDiffOptions`**, **`StepAttribution`**.
- pre-registration: fns **`canonicalize`**, **`evaluateHypothesis`**, **`hashJson`**, **`signManifest`**, **`verifyManifest`** + types.
- active-learning: fn **`proposeSynthesisTargets`** + types.
- causal-attribution: fn **`causalAttribution`** + types.
- reward-model-export: fns **`exportRewardModel`**, **`loadScorerFromGrader`**, **`replayScorerOverCorpus`** + types.
- self-play: fn **`runSelfPlay`** + types.
- replay: classes **`ReplayCache`**, **`ReplayCacheMissError`** + fns **`createReplayFetch`**, **`iterateRawCalls`** + types.
- reference-replay (large surface): fns **`compareReferenceReplay`**, **`decideReferenceReplayPromotion`**, **`decideReferenceReplayRunPromotion`**, **`defaultReferenceReplayMatcher`**, **`inMemoryReferenceReplayStore`**, **`jsonlReferenceReplayStore`**, **`runReferenceReplay`**, **`scoreReferenceReplay`**, **`referenceReplayRunsToSteeringRows`**, **`referenceReplayScenarioToRunScore`** + 22 types.
- canary: fn **`runCanaries`** + types.
- code-mutator: fn **`createSandboxCodeMutator`** + types.
- composite-mutator: fn **`createCompositeMutator`** + types.
- concurrency: class **`Mutex`**.
- discover-personas (0.27): fn **`discoverPersonas`** + types.
- evolution-telemetry: classes **`CostLedger`**, **`LineageRecorder`**, **`MutationTelemetry`**, **`TrialTelemetry`** + types.
- golden-matcher: fn **`matchGoldens`**, **`weightedRecall`**, **`precision`** (re-exported as `goldenPrecision`) + constant **`DEFAULT_SEVERITY_WEIGHTS`** + types.
- held-out gate: class **`HeldOutGate`** + types **`GateDecision`**, **`GateEvidence`**, **`HeldOutGateConfig`**, **`HeldOutGateRejectionCode`**.
- jsonl-trial-cache: class **`JsonlTrialCache`**.
- live-proof: fn **`runLiveProof`** + types.
- locked-jsonl-appender: class **`LockedJsonlAppender`** + fn **`resetLockedAppendersForTesting`**.
- muffled-gate-scanner: fns **`findAutoMatchNoExpectation`**, **`findConstructorCwdDropped`**, **`findFallbackToPass`**, **`findLiteralTruePass`**, **`findSkipCountsAsPass`**, **`formatFindings`**, **`scanForMuffledGates`** + constants **`DEFAULT_FINDERS`**, **`UNIVERSAL_FINDERS`** + types.
- observability (`src/observability.ts`): fns **`replayTraceThroughJudge`**, **`toLangfuseEnvelope`**, **`toPrometheusText`** + types **`JudgeReplayResult`**, **`LangfuseEnvelope`**, **`LangfuseGeneration`**, **`LangfuseScore`**.
- oracle: fns **`evaluateOracles`**, **`jsonShape`**, **`notBlocked`**, **`regexMatches`**, **`textInSnapshot`**, **`urlContains`** + types.
- orthogonality: fn **`passOrthogonality`** + types.
- paraphrase: fn **`paraphraseRobustness`**, **`paraphraseRobustnessScenarios`** + mutators **`DEFAULT_MUTATORS`**, **`lowercaseMutator`**, **`politenessPrefixMutator`**, **`sentenceReorderMutator`**, **`typoMutator`**, **`whitespaceCollapseMutator`** + types.
- pareto: fns **`dominates`**, **`paretoFrontier`**, **`paretoFrontierWithCrowding`**, **`crowdingDistance`**, **`scalarScore`** + types.
- playbook (`src/playbook.ts`): fns **`distillPlaybook`**, **`renderPlaybookMarkdown`** + types.
- prompt-registry: class **`PromptRegistry`** + fn **`hashContent`** + type **`PromptHandle`**.
- series-convergence: fn **`analyzeSeries`** + types.
- slo: fn **`checkSlos`** + constant **`DEFAULT_AGENT_SLOS`** + types.
- state-continuity: fns **`collectionPreserved`**, **`keyPreserved`**, **`scoreContinuity`**, **`statusAdvanced`** + types.
- visual-diff: fns **`pixelDeltaRatio`**, **`visualDiff`** + types.
- dual-agent-bench: class **`DualAgentBench`** + types.
- workspace-inspector: class **`InMemoryWorkspaceInspector`** + fns **`fileContains`**, **`fileExists`**, **`rowCount`**, **`rowWhere`**, **`runAssertions`** + types.
- error-count-extractor: fn **`extractErrorCount`** + constant **`ERROR_COUNT_PATTERNS`** + types.
- eval-api (`src/eval-api.ts`): hosted judge config + RunCritic config types (`HostedJudgeConfig`, `HostedJudgeDimension`, `HostedJudgeRequest`, `HostedJudgeResponse`, `HostedRunCriticConfig`, `HostedRunScoreRequest`, `HostedRunScoreResponse`).
- integration-gates: fn **`integrationAsi`**, **`integrationGateEvals`**, **`integrationInvokeFailedPayload`**, **`integrationManifestResolvedPayload`**, **`integrationManifestValidatedPayload`** + types.
- trial-aggregator: fn **`aggregateTrialsByMode`** (0.27) + types.

## 3. Recently added (post-0.27)

| Version | Commit | Surface | What consumers get |
|---|---|---|---|
| **0.31.1** | f7a567f | (republish) | Fixes stale `dist/` from 0.31.0 npm artifact — `JudgeScoresRecord` now actually present at `dist/index.d.ts` and `outcome.judgeScores` actually propagates in `dist/index.js`. |
| **0.31.0** | 51f6e74 | `JudgeScoresRecord` on `RunRecord.outcome` | Substrate-blessed ensemble shape: `perJudge[judge][dim]`, `perDimMean`, `composite`, `failedJudges?`, `notes?`. Validator rejects NaN. `runEvalCampaign` threads it through without coercion. Replaces stringly-typed `raw.judge_X_Y` keys. |
| **0.31.0** | 3fef590 | Backend-integrity guard | `assertRealBackend(emitter, opts)` + `BackendIntegrityError` + `BackendIntegrityReport` + `summarizeBackendIntegrity`. Distinguishes "agent failed" from "ran blind against stub/unconfigured backend." Required after every canonical eval — 0/N pass-rate no longer silently masks misconfigured runtime. |
| **0.30.1** | 53c1417 | Re-export trace-analyst surface | `analyzeTraces`, `OtlpFileTraceStore` etc. now reachable from root entry (`export *` from `./trace-analyst`). Consumers no longer need to import `@tangle-network/agent-eval/traces` just for these symbols. |
| **0.30.0** | 29ca3d2 | `FindingSubject` typed grammar | `FindingSubject` discriminated union + `FindingSubjectStringSchema` (Zod) + `parseFindingSubject` / `renderFindingSubject` + `KIND_EXPECTED_SUBJECTS`. Lets analyst kinds attribute findings to typed loci (`agent-knowledge:wiki:*`, `system-prompt:*`, etc.) instead of free-text. |
| **0.29.0** | 9f1e1f6 | `AnalystRegistry.runStream` | Async-event stream (`AsyncIterable<AnalystRunEvent>`) so callers can render findings as they arrive (UIs, logs, dashboards) instead of waiting for the whole batch. |
| **0.29.0** | 66ad5fd | `priorFindings` context wiring | `AnalystContext.priorFindings` + `renderPriorFindings`. Improvement-kind run sees the failure-mode findings from the prior pass; analysts reference them via `evidence_uri: "finding://<id>"`. |
| **0.29.0** | 2d19b39 | Kind-factory + 4 trace-analyst kinds | `createTraceAnalystKind(spec)` + `FAILURE_MODE_KIND_SPEC`, `KNOWLEDGE_GAP_KIND_SPEC`, `KNOWLEDGE_POISONING_KIND_SPEC`, `IMPROVEMENT_KIND_SPEC` + `DEFAULT_TRACE_ANALYST_KINDS` + `buildTraceToolsForGroup` / `TraceToolGroupName`. Native Ax structured output replaces flat-defaulted bullet lists. |
| **0.28.0** | 641b0b3 | Analyst registry | `AnalystRegistry`, `Analyst<TInput>` contract, `AnalystFinding`, `FindingsStore`, `diffFindings`, `ChatClient` abstraction, five adapter factories (`createJudgeAdapter`, `createRunCriticAdapter`, `createSemanticConceptJudgeAdapter`, `createTraceAnalystAdapter` *deprecated*, `createVerifierAdapter`). One contract, one runner, model/transport-agnostic. |
| **0.27.2** | 6b2dc08 | Corpus-wide IRR | `corpusInterRaterAgreement(records, opts)` + `corpusInterRaterAgreementFromJudgeScores`. Pivots `{itemId, judge, dim, score}` records to `[n_items × n_judges]` matrix per dimension, ICC(2,1) + κ_w + bootstrap CI per dimension + pooled overall. The companion to within-item `interRaterReliability`. |
| **0.27.1** | dbb2204 | Signal-honesty sweep + consumer-contract test | `tests/consumer-contract.test.ts` pins the runtime symbols five product agents import — removal or rename fails the build. Documents `ControlRunResult.runId: string \| null` at the type. |
| **0.27.0** | 2d3b879 | `withJudgeRetry`, `aggregateTrialsByMode`, `discoverPersonas` | Three primitives to eliminate silent-zero judge corruption: retry+fallback wrapper returning `{succeeded, attempts, value, error}`; modes `'exclude-failed'\|'strict-fail'\|'zero-fill'`; auto-discovery of persona files replacing hardcoded `TRAINING_PERSONA_FILES`. |

## 4. Internal vs external

Surface is **intentionally curated**. Notable observations:

- **Root re-exports are gated to the load-bearing capture-integrity surface** (see comment at `src/index.ts:482-486`). `./trace`, `./knowledge`, `./governance` re-export via `*`; the other six modules (`./rl`, `./pipelines`, `./builder-eval`, `./meta-eval`, `./prm`, `./trace-analyst`) had their root `export *` deleted in 0.24.0 to force subpath imports. 0.30.1 re-added `export * from './trace-analyst'` because consumers needed `analyzeTraces` + `OtlpFileTraceStore` from root.
- **Stability tags are emitted into `.d.ts`**: every `src/rl/index.ts` re-export is JSDoc-tagged `@stable` or `@experimental`. `runProductionLoop`, `proposeAutomatedPullRequest`, every auto-PR transport, every RL exporter, and the four researchers are `@experimental` — consumers MUST pin patch versions.
- **Deprecated symbol still exported**: `createTraceAnalystAdapter` (`src/analyst/adapters.ts`) is kept for one minor while consumers migrate to `createTraceAnalystKind`. Deprecation noted in CHANGELOG 0.29.0.
- **Possible leak**: `resetLockedAppendersForTesting` (`src/locked-jsonl-appender.ts`) is exported at root despite the name suggesting test-only use. Likely should be moved to a `/testing` subpath.
- **`pipelines/tool-waste.ts` re-exports `computeToolUseMetrics`** — that symbol is also at root via `src/tool-use-metrics.ts`. Two reachable paths for the same function; not a bug but worth flagging.
- **Symbols the user expected but that do NOT exist**:
  - `runAnalystLoop` — orchestration is the `AnalystRegistry.run()` / `runStream()` methods, not a free function.
  - `EnsembleAllFailedError` — partial-failure is encoded via `JudgeScoresRecord.failedJudges[]` plus `aggregateTrialsByMode('strict-fail')`, not a dedicated error class.

## 5. Adoption-readiness one-liner per area

- **Run record + outcome**: a consumer must produce `RunRecord` envelopes via `validateRunRecord` (never raw objects), populate `outcome.judgeScores: JudgeScoresRecord` when running ensembles, and surface `failedJudges` instead of zeroing failed judges.
- **Campaign orchestration**: a consumer must implement a `CampaignRunner<V>` that returns `CampaignRunOutcome` (including `judgeScores`), pass it to `runEvalCampaign(opts)`, wire a `TraceStore` (file or in-memory), and pick a `CampaignIntegrityPolicy` (`'throw'` for canonical runs).
- **Judge ensemble**: a consumer must wrap every judge with `withJudgeRetry(judge, policy)`, aggregate trials with `aggregateTrialsByMode(trials, { mode: 'exclude-failed' })`, and never let a failed judge silently become a zero.
- **Judge calibration**: a consumer must call `calibrateJudgeContinuous(golden, candidate)` (not the integer-quantised `calibrateJudge`) when judges return [0,1] scores, and gate composites on the returned ICC + κ_w + bootstrap CIs.
- **Analyst registry / findings**: a consumer must register `Analyst<TInput>` instances on an `AnalystRegistry`, use `createTraceAnalystKind` over `DEFAULT_TRACE_ANALYST_KINDS` for trace analysis, persist via `FindingsStore`, and diff cross-run with `diffFindings(prev, cur, { isMaterial })`.
- **Trace analyst surface**: a consumer must persist OTLP-JSONL via `OtlpFileTraceStore`, invoke `analyzeTraces` (or attach `traceAnalystOnRunComplete` as a `RunCompleteHook`), and provide an `inferDomainKeywords`-friendly domain string.
- **Trace chassis**: a consumer must instantiate exactly one `TraceEmitter` per run, end every run via `endRun(outcome)`, never instantiate one `FileSystemTraceStore` per cell (use one store across cells, fixed in 0.23.1), and configure a `RawProviderSink` if it wants raw LLM I/O captured.
- **Integrity / capture**: a consumer must call `assertLlmRoute(llmOpts, req)` before any judge call, `assertRunCaptured(emitter, expectations)` after every run, and `assertRealBackend(emitter, opts)` after every canonical campaign — the trifecta blocks every shipped capture-integrity bug class.
- **Promotion gate / paired stats**: a consumer must compare variants via `pairedWilcoxon` / `pairedBootstrap`, build `GenerationReport`s from `runPromptEvolution`, gate releases through `judgeReplayGate` + `assertReleaseConfidence` (fail-closed), and never compare raw means.
- **IRR / corpus calibration**: a consumer must call `corpusInterRaterAgreement` (or `corpusInterRaterAgreementFromJudgeScores`) over its full eval corpus before trusting a multi-judge composite, and call within-item `interRaterReliability` per scenario when surfacing disputed items.
- **Builder-eval**: a consumer must store traces in a `TraceStore` partitioned by `projectId`, call `scoreProject(store, projectId, opts)` for a `ThreeLayerProjectReport`, drive sessions via `BuilderSession`, and `correlateLayers(reports)` to surface layer-level drift.
- **Driver / Executor / ProductClient**: a consumer must implement `AgentDriverConfig` (or use `ProductClient` for HTTP-style products), pass scenarios from `ScenarioRegistry`, and invoke `executeScenario(config)` per scenario rather than rolling its own loop.
- **Control runtime + action policy**: a consumer must wrap its agent loop in `runAgentControlLoop(config)` with explicit stop policies (`stopOnNoProgress`, `stopOnRepeatedAction`), gate each action with `evaluateActionPolicy`, and convert results with `controlRunToRunRecord` before persisting.
- **Anti-slop / contamination**: a consumer must wire `createAntiSlopJudge` as part of its ensemble, run `runBehavioralCanaries` + `HoldoutAuditor` against held-out corpora, and gate releases on `redTeamReport`.
- **Benchmark + control runtime**: a consumer must register `BenchmarkAdapter` impls under `./benchmarks`, use `deterministicSplit(items, seed)` for reproducible eval/holdout splits, and ship one `BenchmarkRunner` per benchmark not per scenario.
- **Feedback trajectory + production loop**: a consumer must persist feedback via `FileSystemFeedbackTrajectoryStore`, convert control runs with `controlRunToFeedbackTrajectory`, and (when ready) wire `runProductionLoop({ ... })` + an `AutoPrClient` to close the eval→prod→eval cycle.
- **Optimization / mutation**: a consumer must drive variant search through `runPromptEvolution` (cached via `InMemoryTrialCache`/`JsonlTrialCache`) or `runMultiShotOptimization`, supply a `MutateAdapter` (reflective via `buildReflectionPrompt` + `parseReflectionResponse`), and grade with `ScoreAdapter`.
- **Sandbox / harness**: a consumer must build a `SandboxHarness` with a `SandboxDriver` (Docker or subprocess) per language toolchain, parse outputs via the bundled `vitestTestParser` / `jestTestParser` / `pytestTestParser` (or `composeParsers`), and pool slots via `createSandboxPool` when fan-out exceeds a few.
- **RL bridge**: a consumer must convert eval artifacts to `RunRecord`s via `trialsToRunRecords` / `verificationReportToRunRecord`, extract preferences via `extractPreferences`, export training data via `toDpoRows` / `toGrpoRows` / `toSftRows` / `toPrmRows` — never roll its own RL data shape.
- **Pipelines**: a consumer must call the view functions (`failureClusterView`, `regressionView`, etc.) against a shared `TraceStore` to surface insights, not query spans directly.
- **Meta-eval**: a consumer that persists deployment outcomes must use `FileSystemOutcomeStore` and call `rubricPredictiveValidity` / `correlationStudy` periodically to validate that eval scores predict deployment success.
- **PRM**: a consumer that wants step-level rewards must define `StepRubric`s (or use the five builtin rubrics), grade traces with `PrmGrader`, export via `exportTrainingData`, and gate with `prmBestOfN` / `prmEnsembleBestOfN`.
- **Governance**: a consumer must build a `GovernanceContext`, call the relevant report fn (`euAiActReport` / `nistAiRmfReport` / `soc2Report`), render via `renderMarkdown`, and surface findings in the release scorecard.
- **Knowledge**: a consumer must declare every `KnowledgeRequirement` upfront, call `scoreKnowledgeReadiness` before run start, and use `blockingKnowledgeEval` to fail-closed when blocking knowledge is missing.
- **Telemetry**: a consumer must instantiate `TelemetryClient` once per process with a `FanoutTelemetrySink` (HTTP + File), import the file sink only via `./telemetry/file`, and never reach for `node:fs` directly in worker bundles.
- **Wire**: a consumer building a service must call `createApp({ judgeFleet, ingestionStores, auth })` and `startServer`; cross-language clients must consume `openapi.json` (root export) and use the Zod schemas as source-of-truth.
