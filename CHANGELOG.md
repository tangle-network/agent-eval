# Changelog

All notable changes to `@tangle-network/agent-eval` and its sibling `agent-eval-rpc` (Python). The format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are locked across the npm + PyPI packages.

---

## [0.119.2] — 2026-07-14 — exact measured provenance

- Bind portable improvement evidence to the exact baseline and winner surfaces, raw heldout measurements, decision, diff, cost, and duration.
- Reject contradictory provenance and malformed paired cells before products can publish an improvement proposal.

## [0.119.1] — 2026-07-14 — portable improvement evidence

### Added

- `measuredComparisonFromSelfImproveResult()` converts paired held-out quality, cost, latency, uncertainty, power, decision, and provenance into the shared `AgentImprovementMeasuredComparison` contract.

## [0.119.0] — 2026-07-14 — chained, metered trace analysis

### Added

- Trace analysts can consume findings produced earlier in the same ordered run and emit multiple evidence citations without changing the original singular-citation callback API.
- Analyst summaries report provider calls, input, output, reasoning, cache-read, cache-write, dollar provenance, and known partial spend independently of finding count.

### Fixed

- All Ax analyst calls reserve spend before dispatch, disable hidden provider retries, honor cancellation, wait a bounded time for late receipts, and preserve known charges when token usage is unavailable.
- Trace-analysis proposers record each model call directly in the campaign cost ledger instead of replacing them with one estimated wrapper receipt.
- Direct Gemini 3 analysis keeps its output limit without sending Ax's incompatible thinking-level option.
- Recovery findings pass through the same subject, evidence, and post-processing rules as primary findings, and malformed recovery calls fail visibly.
- Budget allocation rejects invalid values and cannot exceed the remaining run budget or regain spend through malformed finding metadata.

### Breaking

- `SemanticConceptJudgeAdapterOpts.options` no longer accepts `costLedger` or `signal`; remove those fields because `AnalystRegistry` now supplies the run budget and cancellation signal and records the resulting usage.
- `createTraceAnalystKind()` now requires `model` when passed an externally constructed Ax service; supply the service's model explicitly or construct it with `createAnalystAi()` so the model can be recovered safely.
- `TraceAnalystGolden.expected` now uses `CanonicalRawAnalystFinding` with an `evidence` array; migrate singular `evidence_uri` and `evidence_excerpt` fields into the first array entry.

## [0.118.2] — 2026-07-13 — interoperable contracts and trace accounting

### Fixed

- Every caller-supplied cost-ledger API now uses the public structural `CostLedgerHandle`, so types remain assignable when TypeScript resolves them through separate package entrypoints.
- Trace writers emit an exact context-input total from known non-overlapping input and cache categories; behavioral analysis uses that value and leaves ambiguous third-party prompt totals unchanged.

## [0.118.1] — 2026-07-13 — parsed OTLP intake

### Added

- `otlpRowsToRunRecords()` and `otlpRowsToTraceRunRecords()` accept already-parsed OTLP flat rows.
  They use the same projection, nested measurement reconciliation, validation, and deterministic ordering as JSONL intake without forcing in-memory consumers to serialize and parse the rows again.

## [0.118.0] — 2026-07-13 — complete execution accounting

### Added

- `InsightReport.execution` reports duration, optional queue time, direct input, output, reasoning, cache-read, and cache-write tokens, model cohorts, model-call coverage, explicit failure counts, and separately labeled orchestration aggregates from the same `RunRecord[]` passed to `analyzeRuns()`.
- `summarizeExecution()` returns those execution facts and cost provenance without interpreting task quality.
- `RunTokenUsage.reasoning` preserves the reasoning subset of normalized output, and `RunTokenUsage.cacheWrite` preserves provider cache creation separately from cache reads.

### Changed

- Trace capture, every OTLP exporter, OTLP intake, and code-agent session intake preserve reasoning, cache reads, and cache writes separately.
- Both OTLP intake paths use one field-by-field reconciliation rule for nested model-call wrappers, preserving complementary parent data without double-counting complete child data.
- Code-agent intake uses the shared provider-usage parser, including OpenCode's nested `cache.read` and `cache.write` fields and OpenAI-compatible token-detail objects.
- OTLP-derived run records explicitly label complete USD as observed, model-priced USD as estimated, and missing or partial USD as uncaptured instead of relying on a zero-value inference.
- Usage parsing reuses `@tangle-network/agent-core` token vocabulary and SSE framing, preserves agent-eval-specific reasoning and cache-write details, reconciles cumulative streams by default, and accepts explicit delta mode through `captureFetchToRawSink({ sseUsageMode })`.
- Run-record validation rejects negative execution measurements and unknown failure classes, and OTLP intake rejects duplicate span identities instead of corrupting totals.
- Declaration bundles build sequentially and package verification compiles a strict Node consumer, preserving the public subpath types without concurrent declaration workers exhausting memory.
- `@tangle-network/agent-interface` is updated to `0.26.x`.

### Breaking

- `InsightReport.execution`, `CodeAgentSessionMetrics.reasoningTokens`, and `CodeAgentSessionMetrics.cacheWriteTokens` are required fields on newly constructed objects.

## [0.117.1] — 2026-07-13 — retry-safe code-candidate cleanup

### Fixed

- `gitWorktreeAdapter().discard()` now reconciles worktree and branch removal independently.
  Repeated cleanup is safe, partial cleanup can be retried, and a Git command that reports an error after completing its mutation no longer strands candidate branches or worktrees.

## [0.117.0] — 2026-07-13 — durable cost and bounded behavioral evidence

### Added

- `createReferenceEquivalenceJudge()` and `runReferenceEquivalenceJudge()` score whether an answer preserves the meaning of one or more references, with the same cost and transport accounting as other judges.

### Changed

- `CostLedger.runPaidCall()` is now the single paid-call path across campaigns, proposers, judges, analysts, and distillation.
  It durably reserves maximum spend before dispatch, records provider receipts, blocks unresolved crash state, and enforces the run ceiling before another paid call starts.
- `ToolSpan.argsCaptured` distinguishes a call with unavailable arguments from a captured no-argument call.
  Repeated-call analysis, failure clustering, tool-use metrics, and per-step redundancy grading no longer compare uncaptured arguments.
  Every OTLP export path uses one mapping that preserves this distinction.

### Breaking

- `CostLedger.record()` is removed because recording spend after a provider call cannot enforce a cost limit or survive a crash.
  Use `CostLedger.runPaidCall()` for billable work, `CostLedger` receipt import for already-settled calls, or `costForUsage()` for pure estimates.
- `computeTraceMetrics()` now rejects mixed-trace input, and `BehavioralMetrics` adds required `traceId` and `tokenSequences` fields.
  The convenience token trajectories now expose the longest proven-serial sequence instead of flattening parallel branches.
- `ToolUseMetrics` and `ToolStats` add required `callsWithCapturedArgs` fields.
  `duplicateRate` now uses captured-argument calls as its denominator.

### Fixed

- Repeated-call findings now require a contiguous, time-bounded, serial episode within one agent branch instead of grouping identical or concurrent calls across an entire run.
- Behavioral token findings now analyze each trace and serial agent timeline independently, use numeric time ordering across accepted timestamp formats, and only attribute output decay to context that actually grew.
- Behavioral issue IDs remain stable across trace runs while evidence retains exact trace identities and sampled prevalence.
- Partial timing isolates only the uncertain interval, and same-named root spans retain independent structural identity.
- Multi-trace behavioral findings use pattern-level claims while each trace's exact values remain in its evidence reference.

## [0.116.0] — 2026-07-12 — evidence-linked AgentProfile optimization

### Added

- `llmPolicyEditProposer()` converts attributed trace findings and bounded search history into typed JSON edits over caller-approved AgentProfile paths.
- Author context selection retains promoted candidates plus outcome extremes, selects task rows by difficulty and change from parent, enforces an exact serialized size limit, and pseudonymizes known task identifiers before model dispatch.
- Policy-edit history and provenance retain the exact edit, measured parent, observed score change, coverage, eligibility, surface bytes, and final winner chain needed for credit assignment.

### Changed

- `runOptimization()` now keeps one best complete surface across every generation.
  Baselines and candidates must cover the exact designed task-by-repetition count, and partial, failed, or non-finite results cannot be promoted.
- Model-authored confidence and gain forecasts no longer suppress evidence-linked candidates by default.
  Forecasts must describe increasing raw search scores, respect the declared range and current headroom, and enter residual history only when their units match the measured outcome.
- GEPA reflection now uses evidence from the measured incumbent that is actually being edited instead of the latest losing candidate.

### Breaking

- `runOptimization({ promoteTopK })` accepts only `1`; multiple concurrent incumbents were never represented by the optimizer state and now fail before dispatch.
- `ScoredSurfaceOutcome` requires `split: 'search'` and the actual `generation` that measured the surface.
- `llmPolicyEditProposer()` requires explicit raw-score objectives and `PolicyEditFindingInput` rows whose source is either an exact measured surface-generation pair or an explicitly global finding.
- `LoopProvenanceRecord.schema` is now `tangle.loop-provenance.v3`.
  Consumers of v2 records must migrate to the v3 baseline score, parent chain, coverage, eligibility, and exact surface fields; no compatibility shim is provided.

## [0.115.3] — 2026-07-12 — fail-closed structured output parsing

### Fixed

- `callLlmJson()` now rejects responses terminated with finish reason `length`, even when the returned prefix happens to parse as JSON.
- JSON extraction no longer descends into a valid nested object or array when a response declares an incomplete top-level JSON root.

This patch prevents truncated structured responses from being silently accepted under the wrong response shape.
Consumers of `callLlmJson()` should update.

## [0.115.2] — 2026-07-12 — truthful code-agent session accounting

### Fixed

- fix(contract): ingest direct Codex 0.144.x exec JSONL lifecycle, tool, patch, terminal, and token events without double-counting transitions or reasoning tokens.
- fix(contract): preserve observed, estimated, and uncaptured USD provenance through code-agent session intake and analyzeRuns.

This patch corrects imported trace and cost semantics while retaining backward-compatible serialized RunRecords.
Consumers importing code-agent execution traces should update.

## [0.115.1] — 2026-07-11 — fair cross-surface baseline selection

### Fixed

- `analyzeCrossSurfaceInteractions()` now builds the naive stack only from single-surface candidates that satisfy individual eligibility.
  Complete, non-regressing neutral constituents remain available exclusively to interaction-aware search, preserving pure-synergy discovery without weakening the naive comparison.

This patch corrects selection semantics without changing the report schema.
Consumers comparing naive and interaction-aware compositions should update.

## [0.115.0] — 2026-07-11 — auditable cross-surface improvement search

### Added

- `openSearchLedger()` records the predeclared candidate, task, and operation denominators for an improvement search in a durable hash-chained event stream.
  Failed proposal slots, partial batches, task attempts, measured cost, surface firing and effect, and terminal selection decisions remain replayable after a crash.
- `analyzeCrossSurfaceInteractions()` compares fixed, best-single, blind-union, and interaction-aware agent changes on the same task rows.
  It preserves missing and invalid attempts, cost, firing, effect, synergy, interference, and every evaluated composition path, including combinations whose constituents are neutral alone.

This release is additive.
Existing consumers do not need to update unless they want durable improvement-search accounting or cross-surface composition.

## [0.114.0] — 2026-07-11 — exact directional paired inference

### Added

- `pairedSignTest(differences, alternative)` computes an exact one-sided sign test for paired numeric differences, excludes zero ties, requires a predeclared `greater` or `less` direction, and reports every denominator.

### Changed

- McNemar's exact two-sided calculation now reuses the same log-space binomial-tail implementation without changing its public result contract.

This release is additive.
Existing consumers do not need to update unless they want the new statistic.

## [0.113.0] — 2026-07-10 — immutable code candidates

### Changed

- `CodeSurface` is now a finalized, content-addressed code candidate.
  `gitWorktreeAdapter.finalize()` records exact base/candidate commits, the final tree, and the SHA-256 + byte length of the raw binary Git patch; `surfaceHash` and `surfaceContentHash` no longer use filesystem paths.
  Binary-patch generation runs against an isolated bare repository with fixed diff options, config, attributes, compression, and locale, so ambient repository, global, system, or environment settings cannot change the digest for identical trees.
- `LoopProvenanceRecord.schema` is now `tangle.loop-provenance.v2`, distinguishing records that use content-addressed code-surface hashes from v1 records whose code hashes included mutable paths.
- `resolveWorktreePath()` now verifies the candidate before returning its checkout.
  Dirty or ignored files, moved refs, missing objects, wrong trees, raw byte or executable-mode mismatches, external symlinks, submodules, and patch-byte mismatches fail instead of being evaluated under stale identity.
  Raw file hashing bypasses Git clean/smudge filters so repository configuration cannot hide different executable bytes.
  Use `verifyCodeSurface()` when a verification receipt is needed directly.

### Breaking

- `resolveWorktreePath()` no longer returns a best-effort, unchecked locator: it verifies the finalized candidate and throws on any identity mismatch.
  There is intentionally no lenient fallback on the evaluation path.
- Path-only `CodeSurface` objects are invalid.
  Every field in the finalized identity is required.
  Downstream callers must migrate to adapter-finalized candidates when adopting 0.113.0.

## [0.112.0] — 2026-07-10 — complete agent-surface findings

### Added

- Added typed finding subjects for skills, MCP servers and tools, hooks, subagents, workflows, rollout policy, generic agent-profile fields, and code paths.
- Routed every new subject into a typed policy edit so products do not need local string classifiers.

### Changed

- Updated the direct `@tangle-network/agent-interface` dependency from `^0.10.0` to `^0.22.0`.

## [0.111.0] — 2026-07-09 — repository-clustered paired inference

### Added

- Added `clusteredPairedBinary`, which pairs binary outcomes by work item, exposes every unmatched row, resamples whole repositories for a task-weighted confidence interval, and tests the same effect with whole-repository sign flips.
- Added Holm step-down adjustment for strong family-wise error control across benchmark arms.

The cluster interval is unavailable below two repositories, and consumers must reject unmatched rows before promotion.

## [0.110.1] — 2026-07-09 — proposer portfolio export

### Added

- Exported the existing `compositeProposer` and `CompositeProposerOptions` from `@tangle-network/agent-eval/campaign`, so consumers can split one population budget across GEPA, SkillOpt, FAPO, memory, trace-analysis, or other proposers without copying the portfolio implementation.
- Added a packed-package import check for the export.

No proposer behavior changed.

## [0.108.1] — 2026-07-08 — public catalog docs patch

### Fixed

- Added the missing public TSDoc summary for `Lineage`, so downstream primitive catalogs can consume the latest campaign surface without tripping their undocumented-callable ratchet.

No behavior changes.

---

## [0.108.0] — 2026-07-08 — placebo control reaches the facades

### Added

- **`neutralize` passthrough on `selfImprove`.** 0.107.0 wired the footprint-matched placebo arm at `runImprovementLoop`; the public `selfImprove` facade did not forward it, so the placebo gate was unreachable from the one-call entry point. `selfImprove({ ..., neutralize })` now scores the third placebo arm and exposes `ctx.neutralizedJudgeScores` to the gate — compose `neutralizationGate` into `gate` to act on it.

Additive (one optional field); no consumer bump required.

---

## [0.107.0] — 2026-07-07 — footprint-matched placebo promotion gate

### Added

- **`neutralizationGate` + `neutralizeText` (`/campaign`).** A composable promotion gate that proves a held-out lift comes from the candidate's *content* rather than from the prompt/mount *footprint* the content added. A held-out gate proves "candidate beat baseline"; it cannot tell an informative surface from one that merely added bytes the model spends attention on. `neutralizationGate` compares the candidate's lift against a footprint-matched neutralized variant (same layout + length, zero content, via `neutralizeText`) and holds any win whose lift survives blanking (decorative) — however large or significant the raw lift. Compose after significance: `composeGate(heldOutGate({ … }), neutralizationGate({ … }))`.
- **`runImprovementLoop({ neutralize })` + `GateContext.neutralizedJudgeScores` / `neutralizedArtifacts`.** When a `neutralize` function is supplied and the winner changed, the loop scores a third holdout arm (the blanked winner) and exposes it to the gate. Opt-in — one extra holdout campaign only when wired; existing callers are unaffected.

Additive (new exports + optional fields only); no consumer bump required.

---

## [0.100.3] — 2026-07-01 — product benchmark contract + eval fixture UX

### Added

- Published the `@tangle-network/agent-eval/product-benchmark` subpath so product agents can share one strict product-benchmark manifest, record, artifact, and integrity validator instead of copying Agent Lab or product-local schema code.
- **Vercel-style eval fixture loading in `/campaign`.** `discoverEvalFixtures`, `loadEvalFixture`, `loadEvalFixtureScenarios`, and `planEvalFixtureRun` let agents use the simple `evals/<name>/PROMPT.md + EVAL.ts + package.json` shape while still executing through the existing `runCampaign` primitive.
- **Dry-run planning for campaigns.** `planCampaignRun` reports `totalCells`, `cellsCached`, `cellsToRun`, per-cell cache paths, and miss reasons before any agent work starts. This is the cheap proof before spending tokens.
- **`dispatchRef` on `runCampaign`.** Callers can include the model/tool/prompt/runtime identity in the manifest when the same dispatch function name can run different behavior.

### Fixed

- **Campaign resumability now validates `manifestHash` before reusing a cached cell.** Reusing the same `runDir` after changing scenario payloads, judges, seed/reps, or `dispatchRef` no longer serves stale cells that only match by `cellId`.

### Docs

- Added `docs/eval-fixtures.md` and `examples/eval-fixtures-quickstart/` so agents can add fixture-backed evals without rediscovering the campaign plumbing.

---

## [0.96.4] — 2026-06-22 — multishot fatal tool errors

### Added

- `MultishotFatalToolError` from `@tangle-network/agent-eval/multishot`. Tool executors can throw it when a tool failure should abort the cell instead of being fed back to the agent as a recoverable tool message.

## [0.96.3] — 2026-06-22 — multishot driver transcript hygiene

### Fixed

- `runMultishot` no longer sends empty transcript messages to the persona driver after tool-only assistant turns. Tool-only turns are represented as concise tool-call summaries, preventing router 400s for empty message content while preserving the simulated user's awareness of agent actions.

## [0.96.2] — 2026-06-22 — multishot tool loop

### Fixed

- `runMultishot` now keeps tools available across follow-up dispatch rounds and executes sequential tool calls until the agent returns text or hits `maxToolDispatches`. This prevents router-backed agents from emitting tool syntax as plain text after the first tool result.

### Added

- `maxToolDispatches` on `runMultishot` and `runMultishotMatrix` to fail loudly when one assistant turn exceeds the configured tool budget.

---

## [0.95.0] — 2026-06-21 — FAPO proposer + public-surface prune

### Added

- **FAPO proposer policy** in the campaign proposer family — feeds `runImprovementLoop` / `runCampaign` proposer-driven self-improvement (`gepaProposer` at `src/campaign/proposers/gepa.ts`).

### Changed

- Profile handling finalized on the canonical `@tangle-network/agent-interface` `AgentProfile` — completes the migration in 0.94.0. Per-run profile cells are built via `buildAgentInterfaceProfileCell` with `sourceProfile.kind = 'agent-interface-profile'`.
- Proposer and trace plumbing cleaned up across the campaign surface.

### Removed

- **Pruned stale public exports.** Loop / proposer / ship-gate primitives (`runImprovementLoop`, `gepaProposer`, `defaultProductionGate`, `defineAgentEval`, `runCampaign`, …) are reached via the `@tangle-network/agent-eval/contract` subpath; importing them from the package root no longer resolves.

---

## [0.94.0] — 2026-06-21 — canonical AgentProfile + defineAgentEval DX

### Changed

- **Agent profiles now use the canonical `@tangle-network/agent-interface` shape.** The old local flat profile shape is gone. Eval-owned helpers remain in agent-eval: `agentProfileHash`, `agentProfileId`, and `agentProfileModelId`.
- **Profile ids are collision-resistant, path-safe labels.** `agentProfileId(profile)` now returns `label-<hash-prefix>` instead of a bare name/version label, so profile-matrix `byProfile` and `campaigns` keys no longer collapse distinct same-label profiles. Use `profile.name` for display-only labels.
- **Profile hashes and profile-cell kinds intentionally changed.** `agentProfileHash` now hashes the canonical nested `AgentProfile` behavior surface, and profile cells use `sourceProfile.kind = 'agent-interface-profile'`. Existing scorecard/profile artifacts keyed by the old flat shape or old kind may not join with new rows; this is a clean greenfield migration, not a compatibility-preserving release.
- **`defineAgentEval()` is the app-facing helper for the common flow.** Define scenarios, agent, judge, and baseline once, then call `.evaluate()` or `.improve()`. Nested per-call overrides for `budget`, `llm`, and `hostedTenant` merge field-by-field; invalid `budget.reps` and empty judge lists fail loudly.

### Removed

- Removed stale sandbox-profile compatibility names and obsolete Phase-B / self-improvement strategy docs instead of keeping legacy aliases or guidance.

---

## [0.90.0] — 2026-06-10 — infra perf-benchmark substrate (`/perf`)

Domain-agnostic infra-performance benchmarking: a journeys × axes scenario matrix, record-integrity contracts over flat metric records, and a percentile ratchet. Complements the judge-panel `BenchmarkRunner` (root) — that one scores QUALITY via judges; `/perf` scores LATENCY / RELIABILITY. All additive — no existing export changed.

### Added

- **`JourneySpec` + `expandMatrix` + `scenarioKey` (`/perf` + root).** A journey is one measurable user path (`provision.cold`, `chat.ttft`) carrying its own data contract: `requiredFields` (must be non-null on a passing record), `minimums` (numeric floors, e.g. `event_count ≥ 1` for streaming), `phaseFields` (per-phase breakdown, reported separately), and `requiresLLM` (nightly vs per-PR scheduling). `expandMatrix` does the cartesian expansion over free-form `ScenarioAxes` (driver × region × …) with a `filter` for invalid combos; scenario keys are `journeyId|dim=value|…` with dims sorted, so the key is stable across axes-object insertion order.
- **`checkRecordIntegrity` + `assertRecordIntegrity` (`/perf` + root).** A record claiming `pass === true` must actually carry its journey's required measurements — a "passing" run with a null `total_ms` is an integrity violation (`null-required-field` / `below-minimum`), not a pass. Failed records are exempt (an errored run legitimately has nulls); `resolveJourney` returning null skips the record. The assert variant throws listing every violation.
- **`summarizeRecords` + `gatePerf` (`/perf` + root).** Percentile ratchet: fold flat records into per-scenario `PerfStat` (`p50` / `p90` / `n`, nearest-rank on sorted values), then gate a current `PerfBaseline` against a committed one. Null / non-numeric metric values are excluded from `n` and a zero-sample field is omitted — no fake zeros. Regressions trip when p50 OR p90 exceed `tolerancePct` (default 10) over baseline; strict improvements are reported with negative `overBy`; scenarios under `minSamples` (default 3) in current are surfaced in `missingScenarios` and never gated; baseline/current key drift lands in `missingScenarios` / `newScenarios`.

One clean, canonical version of five generic patterns the fleet kept hand-rolling across 2–4 product agents each. All additive — no existing export changed.

### Added

- **`ExperimentTracker` + `improvementVerdict` + `computeExperimentStats` (root).** Git-provenanced experiment log with N-rep stats (`median` / `mean` / `min` / `max` / `iqr` / `stddev` / `passRate` / `n` + a `stable` flag) and a `KEEP` / `REGRESSION` / `NOISE` / `ITERATE` verdict against a parent. Provenance (`ProvenanceReader`, default `gitProvenanceReader`) and persistence (`ExperimentStore`, with `inMemoryExperimentStore` + `fileExperimentStore`) are injected, so the stats + verdict are pure and unit-testable without a repo or disk. Thresholds (`keepThreshold` / `regressionThreshold` / `iqrUnstableAbove` / `stddevUnstableAbove` / `minRepsForVerdict`) are configurable. Replaces the per-agent `tests/eval/lib/experiment-tracker.ts` copies (tax / insurance / legal).
- **`EvalTraceStore` + `runScore` (root).** JSONL save / query / compare over the analysis-time `RunRecord` row: `query(filter)`, `getBest(scenarioId)`, and `compareRuns(a, b)` (paired on matched scenarios, best-score-per-scenario). Persistence is injected via `RunRecordBackend` (`inMemoryRunRecordBackend` / `jsonlRunRecordBackend`, which fail loud on a malformed line). Does NOT fork `FileSystemTraceStore` (the rich TraceSchema-v1 span store) — it is the analysis projection beside it. Replaces the hand-rolled `tests/eval/lib/trace-store.ts` copies.
- **`CostLedger` + `costForUsage` + `modelPriceKey` (root).** Per-run token + USD accounting folded over the substrate's `resolveModelPricing` / `isModelPriced`, with an explicit `costUnknown` axis so a $0 from an unpriced model is never mistaken for a measured free run. Classifies spend by channel (`agent` / `judge` / `verifier` / …), surfaces `unpricedModels` + `fullyPriced`, and computes `costPerCompletedTask`. Generalizes physim's `costForUsage` / `modelPriceKey` and the tax / gtm / agent-builder copies.
- **`extractUsage` + `extractUsageFromSse` + `extractUsageFromResponse` (`/traces` + root).** Token-usage extraction from a chat-completions response or an SSE stream — OpenAI / Anthropic / camelCase shapes, cache-read tokens, and per-chunk SSE accumulation — returning `null` (not a silent zero) when no usage is present. `captureFetchToRawSink` gains an optional `onUsage` callback that emits the parsed usage off each response (reusing the body it already reads — no extra clone), so a caller folds usage → cost without re-cloning. Replaces the insurance / legal / gtm `raw-capture.ts` copies.
- **`partitionHeldOut` + `assignHeldOutTag` + `hashToUnit` + `fnv1a32` (root).** Deterministic FNV-1a id+seed held-out splitter. `assignHeldOutTag` stamps a single id; `partitionHeldOut` splits a whole id list into disjoint search / holdout sets and fails loud on duplicate ids, empty input, an under-floor holdout (`minHoldout` / `minSearch` significance floor), or an out-of-range `holdoutFraction`. Generalizes agent-builder's `deterministicSplit` and the frontier persona-splitter; complements the existing 3-way benchmark `deterministicSplit` in `/benchmarks`.

---

## [0.83.0] — 2026-06-05 — hostedTenantFromEnv

### Added

- **`hostedTenantFromEnv` (`/hosted`).** Builds a `HostedTenant` config from env (the input `selfImprove({ hostedTenant })` and `emitLoopProvenance` take), with the same env precedence + overrides as `hostedClientFromEnv` — which now composes it. Returns `undefined` (not an error) when unconfigured, so a product wires `hostedTenant: hostedTenantFromEnv({ tenantId: 'my-agent' })` unconditionally and hosted ingest stays off until the env is set. Removes the env→tenant mapping every product would otherwise hand-roll when collapsing onto `selfImprove`.

---

## [0.82.0] — 2026-06-05 — selfImprove forwards the full loop surface

### Changed

- **`selfImprove` now forwards every loop knob a product needs**, so a product agent collapses its entire hand-rolled `runImprovementLoop` + `emitLoopProvenance` harness onto one `selfImprove` call with no loss of fidelity. New pass-throughs: `budget.reps`, `budget.promoteTopK`, and options `labeledStore`, `captureSource`, `expectUsage`, `analyzeGeneration` (the per-generation findings producer / EYES→HANDS closure), and `findings`.
- **`selfImprove` defaults `expectUsage: 'assert'`** (was effectively `'warn'`). It is the real-run path, so a stub cell (produced an artifact but reported `costUsd === 0` and zero tokens) now fails loud by default instead of scoring a clean 0. Offline/replay callers set `expectUsage: 'off'` explicitly — the honest opt-out.

### Migration

A deterministic offline test that drives `selfImprove` with a mock agent must now pass `expectUsage: 'off'` (no real backend to assert). Real-backend callers are unaffected — `'assert'` passes on real LLM usage by construction.

---

## [0.81.0] — 2026-06-05 — eval-campaign scaffold prep primitives

### Added

- **`aggregateJudgeVerdicts<D>` (root).** Generic judge-ensemble reducer: fan out N uncorrelated judges, mean each rubric dimension over the SURVIVORS, report the inter-rater disagreement spread, sum cost. Replaces the same reduction hand-rolled across multiple product agents. Fail-loud: a failed judge (`perDimension: null`) is recorded in `failedJudges`, never folded into a zero; all-failed throws; a failed judge's cost is still summed. Composite reuses `weightedComposite`.
- **`createTokenRecallChecker` (root).** The deterministic, no-LLM `CorrectnessChecker` — sibling of `createLlmCorrectnessChecker`. A produced item fulfils a requirement when its content is substantive and recalls ≥ `minRecall` of the requirement title's significant tokens. The default completion gate for apps/tests without an LLM judge.
- **`ErrorCluster` (root + `/analyst`).** The failure-cluster element type is now a named export, so consumers import it instead of deriving `DatasetOverview['error_clusters'][number]`.

### Fixed

- **Lint drift + non-executable pre-commit hook.** `.husky/pre-commit` was tracked `100644`, so the hook silently no-op'd and unformatted code reached `main`; marked executable and reformatted the drift.

---

## [0.72.3] — 2026-06-01 — workflow trace hardening and driver backtests

### Added

- **Canonical workflow branch events in `/workflow`.** Runtime traces now project branch start/end/failure counts into workflow summaries, RunRecords, and feedback trajectories so fanout topology failures are measurable instead of hidden in raw trace blobs.
- **`workflowPhaseGraph` in `/workflow`.** Builds phase nodes and branch edges from workflow trace events with per-phase calls, branch failures, cost, and token counters. Product adopters can consume this instead of maintaining local graph mirrors.
- **Stricter workflow event schema validation.** Workflow traces now reject unknown event kinds, malformed typed payloads, non-monotonic timestamps, missing `workflow.started`, multiple terminal events, and events after terminal completion.
- **Driver comparison substrate proof.** `compareDrivers` now carries analyst findings through the canonical campaign path and includes GSM8K/AppWorld driver backtest examples.

### Fixed

- **Publish skew guard.** PyPI publishing depends on successful npm publishing, and the npm publish job now checks registry authentication and `@tangle-network` package access before building or attempting a publish.

---

## [0.72.2] — 2026-06-01 — workflow driver promotion gates

### Added

- **`decideWorkflowDriverPromotion` in `/workflow`.** Compares a dynamic workflow driver against the reviewer-loop baseline using paired heldout `RunRecord`s keyed by `scenarioId::seed`, then fails closed on missing pairs, too few pairs, insufficient lift, or candidate cost ceilings.
- **Explicit workflow comparison axis.** `expectedScenarioIds` defines the promotion gate's comparison set so unrelated scenarios cannot skew the lift or confidence interval.

### Fixed

- **No seed-only workflow pairing.** Promotion records without `scenarioId` are rejected instead of being paired by seed alone.

---

## [0.72.1] — 2026-06-01 — workflow execution summaries for dynamic drivers

### Added

- **`summarizeWorkflowExecution` in `/workflow`.** Builds the canonical rich projection from a workflow trace: event-kind counts, phase order, agent and loop delegate summaries, verifier/analyst/reviewer checkpoint outputs, cost, tokens, and failure status.
- **Checkpoint output extraction.** Verifier, analyst, and reviewer traces preserve the returned output through `trace.checkpointOutput`, with `trace.output` accepted for compatibility.

### Fixed

- **npm/PyPI version lock.** The Python RPC package version is bumped back into lockstep with the npm package so the publish workflow can release both artifacts from one tag.

## [0.72.0] — 2026-05-31 — cost axis prices unpriced-at-source models (every run carries a real, labeled cost)

A live tax-agent full-loop run (real sandbox, `deepseek-v4-pro`, real tokens) exposed the second root of the cost-ledger split: the sandbox reported `totalCostUsd: 0` despite `17537` input / `622` output tokens — not a stub, not a mis-wired ledger, but a model the **source** can't rate. The cost / Pareto / `tokens_per_dollar` axes blanked even though the substrate's pricing table prices `deepseek` correctly; the table was simply never consulted on the matrix cost projection. A $0 cost on a run that burned real tokens reads as "free," which is the more misleading state.

### Fixed

- **`runProfileMatrix` prices measured tokens when the source reports $0.** Cost precedence is now explicit: **source-billed > token-estimated > none**. When `cell.costUsd === 0` and real output tokens flowed and the model is priced (`isModelPriced`), `buildRunRecord` sets the cost from `estimateCost(in, out, model)` (real published rate × real tokens) and stamps `raw.cost_estimated = 1`. A billed cost is never overridden; a model the table also can't rate stays $0 (no fabrication). The estimate flows into `record.costUsd`, so `byProfile.totalCostUsd`, `integrity.totalCostUsd`, and `tokens_per_dollar` / `cost_per_quality` all populate.
- **Every cost surface in the matrix result agrees.** The embedded `campaigns[id].aggregates.totalCostUsd` is reconciled to the priced total instead of runCampaign's raw `ctx.cost` ledger (which only sees the source's $0). No more two-`totalCostUsd`-that-disagree in one result.
- **Honest integrity diagnosis.** `summarizeBackendIntegrity`'s uncosted-records message now names **both** roots — mis-wired ledger OR unpriced-at-source model — and points at `estimateCost` for the latter, instead of asserting the ledger is broken.

Live proof: the same tax case that recorded `$0` now records **`$0.0059453`** (`17537 × 0.0003/1k + 622 × 0.0011/1k`, exact), `cost_estimated: 1`, `uncostedRecords: 0`, verdict `real`. Generalizes to every consumer of `runProfileMatrix`. New regression tests: priced-when-source-zero, billed-takes-precedence, truly-unpriced-stays-$0, campaign-aggregate-reconciled. Full suite (1663) green.

## [0.71.0] — 2026-05-31 — corpus-by-default + multi-dimensional capture (datasets as eval exhaust)

Every matrix run now emits a multi-dimensional, dataset-able record with no side-channel — the groundwork for "datasets gathered for free by running evals."

### Added

- **Multi-dim guardrail projection in `buildRunRecord`.** Each `RunRecord.outcome.raw` carries `cost_usd`, `tokens_input` / `tokens_output` (+ `tokens_cached` when present), `latency_ms`, and the guarded ratios `tokens_per_dollar` / `cost_per_quality`. RAW-ONLY — the composite stays the judge objective (anti-Goodhart); these are tracked + dashboarded + carried into datasets, never optimized.
- **Corpus-by-default via `corpusText`.** An optional `corpusText(artifact, scenario) => {prompt, completion}` stamps the trajectory text onto each record (the `CorpusRecord` shape), so a run is dataset-able with no side-channel. Fail-soft: a throwing extractor omits the text and keeps the graded record.
- **`appendToCorpus` / `readCorpus` / `buildDatasetFromCorpus`** (`src/rl/corpus.ts`) — append-only JSONL corpus (deduped by `runId`), with score/split filtering into a train/holdout dataset.

`buildRunRecord` is generic over `<TScenario, TArtifact>`; a `scenarioById` map threads each scenario into the projection.

## [0.70.0] — 2026-05-31 — error-grounded reflection (the driver targets real failures, not blind rewrites)

Adversarial verification on TWO domains (legal + tax, two worker models) found the same root cause: the gepaDriver's candidates **regressed** the baseline, so the gate correctly held — but nothing improved. The driver was reflecting on per-scenario *scores* only; the judge's `notes` (the "why it failed") were computed but **dropped** before the reflection. So it proposed generic rewrites a capable model already knows, which distract rather than help.

### Fixed

- **Judge `notes` now reach the reflective driver.** `campaignBreakdown` collects each scenario's judge `notes` (deduped) into `scenarios[].notes`; `GenerationCandidate.scenarios` + `CampaignBreakdown.scenarios` carry it; `gepaDriver`'s `buildEvidence` surfaces it as `TrialTrace.failureNote`; `buildReflectionPrompt` renders a **"Why it scored low"** block per bottom trial. The optimizer now grounds its next edit on the actual failure pattern.
- **Anti-overfit by contract + by construction.** The `notes` are documented as GENERALIZABLE failure patterns (which checks/lines/dimensions failed, and how) — NOT case-specific ground truth; leaking expected answers would be memorization. And the held-out gate is the structural backstop: a candidate that overfits train cannot clear the paired-bootstrap CI on cases the driver never saw.

Generic — any agent benefits by having its judge emit informative `notes`. 3 new tests (notes surfaced + deduped + rendered into the reflection); full suite (1645) green.

## [0.69.0] — 2026-05-30 — strong generic baseline roles (engineer / researcher / generalist)

The structured profile (0.68.0) had a hollow top zone — `baselineProfile` took an arbitrary `role` string. Products are file-producing, tool-using agents living in a sandbox, but nothing gave them a strong operator foundation. This adds three generically-useful, verification-first baseline roles distilled from agent-runtime's `coderProfile` doctrine.

### Added (`profile.*`)

- **`engineerRole`** — a senior principal / 10x-IC sandbox operator: produce the real artifact then verify it; smallest correct change; **run the checks and fix the root cause — never weaken a test or hide an error**; inspect external-boundary outcomes; "done" = produced AND verified.
- **`researcherRole`** — read the real sources, cite every material claim, mark inference vs. verified, never fabricate a source/quote/number.
- **`generalistRole`** — strong default: do over describe, ground claims, verify before done, ask only on genuinely user-owned choices.
- `BASELINE_ROLES` (keyed `engineer|researcher|generalist`) + `baselineProfileFromRole(role, overrides?)` — pick a foundation, override the environment to describe THIS product's sandbox, then layer domain via `prodProfile`.

**Layering discipline:** these are domain-AGNOSTIC and verification-first. Domain strength (legal M&A persona, tax-calc rigor) stays in the **product repo** and composes on top via `domain[]`; it is lifted into the substrate only once ≥2 products genuinely reuse it. 3 new tests assert the roles are distinct, verification-first, and carry no product-domain words. Full suite (1642) green.

## [0.68.0] — 2026-05-30 — structured AgentProfile (the self-improvement surface stops being an opaque blob)

The optimizable surface was an opaque string addendum, so the loop could only mutate (and the dashboard only diff) an unstructured blob — you couldn't see *what kind* of improvement a candidate made. This adds a **sectioned `AgentProfile`** primitive (mirrored on Harvey LAB's system-prompt structure) so the surface has named, separately-addressable zones the loop targets one at a time.

### Added

- **`profile` namespace** (`import { profile } from '@tangle-network/agent-eval'`):
  - `AgentProfile { role, environment, toolConventions, skills: ProfileSkill[], domain: AgentProfileSection[] }` — the structured surface. `environment` is a first-class section (the sandbox contract: workspace root, read-only documents, output dir, skills dir), matching how an agentic harness actually addresses its sandbox.
  - `renderProfile(p)` emits the system prompt in fixed order: role → `## Environment` → `## Tool conventions` → `## Skills` → `## Domain guidance`.
  - `baselineProfile` / `prodProfile(baseline, shipped)` — baseline = empty domain + stock skills; prod = baseline + gate-certified domain sections.
  - `applyDomainPatch(p, sectionId, body)` — **section-scoped** edit so the improvement loop optimizes ONE evolvable section, not the whole blob; `profileToSurface(p)` bridges to the existing string `MutableSurface`.
- Namespaced as `profile.*` to avoid clashing with the benchmark-cell `AgentProfile` already exported from `./agent-profile`.

Additive — does not touch `runImprovementLoop` or the string surface. 15 tests (zone order; only evolvable sections change hash under `applyDomainPatch`; baseline vs prod differ only in domain/skills; Environment present + non-empty). Full suite (1639) green. First consumers: the TaxCalcBench + Harvey LAB benchmark adapters (tax-agent / legal-agent) that score our agent's profile against public leaderboards.

## [0.67.0] — 2026-05-30 — the promotion gate is statistically trustworthy (no more shipping noise)

An adversarial review of a real "ship +4.0 lift" decision found it was a **triple false positive**: the driver's candidate lost on train, so the winner was the baseline (empty diff); the loop re-scored the baseline against ITSELF on the holdout and read run-to-run model noise (91 vs 95) as a "+4 lift"; and a point-estimate gate (`delta >= 0.03` on a 0-100 scale, `reps:1`) shipped it — while the reward-hacking gate was blind to a −30 regression on a safety dimension hiding under the +4 net. The promotion gate could not tell a real improvement from noise or from a Goodhart trade.

### Fixed / Added

- **No-op guard** (`runImprovementLoop`) — when the winner is byte-identical to the baseline (no candidate beat the training baseline, empty diff), the loop now forces `hold` and skips the meaningless baseline-vs-itself holdout pass, instead of shipping the noise delta.
- **Statistical held-out gate** — `defaultProductionGate`'s held-out check is now a **paired bootstrap CI**, not a point estimate. It pairs candidate vs baseline holdout cells by **full `cellId` (`scenario:rep`)** — never averaging reps away — and ships only when the CI lower bound clears `deltaThreshold` (default 0 ⇒ confidently positive). Below `minProductiveRuns` (default 3) paired observations it HOLDS with `few_runs` rather than reading a degenerate interval. (New module `src/campaign/gates/statistical-heldout.ts`; reuses `pairedBootstrap` from `src/statistics.ts`.)
- **Per-dimension regression guard (anti-Goodhart)** — `criticalDimensions` + `regressionTolerance` on `DefaultProductionGateOptions`. The gate HOLDS if any guarded dimension's paired-delta CI lower bound falls below −tolerance, even when the net composite rose. Tolerance auto-scales (0.05 on [0,1], 5 on 0-100) so a default expressed for one scale isn't a silent no-op on the other.
- **Exports** `pairHoldout`, `heldoutSignificance`, `dimensionRegressions`, `detectScale` from `/campaign`.

This collapses the duplicated gate tech-debt (a rigorous `src/held-out-gate.ts` existed but the loop wired the weak adapter) onto the shared `pairedBootstrap` statistics. 12 new regression tests, including the exact noisy-same-mean false positive and the composite-up/dimension-down Goodhart trade. Full suite (1624) green. The remaining path to a *proven* self-improvement (headroom corpus + Goodhart-resistant measurement, driver effectiveness, inter-cycle compounding) is tracked separately.

## [0.66.0] — 2026-05-30 — the improvement loop can no longer hang silently or ingest to the wrong URL

### Fixed

- **`runCampaign` per-cell dispatch deadline (`dispatchTimeoutMs`).** A dispatch that neither resolves nor rejects — a stalled model request, an exhausted runtime resource, a stream that never closes — used to hang the cell, and with it the lane, the campaign, `runImprovementLoop`, and the CI job above them, **forever, with no diagnostic**. The cell now races its dispatch against the deadline; on timeout it aborts the cell's `ctx.signal` and records a LOUD error (`dispatch exceeded <N>ms`) while the campaign proceeds. `undefined`/`0` = unbounded (legacy).
- **`runImprovementLoop` fails loud on an empty holdout.** When every holdout dispatch or judge errored, the gate read both means as 0, computed delta 0, and silently **"held" on garbage** — indistinguishable from a real no-lift result, masking upstream crashes (e.g. a consumer scorer that threw on a malformed scenario). The loop now throws a diagnostic error naming the first underlying failure instead of emitting a verdict over zero scorable cells. It also applies a default per-cell deadline (`DEFAULT_DISPATCH_TIMEOUT_MS`, 10 min, overridable) to every campaign it runs.
- **Hosted ingest URL normalization.** The client appends the versioned `/v1/ingest/...` path itself, but callers (and the client's own prior doc) routinely pass the versioned base `https://host/v1` — producing `/v1/v1/ingest/...` → **404, silently dropping every event**. `post()` now strips a trailing `/v1` (and slashes) from the endpoint so both `https://host` and `https://host/v1` resolve correctly; the doc now shows the bare host.

### Why it matters

These three were a single failure chain in production: a consumer's judge threw on a subset of scenarios → the holdout produced no scorable cells → the loop hung instead of failing loud → no decision, no provenance — and even when it did complete, the activated ingest env (`…/v1`) 404'd. The loop now either completes with real data or fails loud, and its provenance lands.

## [0.65.0] — 2026-05-30 — `emitLoopProvenance` ships the eval-run event too (full dashboard visibility)

### Fixed

- **`emitLoopProvenance({ hostedClient })` now ships BOTH the eval-run event AND the trace spans** to the hosted collector. It previously shipped only `ingestTraces(spans)` — so a wired product's run never appeared in the Intelligence dashboard's run list (which keys on `/v1/ingest/eval-runs`); only the trace drill-down received data. It now builds an `EvalRunEvent` (baseline + winner held-out snapshots, gate decision, held-out lift, cost, duration) from the loop args + record and POSTs it alongside the spans. Both legs stay best-effort (an offline collector is logged, never thrown; the durable on-disk artifact remains the source of truth). With this, a product wiring ingest via `hostedClientFromEnv()` (0.64.0) gets the full run — list + drill-down — from one `hostedClient` pass.

## [0.64.0] — 2026-05-30 — `hostedClientFromEnv()` — one-call ingest wiring for the fleet

### Added

- **`hostedClientFromEnv(overrides?)`** (`/hosted`) — the canonical, fail-soft way to wire a product's eval-run + trace provenance to the Intelligence dashboard. Reads `TANGLE_INGEST_URL` → `TANGLE_ORCHESTRATOR_URL` (endpoint), `TANGLE_INGEST_API_KEY` → `TANGLE_API_KEY` (key), `TANGLE_TENANT_ID` (tenant); returns a `HostedClient` or **`undefined`** when any is missing — so a product wires the ship call unconditionally (`emitLoopProvenance({ hostedClient })` / `selfImprove({ hostedTenant })`) and it stays a no-op until the env is set. Strips a trailing slash; `overrides` (e.g. a fixed per-product `tenantId` label) win over env. Replaces the per-product `resolveHostedClient()` copies with one substrate helper.

---

## [0.63.0] — 2026-05-30 — the full optimizer drivers: GEPA Pareto + SkillOpt + a head-to-head lift benchmark

Closes the optimizer-completeness gap (#101/#100). `gepaDriver` was reflection-only; the SOTA SkillOpt technique was roadmapped but unbuilt; and there was no head-to-head benchmark, so optimizer quality was measurement-invisible — a simplified driver could ship unnoticed. This release ships both drivers in full and the forcing function that keeps them honest.

### Added

- **GEPA Pareto frontier + combine-complementary-lessons (#101).** `runOptimization` now accumulates every scored surface as a per-scenario objective vector and recomputes the non-dominated set before each generation, handing it to the driver as `ctx.paretoParents` (new `ParetoParent` type). A surface uniquely best on one hard scenario survives even when its mean composite is lower. `gepaDriver` spends one population slot merging the frontier parents' complementary strengths (toggle via `combineParents`, default on; fires only when the frontier has >1 member). `RunOptimizationResult.paretoFrontier` exposes the final frontier. Dominance is computed by the package-canonical `paretoFrontier` (`src/pareto.ts`) — the parallel `src/campaign/pareto.ts` fork has been deleted (one dominance implementation).
- **SkillOpt patch-mode driver + `runSkillOpt` preset (#100)** (Microsoft, arXiv:2605.23904). `skillOptDriver` proposes BOUNDED add/delete/replace patches to one skill document (`applySkillPatch`, `SkillPatch`); `runSkillOpt` is the held-out-gated epoch hill-climb: reflect on TRAIN weaknesses → propose ≤ `editBudget` ops → score on the held-out split → ACCEPT only on STRICT held-out improvement, else buffer the rejected edit; with edit-budget annealing (the "textual learning rate") and a slow-update meta note. The held-out composite is monotonically non-decreasing by construction — a regression can never ship. Proposals reflect on train evidence only (no held-out leakage).
- **`compareDrivers` head-to-head lift benchmark (the forcing function).** Runs N optimizer entries on ONE corpus, scores the baseline + every promoted surface UNIFORMLY on the same held-out scenarios, and reports per-driver lift + paired-bootstrap CI + pairwise "which driver wins" CIs, ranked (cost breaks a lift tie). Ships `gepaReflectionEntry` / `gepaParetoEntry` / `skillOptEntry` to wire the real optimizers. Optimizer quality is now a number with a confidence interval — a driver regression turns a build red instead of going invisible.
- **`campaignMeanComposite` / `campaignBreakdown`** (`score-utils`) — the one definition of "composite of a campaign" + per-scenario/dimension breakdown, now shared by `runOptimization`, `runSkillOpt`, and `compareDrivers` (extracted from `runOptimization`'s private copies).

### Changed

- `gepaDriver`'s docstring + new `combineParents`/`combineMaxParents` options reflect the now-complete GEPA mapping (reflection + Pareto + combine).

---

## [0.62.0] — 2026-05-30 — eval↔runtime boundary hardening (honest cost meter + per-cell stub guard)

From the agent-eval ↔ agent-runtime boundary critique. Builds on `runProfileMatrix` (0.61.0).

### Fixed

- **`CampaignCostMeter` docstring no longer lies.** It claimed "Substrate auto-tracks LLM costs via the cost-ledger backend hooks" — false (the meter mutates only on explicit `observe`/`observeTokens`), and it contradicted `observeTokens`' own doc. That doc was the root cause of consumers skipping `observeTokens`, getting `{0,0}` stub cells, and building `RunRecord`s on a side-channel. The doc now states plainly: nothing is captured automatically; the dispatch MUST report.

### Added

- **`runCampaign({ expectUsage })`** — per-cell stub guard, the early/fine-grained sibling of batch `assertRealBackend`. A cell that produced an artifact but reported `costUsd === 0` AND zero tokens is a stub. Modes: `'warn'` (default, non-breaking), `'assert'` (throw `BackendIntegrityError` on the first stub cell), `'off'` (replay/offline). Errored/skipped cells and deterministic judge-only runs are not flagged.

### Changed

- **`CampaignTokenUsage` is now `type CampaignTokenUsage = RunTokenUsage`** (one source of truth; a field added to `RunTokenUsage` is a compile error here, not silent drift across the three hand-synced copies the audit found).
- **multishot aliases sandbox's `AgentProfile` → `SandboxAgentProfile`** so it no longer collides with the eval-harness `AgentProfile` the root exports.

### Boundary

- **`tests/boundary-integrity.test.ts`** — mechanically enforces the zero-upward-dependency rule (agent-eval must never import agent-runtime/agent-knowledge). The CLAUDE.md rule was prose-only; it is now a red build.

### Notes

Pure additive/doc surface (`expectUsage` defaults to non-breaking `'warn'`). Full suite 1538/1538 green. Consumes-side: agent-runtime `loopDispatch` (0.32.0) turns the whole seam into one un-mis-wireable call.

---

## [0.61.0] — 2026-05-30 — `runProfileMatrix` (profile × scenario × persona matrix with integrity by construction)

### Added

- **`runProfileMatrix({ profiles, scenarios, dispatch, judges, reps, integrity, personaOf })`** (`@tangle-network/agent-eval/campaign`) — the keystone that lets a consumer express a multi-profile × scenario/persona eval as **one** call instead of a hand-rolled `eval:*` script. Fans `profiles` over the scenario/persona corpus, runs `runCampaign` per profile, maps every cell to a validated `RunRecord` carrying real `tokenUsage`, and runs **`assertRealBackend` by construction**. Returns `{ records, byProfile, byScenario, byPersona, integrity, campaigns }`.
- **`ProfileMatrixError`** — thrown at preflight (before any LLM spend) when a profile's model lacks a snapshot version or the lists are empty.

### Fixed / closed gap

- **Token usage captured by `runCampaign`** — `CampaignCostMeter` gains `observeTokens()`/`tokens()` and `CampaignCellResult` gains `tokenUsage`, so the integrity guards can run on a `CampaignResult` (they key on `tokenUsage`). Closes the gap for **every** campaign consumer.

### Notes

7 new tests; the keystone is the **stub→throws** regression. Full suite 1527/1527 green at release.

---

## [0.53.0] — 2026-05-27 — prior-period comparison ("did my last change help?")

### Added

- **`analyzeRuns({ runs, baselineRuns?, baselineLabel? })`** — when `baselineRuns` is provided, `InsightReport` gains a `priorPeriodComparison` block. Two-sample Welch comparison (unpaired — the two windows do NOT need to share scenarios) on: composite score, cost, duration, token usage, and every judge dimension present in both windows.
- **`PriorPeriodComparison` + `MetricDelta` types** — per-metric `current`, `baseline`, `delta`, Welch 95% CI, p-value, Cohen's d, `baselineN`/`currentN`, and `significant` boolean (p < 0.05 AND |d| ≥ 0.2 — conjunction prevents large-effect-but-noisy and significant-but-tiny from triggering).
- **`regressedMetrics` + `improvedMetrics` lists** — direction-aware (cost/duration are lower-is-better; composite/dimensions are higher-is-better). Drives the recommendations engine.
- **New recommendations** — `critical/investigate` fires per regressed metric with the full statistical detail in the rationale (`Welch CI95 = [..], p=.., Cohen's d=..`). `low/ship` fires per improved metric so consumers see what to celebrate without noise.

### Why this matters

"Did my last change help?" is the conversion question for every observability prospect. LangSmith / Braintrust / Phoenix ship scorecards without paired-CI deltas. Hermes has no comparison at all. Our `priorPeriodComparison` answers the question with a falsifiable, statistically-rigorous delta. The block lands in the existing `InsightReport` so every consumer of `analyzeRuns` picks it up automatically.

### Architectural context

Part of the self-improvement-protocol design (`docs/design/self-improvement-protocol.md`). This is 0.53.0 of the roadmap that ends at 1.0.0 (profile-versioning + composite driver) and 1.1.0 (empirical-proof publication).

### Notes

Pure additive surface. `priorPeriodComparison?` is optional; existing consumers untouched. 10 new tests under `tests/prior-period-comparison.test.ts` cover: no-comparison-when-omitted, significant improvement, significant regression, direction-awareness for cost/duration, noise rejection, per-dimension comparison, empty windows, CI bracket-the-truth, both recommendation types. Full suite 1454/1454 green.

---

## [0.52.0] — 2026-05-27 — honest drivers + profile-versioning architecture

### Honest correction

After cloning and reading the actual SkillOpt source (microsoft/SkillOpt) and the GEPA paper (Agrawal et al., arXiv:2507.19457), 0.51.0's `skillOptDriver` was **not** SkillOpt — it was `gepaDriver` + 2 post-parse rejection rules. 0.52.0 closes that integrity gap. Greenfield in-place collapse; no V2.

### Changed (breaking)

- **`skillOptDriver` removed.** Its only substantive behavior (section preservation + sentence-edit-count cap) moves into `gepaDriver` as opt-in `constraints`. The `skillOptDriver` name is reserved for when we ship the real 6-stage patch-mode pipeline (tracked as task #100, blocked on profile-versioning).
- **`gepaDriver` gains `constraints?: { preserveSections?, maxSentenceEdits? }`**. When `preserveSections: []`, the driver auto-detects current H2 headings and rejects candidates that drop or rename them. When `maxSentenceEdits: N`, candidates whose sentence-level edit count vs the parent exceeds `N * 2` are rejected. Both inspired by SkillOpt's edit-budget-as-textual-learning-rate principle.
- **`gepaDriver` docstring updated** to be honest about Pareto: today the driver implements GEPA's *reflection* primitive but not the Pareto frontier or combine-complementary-lessons step. Tracked as task #101.

### Added

- **`docs/specs/driver-honest-spec.md`** — primary-source comparison vs GEPA and SkillOpt. Quotes the actual source. Names 13 deviations between 0.51.0's `skillOptDriver` and the real SkillOpt pipeline.
- **`docs/specs/hermes-self-improvement-audit.md`** — corrected audit after cloning NousResearch/hermes-agent. Hermes has two loops, not one: the 7-day curator (housekeeping) AND a per-turn `background_review` fork that uses **user corrective feedback as a first-class skill-update signal** ("stop doing X", "you always do Y"). Signal source we don't capture today.
- **`docs/specs/profile-versioning.md`** — architecture for the offline/online drift problem. Symmetric-fork framing (both writers are peers, neither is the authority). `AgentProfileVersion` content-hashing, `ProfileDiff` patch/replace types, 4-way `DriftGateDecision` (ship-substrate / ship-harness / merge / inconclusive), opt-in `driftPolicy` (ignore / reject-on-drift / benchmark-branches), four conflict-resolution cases including semantic-duplication detection. Phase 0 forcing-function experiment specified.

### Where we beat the prior art (now named explicitly)

Our `defaultProductionGate` uses paired bootstrap CI + Cohen's d + MDE + p-value. **SkillOpt's gate is a literal `cand_hard > current_score`** (verified at `skillopt/evaluation/gate.py:38`). **Hermes has no gate** — the forked review agent decides. We are statistically stricter than both.

### Notes

`gepaDriver({ constraints })` covers every use case the deleted `skillOptDriver` covered. The single `skillOptDriver` test file was removed; 13 new tests under `tests/gepa-driver-constraints.test.ts` cover the absorbed behavior + the unconstrained baseline behavior. Full suite 1444 / 1444 green.

---

## [0.51.0] — 2026-05-27 — skillOptDriver (SkillOpt methodology as a substrate driver) — SUPERSEDED BY 0.52.0

⚠️ 0.51.0 named a driver `skillOptDriver` after Microsoft's SkillOpt methodology but did not implement it (it was `gepaDriver` + 2 post-parse rules). The honest replacement landed in 0.52.0; this entry is preserved for changelog continuity.

### Added

- **`skillOptDriver`** in `/campaign`. A section-aware, bounded-edit `ImprovementDriver` for structured natural-language procedures (SKILL.md files, runbooks, sectioned system prompts, judge rubrics with dimensions). Implements the SkillOpt methodology (Microsoft, 2026): treat the skill document as a trainable optimization target, train the procedure not the weights, constrain each generation to ≤N targeted edits to prevent useful-rule overwrites.
  - **Edit-budget enforcement** — candidates that exceed `editBudget * 2` sentence-level diffs vs baseline are rejected at parse time. SkillOpt's "edit budget functions as a textual learning rate."
  - **Section preservation** — H2 headings (or an explicit `preserveSections` allowlist) MUST appear unchanged in every candidate. Candidates that delete or rename sections are rejected.
  - **Surface-typed** — throws on non-string surfaces; agent-runtime's `improvementDriver` handles code-tier.
- `extractH2Sections(text)` + `countSentenceEdits(a, b)` exported as named helpers for consumers writing custom drivers with similar invariants.

### Scope (honest)

This is **batch SkillOpt** — one LLM call per generation produces all N candidates with the budget enforced as a prompt instruction + post-parse rejection. **Per-edit iteration** (propose 1 edit → validate → accept-or-reject → propose next) is a future 0.52.0 enhancement that needs a new `IncrementalImprovementDriver` interface; the substrate's current batch `ImprovementDriver` can run SkillOpt-style behavior with `populationSize=1` + `maxGenerations=N`, but a single driver invocation can't iterate per-edit yet. Tracked.

### Notes

Selectable alongside `gepaDriver` and `evolutionaryDriver`. Use when the surface IS a structured doc; use `gepaDriver` when the surface is unstructured prose.

---

## [0.50.2] — 2026-05-27 — actionability fixes from real-data dogfood

### Added

- **`ScalarDistribution.tailRuns?: Array<{runId, score}>`** — populated for the composite distribution. The report now names the 5 worst runs a customer should inspect first, instead of telling them to "investigate the lower tail" anonymously.
- **`InsightReport.costQuality.degraded?: {cost?, pareto?}`** — explicit per-axis degradation reasons when `costUsd` is all zero (cost axis carries no signal) or only a single candidate appears (Pareto collapses to a single point). Replaces the prior silent emission of meaningless single-point Pareto figures.
- **Composite-distribution recommendations.** When `composite.mean < 0.3`, the report emits a `critical/investigate` recommendation with the worst-5 runIds enumerated in the detail. Between 0.3 and 0.5, a `high/investigate` recommendation with the worst-3. Closes the gap where `recommendations: []` was being emitted for completely broken corpora.
- **Missing-judges flag.** When `judges` is empty across the corpus, the report emits a `medium/expand-corpus` recommendation pointing at `outcome.judgeScores.perJudge` enrichment. Before, the customer had no signal that per-dimension / calibration was unavailable because of input shape, not substrate failure.

### Fixed

- `analyzeRuns()` on the legal-agent canonical run (n=36, mean composite = 0.002) now emits actionable recommendations naming specific failing scenarios; previously it returned `recommendations: []` for a fully-broken agent.

### Notes

The four behavior changes are additive — fields are optional, no existing field shape changed. Dogfood-driven: surfaced by running `analyzeRuns()` against three real consumer datasets (legal-agent, agent-builder, gtm-agent golden run) and observing where the report was silent when it should have been loud.

---

## [0.50.1] — 2026-05-27 — docs + examples

### Added

- `README.md` rewritten as a top-tier OSS landing page: table of contents, decision-packet output sample (annotated JSON), comparison matrix vs LangSmith / Braintrust / Phoenix, three customer journey cards.
- `examples/selfimprove-quickstart/` — minimal closed-loop example with annotated stdout.
- `examples/customer-feedback-loop/` — Customer A journey: multi-rater approve/reject corpus → `fromFeedbackTable` → `analyzeRuns`.
- `examples/customer-otel-traces/` — Customer B journey: OTel spans → `fromOtelSpans` → `analyzeRuns`.
- `docs/insight-report.md` — annotated walkthrough of every section of the decision packet.
- `docs/customer-journeys.md` — three end-to-end journeys with code + expected output.

### Changed

- `docs/concepts.md` — updated mental model for the three top-level entries (`selfImprove`, `analyzeRuns`, intake adapters) and the layering rule.

### Notes

Docs-only patch. No code changes, no behavior changes, no API surface changes vs 0.50.0.

---

## [0.50.0] — 2026-05-27 — the decision packet

### Added

- **`analyzeRuns({ runs, ... }): InsightReport`** in `/contract`. Composes the substrate's statistical / calibration / clustering / Pareto primitives into one rigor packet. Sections populate based on what the input supports: distributional summary always, lift when baseline+candidate are present, judges when run records carry `judgeScores`, inter-rater agreement when `raterScores` are supplied, failure clusters when an `AnalystRegistry` is wired, contamination when canaries are passed, outcome correlation when a downstream signal is supplied.
- **`InsightReport`** canonical decision-packet shape; reused by `selfImprove()` and emitted on the hosted wire as `EvalRunEvent.insightReport?`.
- **Intake adapters** in `/contract`:
  - `fromFeedbackTable({ ratings })` — multi-rater corpus → `RunRecord[] + raterScores`.
  - `fromOtelSpans({ spans })` — OpenTelemetry spans → `RunRecord[]`, grouped by `tangle.runId` or `traceId`.
- **`SelfImproveResult.insight: InsightReport`** — `selfImprove()` now returns the full decision packet alongside the existing ship/hold verdict.

### Changed

- `selfImprove()` internally calls `analyzeRuns()` on baseline + winner cells; consumers reading `.lift` continue to work unchanged, while `.insight.lift` now carries CI95 + p-value + Cohen's d + MDE + required-n.

### Test coverage

1427 / 1427 passing; 11 new integration tests covering lift detection paths, outcome correlation + linear reward model, canary contamination, multi-rater journey end-to-end, OTel journey end-to-end, recommendations shape, JSON-serialisability.

---

## [0.49.0] — 2026-05-27 — audit-fix sweep

### Added

- `src/adapters/otel.ts` — generic OTel→hosted bridge (`createOtelBridge` / `OtelBridge` / `OtelBridgeOptions`). Stringifies array-valued attributes instead of dropping them.
- `src/contract/diff.ts` — `keyForCell` uses `JSON.stringify([scenarioId, rep])` (no separator collisions); `Number.isFinite` coercion on dimension deltas (no NaN propagating to dashboards).
- `examples/hosted-ingest-server/server.ts` — `REFERENCE_RECEIVER_START=1|0` env var as the primary start signal; idempotency cache prunes on read with the wire-spec 24h TTL.

### Changed

- Python `TraceSpanEventOuter` exposes `tangle.*` pivots via field aliases (`tangle_run_id`, etc.) and round-trips through `model_dump(by_alias=True)`.
- Python `_WireModel` emits a `UserWarning` when an extra field is the snake_case shadow of a declared camelCase field (cross-language drift guard).

### Removed

- `src/adapters/traceai.ts` — replaced by `src/adapters/otel.ts`. No back-compat shim.

---

## [0.48.0] — 2026-05-27 — substrate↔runtime layering fix + diffRuns + Python hosted parity

### Added

- `src/verdict.ts` — `DefaultVerdict` substrate primitive (moved DOWN from agent-runtime).
- `src/contract/diff.ts` — `diffRuns` / `diffGenerations` / `diffRunBaselineToWinner` for v3-vs-v4 dashboard rendering, CI reporting, and any consumer comparing improvement-loop output.
- `src/adapters/traceai.ts` — OTel→hosted bridge (renamed to `otel.ts` in 0.49.0).
- `tests/hosted-roundtrip.test.ts` — proves wire-format binary compat between client and reference receiver.
- Python `HostedClient` (`clients/python/src/agent_eval_rpc/hosted.py`) — TS↔Python wire-format parity with bearer auth, idempotency, and exponential backoff on 5xx/408/429.
- `CLAUDE.md` repo-layering rule: agent-eval is the substrate; agent-runtime + agent-knowledge depend on it; the reverse is forbidden.

### Changed

- `src/campaign/gates/default-production-gate.ts` — `RunRecord` import from local `../../run-record` (was reaching up into agent-runtime).
- `src/matrix/types.ts` — `DefaultVerdict` import from `../verdict` (was reaching up into agent-runtime).

### Removed

- `@tangle-network/agent-runtime` from `peerDependencies`, `devDependencies`, and `pnpm.minimumReleaseAgeExclude` (no upward deps from substrate).

---

## [0.47.0] — 2026-05-26 — Phase D hosted-tier substrate

### Added

- `src/hosted/` — wire-format types frozen at `HOSTED_WIRE_VERSION = '2026-05-26.v1'`, `createHostedClient` with bearer auth + idempotency + bounded retries.
- `examples/hosted-ingest-server/` — reference receiver implementing the spec.
- `docs/hosted-ingest-spec.md` — semver-locked wire spec.
- `selfImprove({ hostedTenant })` — opt-in hosted ingest; failures logged, never fail the loop.

---

## [0.46.0] — `selfImprove()` LAND-tier helper

`selfImprove({ scenarios, dispatch, judges, baselineSurface })` shipped in `/contract` as the one-shot wrapper around `runImprovementLoop`.

---

## [0.45.0] — distributed campaigns

`/adapters/http` with `httpDispatch` + `runDispatchServer`; `cellPlacement` on `RunCampaignOptions` for cross-region fan-out.

---

## [0.44.0] — `/adapters/langchain`

LangChain runnable → `Dispatch` adapter.

---

## [0.43.0] — edge-friendly storage

`inMemoryCampaignStorage()` for Cloudflare Workers / edge / test environments.

---

## [0.42.0] — GEPA driver + legacy deletion

### Added

- `gepaDriver` reflective LLM mutation driver.
- `campaignToRunRecords` adapter.

### Removed

- `runMultiShotOptimization` (top-level trajectory-optimizer) — replaced by `runImprovementLoop` + `gepaDriver` composition. The `/multishot` subpath (N-shot persona matrix) is unrelated and remains.

---

## 0.34.0 — 2026-05-23

### Eval evolution-tracking — first-class `AgentProfile` + per-cell scorecard

The headline shift: a feature PR's eval can now answer the question a single
run cannot — *did this change regress persona P on profile F, even while the
aggregate improved?*

- **`AgentProfile` + `agentProfileHash`** — the harness's unit of variation.
  Model lives inside the profile (skill/tool order doesn't matter; the `id`
  label is excluded from identity), so "same model, different skills" is two
  profiles. (#78)
- **Append-only JSONL scorecard** keyed `(scenarioId, profileHash)` —
  `recordRuns` / `recordRunsToScorecard` / `loadScorecard`. Idempotent
  appends on `eventId` so concurrent campaign runs cannot clobber. (#78)
- **`diffScorecard`** — per-cell verdict (`improved` / `regressed` / `flat` /
  `new`) using Cohen's d + Welch's t-test; the keystone CI guard is
  `diff.cells.filter(c => c.verdict === 'regressed')`. `formatScorecardDiff`
  renders the PR-facing report. (#78)
- **Agent profile cells** — `src/agent-profile-cell.ts` extends the profile
  contract into `RunRecord` rows and `runEvalCampaign` so every campaign row
  is keyed by `(profile, scenario, seed)` end-to-end. (#79)
- **Stats consolidation** — `pairedBootstrap`, power analysis, and the
  paired/Welch primitives now all live in `src/statistics.ts`. (#73)
- **LLM retry classifier unified** across `llm-client` and `judge-retry`
  via `isTransientLlmError`. (#74)
- **`pr-review-benchmark` source committed** — the module was exported from
  `index.ts` since the run-record refactor but the source files were never
  committed; CI on `main` has been red on #78/#79/#81 as a result. (#83)
- **Examples**: `scorecard/`, `held-out-gate/`, `user-simulation-driver/`. (#81)

No breaking changes — additive across the board.

## 0.33.0 — 2026-05-21

### Release — `decideNextUserTurn` in the published tarball

`0.32.0` shipped the completion oracle (`verifyCompletion`,
`extractProducedState`) but `decideNextUserTurn` — the standalone reactive
adversarial turn generator — merged after the `0.32.0` tag and never made it
into a published tarball. Consumers wiring an in-process eval loop against the
driver could import the symbol from source but not from npm.

This release publishes `main` as-is: `decideNextUserTurn`,
`DecideNextUserTurnOpts`, the completion verifier, and produced-state
extraction are all in `dist/`. No source changes — a republish that closes the
tag/npm drift.

## 0.32.0 — 2026-05-20

### Completion oracle + produced-state pathway

- `verifyCompletion(gold, state, checkCorrectness)` — the task-completion
  oracle. Two-stage per requirement: structural match against produced state,
  then an injected correctness check. `completionRate` / `fullyComplete` gate
  quality scoring — a fluent transcript that never produces the deliverable
  scores zero.
- `extractProducedState(events)` — normalizes a run's `RuntimeStreamEvent[]`
  into `ProducedState` { artifacts, proposals, toolCalls }.
- `createLlmCorrectnessChecker(tc)` — production `CorrectnessChecker`.
- `decideNextUserTurn(tc, opts)` — standalone reactive adversarial turn
  generator extracted from `AgentDriver`, for in-process eval loops.

## 0.31.1 — 2026-05-20

### Republish of 0.31.0 — dist drift fix

The `v0.31.0` tag's npm tarball shipped a stale `dist/` — `JudgeScoresRecord`
was missing from `dist/index.d.ts` and the `recordOutcome.judgeScores`
propagation never made it into `dist/index.js`, even though the source on
the tagged commit had both. Consumers that bumped to `^0.31.0` got a
typecheck failure on `RunOutcome.judgeScores` (since the type wasn't
re-exported) and a silent drop on the wire (since the campaign runner
didn't carry the field through).

Cause: a build artifact picked up by the publish workflow predated the
source merge. The retag forces a clean `pnpm build` and republish; this
patch carries no source change beyond the version bump.

Verified after this tag: `dist/index.d.ts` contains `JudgeScoresRecord`,
`dist/index.js` propagates `outcome.judgeScores` end-to-end via
`recordOutcome.judgeScores`, and a downstream `pnpm install
@tangle-network/agent-eval@0.31.1` types-clean against the shape
documented in 0.31.0.

## 0.31.0 — 2026-05-20

### `JudgeScoresRecord` on `RunRecord.outcome` — substrate-blessed ensemble shape

Multi-judge consumers (forge-chat in agent-builder, and four sibling
product agents on the same trajectory) compute per-judge per-dimension
scores per cell, then collapse to a single composite for the gate. The
substrate's `RunOutcome` only had a slot for the composite plus a free
`raw: Record<string, number>` bag. Consumers were either dropping the
breakdown on the floor or smuggling it through stringly-typed `raw`
keys like `judge_kimi_helpfulness` — neither survives a corpus-IRR run
(0.27.2's `corpusInterRaterAgreement` expects structured per-judge
per-dim records, not parsed strings).

This release ships the typed slot so every product agent speaks the
same shape, and the inter-rater primitives consume it without a
per-consumer adapter.

### Added

- **`JudgeScoresRecord`** (`src/run-record.ts`) — `perJudge[judgeId][dim]`
  is the canonical store; `perDimMean` and `composite` are precomputed
  projections so reporters and IRR primitives don't repeat the
  aggregation; `failedJudges?: string[]` records dead-judge ids
  explicitly (no inferring partial-failure from missing keys);
  `notes?: string` carries panel prose.
- **`RunOutcome.judgeScores?: JudgeScoresRecord`** — optional. Single-
  judge or scalar-only runs leave it unset; ensemble runs populate it.
- **`CampaignRunOutcome.judgeScores?: JudgeScoresRecord`** — runners
  return it on the per-cell outcome; `runEvalCampaign` threads it onto
  the resulting `RunRecord.outcome.judgeScores` without coercion.

### Validator extended

`validateRunRecord` validates `outcome.judgeScores` when present.
Every `perJudge[judge][dim]` and every `perDimMean[dim]` and the
`composite` must be finite numbers — the NaN-as-silent-zero bug class
banned by `CLAUDE.md` cannot pass the boundary. `failedJudges` must be
an array of non-empty strings; `notes` must be a string. Round-trip
tested in `tests/run-record.test.ts`.

### Fail-loud contract

A judge that throws lands in `failedJudges` by id, not a silent zero
in `perJudge`. The composite is computed over surviving judges only;
the partial-failure signal is preserved through to the gate.
`tests/eval-campaign.test.ts` covers the four shapes (full, partial,
missing, with notes) plus an explicit fail-loud case where one judge
throws and the run record carries `failedJudges: ['glm-5.1@...']`.

### Consumer contract

`tests/consumer-contract.test.ts` pins `JudgeScoresRecord` as a
type-level export at the root entry. The 0.30.0 surface is preserved —
the new field is additive on `RunOutcome` and the new type is a new
export, so existing consumers stay green.

## 0.29.0 — 2026-05-19

### Analyst kinds + cross-run findings context

Builds on 0.28.0's analyst registry. Ships four trace-analyst **kinds**
that emit graded findings through native Ax structured output (no more
flat-defaulted bullet lists) and a cross-run findings context the
registry can inject into prompts so each kind sees what the prior run
already surfaced.

### Added

- **`createTraceAnalystKind(spec, opts)`** (`src/analyst/kind-factory.ts`) —
  turns a `TraceAnalystKindSpec` into a registry-ready
  `Analyst<TraceAnalysisStore>`. Ax signature is
  `'question:string -> findings:json[]'`; the Zod boundary in
  `finding-signature.ts` rejects malformed rows instead of lifting them
  with default severity. Supports `versionSuffix` for optimizer-fitted
  prompts (MIPRO / GEPA / Bootstrap) and a per-row `postProcess` hook.
- **`RawAnalystFinding`** Zod schema + **`RAW_FINDING_SCHEMA_PROMPT`**
  string embedded into kind actor prompts so the model and the parser
  share one source of truth.
- **`TraceToolGroupName`** + **`buildTraceToolsForGroup`**
  (`src/analyst/tool-groups.ts`) — five named tool subsets
  (`all | discovery | discoveryAndRead | discoveryAndSearch | targeted`);
  unknown group names throw.
- **Four shipping kinds** (`src/analyst/kinds/`):
  - `FAILURE_MODE_KIND_SPEC` — clusters dataset failures into distinct
    modes (maxDepth 3, parallel 4, all tools).
  - `KNOWLEDGE_GAP_KIND_SPEC` — attributes missing/stale knowledge to
    `agent-knowledge:wiki:*`, `websearch:outdated:*`, `tool-doc:*`,
    `system-prompt:*`, `memory:*` (maxDepth 2, discoveryAndSearch).
  - `KNOWLEDGE_POISONING_KIND_SPEC` — dual-verify analyst for
    confident-but-wrong actions (maxDepth 2, all tools).
  - `IMPROVEMENT_KIND_SPEC` — converts upstream failure / gap /
    poisoning findings into concrete locus-named edits with leverage
    grades (maxDepth 3, all tools).
- **`DEFAULT_TRACE_ANALYST_KINDS`** — the four specs in canonical run
  order (failure-mode → gap → poisoning → improvement).
- **`priorFindings` on `AnalystContext`** — registry injects findings
  from a prior `AnalystRunResult` into every analyst's context, so an
  improvement-kind run can see the failure-mode findings the previous
  pass surfaced. Kinds reference prior findings via
  `evidence_uri: "finding://<id>"`.

### Deprecated

- `createTraceAnalystAdapter` (`src/analyst/adapters.ts`) — the legacy
  bullet-list lifter. Kept for one minor while consumers migrate to
  `createTraceAnalystKind`.

## 0.28.0 — 2026-05-19

### Analyst registry + findings envelope

A generic, model-agnostic orchestration layer over the existing
analyzers (`analyzeTraces`, `MultiLayerVerifier`, `RunCritic`,
`SemanticConceptJudge`, `JudgeFn`). One contract, one runner, one
persistence path. Reusable by VB operator bench, leaderboard submission
pipeline, and orchestrator on-completion reports with the same code.

### Added

- **`Analyst<TInput>`** contract + **`AnalystFinding`** envelope with
  sha-stable `finding_id` (`src/analyst/types.ts`).
- **`AnalystRegistry`** (`src/analyst/registry.ts`) — register/list/run
  with input routing by `inputKind`, per-analyst isolation, equal-split
  budget by default, per-analyst telemetry.
- **`AnalystHooks`** — `onBeforeAnalyze | onAfterAnalyze | onError |
  onComplete`. Generic seam for telemetry, cost ingestion, rotation,
  error → finding conversion.
- **`BudgetPolicy`** — `{ totalUsd, weights, allocate }`. Default
  equal-split; weighted split or custom `allocate(args)` for precision.
- **`ChatClient`** abstraction (`src/analyst/chat-client.ts`) over
  `router | sandbox-sdk | cli-bridge | direct-provider | mock` so
  analyst code is transport-agnostic; `wrapLlmClient` races the call
  against `ChatCallOpts.signal`.
- **`FindingsStore`** + **`diffFindings(prev, cur, { isMaterial })`**
  (`src/analyst/findings-store.ts`) — locked JSONL persistence + cross-run
  diff (appeared / disappeared / persisted / changed) with a pluggable
  materiality predicate (`defaultIsMaterial` exported for layering).
- Five **adapter** factories (`src/analyst/adapters.ts`) that lift
  existing primitives into the contract without re-implementing them:
  `createTraceAnalystAdapter`, `createVerifierAdapter`,
  `createRunCriticAdapter`, `createJudgeAdapter`,
  `createSemanticConceptJudgeAdapter`.

## 0.27.2 — 2026-05-17

### Corpus-wide inter-rater agreement primitive

`interRaterReliability(JudgeScore[][])` measures Krippendorff α *within
a single item* — multiple judges rate the same scenario, how much do
their scores cluster? That answers "is this one judgement contested?"
It does not answer "is this judge panel reliable across the whole
evaluation corpus?" — the question the five product consumers actually
need before trusting a multi-judge composite over 100+ scenarios.

This release ships the corpus-wide companion. It does not touch the
existing primitive: the within-item α and the corpus-wide ICC are
different formulas with different domains of validity.

### Added

- **`corpusInterRaterAgreement(records, opts?)`** (`src/statistics.ts`) —
  takes a flat list of `{itemId, judgeName, dimension, score}` records.
  For each dimension, pivots to the [n_items × n_judges] matrix of items
  every judge rated and delegates to `continuousAgreement` (ICC(2,1) +
  κ_w + Pearson + Spearman + bootstrap CIs from 0.26.0). An overall
  pooled mean across dimensions gives one "is the panel reliable on
  this corpus?" number.
- **`corpusInterRaterAgreementFromJudgeScores(itemsScores, opts?)`** —
  adapter for consumers that already hold per-item `JudgeScore[]`
  arrays (e.g. `ScenarioResult.judgeScores`) and want to skip manual
  flattening.
- New exported types: `CorpusScoreRecord`, `CorpusAgreementOptions`,
  `CorpusAgreementPerDimension`, `CorpusAgreementReport`.

### Fail-loud contract

Per `CLAUDE.md` "no silent fallbacks": the primitive throws
`ValidationError` on empty input, fewer than 2 judges, fewer than 2
items rated by every judge on a given dimension, a judge with zero
items on a dimension (would silently shrink the matrix and corrupt the
overall metric), duplicate `(itemId, judge, dimension)` records, or any
non-finite score. There is no quiet-NaN path.

### Consumer contract

`tests/consumer-contract.test.ts` pins both new exports. The 0.27.0
surface is preserved — no rename, no signature change on the existing
`interRaterReliability`.

## 0.27.1 — 2026-05-17

### Signal-honesty sweep — substrate

- **`sandbox-harness.ts`** — the timeout-driven `SIGKILL` previously sat
  inside an empty `} catch {}`. A failed kill would vanish from logs.
  It now surfaces via `console.warn` with full error context while
  preserving teardown semantics (the timer already fired; the subprocess
  is being terminated).
- **`control-runtime.ts`** — documented the `ControlRunResult.runId:
  string | null` contract at the type declaration. The 18 sites that
  coerce `emitter?.runId` to `null` (one per terminal return path) are
  typed-contract conversions, not silent fallbacks: `null` means "the
  run executed without a `TraceEmitter` wired and no run record was
  persisted." Type-level docs end the recurring "is this a bug?" review.
  (Three sibling `?? null` coercions on the same returns —
  `actionCostUsd`, `scoreBefore`, `scoreAfter` — are likewise typed-optional
  span attributes documented at their declaration sites.)
- **`.gitignore`** — added `data/` (local dev session storage).
- **`tests/consumer-contract.test.ts`** — pins the runtime symbols that
  the five product-agent consumers (tax/creative/legal/gtm/agent-builder)
  import from `@tangle-network/agent-eval`. The full set of types is
  validated at compile time via the namespace import; runtime classes
  and functions are exhaustively asserted. Any removal/rename of a
  load-bearing export now fails this test before shipping.

## 0.27.0 — 2026-05-17

### Substrate reliability — eliminate silent-zero judge corruption

Today's tax + gtm evals shipped composites where the judge LLM silently
aborted (verbose new prompts streamed past the 60s default timeout) and
the per-trial score collapsed to `0`. The composite formula then weighted
that zero into the mean, producing a "−27pp tax regression" that was
actually a measurement-instrument failure, not a prompt regression.

This release adds three substrate primitives so consumers can stop
silent-zeroing their own data:

- **`withJudgeRetry(judgeFn, policy)`** — wraps any judge call with retry
  on transient failures (Abort, Timeout, fetch failed, 429/502/503/504),
  optional fallback-model rotation, and a typed outcome (`succeeded`,
  `attempts`, `value`, `error`). Refuses to default to a silent zero.
- **`aggregateTrialsByMode(trials, { mode })`** — `'exclude-failed'` mode
  drops trials with `judgeSucceeded === false` from the mean so a failed
  judge doesn't corrupt the composite. `'strict-fail'` mode refuses the
  aggregate when any judge failed. `'zero-fill'` preserves legacy.
- **`discoverPersonas(dir, opts)`** — replaces every consumer's hardcoded
  `TRAINING_PERSONA_FILES` constant. New personas on disk are picked up
  automatically; consumers can filter via include/exclude patterns.

Additive to `TrialResult`: `judgeSucceeded?`, `judgeAttempts?`, `judgeError?`
fields. Existing adapters that don't set these continue to work
unchanged via `'zero-fill'` mode (default for back-compat).


## 0.26.0 — Continuous-value inter-rater agreement (ICC + weighted κ)

The original `calibrateJudge` rounded scores to ints before computing
Cohen's κ. For fine-grained judges that's lossy — 0.78 vs 0.81 both
round to "1" and the integer κ pretends they agreed perfectly when they
actually disagree by 3 percentage points. This release ships principled
continuous-value agreement metrics so calibration findings become
quantitative for [0,1]-valued judges.

### Added

- **`continuousAgreement(scores, opts?)`** (`src/judge-calibration.ts`) —
  inter-rater agreement on continuous scores. Returns:
    - `weightedKappa` — Cohen's κ_w with quadratic (or linear) weights on
      raw scores, no quantisation.
    - `icc` — ICC(2,1), two-way random effects, absolute agreement,
      single rater (Shrout & Fleiss 1979). The principled reliability
      coefficient when judges are a random sample of the judge population.
    - `pearson` / `spearman` — averaged over rater pairs when N ≥ 2 raters.
    - `ci.icc` / `ci.weightedKappa` — bootstrap percentile 95% CIs
      (default `n=1000`, seeded for reproducibility).
  Accepts `scores: number[][]` shaped `[n_items][n_raters]`. Rows with
  non-finite entries are dropped, not coerced.

- **`calibrateJudgeContinuous(golden, candidate, opts?)`** — drop-in
  superset of `calibrateJudge`. Preserves every legacy field
  (`n`, `pearson`, `kappa`, `mae`, `worstItems`) and adds
  `weightedKappaContinuous`, `icc`, `spearman`, and `ci`. Use this when
  the judge produces fine-grained [0,1] scores; keep `calibrateJudge`
  for the original integer-quantised report.

### Why two κ flavours

ICC(2,1) catches systematic bias that Pearson misses. If judge B scores
2× judge A, Pearson stays ≈ 1 (linear association is perfect) while ICC
plummets (absolute agreement is poor). The new tests assert this exact
failure mode so the regression can't sneak back in.

### Unchanged

- `calibrateJudge` keeps its original integer-rounded κ semantics for
  backwards compatibility. Nothing else moves.

## 0.25.0 — ProductionLoop primitive: close the eval → prod → eval cycle

This release ships the **orchestration layer** that turns the existing
eval substrate into a continuously-improving production system. Static
prompts decay; today's regulation flips tomorrow. The pieces to close
the loop were already in the package (`runMultiShotOptimization`,
`failureClusterView`, `evaluateReleaseConfidence`, `extractPreferences`,
`FeedbackTrajectoryStore`, `TraceStore`); this release adds the one
clean primitive that wires them together end-to-end.

### Added

- **`runProductionLoop({ ... })`** (`src/production-loop.ts`,
  `@experimental`) — one call = one cycle. Ingests production traces
  and feedback, clusters failures, runs evolve against the worst
  cluster, gates with `HeldOutGate` + `evaluateReleaseConfidence`
  (fail-closed), and — when wired with an `AutoPrClient` — opens a PR
  with the improved prompt. Idempotent + replayable: same `runId`
  yields the same plan. Cron / GitHub Actions are the consumer's job;
  the primitive doesn't own scheduling.

- **`proposeAutomatedPullRequest(client, input)`** + two transports
  (`src/auto-pr.ts`, `@experimental`):
    - `httpGithubClient({ token, ... })` — direct REST against
      `api.github.com`, no extra deps. Idempotent on branch name:
      existing open PRs are returned, not duplicated.
    - `ghCliClient({ ... })` — shells out to `gh` for environments
      where developer auth state is already configured.
  Both validate inputs (no `..` paths, no whitespace branches, no
  duplicate file changes) and surface `ValidationError` / `ConfigError`
  from the typed taxonomy.

- **`POST /v1/feedback` + `POST /v1/traces/ingest`** wire endpoints
  (`src/wire/`). Both Zod-validated, both append to the configured
  store (`FeedbackTrajectoryStore` / `TraceStore`). 503 when no store
  is wired (fail loud, not silent). Traces ingest accepts both
  `application/json` (`{events:[...]}`) and `application/x-ndjson` for
  streaming production runtimes. Schemas (`TraceEvent`,
  `FeedbackTrajectory`, `TracesIngestRequest/Response`,
  `FeedbackIngestResponse`) added to `openapi.json` for cross-language
  clients.

- **Optional bearer-token auth** on the wire server, configured via
  `createApp({ auth: { bearer: '...' } })` or as a verifier function
  for rotating tokens. `/healthz` and `/v1/version` remain unprotected
  (regression: never lock monitoring out of the runtime).

- **`examples/production-loop/`** — synthetic end-to-end demo wiring
  the loop against in-memory trace + feedback stores and a fake
  auto-PR client. Shows the failure-cluster trigger, the evolve round,
  the gate verdict, and the PR-shaped output without requiring
  credentials or a live model.

### Changed

- **Wire server** (`createApp(opts)`) now accepts optional
  `IngestionStores` (`{ traceStore?, feedbackStore? }`) and `auth`.
  Existing zero-arg callers continue to work — judge / rubrics /
  version / healthz are unchanged.

### Status tags

- Every new export is `@experimental` initially. Pin the patch version
  if you depend on it. All other 0.24.0 stability tags are preserved.

## 0.24.0 — DX cleanup: framing, stability tags, lint, taxonomy, strict indices

This release is **DX + correctness**. No production behavior moved; consumer
contracts tightened across the board. Library went from 7.5/10 to 10/10 on
first-touch usability and contract clarity. The visible deltas:

### Strictness

- **`noUncheckedIndexedAccess: true`** in `tsconfig.json`. 251 latent
  `T | undefined` sites surfaced and fixed across ~70 files. Loop-bound
  indices documented with `!`, external lookups guarded explicitly, accumulator
  patterns refactored to capture-then-assign. Every fix audited for semantic
  correctness (math code: `!`; untrusted data: guards).
- **Subpath imports forced.** Six `export * from './X'` wildcards at root
  deleted (`./rl`, `./pipelines`, `./builder-eval`, `./meta-eval`, `./prm`,
  `./trace-analyst`). New subpaths in `package.json`: `/pipelines`,
  `/meta-eval`, `/prm`, `/builder-eval`, `/governance`, `/knowledge`. Root
  re-exports retained only for the load-bearing capture-integrity surface
  (`./trace`, `./knowledge`, `./governance`).
- **Error taxonomy.** New `src/errors.ts` exports `AgentEvalError` base plus
  `ValidationError`, `NotFoundError`, `ConfigError`, `CaptureIntegrityError`,
  `JudgeError`, `VerificationError`, `ReplayError`. Existing custom errors
  re-parented: `ReplayCacheMissError`, `BudgetBreachError`, `RunIntegrityError`,
  `HoldoutLockedError`, `RunRecordValidationError`, `LlmCallError`,
  `LlmRouteAssertionError`, `TraceFileMissingError`, `TraceNotFoundError`,
  `SpanNotFoundError`. ~25 user-facing `throw new Error(...)` calls migrated
  to typed errors across `rl/*`, `replay`, `sandbox-harness`, `statistics`,
  `release-confidence`, `visual-diff`, `counterfactual`, `run-critic`,
  `observability`. Internal invariant guards intentionally left as plain
  `Error` — those are bugs, not contract failures.
- **`LlmRouteAssertionError.code` → `reason`** (breaking, greenfield).
  The subclass's route-specific reason now lives on `.reason`; the base
  category `code = 'capture_integrity'` survives via the `AgentEvalError`
  contract.

### Visible deltas

### Changed

- **README reframed** as the substrate for self-improving agents. The package
  has shipped `EvalCampaign`, replay, GEPA / reflective mutation, auto-research,
  active curriculum, contamination probes, tournaments, compute curves, PRM,
  off-policy estimators, and sequential anytime-valid stats since 0.22 — the
  README now actually names them, not just "evaluation infrastructure."

- **`src/rl/index.ts` carries stability markers** — every re-export is tagged
  `@stable` or `@experimental` via JSDoc. Stable: `run-record-adapters`,
  `verifiable-reward`, `preferences`, `off-policy`, `tournament`,
  `contamination`, `compute-curves`. Experimental: `process-reward`,
  `adversarial`, `active-curriculum`, `reward-hacking`, `adaptation-eval`,
  `exporters`, `rl-campaign`, `predictive-validity-researcher`, `auto-research`.
  Tags are visible in IDE hover and emitted into `dist/rl.d.ts` so consumers
  can see the contract at the call site.

### Added

- **Biome lint + format** — `biome.json` codifies the project style (no
  semicolons, single quotes, 2-space indent, 100 col, `noNonNullAssertion`
  off, `useNodejsImportProtocol` on). `pnpm lint` and `pnpm format` scripts.
- **`.github/workflows/ci.yml`** — runs typecheck + lint + test + build +
  Python pytest on every PR. Previously only the publish workflow on tag
  push exercised this surface; PRs were unguarded.
- **`ReplayCache.entries()`** — public iterator for the cached
  `(request, response)` pairs. Replaces the bracket-access escape hatch into
  the private `byKey` map. Same semantics, exposed in the type contract.
- **Per-example READMEs** — `examples/multi-shot-optimization` and
  `examples/same-sandbox-harness` now document what they show, how to run,
  expected output, and adaptation guidance. The other three examples already
  had READMEs; the README index now links to all five.
- **`clients/python/examples/judge_anti_slop.py`** — runnable script that
  doubles as a pytest, anchoring the `judge` API contract: composite in
  `[0, 1]`, `RubricNotFoundError` for bogus rubric name, `ValidationError`
  for no-rubric call.

### Fixed

- **`reflective-mutation.ts`** — local `escape` variable shadowed the global
  `escape` property. Renamed to `escaped`. No behavior change; flagged by
  biome.

## 0.23.1 — FileSystemTraceStore.updateRun no longer double-appends

### Fixed

- **`FileSystemTraceStore.updateRun` / `updateSpan`** — once the lazy
  in-memory index had been populated (by any prior `getRun` / `listRuns` /
  `spans` / `events` query), an `updateRun` would mirror the synthetic
  update row back into the index via `appendRun`, throwing
  `run X already exists`. Same root cause for `updateSpan`, which would
  silently insert a phantom duplicate span row. The `append()` helper now
  skips `insertInto` for rows carrying the internal `_update: true` marker;
  `updateRun` / `updateSpan` continue to apply the patch directly via the
  index's `updateRun` / `updateSpan` APIs.

  Surfaced by tax-agent's canonical eval running multiple variants per
  persona against a shared store: the second variant's `endRun`
  consistently threw, forcing callers to instantiate one store per
  (persona × variant) cell and stitch results back together post-hoc.
  After this fix, a single `FileSystemTraceStore` can fan out runs across
  arbitrarily many cells with interleaved reads, which is the intended
  usage pattern. Regression test added in `tests/trace-store.test.ts`.

## 0.23.0 — RL primitives + auto-research worked example

In addition to the RL bridge primitives below, this release ships the
canonical worked example of the auto-research loop end-to-end against
agent-builder, plus a concrete prime-rl SFT integration. The auto-research
thesis — capture → score → preferences → mutate → improved candidate —
is now demonstrably real, not aspirational.

### Added (worked examples)

- **`examples/auto-research-with-agent-builder/`** — runnable demo of the
  closed loop: a synthetic agent-builder driver iterates 4 generations
  of prompt variants, with each generation's runs feeding
  `analyzeOptimizationResult` for preferences + reward-hacking + sequential
  verdict, and the next generation proposed via a deterministic mutator.
  The demo shows score climbing from 0.739 → 0.973 over 4 iterations on
  the synthetic environment. Real-driver mode (replace the synthetic
  runner with `runForgeBuilderSim` from `agent-builder`) is documented
  inline.
- **`examples/fine-tune-with-prime-rl/`** — concrete integration with
  Prime Intellect's prime-rl SFT trainer. Reads `RunRecord[]` (NDJSON),
  filters to high-quality runs, projects via `toSftRows` to messages-list
  JSONL, writes a 15-line prime-rl SFT TOML config, prints the runnable
  command. ~150 LoC of glue. SFT was chosen as the first integration
  because it's the cleanest fit between agent-eval's exporters and
  prime-rl's entrypoints (DPO/PRM go to TRL; offline GRPO requires a
  custom verifiers env — both called out in the README).
- **`docs/three-package-architecture.md`** — the contracts between
  agent-eval, agent-knowledge, agent-runtime. Dependency direction (both
  consume agent-eval; agent-eval imports neither), shared data
  interchange (RunRecord, Scenario, KnowledgeBundle), and known
  contract gaps tracked as follow-ups.
- **`docs/auto-research-loop-end-to-end.md`** — the runnable composition
  pattern with the explicit invariants every iteration must preserve
  (canonical RunRecord with scenarioId, capture wired by construction,
  stable comparator, deterministic mutator).

### Added (RL primitives)

0.22 made eval rigorous and integrated; 0.23 closes the loop back to RL training. The package now ships the canonical primitives a working RL-on-LLM-agents team needs — verifiable rewards, preference extraction, off-policy evaluation, process reward scaffolding, contamination probing, Bradley-Terry / Elo tournaments, adversarial scenario search, and test-time compute scaling — all designed to consume the standardised `RunRecord` artifact 0.22 produced. The auto-research loop is now coherent end-to-end.

#### RL barrel — `@tangle-network/agent-eval/rl` (new subpath)

A single subpath for every RL-shaped primitive, importable as a unit. The 9 modules:

1. **`run-record-adapters.ts`** — convert `TrialResult[]` (from `runPromptEvolution` / `runMultiShotOptimization`), `VerificationReport` (from `MultiLayerVerifier`), and `VariantAggregate` into canonical `RunRecord[]`. Closes the integration gap between the pre-0.22 optimization stack and the post-0.22 campaign artifact. Existing optimization runs become `replayCache`-able and `rubricPredictiveValidity`-scorable for free.

2. **`verifiable-reward.ts`** — extract a clean `VerifiableReward` from `VerificationReport` or `RunRecord`. Distinguishes `'deterministic'` (compile, test, schema, sandbox) from `'probabilistic'` (judge) reward sources. The seam every credible 2025-2026 frontier RL result on coding agents leans on (DeepSeek-R1 GRPO on test pass-rate, AlphaProof on Lean kernel checking).

3. **`preferences.ts`** — `extractPreferences(runRecords)` produces DPO/PPO/KTO-shape `(chosen, rejected)` triples with three documented strategies (`paired-by-scenario-and-seed`, `paired-by-scenario`, `top-vs-bottom`). Bridge from campaign artifact to RL training. Includes `toTRLFormat` and `toAnthropicFormat` adapters.

4. **`off-policy.ts`** — IPS, SNIPS, doubly-robust off-policy estimators (Dudík–Langford–Li 2011 for DR, Owen 2013 for SNIPS SE). Caller supplies behavior + target propensity scores (typically from token log-probs). All three return matched-shape `OffPolicyEstimate` with effective-sample-size and max-importance-weight diagnostics. `offPolicyEstimateAll` runs all three side-by-side — agreement across estimators is a much stronger signal than any one alone.

5. **`process-reward.ts`** — step-level credit assignment from trace spans. `extractStepRewards(store, runId, scorers)` produces `StepReward[]`; `prmTrainingPairs(stepRewardsByRun)` produces `(prefix, chosen_step, rejected_step)` triples in the canonical Lightman et al. / DeepSeek-R1 process supervision shape. We ship the data extraction, not the trainer — gradient descent over a transformer is out of scope for a TS package.

6. **`contamination.ts`** — held-out perturbation contamination probe. `runContaminationProbe({ originals, perturbation, scoreFn })` runs the policy against original + perturbed scenarios, computes paired Wilcoxon on the deltas, and flags suspected contamination when median drop ≥ 5pp at p < 0.05. Stock perturbations: `renameVariables`, `shuffleOrder`, `injectIrrelevantClause`. Catches the SWE-Bench → SWE-Bench-Verified failure mode upstream.

7. **`tournament.ts`** — `fitBradleyTerry(outcomes)` uses Hunter's MM algorithm to recover candidate strengths from pairwise outcomes; `applyEloUpdate(ratings, outcome)` for online updates with FIDE-style K-factor. `buildPairwiseFromCampaign` extracts pairwise outcomes from per-scenario campaign runs. Sample-efficient ranking for many-candidate sweeps; the methodology Chatbot Arena and AlpacaEval converged on.

8. **`adversarial.ts`** — `adversarialScenarioSearch({ seeds, mutations, scoreFn })` actively searches for inputs the policy fails on. Hill-climb-against-failure-indicator loop (the simplest version of AdA / POET / auto-jailbreak rigs). Caller supplies mutation strategies; the harness deduplicates, budgets, and reports per-generation statistics.

9. **`compute-curves.ts`** — characterize a candidate as a *curve* across compute budgets, not a point. `runComputeCurve` produces `(cost, score)` points + log-slope. `bestOfN`, `selfConsistency` are the canonical test-time-scaling primitives (Snell et al. 2024). `paretoFrontier` removes dominated (candidate, compute) combinations. Required for honest cost-quality reporting in the o1-era.

#### RL barrel — additional experimental modules

The 9 modules above are stable and tested. The following modules are also shipped under `@tangle-network/agent-eval/rl` as **experimental** — interfaces are reasonable but may evolve based on real production consumer feedback. Marked clearly in the barrel docstring; flagged here so consumers know the contract may shift.

10. **`active-curriculum.ts`** — adaptive scenario allocation. `varianceBasedCurriculum` (Neyman 1934 optimal allocation: weight ∝ √variance + 1/√n for under-sampled-cell tie-break) and `thompsonCurriculum` (Beta-Bernoulli posterior + decision-threshold-weighted sampling) reallocate next-round budget toward cells whose outcome is uncertain.

11. **`reward-hacking.ts`** — `detectRewardHacking({ runs, truthOf })` watches four signature signals (proxy-vs-truth divergence, distributional shift, reward disagreement between independent rewards, judge drift relative to deterministic reward) and returns a structured `'clean' | 'suspect' | 'gaming'` verdict with per-signal severity. Krakovna et al. + Skalse et al. 2022 + Kim et al. 2023 lineage.

12. **`adaptation-eval.ts`** — `runAdaptationCurve` and `compareAdaptationCurves` for sample-efficient adaptation evaluation. The metric a foundation-model-based agent should be measured on isn't end-state performance but the curve of score vs k (k=0, 1, 2, 4, 8, 16 demonstrations). Returns area-under-curve summary + per-k bootstrap CIs.

13. **`exporters.ts`** — trainer-format export functions. `toDpoRows` (HuggingFace TRL DPO/IPO/KTO format), `toGrpoRows` (offline GRPO `{prompt, completions[], rewards[]}`), `toSftRows` (TRL/prime-rl SFT messages list), `toPrmRows` (Lightman-style PRM training shape), `stepRewardsToJsonl` (step-level rewards for value-function regression). **Honest scope:** `toSftRows` is the only one that maps directly onto a prime-rl entrypoint; the others target TRL or custom trainers — see `examples/fine-tune-with-prime-rl/README.md` for the explicit fit table.

14. **`rl-campaign.ts`** — `runRLCampaign(opts)` wraps `runEvalCampaign` and runs the full RL bridge (verifiable rewards + preferences + sequential interim verdict + reward-hacking + optional predictive validity + optional trainer export) in one call. The single top-level orchestrator the pre-0.23 audit panel called out as missing.

15. **`auto-research.ts`** — `analyzeOptimizationResult({ result, ctx, comparator })` takes a `PromptEvolutionResult` or `MultiShotOptimizationResult` (the existing GEPA/AxRLM stack outputs) and runs the same RL bridge on top, producing a unified artifact. Closes the architectural fragmentation between the optimization primitives and the RL bridge.

16. **`predictive-validity-researcher.ts`** — `PredictiveValidityResearcher` is a concrete `Researcher` interface implementation (the interface had been a placeholder + `NoopResearcher` until now). Drives steering changes from outcome-anchored predictive validity: rubrics that don't predict deployment outcomes get down-weighted; load-bearing rubrics get up-weighted.

17. **`run-record.ts`** — `RunRecord.scenarioId` is now an optional canonical field (was previously inferred from `outcome.raw.scenario_id`). Populated automatically by `runEvalCampaign` and the optimization adapters; legacy `RunRecord[]` arrays without it fall back to the `outcome.raw.scenario_id` convention. Closes the fragility called out by the 0.23 audit.

#### Build / surface

- New build entry: `dist/rl.{js,d.ts}` exposed via the `@tangle-network/agent-eval/rl` package subpath.
- All RL primitives also re-exported from the root barrel for ergonomic single-import use.
- Default `BradleyTerry` smoothing raised from 0 to 0.1 — Hunter's MM degenerates when a candidate has zero wins; 0.1 keeps the iteration well-conditioned without meaningfully biasing real win counts.

### Why

The previous release shipped EvalCampaign + replay + sequential + outcome calibration as parallel infrastructure to the existing optimization primitives. That left a real gap: `runMultiShotOptimization` and `runPromptEvolution` produced their own trial shapes that didn't compose with the new artifacts. 0.23 closes that gap with the adapter layer, and ships the eight downstream primitives that turn the unified artifact into RL training data, OPE estimates, contamination probes, tournament rankings, adversarial scenarios, and compute curves.

After 0.23, the auto-research loop is coherent end-to-end:

```
mutate (existing primitives)
  → trial outcomes (TrialResult)
  → adapter (run-record-adapters)
  → RunRecord[] (canonical artifact)
  → preferences / verifiable rewards / OPE / step rewards
  → policy update (consumer's choice of TRL / GRPO / PPO / DPO)
  → next sweep
```

### References

- Dudík, M., Langford, J., Li, L. (2011). Doubly Robust Policy Evaluation and Learning. *ICML*.
- Owen, A. B. (2013). *Monte Carlo Theory, Methods and Examples*. Ch. 9 — Importance Sampling.
- Hunter, D. R. (2004). MM algorithms for generalized Bradley-Terry models. *Annals of Statistics*, 32(1), 384–406.
- Bradley, R. A., Terry, M. E. (1952). Rank analysis of incomplete block designs. *Biometrika*, 39(3/4).
- Lightman, H. et al. (2023). Let's Verify Step by Step. *arXiv:2305.20050*.
- Snell, C. et al. (2024). Scaling LLM Test-Time Compute Optimally. *arXiv:2408.03314*.
- Plus the foundational citations from 0.21 / 0.22.

### Migration

All 0.23 primitives are additive. Existing consumers don't need to change. Recommended adoption sequence:

1. Add `trialsToRunRecords(trials, ctx)` after every existing optimization sweep — every old run becomes replay-able and predictive-validity-scorable for free.
2. Wire `extractVerifiableReward` into your scoring pipeline; route deterministic and probabilistic rewards into separate training batches.
3. Use `extractPreferences` to produce DPO/PPO triples for any RL training the consumer runs.
4. Run `rubricPredictiveValidity` quarterly + `runContaminationProbe` per release to keep the rubric weights honest.
5. Replace fixed-comparator HeldOutGate with `fitBradleyTerry` once you have ≥ 5 candidates running on shared scenarios.
6. Replace single-budget evaluation with `runComputeCurve` for any candidate where compute scaling is a question.

### Caveats and out-of-scope

- The DR estimator's Q-function is caller-supplied. We don't ship a learned Q-function trainer — that's a regression problem with too many domain-specific choices to ship a default.
- PRM training itself (gradient descent over a transformer) is out of scope; we ship the data extraction shape.
- The contamination probe's per-scenario q-values use a heuristic pseudo-p (the load-bearing test is the global Wilcoxon).
- `prmTrainingPairs` matches trajectories by step name + kind; production use should replace this with a token-level prefix hash.
- Adversarial scenario search is a simple hill-climb; novel scenario synthesis (compositional, language-model-driven) is future work.

## 0.22.0 — EvalCampaign + replay + always-valid + outcome calibration

0.21 shipped the four capture-integrity primitives as opt-in. Every consumer still had to wire them by hand, and the bug class blueprint-agent reported (forgotten wiring → silent partial-capture) reappears the moment a new consumer adopts agent-eval cold. **0.22 makes the right thing the default path** — and adds three primitives that compound on top of standardized capture: replay-from-raw-events, anytime-valid sequential evaluation, and rubric predictive validity. The four primitives together turn agent-eval from a TS framework into research-grade evaluation infrastructure.

### Added

#### `runEvalCampaign` — capture integrity by construction

Opinionated matrix runner that wires the four directives by construction. Inputs: variants, scenarios, seeds, an `LlmClientOptions`, factories for `TraceStore` and `RawProviderSink`, and a `runner(ctx)` callback. Outputs: per-cell `RunRecord[]`, `RunIntegrityReport[]`, optional `researchReport`, and a campaign fingerprint.

- **Preflight:** `assertLlmRoute` is called once before any work, with `{ requireExplicitBaseUrl: true, requireAuth: true }` defaults. Misconfigured routes never burn a run.
- **Per run:** the campaign constructs the `TraceStore`, `RawProviderSink`, and `TraceEmitter` (with `onRunComplete` hooks attached), then hands the runner an `LlmClientOptions` already pre-wired with `rawSink` + `traceContext`. The runner cannot accidentally call an LLM without capture.
- **Run-completion:** `assertRunCaptured` runs after every `endRun` with `{ llmSpansMin: 1, requireRawCoverageOfLlmSpans: true, requireOutcome: true }` defaults. Failures are routed via `onIntegrityFailure: 'throw' | 'mark_failed' | 'log'` (default `'mark_failed'`).
- **End of campaign:** if `report.comparator` is set, computes `researchReport` over the collected `RunRecord`s and embeds the campaign fingerprint + `preregistrationHash`.
- **Concurrency:** local async worker pool, default 1, configurable via `concurrency`.
- **Determinism:** the default `runId` generator is a stable hash of `(campaignId, variantId, scenarioId, seed)`, so re-running the same campaign produces the same ids; override `runId` for non-deterministic generation.

Exported from the root barrel and the `@tangle-network/agent-eval/optimization` subpath: `runEvalCampaign`, `CampaignRunner`, `CampaignRunContext`, `CampaignRunOutcome`, `CampaignVariant`, `CampaignScenario`, `EvalCampaignOptions`, `EvalCampaignResult`, `FailedRun`, `CampaignIntegrityPolicy`, `CampaignFactoryParams`.

#### Replay-from-raw-events

Every campaign run is now a re-runnable artifact. `ReplayCache.fromSink(sink)` turns a populated `RawProviderSink` into a deterministic `(canonicalised request → cached response)` map; `createReplayFetch(cache)` returns a `fetch`-shaped function that satisfies `/chat/completions` calls out of the cache and passes other URLs through.

```ts
const cache = await ReplayCache.fromSink(yesterdayRawSink)
const replayFetch = createReplayFetch(cache, { onMiss: 'fail-closed' })
await callLlm(req, { ...llmOpts, fetch: replayFetch }) // zero LLM cost
```

Use cases:

- Post-hoc judging — apply a new judge or scorer to last week's runs without burning a single token.
- Determinism audits — replay a campaign and verify the responses match byte-for-byte.
- Free judge calibration — run two judges on identical responses and measure agreement.

`onMiss` is `'throw' | 'fallback' | 'fail-closed'`. The cache hashes a canonical projection (`model + messages + temperature + max_tokens|max_completion_tokens + response_format`) so insertion-order quirks don't cause spurious misses.

Exported from root and `@tangle-network/agent-eval/traces`: `ReplayCache`, `createReplayFetch`, `iterateRawCalls`, `ReplayCacheEntry`, `ReplayCacheStats`, `ReplayFetchOptions`, `ReplayCacheMissError`.

#### Always-valid sequential evaluation

`pairedEvalueSequence(deltas, opts)` and `evaluateInterimReleaseConfidence({ deltaSeries })` ship the predictable plug-in betting martingale of Waudby-Smith & Ramdas (2024) for paired bounded outcomes, plus the empirical Bernstein confidence sequence of Howard et al. (2021) for the running mean. Both are *anytime-valid* — type-I error is bounded by α at every stopping time, no peeking penalty.

```ts
const verdict = evaluateInterimReleaseConfidence({
  deltaSeries: [{ candidateId: 'cand', deltas }],
  alpha: 0.05,
  rope: { low: -0.02, high: 0.02 },
})
// → { recommendation: { decision: 'promote_now' | 'continue' | 'reject_now' | 'equivalent', candidateId } }
```

This closes the methodological hole flagged in the 0.21 methodology doc as out-of-scope. Consumers running rolling campaigns can now ship the moment evidence is decisive, stop-early on dead-on-arrival variants, and accumulate evidence across partial runs without spending the FDR budget. Tested under-the-null at α=0.05 on 100 synthetic series; false-rejection rate stays below the bound.

Exported from root and `@tangle-network/agent-eval/reporting`: `pairedEvalueSequence`, `evaluateInterimReleaseConfidence`, `PairedEvalueOptions`, `PairedEvalueSequence`, `PairedEvalueStep`, `InterimReleaseConfidence`, `InterimReleaseConfidenceInput`, `SequentialDecision`.

#### Rubric predictive validity

`rubricPredictiveValidity({ runs, outcomes, outcomeMetrics })` joins canonical campaign `RunRecord`s to a `DeploymentOutcomeStore` and reports per-rubric Pearson + Spearman + bootstrap CI against each outcome metric. Verdict bucketing: `'load_bearing' | 'informative' | 'decorative'` based on `|spearman|`. **Without this loop every rubric is faith-based;** with it, you know which rubrics earn their promotion power and which are decoration.

```ts
const validity = await rubricPredictiveValidity({
  runs: lastQuarterRuns,
  outcomes: shipFlagOutcomeStore,
  outcomeMetrics: ['revenue_lift', 'retention_30d', 'csat'],
})
for (const r of validity.ranked) {
  console.log(`${r.rubric} → ${r.bestOutcome}: ρ=${r.spearman.toFixed(2)} (${r.verdict})`)
}
```

Builds on the existing `correlationStudy` primitive but works directly off `RunRecord` (the canonical campaign artifact) rather than `Run` from a `TraceStore`, so it composes cleanly with `runEvalCampaign`'s output. Returns a per-rubric ranking + every (rubric, outcome) pair tested + a list of rubrics that produced no usable data.

Exported from root and `@tangle-network/agent-eval/reporting`: `rubricPredictiveValidity`, `RubricOutcomePair`, `RubricRanking`, `RubricPredictiveValidityInput`, `RubricPredictiveValidityReport`. The existing `correlationStudy`, `OutcomeStore`, `InMemoryOutcomeStore`, `FileSystemOutcomeStore` continue to work unchanged.

#### `NoopRawProviderSink.list()` returns `[]`

Explicit opt-out from capture is no longer flagged by `assertRunCaptured` as `no_raw_sink`. Opt-out remains a deliberate choice; the campaign still requires the matching integrity overrides.

### Why

Every consumer that adopted agent-eval before 0.22 wrote their own matrix runner, and every one of them re-introduced the same forgettable wiring (raw sink, route guard, integrity assertion, analyst hook). 0.21 documented the pattern; 0.22 owns it. The four new primitives compound:

- `runEvalCampaign` standardises the artifact (`RunRecord` + raw events + fingerprint).
- Replay turns every past run into free training/validation data for new judges.
- Sequential evaluation makes "ship-when-evidence-says-so" mathematically defensible.
- Predictive validity converts evals from belief-based to outcome-anchored.

`runMultiShotOptimization` remains the right primitive for trajectory-shaped GEPA optimization sweeps; `runPromptEvolution` for prompt + code evolution loops with sandbox pools; `runEvalCampaign` for the "compare N variants on M scenarios with K seeds and tell me which to ship" case that makes up the bulk of consumer evals.

### References

- Howard, S. R., Ramdas, A., McAuliffe, J., Sekhon, J. (2021). Time-uniform, nonparametric, nonasymptotic confidence sequences. *Annals of Statistics*, 49(2), 1055–1080.
- Waudby-Smith, I., Ramdas, A. (2024). Estimating means of bounded random variables by betting. *JRSS B*, 86(1), 1–27.

### Migration

Existing consumers do not need to change. All four primitives are additive. Recommended path: on the next eval-runner refactor, replace hand-rolled matrix loops with `runEvalCampaign`. Use `evaluateInterimReleaseConfidence` for any campaign you run on a recurring cadence. Wire `rubricPredictiveValidity` once you have ≥ 30 deployment outcomes joinable by `runId`. Replay is a free win — once campaigns are running, every eval R&D loop drops to CPU-bound.

## 0.21.0 — capture integrity + launch-grade reporting

This release closes the layer-1 gap a downstream consumer surfaced: better
post-run statistics don't help if the underlying data wasn't captured. 0.21
adds first-class raw provider-event capture, a fail-loud route guard, a
run-completion integrity check, and run-complete hooks (with a trace-analyst
auto-execution helper) so a direct matrix run produces complete forensics
without out-of-band glue.

### Added

- **`RawProviderSink` (capture).** First-class persistence for HTTP-level
  provider request / response / error payloads alongside the structured
  `LlmSpan`. `InMemoryRawProviderSink`, `FileSystemRawProviderSink` (NDJSON,
  rolls at 32 MiB), and `NoopRawProviderSink` ship in core. Default redactor
  strips `Authorization` / `X-Api-Key` / `Cookie` headers and credential-shaped
  body fields (`apiKey`, `bearer`, `password`, `secret`, `token`); redacted
  paths are recorded on `event.redactedFields` so a reviewer can see what was
  stripped without exposing values. Wired into `callLlm` via
  `LlmClientOptions.rawSink` — every retry attempt produces a `request` and
  either a `response` or `error` event with the attempt index attached.
- **`assertLlmRoute` (route guard).** Pure function that throws
  `LlmRouteAssertionError` when the configured client doesn't match the
  caller's route requirements: `requireExplicitBaseUrl`, `allowedBaseUrls`,
  `blockedBaseUrls`, `requireAuth`, `expectedProvider`. Designed for the
  matrix-runner preflight — fail loud at the boundary instead of silently
  falling back to the public/free-tier router.
- **`assertRunCaptured` (integrity check).** Read-only check on
  `(store, runId, expectations)` that returns a structured
  `RunIntegrityReport` with issue codes (`missing_llm_spans`,
  `missing_raw_events`, `orphan_llm_span`, `no_raw_sink`, `missing_outcome`,
  …). Pair with the new `requireRawCoverageOfLlmSpans` to assert every
  `LlmSpan` has a matching raw `request` event. Use directly or via
  `throwIfRunIncomplete` for strict mode.
- **`onRunComplete` hooks on `TraceEmitter`.** New
  `TraceEmitterOptions.onRunComplete` array fires after `endRun` / `abortRun`
  with full run context (run id, outcome, status, store, emitter). Errors are
  swallowed and recorded as `log` events by default; opt into propagation via
  `hookErrors: 'throw'`. `addRunCompleteHook` attaches hooks after construction.
- **`traceAnalystOnRunComplete` factory.** Drop-in run-complete hook that
  runs `analyzeTraces` after each run and persists the result. Resolves the
  "trace analyst never ran on this matrix sweep" complaint by making
  auto-execution declarative.
- **`researchReport`** — executive research-report layer for coding-vertical
  benchmark runs (originally landed in #34, elevated in #35). Composes
  `summaryTable`, `paretoChart`, `gainHistogram`, held-out gate decisions,
  and optional `failureClusterView` output into one structured artifact:
  promote / hold / equivalent / reject / needs-more-data guidance with
  rationale, risks, next actions, markdown, HTML, and JSON chart specs.
  - Decisions are made on paired evidence — never on marginal means alone.
  - ROPE (Region of Practical Equivalence) supported via the `rope` option.
  - Bayesian-bootstrap-style `Pr(Δ>0)` and `Pr(Δ∈ROPE)` summaries (Rubin 1981).
  - Per-candidate minimum detectable paired effect via `pairedMde`.
  - SHA-256 `runFingerprint` and optional `preregistrationHash` linking a
    signed `HypothesisManifest`.
  - Embedded methodology + `docs/research-report-methodology.md` companion.
- **`pairedMde`** in `power-analysis`: closed-form minimum detectable paired
  effect (inverse to the paired-t / sign-rank power formula).

### Changed

- `researchReport` is async (uses Web Crypto via `hashJson` for the run
  fingerprint).
- Default `researchReport.minPairs` is 20 (soft floor); hard floor of 6 is
  enforced regardless via `RESEARCH_REPORT_HARD_PAIR_FLOOR`.

### Wire-protocol consumers

No wire-protocol changes. The new capture / integrity / hook primitives are
TypeScript-only; cross-language consumers continue to use the existing RPC
surface.

### Python client

The PyPI distribution renamed from `tangle-agent-eval` to **`agent-eval-rpc`**, and the import path from `tangle_agent_eval` to `agent_eval_rpc`. The new name accurately describes the package — it is a thin RPC client over the Node runtime, not a Python re-implementation of the eval logic — and the npm scope (`@tangle-network/agent-eval`) already provides the namespacing the `tangle-` prefix was substituting for. No prior PyPI version ever shipped under the old name (Trusted Publisher misconfiguration; see issue #40), so this rename is a clean first publish rather than a migration.

Locked at `agent-eval-rpc==0.21.0` to match the npm package.

## 0.20.10 — hardening audit follow-up

### Fixed

- `hashRubric` now recursively sorts nested rubric fields before hashing, so
  dimension, failure-mode, and win changes alter `rubricVersion`.
- Wire judge handling now validates LLM output before returning it: finite
  dimension scores, rationale, and known failure/win ids are enforced.
- Control-runtime budgets reject invalid numeric config, and invalid action
  costs are omitted from step telemetry instead of leaking `NaN`/`Infinity`.
- Knowledge readiness now treats invalid `validUntil` timestamps as stale.
- Trace-analyst regex search supports leading `(?i)` and stops scanning once
  bounded match output is reached.
- SWE-Bench Lite example wording now reflects the implemented external-grader
  adapter, with quoted command parsing and timeout coverage.

### Changed

- Published package contents now include `CHANGELOG.md`.
- Public docs now use GitHub URLs for repository-only examples and Python
  client source.
- Publish CI now checks npm, Python package, runtime fallback version, and tag
  version agree before publishing.

## 0.20.9 — release hygiene and runtime failure fixes

### Fixed

- Initial `runAgentControlLoop` observe/validate failures now report the
  actual observe/validate error even when trace start/end emission also fails.
- Knowledge readiness recommended actions now honor non-blocking gap
  acquisition modes such as `ask_user`, `search_web`, `query_connector`, and
  `inspect_repo`.
- Npm builds now generate `dist/openapi.json`, and the package exports
  `@tangle-network/agent-eval/openapi.json`.
- Npm and Python client versions are locked at `0.20.9`.

### Added

- `CallbackResearcher`, a concrete callback-backed implementation of the
  stable `Researcher` interface for scripts, tests, and small integrations.
- Public `@tangle-network/agent-eval/benchmarks` subpath for the supported
  routing benchmark surface.
- Root MIT `LICENSE`.

### Changed

- Raw TypeScript examples are no longer included in the npm package; they remain
  repository examples to read, copy, and adapt.

## 0.20.2 — freshness-aware knowledge readiness

### Added

- `KnowledgeRequirement.validUntil` and `lastVerifiedAt` for explicit freshness
  contracts.
- `scoreKnowledgeReadiness({ now })` support for deterministic freshness gates.

### Changed

- Expired knowledge requirements now score as missing even when confidence and
  evidence are otherwise high.

## 0.20.0 — knowledge readiness contracts

### Added

- First-class knowledge-readiness contracts: `KnowledgeRequirement`,
  `KnowledgeBundle`, `KnowledgeReadinessReport`, `UserQuestion`, and
  `DataAcquisitionPlan`.
- `scoreKnowledgeReadiness`, `blockingKnowledgeEval`,
  `userQuestionsForKnowledgeGaps`, and `acquisitionPlansForKnowledgeGaps`.
- Knowledge/data failure classes including `knowledge_readiness_blocked`,
  `missing_credentials`, `bad_retrieval`, `insufficient_evidence`, and
  `contradictory_evidence`.
- `docs/knowledge-readiness.md`, plus documented knowledge-related ASI
  responsible surfaces for multi-shot optimization.

## 0.19.1 — release confidence gate

### Added

- `evaluateReleaseConfidence`, a conservative release scorecard over corpus
  coverage, search/holdout run evidence, ASI diagnostics, overfit checks, and
  cost/latency budgets.
- `assertReleaseConfidence`, a throwing variant for CI/release scripts.
- `releaseTraceEvidenceFromMultiShotTrials`, a helper that projects
  `MultiShotTrialResult` rows into release trace evidence so single-shot and
  variable multi-shot apps use the same release gate.

## 0.19.0 — legacy optimizer removal

### Removed

- Removed the legacy pairwise prompt optimizer surface:
  `PromptOptimizer`, `OptimizationLoop`, and their associated root-exported
  types are gone. The blessed optimization path is now
  `runMultiShotOptimization` for task trajectories and the steering-specific
  optimizers for explicit steering tables.
- Removed the old `PromptVariant` root export. Public callers should use
  `MultiShotVariant` for multi-shot trajectory optimization or
  `EvolvableVariant` for the lower-level prompt/code evolution core.

### Changed

- Documentation now points optimization users at `runMultiShotOptimization`
  instead of the removed pairwise prompt optimizer.

## 0.18.0 — multi-shot optimization

### Added

- `runMultiShotOptimization`, the canonical GEPA-style adapter for
  variable-length agent trajectories. It wraps `runPromptEvolution` while
  preserving full multi-shot traces, actionable side information, stable paired
  seeds, score/cost objectives, and optional held-out promotion gating.
- `trialTraceFromMultiShotTrial`, a bridge from multi-shot trial results into
  reflective mutation prompts.
- `ActionableSideInfo`, `MultiShotVariant`, `MultiShotTrace`, `MultiShotRun`,
  `MultiShotScore`, `MultiShotTrialResult`, `MultiShotMutateAdapter`, and
  related public types.
- `docs/multi-shot-optimization.md` and
  `examples/multi-shot-optimization/index.ts`.

### Changed

- The multi-shot result shape explicitly separates `searchBestVariant` from
  `promotedVariant`. If a holdout gate rejects the search winner, the promoted
  variant is the baseline.
- `runMultiShotOptimization` validates release-critical configuration up front:
  unique variant/scenario ids, positive integer run counts, population size,
  disjoint search/holdout ids, and a gate baseline key matching the first seed
  variant.

## 0.17.2 — agent control runtime

### Added

- `runAgentControlLoop`, a generic `observe -> validate -> decide -> act`
  runtime for agentic tasks with step, wall-clock, and recorded-cost budgets;
  no-progress and repeated-action stop policies; structured runtime failures;
  objective/subjective eval helpers; and `TraceStore` emission.
- `runProposeReviewAsControlLoop`, a bridge preset that expresses
  propose/verify/review as a specialization of the generic control runtime.
- feedback trajectory helpers for turning control-loop runs and user/judge
  labels into reusable dataset scenarios, optimizer rows, and preference
  memory.
- `docs/control-runtime.md`, with integration patterns for tax, legal,
  agent-builder, and film-agent products.

### Changed

- control runtime trace sink and `onStep` callback failures are now recorded
  as structured runtime errors without aborting an otherwise valid run.
- `runProposeReviewAsControlLoop` accepts a caller-provided verifier failure
  mapper for domain-specific failure classes.

## 0.17.0 — surface cleanup + usage-guidance pitfalls

This release tightens the public benchmark surface and lands internal usage guidance that the v0.15 dispatch couldn't write.

### Moved

- `src/benchmarks/gsm8k/` → `examples/benchmarks/gsm8k/`
- `src/benchmarks/swebench-lite/` → `examples/benchmarks/swebench-lite/`

These are reference implementations of `BenchmarkAdapter`, not core surface. Consumers read them, copy them, adapt them. The novel `routing` benchmark stays in `src/benchmarks/` because it's our own and broadly useful.

`src/benchmarks/index.ts` now exports the shared types + the `routing` benchmark only. The previous `gsm8k` and `swebenchLite` namespace exports are gone — import directly from `examples/benchmarks/<name>/index.ts` (or copy the wrapper into your own project).

### Added

- `examples/benchmarks/README.md` documents how to use, copy, and extend the example wrappers.
- Internal agent-eval usage guidance gains production-rigor and pitfalls sections covering the v0.16 primitives.

### Migration

If you imported `gsm8k` or `swebenchLite` from `@tangle-network/agent-eval/benchmarks`:

```ts
// before
import { gsm8k, swebenchLite } from '@tangle-network/agent-eval/benchmarks'

// after — copy the file from examples/benchmarks/<name>/index.ts into your project,
// or import via relative path from the cloned repo.
```

The `routing` benchmark and the shared `BenchmarkAdapter` types are unchanged.

## 0.16.0 — naming cleanup

The v0.15 primitives were framed as "paper-grade" but most are production-rigor utilities any team needs. This release renames the three reporting helpers and drops the "paper" framing from the public API. Behavior unchanged.

### Renamed

- `paperTable` → `summaryTable`
- `paretoFigure` → `paretoChart`
- `gainDistributionFigure` → `gainHistogram`
- `PaperTable` / `PaperTableOptions` / `PaperTableRow` types → `SummaryTable` / `SummaryTableOptions` / `SummaryTableRow`
- File: `src/paper-report.ts` → `src/summary-report.ts`

### Migration

Drop-in: search-and-replace the three function names and the file path. Type names follow the same pattern. No behavior change.

```ts
// before
import { paperTable, paretoFigure, gainDistributionFigure } from '@tangle-network/agent-eval'
// after
import { summaryTable, paretoChart, gainHistogram } from '@tangle-network/agent-eval'
```

## 0.15.0 — paper-grade primitives

Substrate for the "Two Loops, Three Roles" paper on multi-level prompt
optimization with held-out promotion gates.

### Added

- **`HeldOutGate`** (`src/promotion-gate.ts`) — first-class held-out
  paired-delta promotion gate. Three checks: minimum productive runs,
  positive lower bound on bootstrap CI of paired holdout median delta,
  bounded overfit-gap relative to baseline. Decisions carry a
  machine-readable `rejectionCode` (`few_runs` | `negative_delta` |
  `overfit_gap`) plus an `evidence` block with every number the gate
  read. Generalizes the inline pattern that lived in
  `redteam/scripts/agent-eval-autoresearch.ts:138–171`.
- **`RunRecord`** (`src/run-record.ts`) — paper-grade JSON-friendly run
  schema with mandatory fields: `runId`, `experimentId`, `candidateId`,
  `seed`, snapshot-versioned `model`, `promptHash`, `configHash`,
  `commitSha`, `wallMs`, `costUsd`, `tokenUsage`, `outcome`, `splitTag`.
  Runtime validator (`validateRunRecord`, `isRunRecord`,
  `parseRunRecordSafe`, `roundTripRunRecord`) throws on missing fields
  and on bare model aliases without snapshot suffix.
- **`Researcher`** (`src/researcher.ts`) — stable hook for an
  autonomous-research agent: `inspectFailures` → `proposeChange` →
  `applyChange` → `evaluateChange`. `NoopResearcher` is the
  fail-loud placeholder. Implementations live downstream.
- **Reference benchmarks** (`src/benchmarks/`) — three adapters that
  share the `BenchmarkAdapter<TItem, TPayload>` shape:
  - `gsm8k`: HF-mirror loader (JSONL via `AGENT_EVAL_GSM8K_PATH`),
    exact-match grading via `parseGsm8kAnswer`.
  - `swebench-lite`: 30-instance subset stub. Loader reads
    `AGENT_EVAL_SWEBENCH_PATH`; grader shells out to
    `AGENT_EVAL_SWEBENCH_GRADER_CMD`. Both fail loud when unset.
  - `routing`: synthetic 16-task router benchmark, ships in the
    package, dependency-free. Format documented in
    `src/benchmarks/routing/README.md`.
  - `deterministicSplit(itemId, seed?)`: stable 60/20/20 split via
    FNV-1a hash. Default seed `agent-eval-v1`.
- **`summaryTable`, `paretoChart`, `gainHistogram`**
  (`sr./summary-report.ts`) — Table 1 + Pareto + gain-distribution specs.
  Returns data structures (markdown table, point lists, histogram bins);
  caller picks the plotting library.
- **`runCanaries`** (`src/canary.ts`) — three liveness canaries:
  silent judge fallback (consecutive constant-confidence streak),
  judge calibration drift (KS test on confidence distribution), eval-set
  distribution shift (chi-square on category bucket counts).
- **`pairedBootstrap`, `pairedWilcoxon`, `bhAdjust`**
  (`src/paired-stats.ts`) — paper-style aliases + the missing paired
  bootstrap CI primitive. Deterministic with optional seed.

### Notes

- No breaking changes. Every existing module is untouched; new types
  are additive.
- All new public symbols carry JSDoc.
- 87 new tests across 7 new test files. 571 total tests pass.
- See the package docs for usage directives and pitfalls.

## 0.11.0

intent-match + flow-layer + deploy-gate + concept complexity
weighting.

## 0.10.0

`LayerResult.diagnostics` + `buildReviewerPrompt` +
`createDefaultReviewer` + `mergeLayerResults` options.

## 0.9.0

`CommandRunner` contract + `multiToolchainLayer` + `Finding.detail`.

## 0.8.x

`probeLlm` + `keyword-coverage-judge`. Honestly-absent primitives
backfilled — `llm-client`, multi-layer verifier, semantic concept judge,
extractor utilities.

## 0.7.x

Extracted muffled-gate scanner; `CostTracker.recordVerdict`. Footgun
fix: `cwd` belongs in `HarnessConfig`, not the driver constructor.

## 0.6.x

Tier 1 (meta-eval correlation, PRM, bisector), Tier 2 (counterfactual,
cross-trace diff, pre-registration), Tier 3 (self-play, causal
attribution, active learning, RM export), governance templates.
