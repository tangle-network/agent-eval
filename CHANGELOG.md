# Changelog

All notable changes to `@tangle-network/agent-eval` and its sibling `agent-eval-rpc` (Python). The format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are locked across the npm + PyPI packages.

---

## [Unreleased]

---

## [0.150.0] — 2026-08-20

### Fixed

- The GEPA bridge forwards the required `seed` input into every standard `gepa` engine configuration (`engine.seed`) on both supported GEPA generations: the published 0.1.4 launcher config and the pinned source revision's engine config. The bridge previously hashed the seed into the run identity but never passed it to GEPA, so two runs differing only in seed got different `compatibleRunId`s with identically-distributed unseeded behavior. Agent engines (`autoresearch`, `best_of_n`, `meta_harness`) accept no seed parameter; the bridge output now reports that asymmetry as `seedApplied` (false when a recipe includes an agent engine), `GepaBridgeOutput` requires the flag, and `gepaOptimizationMethod` surfaces it in the returned `provenance.seedApplied`. A caller-supplied `engineConfig.engine.seed` is rejected on both sides of the wire because the run seed owns that field — set the seed once at the comparison level. TypeScript from this release requires an `agent-eval-rpc` build that emits `seedApplied`; the packages release in lockstep.

### Added

- `createOpenAiCompatibleExecutionOwner` in `/campaign`: a shipped `ExternalOptimizerModelCall` for the metered optimizer-model path, backed by any OpenAI-compatible `/chat/completions` endpoint via the package's own `callLlm` + `costReceiptFromLlm`. The examples' `loadOptimizerExecutionOwner` now defaults to it, built from `LLM_BASE_URL`/`LLM_API_KEY`, so every documented optimizer example command runs without `OPTIMIZER_EXECUTION_OWNER_MODULE`; the module override path is unchanged.
- The GSM8K comparison example validates every required environment variable at startup and reports the complete missing list before its first paid call. Its header and `examples/README.md` document dataset acquisition: the exact commands that convert the GSM8K test split into the `{id, question, answer}` JSONL the loader expects.
- `servedModelPolicy?: 'exact' | 'allow-within-family'` on `OpenAICompatibleOptimizerModel` and on the metered optimizer model proxy. Default `'exact'` keeps the current behaviour: any substitution fails the proxied call with a 502. `'allow-within-family'` accepts a same-provider-family substitute at both enforcement points (execution receipt and response body), keeps family-level claims, and forfeits per-model claims. A cross-family substitute is always rejected. `ServedModelPolicy` is exported from the root barrel.
- `upstreamReportedEvaluations` is now typed on `GepaBridgeOutput`, validated (non-negative safe integer), and surfaced as `provenance.upstreamReportedEvaluations` next to the callback-metered `evaluationCount`. The bridge has always emitted it; the TS side previously discarded it, so a divergence between GEPA's own counters and the metered count was invisible.
- `docs/campaign-proposers.md` gains a "Runtime Knobs" table: `timeoutMs` (30-minute bridge default), `dispatchShutdownTimeoutMs` (5-second cost-settlement deadline), `servedModelPolicy`, `reflection_lm_kwargs` (`num_retries: 0`; `max_tokens` family caps), and `maxProposerCostUsd` — each with its default, its failure mode, and where to set it.
- Metered agent CLI engines for `gepaOptimizationMethod`. `optimizer.anthropicEndpoint: true` admits the `autoresearch` and `meta_harness` engines in proxied mode. The loopback model proxy grows a `POST /v1/messages` route (Anthropic Messages API) that translates each `claude` CLI call onto the same canonical execution-owner call, reservation, receipt, and budget pipeline as reflection traffic, and synthesizes the SSE stream the CLI requires from the completed call. The bridge child env gains `ANTHROPIC_BASE_URL` (loopback origin), an ephemeral `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` — injected after `removeCredentialEnvironment`, so the ephemeral token stays the only credential the child sees. Budget exhaustion surfaces to the CLI as a terminal 402. Dual-count integrity splits by wire: the bridge-reported reflection counts must equal the proxy's OpenAI-wire counts, and Anthropic-wire receipts must equal admitted Anthropic-wire attempts (`wire: 'anthropic'` receipt tag, `wireUsage()` on the proxy handle, `anthropicEndpoint` counts in provenance). The route translates text conversations only; tool use, thinking, images, `top_p`, `top_k`, and `stop_sequences` are refused loudly — tool metering needs a tool extension of the execution-owner contract.

### Fixed

- `docs/campaign-proposers.md` no longer tells readers to keep API keys "in environment variables": the bridge child is spawned with a fixed allowlist environment, so an exported shell variable never reaches it. The doc now names `runner.env` as the only credential channel, states that `removeCredentialEnvironment` strips credential-shaped keys from `runner.env` when `optimizer` is set, and describes the loopback proxy URL + ephemeral key the metered path passes instead.
- `examples/self-improve-optimizer/`: a runnable `selfImprove()` + `gepaOptimizationMethod()` path — one call from a tiny inline case set to a gated release decision, with env-validated budgets and the default OpenAI-compatible execution owner. The maintainer skill gains an "Optimization Surface" routing table, `docs/campaign-proposers.md` gains a "Choose The Entry Point" section (`selfImprove` = improvement entry, `compareOptimizationMethods` = measurement entry), and the `selfimprove-quickstart` README no longer routes official-optimizer users to the comparison entry.

- The evidence registry: one canonical home for measured claims. `evidence/records/*.json` hold typed records (claim, instrument, exact command, arms, denominator, result, evidence state `CERTIFIED`/`MEASURED-ONCE`/`RESOLVED-NULL`/`UNVERIFIED`/`KILLED`, artifacts, cost, confounds, optional experiment seal digest), validated by `evidenceRecordSchema` from `./experiment`. `pnpm run evidence:render` generates `evidence/INDEX.md` from the records; `pnpm run evidence:check` (inside `verify:package`) fails on an invalid record or a stale index, so the human index can never drift from the data. Initial migration: seven records spanning trace-repair (gated-stop confirm, free-lunch), multishot (golden oracle v1), trace-analysis (GEPA-certified prompt, prime-vs-dspy), creative-cad, and vertical-bench (parity no-flip).

### Fixed

- `costReceiptFromLlm` / `costReceiptFromLlmError` return JSON-clean receipts: absent optional fields (`reasoningTokens`, `cachedTokens`) are omitted instead of carried as explicit-undefined keys, which the external-optimizer proxy's `assertJsonValue` rejects. Execution owners no longer need a `JSON.parse(JSON.stringify(...))` round-trip before returning receipts.

---

## [0.149.0] — 2026-08-18

### Removed

- Twelve modules and their tests: `reviewer`, `analyst/knowledge-capture`, `multi-toolchain-layer`, `dual-agent-bench`, `workspace-inspector`, `golden-matcher`, `ui-finding`, `slo`, `adapters/langchain`, `judge-runner`, `cost-report` and `worker-driver-seed`.

  0.145.3 tiered the root barrel to consumer-imported symbols and documented front doors. These twelve lost their last export path in that pass and kept their source files. Each is unreachable from all 28 build entry points, so none has shipped in `dist` since 0.145.3, and the only importer each retained was its own test.

  **The public export surface does not move.** A build of 0.148.0 and a build of this release each declare 3,447 export entries, and the two lists are identical. No consumer of any published version can be importing a deleted name, because none of them was reachable to import.

### Changed

- Four doc comments named a deleted symbol and now describe the surviving behaviour: `multi-layer-verifier` (twice), `fuzz/types` and `contract/self-improve`, plus the `docs/feature-guide` feature map. `dist` loses 753 bytes, all of it that doc-comment text.

### Migration

Nothing to do. No symbol removed here has been importable since 0.145.3.

One repository still names three of them. `starter-foundry` imports `runAssertions`, `WorkspaceAssertion` and `WorkspaceSnapshot` from this package and pins it to exactly `0.135.1`, where those symbols still exist, so it builds today and this release does not change that. The constraint it already carries is that it cannot move past 0.145.3 without porting them, and that predates this release by four versions. The workspace-assertion helpers were a thin projection over a snapshot it already builds itself.

---

## [0.148.0] — 2026-08-18

### Added

- `@tangle-network/agent-eval/experiment` publishes the evidence receipt: `createEvidenceReceipt`, `verifyEvidenceReceipt`, `isIndependentEvidence`, `EVIDENCE_RECEIPT_VERSION`, `EVIDENCE_AUTHORITY_KINDS`, `INDEPENDENT_EVIDENCE_AUTHORITY_KINDS`, and the `EvidenceReceipt` / `EvidenceBinding` / `EvidenceAuthority` / `EvidenceAuthorityKind` / `EvidenceReceiptVerification` / `CreateEvidenceReceiptInput` types.

  A receipt binds one Runtime execution to the measurement that judged it, without either package importing the other. It carries stable pursuit and run identity, the exact candidate, evaluator, environment, input-set and output content identities, the result digest, and the authority class that made the observation. The payload is attested with the existing canonical report attestation, so mutating any bound field invalidates the receipt.

  The authority vocabulary is closed. An unknown or misspelled kind is never independent, and `candidate-self-report` is never independent, so a candidate cannot certify itself by accident.

- A bounded `SearchHistoryReceipt` over the canonical `SearchLedger`, plus search-history coverage and `searchHistoryPolicy: 'require-complete'` on `compareOptimizationMethods()`. Strict mode refuses missing or denominator-incomplete optimization evidence before untouched-final-test scoring. Rich events remain only in the ledger.

### Fixed

- The packed dependency cohort is read from the manifests instead of a second hand-kept list.

### Changed

- No existing export changed.

---

## [0.147.0] — 2026-08-16

### Removed

- `decideNextUserTurn`, `DecideNextUserTurnOpts` and `buildDriverSystemPrompt`, with `src/driver.ts` and the `user-simulation-driver` example. A role written as a code function cannot be optimized, and a persona driver is an `AgentProfile` on a graph edge, not a packaged function. All five first-party callers now own the role in their own repositories, where the prompt is product data they can change and measure: gtm-agent, legal-agent, insurance-agent, workcomp-agent and creative-agent.
- `ConvergenceTracker` and `src/convergence.ts`. Its only caller was `AgentDriver`, which 0.145.22 deleted, and it never reached the barrel. `analyzeSeries` in `src/series-convergence.ts` is unaffected — it reads drift across runs, not progress within one.
- `PersonaConfig.feedbackPatterns`, the `FeedbackPattern` type, and `PersonaConfig.driverModel`. `feedbackPatterns` told `AgentDriver` which product approvals to reject, and `driverModel` picked its driver model; with the class gone nothing reads either, in this package or in any repository that depends on it. A field that advertises behaviour the package no longer has is worse than no field.
- Nothing else on the public surface changes. `PersonaConfig` and `DriverState` stay: a harness that writes its own driver still describes a persona and a produced state with them.

### Migration

A caller that drove a conversation with `decideNextUserTurn` owns two things now: the system prompt that states what its simulated professional demands, and one priced call that turns the transcript into the next message. Both stay reachable from this package — `CostLedger.runPaidCall` prices and attributes the call, `maximumChargeForLlmRequest` caps it, `costReceiptFromLlm` records it, and `assertServedModel` (published in 0.145.22) holds the transport to the model id it was asked for. gtm-agent's `eval/lib/persona-driver.ts` is the worked example.

A caller pinned below 0.145.22 cannot import `assertServedModel`. Check what the pinned version did before porting: `decideNextUserTurn` did not call the guard before the 0.145.x line, so a port that omits it there matches the pinned behaviour exactly.
## [0.146.0] — 2026-08-16

### Added

- `@tangle-network/agent-eval/multishot/golden` — frozen recordings of what a multishot conversation engine produces on a closed set of deterministic scenarios, and a framework-free check any engine can point at.

  A record holds two things. The REQUEST LEDGER: every transport call each leg received, in issue order, with its model, temperature, token budget, advertised tool definitions and full message log — the four places two orchestrations diverge without their return value changing. And the OUTCOME: the `MultishotResult` without wall-clock `durationMs`, or the throw reduced to its class, its message and the cell spend it declares for the cost ceiling. Matrix records add the returned `MatrixResult`, the judge calls, and every file the run persisted.

  13 shot scenarios and 1 matrix scenario cover the turn-count edges (0, NaN, 1, 3, 10), silent multi-tool turns, an unknown tool with unparseable arguments, typed artifacts of two kinds, both cost provenances, driver retry and full model rotation, and all three error paths. Everything is scripted: no network, no clock in a recorded field, no random number.

  `assertMultishotGoldenScenario` / `checkMultishotGolden` and the matrix pair report every field that moved, by name. `docs/multishot-golden-records.md` documents the contract and the regeneration path.

  Records are frozen. `scripts/record-multishot-golden.ts` never picks an engine for you, captures every scenario twice and refuses an unreproducible one, and cannot overwrite an existing version — a behaviour change mints a NEW version file and the diff between them is the reviewable evidence.

### Changed

- No existing export changed. `runMultishot` and `runMultishotMatrix` are untouched.

---

## [0.145.22] — 2026-08-16

### Removed

- `AgentDriver` and `AgentDriverConfig`. The class was absent from the barrel and from every published subpath, so no consumer could import it. Nine sibling default branches and ten published npm dependents carry zero callers.
- `MetricsCollector`, `TurnMetrics` and `DriverResult`. Each existed only to serve `AgentDriver`, and none reached the export surface.

### Added

- The served-model guard reaches the public surface: `assertServedModel`, `assertServedModels`, `assertCrossFamilyServed`, `checkServedModel`, `servedModelAcceptable`, `ModelSubstitutionError`, `ServedCrossFamilyError`, and the `AssertServedModelOptions` / `AssertCrossFamilyServedOptions` / `ServedModelCheck` / `ServedModelVerdict` types. A harness that owns its own conversation loop needs the same check the packaged drivers make — hold the transport to the model id it was asked for — and could not reach it. Without this, migrating off `decideNextUserTurn` means dropping the check. `docs/building-doctrine.md` names `assertCrossFamilyServed` as an enforcement mechanism, so the whole family ships together rather than the half a driver happens to call.

### Changed

- The `buildDriverSystemPrompt` and `decideNextUserTurn` deprecation notices cite `tangle-network/agent-eval#618`, the open issue that tracks their removal, instead of a closed issue in another repository.

---

## [0.145.21] — 2026-08-16

### Changed

- `@tangle-network/agent-interface` is declared as `^1.0.0` instead of the exact `0.56.0`. Interface 1.0.0 publishes the surface of 0.56.0 unchanged and states a compatibility promise: a minor release is additive, a patch release is a fix, and only a major release removes or narrows. A caret range reads that promise, so a later additive minor needs no release here, and a consumer that installs this package beside another first-party package resolves one interface copy instead of two.
- `@tangle-network/agent-core` moves to 0.9.4, which is the release that depends on interface 1.0.0. An older core pin drags its own interface copy into the tree.
- `pnpm.minimumReleaseAgeExclude` accepts `@tangle-network/*`. The 3 day release-age floor refused a first-party version published the same day, which blocked adoption of the package this repository releases against.
- `scripts/verify-package-exports.mjs` asserts the declared range and the resolved version apart. A caret range and the single version it resolves to are different strings, so one expectation cannot cover both.

---

## [0.145.20] — 2026-08-16

### Fixed

- A matrix cell that spent money and then threw recorded `costUsd: 0` and `durationMs: 0`. That spend left the cumulative sum `costCeiling` reads, so a run kept scheduling cells after real spend passed the ceiling. A failed cell is now billed for the spend it declares.
- `runMultishot` lost the cost of every driver attempt that billed and returned empty content. Those calls are now charged as they happen, so `MultishotDriverEmptyError` no longer discards the whole conversation's spend.
- A cell that returns a non-finite or negative `costUsd` no longer disables the ceiling for the rest of the run. `NaN` in the cumulative sum makes `>= costCeiling` false forever. Such a result now fails its own cell and the ceiling stays enforceable. An unusable `durationMs` reaches only `meanDurationMs`, so it is recorded as 0 with a warning and the cell keeps its verdict and its cost. A wall clock that steps back mid-cell makes an elapsed time negative, so this is a reachable state.
- A shot whose call reported neither a cost nor usage priced that call at 0 and still reported the total as a complete estimate. `runMultishot` now reports `costProvenance` on success, so the cell records `uncaptured` and the run counts it. The error path already reported this; the success path did not.
- `withCellSpend` lost the spend and replaced the original error when the thrown value was frozen, sealed, or otherwise non-extensible. Such a value is now wrapped in an `Error` that carries the spend and keeps the original as `cause`.

### Added

- `withCellSpend(error, spend)` and `readCellSpend(error)` on `@tangle-network/agent-eval/matrix`. A `runCell` implementation that spends before it throws declares that spend with `throw withCellSpend(err, { costUsd, durationMs, kind })`. The carrier is read structurally, so a throw that crosses a package boundary still bills.
- `CellResult.costProvenance` names the origin of `costUsd`: `observed`, `estimated`, or `uncaptured`. A failure that declares no spend records `uncaptured`, which is distinct from a measured zero.
- `MatrixResult.summary.costUncapturedCells` and `AxisSummary.costUncapturedCells` count the cells whose cost is a subtotal. Above 0, `totalCostUsd` is a floor on real spend, not the total.
- `RunAgentMatrixOptions.maxCellCostUsd` bounds what one cell can spend. A cell whose cost is a subtotal is charged that bound against `costCeiling` instead of its known amount, so spend a cell hid cannot walk the run past its budget. It changes only what the ceiling reads: `CellResult.costUsd` and `summary.totalCostUsd` keep reporting known spend. `runMultishotMatrix` forwards the option.
- `MatrixResult.summary.ceilingChargedUsd` reports the figure the ceiling read. It exceeds `totalCostUsd` only when `maxCellCostUsd` charged a bound.
- `MultishotResult.costProvenance` lets a shot declare whether its `costUsd` is a total or a subtotal. It is optional, so an engine written before this field behaves as before. `assertMultishotShotResult` validates it when present and rejects an `uncaptured` provenance that carries a number.

### Changed

- The multishot cell declares the shot's own subtotal plus settled judge cost when it fails after the shot returns, and reports `costProvenance: uncaptured` when a judge cost was never reported. A shot that declares no spend is rethrown untouched, so the cell records as uncaptured rather than claiming a fabricated total.
- `runMultishotMatrix` writes `costUncapturedCells` and `ceilingChargedUsd` into `summary.json`. `summary.md` labels the cost line "Cost (at least)" and carries a caveat line when any cell reported a subtotal, so a reader of the on-disk report cannot mistake the figure for the run's whole spend.
- Refreshed the analyst benchmark dependency-lock hash for this version.

---

## [0.145.19] — 2026-08-16

### Added

- Add `RunMultishotMatrixOptions.runShot`, the per-cell conversation engine for `runMultishotMatrix`. It defaults to `runMultishot`. A consumer supplies an alternative engine and keeps the substrate cell body: fan-out, concurrency, the cost ceiling, the judge slots, the cell composite, the per-cell writers, and the run summary.
- Export `MultishotShot`, the shot signature, and `MultishotCellOutput`, the per-cell output type. A consumer engine is checked against these types instead of a structural copy.
- Export `MultishotShotResultError` and `assertMultishotShotResult`. The matrix validates each shot result and fails the cell loud. It never falls back to the default engine. The guard reads every required field of each transcript row and each artifact, including `toolCalls` elements and `invocation.args`. It rejects an untyped artifact before the cell scores as though the artifact was never produced, and a non-finite `costUsd` before the value makes every cost number NaN. The guard does not protect spend: a rejected cell records `costUsd: 0`, which is how the matrix records every failed cell.

### Changed

- The multishot matrix now applies `assertMultishotShotResult` to the default engine's result too. A custom tool executor that returns non-string `content`, or a custom transport that reports a negative or non-finite `costUsd`, now fails the cell instead of writing the value into the cell artifacts.

---

## [0.145.18] — 2026-08-16

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.9.3` and `0.56.0`.
- Packed consumers now resolve one Core and Interface contract set through Eval.

---

## [0.145.17] — 2026-08-16

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.9.2` and `0.55.0`.
- Packed consumers now resolve one Core and Interface contract set through Eval.

---

## [0.145.16] — 2026-08-16

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.9.1` and `0.54.0`.
- Packed consumers now resolve one Core and Interface contract set through Eval, Knowledge, and Runtime.

---

## [0.145.15] — 2026-08-15

### Added

- Add runnable entry points for evaluation, experiment planning, trace analysis, sealed experiments, verification, and optimizer adapters.
- Add measured unconditional-continuation and gated-stop studies for trace repair.

### Changed

- Align the exact `@tangle-network/agent-core` dependency with `0.9.0`.
- Size gated-stop confirmation draws from the registered power curve and reject substituted served models before spend.

### Fixed

- Read registered binary outcomes as `1` or `0` in paired estimates and intervals.
- Give each continuation rollout an independent seed and clear stale assay rewards before every run.

---

## [0.145.14] — 2026-08-15

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.8.1` and `0.53.0`.
- Packed consumers now resolve the one-copy `0.8.1` Core and `0.53.0` Interface cohort through Eval's release verification.

---

## [0.145.13] — 2026-08-15

### Added

- Add `streamCodeAgentJsonlFile` and `parseCodeAgentJsonlFile`, which read a code-agent transcript one line at a time and retain only the unterminated tail, so a session past V8's 536,870,888-character string ceiling can still be ingested. `parseCodeAgentJsonl` keeps its existing string-entrypoint signature and behavior.

---

## [0.145.12] — 2026-08-14

### Fixed

- Concurrent candidate campaigns now cancel active siblings after the first candidate failure while preserving caller cancellation.

---

## [0.145.11] — 2026-08-14

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.8.0` and `0.52.0`.
- Packed consumers now resolve the one-copy `0.8.0` Core and `0.52.0` Interface cohort through Eval's release verification.

---

## [0.145.10] — 2026-08-13

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.7.1` and `0.49.0`, so downstream consumers share one current contract cohort.

---

## [0.145.9] — 2026-08-13

### Fixed

- `runProfileMatrix()` now retains failed moving-model cells when the canonical `UNKNOWN_MODEL` receipt marker is present.
- The marker counts as absent served-model evidence only on failed rows; successful rows and non-canonical invalid model strings remain rejected.

---

## [0.145.8] — 2026-08-13

### Added

- Export the durable campaign cache reader and canonical cell-cache path from `@tangle-network/agent-eval/campaign`.
- Consumers that inspect retained campaign cells can now use Eval's identity and cost-provenance validation without copying its filesystem parser.

---

## [0.145.7] — 2026-08-13

### Fixed

- `runProfileMatrix()` now retains failed moving-model cells when no served model was observed.
- These rows use explicit unknown model, uncaptured cost, and incomplete usage markers instead of fabricated snapshots or zero measurements.
- Successful moving-model cells still require one immutable served model snapshot.

---

## [0.145.6] — 2026-08-13

### Fixed

- `runCampaign()` now passes its existing per-invocation `runAttemptId` through every `DispatchContext`, so failed profile retries receive distinct workspace identities while completed cache reuse remains unchanged.

---

## [0.145.5] — 2026-08-12

### Fixed

- External text optimizers now receive a finite zero penalty when a continue-on-error campaign cell fails.
- Eval preserves that cell as failed and unscored, retries it instead of caching it, and keeps `abortOnCellError: true` fail-fast.

---

## [0.145.4] — 2026-08-12

### Added

- Consumers that split one profile matrix across bounded external grants can
  create one Eval-owned plan, pass disjoint rows to each segment, reuse the
  same segment identity to resume failed cells, and call finalization only
  after every declared row is claimed.
- Finalization preserves the ordinary `runProfileMatrix` result and reports
  missing, failed, and zero-score rows separately.

---

## [0.145.3] — 2026-08-12

### Fixed

- Accept and preserve a provider-qualified snapshot when an optimizer callback reports the requested model.
- Reject true model substitution and conflicting response and receipt identities.

---

## [0.145.2] — 2026-08-12

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.6.1` and `0.47.0`, so downstream consumers share one current contract cohort.

---

## [0.145.1] — 2026-08-11

### Fixed

- Restored the root `pairArms` export (with its `PairArmsOptions`, `PairArmsResult`, `MatchedPair`, `MatchedRunRecordPair`, and `PairRunRecordsResult` types). Published `agent-knowledge` dists (7.0.x) import `pairArms` from the package root at ESM link time, so its removal in 0.144.13 crashed those consumers at import. The 0.145.0 census read consumer sources; published dists are consumers too.
- `verify:package` now proves every typed entry point's `d.ts` and `js` agree exactly: a name the `d.ts` declares as a value must be a runtime export of the `js`, and the reverse. TypeScript classifies each candidate name, so the check is independent of the declaration bundler's output format.

---

## [0.145.0] — 2026-08-11

Breaking release: the deep clean. The measured consumer-import census is the compatibility contract — every symbol any consumer imports keeps its exact specifier; everything with zero importers is deleted.

### Removed (breaking)

- The generation-1 eval spine: `executeScenario`, `BenchmarkRunner`, the legacy reporter, the no-op `normalizeScores`, and the dead legacy exports of `types.ts` (`JudgeConfig`, `BenchmarkReport`, `BenchmarkRunnerConfig`, `EvalResult`). The campaign engine (`runCampaign`) and `/contract` are the one spine.
- 30 zero-importer root modules and their tests (behavior-dsl, bisector, causal-attribution, ci-gate, cross-trace-diff, description-length-gate, self-play, visual-diff, and the rest listed in PR #581).
- The `./control` subpath entry (its modules stay importable from the root barrel) and two-thirds of the root barrel: 1,660 → 789 symbols. Symbols removed from the root remain importable from their subpaths.

### Changed

- `src/statistics.ts` is now the `src/statistics/` directory (12 focused modules); every existing import specifier still compiles.
- `runCampaign` internals split into phase modules; its import path and options are unchanged.
- Every verifier lands in `DefaultVerdict`, with `certification` naming what certified the verdict (checker identity, strategy, assumptions, evidence digest).


### Fixed

- Number callback evaluations from one for each optimizer attempt so resumed artifact files remain independently verifiable while cumulative budgets stay intact.

### Added

- `AnalystDefinition` — the declarative unit behind an analyst arm: a profile fragment, an `EvidenceProjection` (`inline` | `chunked` | `repl-variable` | `agent-tools`), a `ReplyContract` (generalized from `PrimeReplyContract`, which is now a type alias of it), and budget plus repair-turn declarations.
- `bindAnalyst(definition, transports)` compiles a definition into a runnable `AnalystBenchmarkRunner`; a projection × transport pair with no strategy fails loud with `AnalystExpressivenessError`.
- The three benchmark arms are re-expressed as exported definitions (`publicDirectAnalystDefinition`, `publicRlmAnalystDefinition`, `primeCodeTraceAnalystDefinition`); `createPublicBenchmarkDirectRunner`, `createPublicBenchmarkRlmRunner`, and `createPrimeBenchmarkRunner` are thin shells over them, so no consumer changes.
- `analystDefinitionProtocolSha256` (equals `primeAnalystProtocolSha256()` for the inline arm) and `analystDefinitionAsymmetries` (refuses unequal repair turns, renders declared differences).
- `ExecutionProbe` — the optional live-execution port on `AnalystContext` (`context.probe`); a runtime fills it later, this package defines only the port.
- Definition parity kill test (`src/analyst/definition-parity.test.ts`): each compiled arm and its entry point must send byte-identical request bodies and record equal protocol digests, so expression loss fails CI by construction.
- Verification-strategy family (`VerificationStrategySource`, `VERIFICATION_STRATEGIES`): the reward-source union opens with `proof-kernel`, `invariant`, `replication`, and `agreement`, each carrying its documented failure mode (the formalization gap, uncalibrated invariants, method self-replication, the shared blind spot). The answer-key members and the deterministic/probabilistic axis are unchanged.
- Verdict epistemics: `DefaultVerdict` gains an optional `certification` (`VerdictCertification`) — strategy, exact checker identity with content pins, assumption list, evidence digest. Additive: consumers that do not read the field are unaffected.
- Checker port (`StrategyChecker`, `CheckerIdentity`, `CheckerOutcome`): a checker is an injected executable boundary returning a typed outcome; the package ships no checker implementation, so a consumer binds its own kernel.
- Blind statement-equivalence protocol (`defineEquivalenceCheck`, `buildEquivalenceRecord`, `runEquivalenceCheck`): the two-arm design as a typed primitive with fail-loud refusals (`EquivalenceProtocolError`) — a non-blind arm, a wrong arm count, a refutation without its separating witness, or a mismatched checker strategy throws instead of recording.
- `docs/verification-strategies.md`: the family, each member's failure mode, and the BCWW (4.6) formalization pilot as the worked example.

## [0.144.13] - 2026-08-11 - GEPA callback timeout alignment

### Fixed

- GEPA callers can now set `GepaOptimizationMethodConfig.timeoutMs` above 30 minutes without the Python callback bridge expiring at its old 30-minute limit.
  Consumers using a custom GEPA timeout must upgrade both packages to 0.144.13; no new setting is required.

## [0.144.11] - 2026-08-10 - GEPA candidate graph

### Added

- `readGepaCandidatePopulationArtifact()` returns GEPA's exact accepted candidates, parent indices, selection scores, and discovery counts from a verified artifact.
- Direct GEPA method provenance addresses the candidate graph and its configured population bounds, selection identities, and candidate surface kind.

### Fixed

- The Python bridge preserves the official GEPA result graph from both published GEPA 0.1.4 and the pinned source API wrapper.

## [0.144.10] - 2026-08-10 - Optimizer candidate population

### Added

- `readExternalOptimizerObservationArtifact()` returns every distinct callback-submitted optimizer candidate after it verifies the addressed artifact's digest, canonical rows, sequence, candidate identities, and counts.
- `decodeExternalTextCandidate()` exposes Eval's existing canonical conversion from external text or named components to a mutable optimization surface.

## [0.144.9] - 2026-08-10 - Token usage completeness

### Fixed

- Campaign cells and run records preserve incomplete token usage as `tokensKnown: false`; their numeric counts remain known subtotals and no token-efficiency ratio is reported.

## [0.144.8] - 2026-08-10 - Duplicate candidate admission

### Fixed

- `runOptimization()` rejects duplicate candidate surface identities before candidate dispatch, including repeated entries in one population and surfaces admitted by an earlier generation.

## [0.144.7] - 2026-08-10 - Runtime journal alignment

### Fixed

- Runtime recursive supervisor journals now retain every event envelope at the Eval reader boundary.
  Transport events such as `materialized`, `execution-bound`, and `trace-unpropagated` remain readable as unavailable evidence instead of becoming malformed rows.
  The reader also projects Runtime's nested profile identity and structural tree roles, so recursive trees retain their nodes, settlements, token spend, and unknown-cost fields.

## [0.144.6] - 2026-08-09 - interaction binding cohort alignment

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.5.4` and `0.46.1`, so consumers share the canonical provider interaction binding without nested contract copies.

## [0.144.5] - 2026-08-09 - structured profile and prime cohort alignment

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.5.3` and `0.46.0`.
- Preserve the shared profile contract's structured system-prompt capabilities and `prime` harness through Eval's profile matrix without adding a local profile schema or capability copy.
- Multishot agent requests now preserve the profile's ordered `systemPrompt` and `appendSystemPrompt` values.

## [0.144.4] - 2026-08-04 - prompt-cache cohort alignment

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.5.0` and `0.43.1`, so Eval consumes the shared prompt-cache accounting contract used by Runtime and Knowledge.

## [0.144.3] - 2026-08-03 - exact profile matrix evidence

### Changed

- Campaign cells expose every distinct agent receipt model in `resolvedModels` and expose `resolvedModel` only when all agent receipts agree.
- Snapshot validation accepts Router `-MMDD` model snapshots while rejecting routing selectors such as `@preset/name`.

### Fixed

- `runProfileMatrix` rejects mismatched receipt models, multiple resolved snapshots within one profile, and duplicate profile identities before they can corrupt comparisons.
- A failed profile campaign now cancels active sibling campaigns through their existing abort signals instead of allowing additional paid work to continue.
- Profile campaign cache identity now includes the caller commit, optional `dispatchRef`, profile identity, and comparison config, so changed execution cannot reuse and relabel an old cell.

## [0.144.2] - 2026-08-03 - concurrent exact profile comparison

### Changed

- `runProfileMatrix` accepts caller-controlled `maxProfileConcurrency` while preserving deterministic output order and independent per-profile run directories and cost ceilings.
- Profiles may keep the exact provider-facing model alias used for execution when every paid-call receipt supplies the related snapshot-bearing model written to durable records.

### Fixed

- Broad profile comparisons no longer have to serialize every profile campaign or maintain a second matrix runner just to compare exact execution profiles at practical throughput.

## [0.144.1] - 2026-08-03 - runtime-owned optimizer model calls

### Fixed

- Official GEPA, SkillOpt, and DSPy child requests now cross one OpenAI-compatible loopback boundary and invoke the caller-owned canonical model callback exactly once.
  Provider URLs, credentials, retries, and raw HTTP responses no longer cross Agent Eval's public callback.
- Each invoked optimizer-model call carries a stable call ID, a deeply immutable canonical chat request, the original abort signal, and its endpoint format.
  The owner must return a canonical chat response, an exact cost receipt, and finite JSON execution evidence.
- Response and receipt validation now preserves cached-input, cache-write, reasoning, output, actual, estimated, and unknown cost semantics without counting cached input twice.
- The public analyst benchmark records the model-owner callback identity and loads it from an explicit owner module instead of accepting provider credentials.
- Pinned official GEPA and SkillOpt request fixtures now cover the real library payloads, including SkillOpt's dynamic system-role task message.

## [0.144.0] - 2026-08-03 - caller-owned optimizer execution

### Changed

- **Breaking:** official GEPA and SkillOpt optimizer models replace direct `baseUrl` and `apiKey` fields with a caller-owned `call` callback and stable `callRef` identity.
  Agent Eval no longer accepts provider credentials or performs provider retries for this path; the package that owns execution, such as Runtime with one exact `AgentProfile`, makes each admitted call and reports its own retry history.
- Every invoked optimizer-model call must return a typed success or failure, a canonical measured cost receipt, and finite JSON execution evidence.
  Rejected callbacks, malformed outcomes, missing receipts, missing evidence, and response/receipt usage disagreements fail the optimizer attempt.
- Official optimizer runs persist append-only candidate, evaluation, refusal, and model-execution records with counts and SHA-256 identities in method provenance.
- Comparison costs now carry explicit observed, estimated, or uncaptured provenance, so an unknown bill remains unknown even when a known subtotal exists.
- Optimizer pricing and dollar limits are optional.
  When billed USD is unknown, callers omit both instead of presenting a catalog estimate or zero as observed billing.
- GEPA `maxProposerCostUsd` is optional while evaluation, request, byte, output-token, reasoning-token, and timeout limits remain caller-controlled.

### Fixed

- Runtime file-backed run contexts are now read by the supervisor-run parser instead of being mistaken for missing inline journals.
- Agent-profile matrix expansion preserves the canonical `harness` field on every generated profile.
- OpenAI-style nested prompt-cache fields and Anthropic-style separate cache-read and cache-creation fields are preserved and reconciled against the execution owner's receipt.
- Negative, fractional, and unsafe reasoning-token allowances are rejected before they can understate a cost reservation.
- The official optimizer model callback is invoked exactly once per admitted request; Agent Eval no longer hides a second retry policy inside its proxy.

## [0.143.0] - 2026-08-03 - exact campaign cost provenance

### Changed

- **Breaking:** `CampaignCellResult.costEstimated` is replaced by the required `costProvenance` union, and `ProfileSummary.totalCostUsd` becomes `number | null` with an adjacent `costProvenance` value.
- Campaign measurement digests now include the complete cost-provenance value, so digest equality is intentionally not preserved across the `0.142.x` to `0.143.0` data boundary.
- Run-record raw cost fields now describe the total as observed, estimated, or uncaptured, while `cost_known_subtotal_usd` retains any measured subtotal when the total remains unknown.
- `planCampaignRun` reports `cellsBlocked`, and each planned cell may be `blocked` when saved data cannot prove its cost or receipt identity.
- Caches created before `0.143.0` have no complete cost provenance and therefore stop a resumable campaign by default.
  Inspect the plan and set `rerunInvalidCachedCells: true` for a one-time selective rerun, or set `resumable: false` for an intentional full rerun.

### Fixed

- Failed provider calls retain input, cached-input, cache-write, output, and reasoning tokens without presenting an unknown USD total as zero.
- Campaign execution inspects every saved cell and its exact billing receipts before any concurrent dispatch begins, so a late stale cell cannot waste spend in earlier cells.
- Malformed, unreadable, mismatched, or receipt-incomplete saved cells require explicit rerun approval instead of being silently reused or re-executed.
- `planCampaignRun` no longer creates the run directory while performing read-only inspection.

## [0.142.2] - 2026-08-02 - current shared type cohort

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependencies with `0.4.33` and `0.43.0`, so Eval, Runtime, Knowledge, and Sandbox share the current canonical profile contract.

## [0.142.1] - 2026-08-02 - current shared type patch

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependency cohort with `0.4.32` and `0.42.1`, preventing nested copies when consumers use the current interaction-field contract.

## [0.142.0] - 2026-08-02 - current agent control contracts

### Changed

- Align the exact `@tangle-network/agent-core` and `@tangle-network/agent-interface` dependency cohort with `0.4.31` and `0.42.0`, including native continuation results bound to the submitted turn and current run control reference.

## [0.141.0] - 2026-08-02 - portable trace identity and profile-native multishot

### Changed

- **Wire-format change: OTLP trace/span ids.** All three private paddings — `padTraceId` in `store-to-otlp` and `otel-export`, plus the same strip+pad body as `runToTraceId`/`padSpanId` in `otel.ts` — are retired for `deriveHexId` from `@tangle-network/agent-trace-contract` (new dependency), routed through one shared `src/trace/wire-ids.ts`. The exporters previously produced DIFFERENT trace ids for the same run, and the strip+pad family emitted invalid hex that embedded the raw run id in the wire id — flagged by the contract's own `non-hex-id` validator. Any id that is already a valid W3C id passes through unchanged (an inbound `traceparent` survives); every other id now derives to the contract id, so trace ids emitted by prior releases for the same run DO NOT match ids emitted by this one.
- `MultishotShape.buildOpener` / `buildDriverSystemPrompt` are now OPTIONAL: omitted callbacks derive from the `AgentProfile` + persona payload (`defaultShapeFromProfile`, exported), so a pure-profile `runMultishot({ profile, persona })` works with no role-builder functions. Existing shapes keep working unchanged.

### Deprecated

- `AgentDriver`, `ProductClient`, `decideNextUserTurn`, `buildDriverSystemPrompt` — a one-product REST client and its persona-driver loop do not belong in the generic substrate; they move to the product repo / become a 2-node agent graph in the next major. Each warns on first use (once per process).

### Removed

- `buildWorkerDriverSystemPrompt` + `WorkerDriverContext` (zero callers in any package, re-measured). Its knowledge ships as seed DATA instead: `WORKER_DRIVER_DOCTRINE` (the "never write a thin steer" driving contract) and `HARNESS_BRIEFS` (per-harness capability + caveat briefs), so a driver profile can seed from it and an optimizer can improve it — a role expressed as a code function can never improve.

## [0.140.1] - 2026-07-31 - a supervisor journal is read, or reported unreadable

### Fixed

- `parseSupervisorTree` returned zero spawns AND zero invalid rows for the journal `agent-runtime` writes — a positive claim that the run was empty. `agent-runtime/src/durable/spawn-journal.ts:232` writes `{kind:'event', root, event}`, so reading that envelope is a correctness fix rather than leniency.
- Every non-empty line now lands in exactly one bucket, enforced by an invariant the tests assert on every case: `journalRows === spawns + closes + metered + sum(ignored) + journalInvalidRows`. A `never`-typed switch default makes a future unhandled event kind a compile error instead of a dropped row.
- `journalInvalidRows` widens to "could not be interpreted at all", so the three existing integrity consumers fail closed on the new case without a second field to remember. `journalMalformedJsonRows` keeps the old narrower meaning, `journalIgnoredRowsByKind` records recognized-but-unmodelled kinds by name, and `journalDialect` (`none | flat | runtime-envelope | mixed`) records that the shape differed.

## [0.140.0] - 2026-07-31 - the recursive engine runs on real providers

### Changed

- The DSPy bridge takes a selectable control adapter, so a model that answers in prose and fenced code rather than DSPy's `[[ ## field ## ]]` markers no longer voids a completed investigation.
  **The bridge's `analyze` input gains a required `controlAdapter` key**: a Python `agent-eval-rpc` and its npm peer must now be the same version, and a mismatch fails with `analyze input must contain exactly [...]`.
- A single malformed finding never voids a completed RLM case; rejections are recorded with a reason instead of raised.
- Raise the DSPy output-token default from 4096 to 16384. 4096 is below what current coding models emit for a full findings array — glm-5.2 through an OpenAI-compatible gateway returns 8192 and the request is rejected outright, so the old default failed before any analysis ran. `maxCostUsd` remains the real spend bound.

### Added

- First scored run of the recursive DSPy RLM analyst on the pinned 32-case CodeTraceBench corpus: F1 0.3644 over 60 of 64 completed cases at $6.73, against the retired one-shot runner's 0.3673 at $1.21 and CodeTracer's 0.3128.
  Recursion did not improve step localization on this task, and the artifact says so; the engine's claimed value is verified findings on an arbitrary session, which this benchmark does not measure.

## [0.139.3] - 2026-07-31 - supervisor runs under `.agent`

### Changed

- Find supervisor runs under `<ws>/.agent/supervisor`, falling back to the pre-rename `<ws>/.loops/supervisor` so historical runs stay analyzable.
  agent-runtime 0.111.0 moves the run contract to `.agent`, the one dot-dir for agent-owned state; `.agent` wins when both exist.
  The "no supervisor run dir" gap messages name both locations.

## [0.139.2] - 2026-07-31 - interface 0.40 cohort alignment

### Fixed

- Depend on `agent-interface@0.40.0`, matching the interface every current consumer ships.
  agent-runtime's packed-cohort verifier requires this package's interface dependency to equal the packed cohort interface exactly; 0.139.1 still depended on 0.39.0.

## [0.139.1] - 2026-07-31 - source-only build gate

### Fixed

- `pnpm build` verifies the benchmark implementation digest only, via the new `--source-only` flag on the check script.
  A consumer rebuilding the package with deliberately rewritten dependency manifests — agent-runtime's packed-cohort verifier, a vendored fork — still proves the analyst-benchmark source is untouched, but no longer fails on its own dependency rewrite.
  `pnpm verify:package` and the test suite keep enforcing the dependency-lock pin on the release path.

## [0.139.0] - 2026-07-31 - recursive RLM trace analysts and caller failure reasons

### Added

- Trace analysts run official DSPy RLMs; the Ax stack is retired (#495).
  The published CodeTraceBench evidence remains bound to the retired direct runner via the evidence digests; a fresh certified run must replace it before any accuracy number is attributed to the new engine.
- `CostLedger.reconcile` accepts a caller-supplied failure reason: `reconcile(callId, observed, { error })` settles a failed receipt carrying that reason, and supplying a reason implies failure.
  0.138.0 had narrowed `CostReceipt.error` to the ledger's own `'paid-call-failed'`, silently discarding caller reasons — a crash orphan settled as a successful $0 call.
  The receipt schema accepts any non-empty reason again, so ledgers persisted before 0.138.0 parse.

## [0.138.0] - 2026-07-30 - exact analyst runs with sealed receipts

### Fixed

- A release version bump no longer invalidates the published analyst benchmark evidence.
  The dependency-lock pin now tracks the current lockfiles, the evidence keeps its own creation-time digest and package version, and a test proves the two locks differ by the version stamp alone — a real dependency change still forces a new benchmark run or explicit retirement of the evidence.

### Added

- `AnalystRegistry.runExact()` requires ordered analyst ids and an explicit value for every run-policy field.
  It never inherits registry insertion order or the constructor's default budget.
  Disabled budgets, timeouts, cancellation, cost attribution, tags, and prior findings use explicit `null` values.
  Exact runs bind analyst, ledger, hook, chat, and policy identities with non-secret configuration digests.
  They use the registry's shared serial execution path and persist canonical equal or weighted allocations instead of adding a second scheduler or allocator.
  Exact receipts explicitly distinguish complete execution from a failed ordered prefix.
  `ExactAnalystRunExecutionError.result` is always a canonical immutable failed receipt with valid completed work and accounting.
- `defineTraceAnalyst()` accepts canonical `executionConfig` and returns an exact-capable custom analyst when it is supplied, while preserving its existing minimal form.
- **Breaking:** `AnalystBenchmarkCase` now requires `clusterId` and `labelState`.
  A case must identify its independent source unit and state whether labels prove an issue, prove no issue, or leave the outcome unknown.
  The benchmark no longer guesses either field from an empty issue list.
- `agent-eval analyst-benchmark` compares an empty baseline with a real-model AgentRx or CodeTraceBench analyst through any OpenAI-compatible endpoint.
  It requires an explicit case limit and immutable dataset revision, validates labeled spans before paid work, uses benchmark-specific output adapters, and writes complete JSON plus Markdown results.
  CodeTraceBench cases also retain hashed final verification artifacts, parse known upstream result formats, and mark missing outcomes unavailable.
  Limited hash samples report source-versus-selected class, agent, model, difficulty, and solved distributions without claiming representativeness.
  The published all-row score is retained, while a calibrated view measures solved label-empty trajectories as trusted negatives and keeps failed or unknown label-empty trajectories unlabeled.
  Interrupted runs persist hash-chained observations and resume only when public inputs, model settings, local paths, and endpoint still match.
  Reports include pooled and per-case step-localization metrics, exact source-quote coverage, final-result availability, and imported runtime duration.
  External runner failures retain reported token, cost, duration, and metadata instead of becoming telemetry gaps.
  Public model runs use one structured model call over a bounded trace projection.
  A durable run-wide cost ledger enforces `--max-cost-usd` across concurrency and resume.
  Paid responses are cached under deterministic call ids before settlement, so resume neither loses a completed response nor creates a second reservation after interruption.
  Completed results retain a digest of every behavior-defining source file and are read through one strict recursive schema.
  The repository includes one pinned 32-case CodeTraceBench input, two complete 64-call GLM-5.2 Agent Eval runs, and a failure-inclusive run of pinned CodeTracer on the same trajectories.
  Exact source, input, result, resume, usage, cost, and secret-scan checks are committed with the results.
- The Python package gains a `dspy` extra: `agent-eval-rpc[dspy]` runs official `dspy.RLM` in a sandboxed Deno/Pyodide child process with seven allowlisted trace tools and strict JSON I/O.

### Changed

- **Breaking:** trace analysts are recursive research programs run through an explicit analysis engine.
  `analyzeTraces` requires an `engine` (the DSPy RLM engine is the primary implementation) and reports engine iterations; `maxTurns`, `maxSubqueries`, `onTurn`, and `AnalyzeTracesTurnSnapshot` are gone.
  `callLlmJson` remains only as the one-shot `direct` benchmark baseline.
- **Breaking:** `defineTraceAnalyst()` returns an inert `TraceAnalystDefinition` for registration instead of a registrable analyst, and no longer takes a `cost` declaration — analyst cost is always metered LLM usage.
  `createTraceAnalystKind` is now `createTraceAnalyst`; `TraceAnalystKindSpec` and `CreateTraceAnalystKindOpts` are replaced by `TraceAnalystDefinition`.
- **Breaking:** `BuildTraceAnalystSurfaceDispatchOptions.analyze` receives `instructions` instead of `actorDescription`.
- **Breaking:** `SteeringOptimizerBackend` narrows to `'pairwise'`.
- Citation verification is store-backed: cited trace and span ids must resolve in the trace analysis store, and encoded or foreign ids are rejected.
- External-optimizer subprocess calls fail on HTTP 200 responses with zero input and output usage, and on output over-reservation after recording the actual charge.
- Relative external-optimizer runner commands resolve against the caller's working directory instead of the child's temporary directory.

### Removed

- **Breaking:** the Ax analyst stack and the `@ax-llm/ax` dependency: `createAnalystAi`, `CreateAnalystAiConfig`, `structureFindings`, `StructureFindingsOptions`, `StructureFindingsResult`, `AxGepaSteeringOptimizer`, and `AxSteeringOptimizerConfig`.
- **Breaking:** `createPublicBenchmarkModelRunner`; the analyst benchmark CLI defaults to the DSPy RLM runner and keeps the one-shot runner as the explicit `direct` baseline.
- `buildTraceAnalystTools`; trace tools are built from the transport-neutral descriptors.

### Fixed

- Canonical `trace://<trace>/span/<span>` evidence is classified as span evidence instead of artifact evidence.
- Public model output selects positive integer assistant step ids.
  The runner builds canonical trace URIs and exact action excerpts from those spans, and rejects missing, non-assistant, or empty steps.
- Capped concurrent paid calls wait for active reservations to settle when their final spend may still fit.
  They fail immediately only when committed spend plus the next enforced maximum exceeds the run limit.
- Releasing a single-run lock now removes its process exit listener instead of leaking one callback per completed campaign.
- Phoenix evaluator tests use OpenTelemetry Core 2.10 instead of the vulnerable 1.x transitive dependency.
- CodeTracer prediction adapters accept the published schema and both flat and grouped step-label outputs emitted by CodeTracer 0.2.
- The CodeTraceBench model prompt now matches the public incorrect-step task by scoring wrong actions that are later recovered, instead of treating final task success as proof that earlier steps were correct.
- JSON-text finding rows reach the existing per-row schema repair instead of failing the entire trace analyst response.

## [0.137.0] - 2026-07-29 - trace analyst measurement and review integrity

### Added

- `CONTROL_INTEGRITY_ANALYST` checks existing `SupervisorRunSources` and `SupervisorRunTree` values for duplicate or detached identities, parent cycles, impossible event order, orphan terminal events, and steer request or acknowledgement mismatches.
  Missing transcripts, profile ids, worker logs, and declared tree gaps remain unavailable instead of becoming clean results.
- Trace analyst benchmarks now retain dataset revision, case and runner metadata, labeled issue recall, finding precision, critical-step accuracy, citation coverage, label-location agreement, actual location resolution, clean-case failures and false positives, repeat agreement, execution order, failures, latency, every reported token counter, and cost.
- Paired analyst comparisons average repetitions within independent cases before computing intervals and report both case and observation counts.
- Phoenix Evaluators and Braintrust Autoevals can run as campaign judges through structural adapters, without copying either scorer implementation.
- `defineTraceAnalyst()` provides the minimal custom analyst entry point and requires an explicit cost declaration.
- Reviewed analyst runs can become feedback trajectories while preserving findings, evidence, per-analyst status, trace references, and cost.
- AgentRx and CodeTraceBench label adapters load public step-localization and root-cause cases without imposing a trajectory format, and output translators score the maintained upstream engines directly.

### Changed

- Generated analyst findings become digest-bound review requests and cannot enter optimizer data until every finding has one explicit external decision.
- Every analyst run requires one independent completeness assessment before optimizer export.
  Optimizer quality is F1 over confirmed findings and independently identified misses, with precision, recall, F1, and counts retained in metadata.
- Trace analyst prompt optimization scores typed issue identity and exact evidence locations instead of matching phrases in generated prose.
- Analyst benchmarks use the upstream `linear-sum-assignment` implementation to maximize one-to-one label coverage and then critical-step localization, so duplicate predictions reduce precision and ambiguous findings are scored consistently.
- AgentRx evaluation targets its published root-cause task by default, accepts its maintained `failures` report shape, and treats `failure_case: 0` as a no-error prediction.
- CodeTraceBench uses its published incorrect-step labels by default; the combined incorrect-and-unuseful task must be selected explicitly.

### Fixed

- Phoenix and Autoevals model-backed judges now share campaign cancellation and paid-call accounting.
  They refuse unmetered execution, retain late provider receipts after cancellation, and reject incomplete token or cost capture.
- Analyst review requests and decisions bind to the canonical digest of one complete run, so decisions cannot be replayed across runs and repeated findings cannot collide in review queues.
- AgentRx category quality and root-step accuracy are scored independently; `traceAnalystQualityJudge` averages them when a root-step label exists.
- Analyst runner comparisons reject invalid confidence and resample controls instead of returning non-finite intervals.

## [0.136.0] - 2026-07-29 - preserve recursive evidence and complete profile changes

### Fixed

- The npm package pins `@tangle-network/agent-core` 0.4.28 and `@tangle-network/agent-interface` 0.39.0 as one compatible cohort.
  Profile-improvement experiments validate every existing `AgentProfileDiff` axis with the same schema that constructs those diffs.
- Recursive supervisor-run reports now join worker artifacts by optional stable `workerId`, falling back to `label` only for older stores.
  Retry and reaction counts are computed within each parent, so identical labels and settlements in separate branches no longer collide.
  Per-worker and steer rows expose the joined `workerId`; custom report consumers should read it instead of treating the display label as identity.
- Spawned invocations retain an explicit `supervisor` or `worker` role, and structured verdicts retain their numeric score in rollout rewards and per-worker report rows.
- Accepted-patch counts are unavailable when the source did not retain worker deliverables, even when a worker event claimed patch bytes.
- Manager and worker token totals have independent unavailable reasons, so an uncaptured channel is not reported as zero and a captured zero remains zero.
- Supervisor-run integrity checks share one typed source parse, correlate worker control rows by stable invocation id, and distinguish captured-empty control artifacts from missing artifacts.
- Claude Code child agents remain workers when they delegate, and steer counts use the original tool-use request id.
- Malformed journal and worker-control rows make dependent checks unavailable instead of producing missing-parent claims or clean zero counts.

### Breaking changes

- Custom `SupervisorRunSources` readers must add `managerTokens` and `workerTokens` to `SourceLimits`.
  Set each field to `null` only when that role's aggregate token channel is complete; otherwise set the reason it is unavailable.
  Readers with no source limitations can continue to use `NO_SOURCE_LIMITS`.
- `SupervisorRunTree.gaps` now contains typed `{ code, message, nodeId?, count? }` records instead of free-form strings.
- `WorkerLogFacts.steersQueued` and `steersDelivered` are now nullable.
  `null` means malformed, incomplete, or uncorrelated control rows prevent exact request-id accounting.

## [0.135.4] - 2026-07-29 - keep rich source evidence in one schema cohort

### Fixed

- The npm package pins `@tangle-network/agent-core` 0.4.26 and `@tangle-network/agent-interface` 0.37.0 as one compatible cohort.
  Candidate and profile-improvement contracts accept and retain licensed, attributed, noticed, and transformed public-source evidence without installing an older nested Interface schema.
- Packed-package verification installs the release archive into a fresh npm consumer and refuses duplicate or incorrect Core and Interface versions.

## [0.135.3] - 2026-07-29 - preserve real tool evidence for trace learning

### Added

- `toolSpansToTraceAnalysisStore()` converts captured runtime `ToolSpan` records into the canonical trace-analysis store without a Discovery-specific adapter.
- The adapter preserves run, trace, span, parent, tool, timing, input, output, error, and attribute evidence in one deterministic projection.

### Fixed

- Trace-analysis intake now refuses missing or structurally empty tool evidence explicitly instead of allowing an empty projection to masquerade as an observed trace.

## [0.135.2] - 2026-07-29 - correct paired promotion decisions

### Fixed

- Paired promotion paths now share one decision function.
  Binary outcomes use an interval that remains valid at the configured margin, plus an exact test.
  Continuous outcomes reject zero-width samples.
  This prevents real pass/fail gains and regressions from hiding at `[0, 0]`, and stops constant samples from being treated as certainty.
- `runRLCampaign()` now computes interim confidence only when the declared fraction of paired cells has usable scores on both arms.
  Failed runs count toward coverage, and `RLCampaignResult.deltaCoverage` reports every missing or unscored cell.

### Changed

- `sequential.minDeltaCoverage` defaults to `1`.
  Set a lower value explicitly when a campaign may accept incomplete paired results.
  Values outside `[0, 1]` throw.

## [0.135.1] - 2026-07-28 - stable estimated-cost receipts

### Fixed

- Token-priced receipts now tolerate the machine-precision difference introduced when per-million rates are persisted and replayed as per-thousand rates.
- Material disagreement between a receipt's estimated cost, token usage, and pricing snapshot still fails validation.

## [0.135.0] - 2026-07-28 - mint refuses what nobody measured

### Why a MINOR and not a patch

Two fields that MINTED on 0.134.2 now THROW: `terminalOutcome` and `outcome.raw`.
A caller on pre-0.126 records who upgrades will see `mintRolloutRows` stop producing
lines it produced yesterday, and that is the intended correction — but it is a
behaviour change, not a bug fix, so the number says so.
It is also **batch-fatal**: `mintRolloutRows` loops over `records` with no per-record
`try`/`catch` (`src/rollout/mint.ts:413-437`), so ONE legacy record throws out of the
whole call and no rows come back at all.
Partition the store first with `unmintableReasons(record)` — see the API note below —
rather than discovering this one record at a time.

### Consumer notice — minting a pre-0.126 RunRecord now names the field instead of crashing

`mintRolloutRows` reads `record.costProvenance.kind`.
That field was OPTIONAL through 0.125 — documented verbatim as "Optional only so
existing serialized RunRecords remain valid" — and became REQUIRED in 0.126, with
no on-disk migration and with the optional chain dropped in the same commit.
Every RunRecord a 0.125-era producer persisted therefore kills mint with
`TypeError: Cannot read properties of undefined (reading "kind")`, naming neither
the field nor the run.
It typechecks clean on the caller's side because the TYPE says required; the
RECORDS are simply older than the type.
Measured in one consumer repo: 65 of 65 ledgers, 2742 of 2742 records, 100 %
failure.

The same record is now refused by name, and the refusal spells the backfill —
verbatim, from the built package:

```
ValidationError: Cannot mint rollout for run run-0125-era: costProvenance is missing.
Records written before agent-eval 0.126 predate this field and carry `costUsd: 0` as
the documented uncaptured sentinel, which is NOT an observed zero. Backfill it as
costProvenance: { kind: 'uncaptured', usd: null } WITH costUsd: null — an uncaptured
cost whose costUsd is non-null is rejected by validateRunRecord, so provenance alone
leaves the record invalid.
  terminalOutcome is missing. It became required in agent-eval 0.126. Backfill it from
root-run or process evidence, or as 'unknown' when the producer has none — mint will
not decide the line's is_completed and is_truncated for you.
```

**Audit the rollout rows you already published.**
Restoring the 0.125 optional chain would have made mint run again AND restored a
false dollar figure, so it was not the fix.
Under `record.costProvenance?.kind === 'uncaptured'` an absent provenance evaluates
to `undefined === 'uncaptured'` → false, and the next line is
`cost: { usd: uncaptured ? null : record.costUsd }` — so every 0.125-era record
carrying the documented `costUsd: 0` uncaptured sentinel minted a line asserting
`cost.usd: 0`.
A rollout row whose `cost.usd` is `0` and whose source record was uncaptured **was
never a measured zero**: it is a cost nobody captured, published into a dataset as a
measurement.
Re-mint those rows from backfilled records, or drop the column — do not average over
them.

Four more fields on the same record fail the same way in the same forty lines, and
three of them fail silently:

- `outcome` and `tokenUsage` are dereferenced unguarded — the same `TypeError`, with the same missing field name.
- `terminalOutcome` (also newly required in 0.126) is safe on 0.134.2 only BY ACCIDENT: it is compared with `===` rather than dereferenced, so an absent value MINTS, as `is_completed: false, is_truncated: false, error: null` — three claims about how a run ended, made from no evidence.
- `outcome.raw` MINTS as `metrics: {}`, because `{ ...undefined }` spreads without complaint. "This run reported no metrics" is a different claim from "this record predates the field".
- `scenarioId` (also newly required in 0.126) reached `assertMinted` and threw a bare `Error` naming the LINE's empty `task.instance_id` — when the thing the caller has to fix is the RECORD.

**The mint door throws; it does not normalise.**
Normalising an absent `costProvenance` to `{kind: 'uncaptured', usd: null}` would be
kinder to historical data and it is still wrong, for two reasons that are visible in
the code.
It cannot cover the record, only part of it: `terminalOutcome` feeds `is_completed`
and `is_truncated`, which the rollout schema requires to be **boolean**, so there is
no null to fall back to and every possible default is a claim about how the run
ended.
And normalising the cost requires knowing what `costUsd: 0` meant — a genuinely free
run and an uncaptured one are the same bytes in a pre-0.126 record, and only the
producer can tell them apart.
That is the same guess the dropped optional chain was already making silently.
The backfill belongs at your store, in one pass, where `costUsd` can be corrected
alongside `costProvenance`; the refusal names the run, names **every** missing field
at once, and spells the value to write.

### Changed — behavior

- `mintRolloutRows` refuses a record missing any field the rollout line is built from, with a `ValidationError` naming the run and each missing field: `costProvenance`, `tokenUsage` (+ `.input`, `.output`), `outcome` (+ `.raw`), `terminalOutcome`, `scenarioId`.
  The check runs on the only constructor of a minted line, so the traced path and the untraced gap-line path are both covered.
  It runs **before** the existing task-score guard, which reads `record.outcome.searchScore` on its way to an answer and would otherwise `TypeError` from inside the guard that exists to produce a clean refusal.
- This is deliberately not `validateRunRecord`.
  That validator answers "is this a valid RunRecord", a wider question than "can a rollout line be built from this one" — it also enforces model-snapshot discipline and the `costUsd === costProvenance.usd` agreement, and routing the mint door through it would refuse records mint can mint honestly today.

### Changed — API (additive; no field changed meaning, none removed)

- `unmintableReasons(record): string[]` (new export) — why a record cannot be minted, one entry per missing field, empty when it can.
  Exported so a caller can partition a whole ledger without catching an exception per record, and without re-deriving the field list on their side: it is the same list the door refuses on, so the two cannot drift.

## [0.134.2] - 2026-07-28 - complete multishot cost accounting

### Fixed

- Multishot matrices now include conversation, code, and content judge calls in cell and run cost totals.
- Judge usage and cost survive malformed judge output, and unknown spend is marked explicitly.
- Matrix cost limits now stop new work based on combined simulation and judge spend.

## [0.134.1] - 2026-07-28 - complete comparison evidence

### Fixed

- `DescriptionLengthGate` now returns `missing_task_scores` instead of evaluating only the tasks both arms happened to score.
- `evaluateContract()` now fails when declared metrics are partially measured, under-sampled, or absent.
- `decideReferenceReplayPromotion()` now refuses comparisons built from different scenario identities or duplicate counts.

## [0.134.0] - 2026-07-28 - isolated proposal inputs

### Changed

- `runOptimization()` now accepts only findings labeled from search runs or observed production behavior.
- `ProposalFinding` carries the required `proposal_origin`.
- Removed opaque `report` and capture-store access from `ProposeContext`; final evaluation data has no internal path into candidate generation.
- Removed `assertNoJudgeVerdict`, `isJudgeVerdict`, and `isTraceObservable`; use validated `ProposalFinding` inputs instead.
- `runOptimization()` snapshots its baseline and candidate outputs before measurement.

## [0.133.3] - 2026-07-27 - trustworthy statistical decisions

### Consumer notice — reported p-values were too small in every release from 0.1.0 to 0.133.0

0.133.1 corrected the standard-normal CDF. This release carries the rest, and
restates the notice because the re-check bands and the affected version range are
what a consumer actually needs.

A standard-normal CDF mixed the arguments of the Abramowitz–Stegun error-function
approximation, giving up to `3.7189e-2` absolute CDF error where a correct
implementation is bounded by `7.5e-8`. Every p-value routed through it was too
small by 26–36 % relative, so the module's real type-I error rate was **6.53 % at
a nominal 5 %** and **1.34 % at a nominal 1 %**. The defect entered at the initial
commit (`7d5032b`, 2026-04-20) and shipped in every release through 0.133.0.

**Affected:** `mannWhitneyU`, `wilcoxonSignedRank`, `pairedTTest`, `welchsTTest`,
`compareToBaseline`, `mcnemarPower`.

**Unaffected** (verified numerically identical before and after, because they route
through the inverse normal rather than the forward CDF): `requiredSampleSize`,
`requiredPairedSampleSize`, `pairedMde`, `mcnemarRequiredN`, `mcnemar`,
`pairedSignTest`, `wilson`, `passAtK`, `corpusInterRaterAgreement`, `eProcess`,
`holm`, `ranks`, `pearsonR`, `spearmanR`, `cliffsDelta`, `pairedCohensDz`.

**How to re-check a decision you already made.** The error is monotone in `|z|`, so
the affected band is exact and narrow:

- Any recorded p in `[0.038053, 0.050000)` crossed a 5 % gate it should not have.
- At `α = 0.01` the band is `[0.007443, 0.010000)`; at `α = 0.10`, `[0.077398, 0.100000)`.
- A recorded p below `0.038053` was significant either way; at or above `0.05`, not
  significant either way. Neither needs re-checking.

Three further cautions, independent of the CDF:

- A `wilcoxonSignedRank` leg that reported `p = 1` on fewer than six non-zero
  differences measured nothing — the function hard-returned `p = 1` there with no
  flag. A clean 5-of-5 shift reported `1.0` where the exact answer is `0.0625`.
  Exact ties are dropped before ranking, so ten pairs with five tied deltas also
  fell into that branch. Re-run those on this release.
- A promotion that turned on a `pairedBootstrap` `low > 0` check below 20 pairs was
  never valid at the stated confidence: measured false-positive rate is 13.53 % at
  `n = 3` against a nominal 2.5 %. `gateEligible` now reports this.
- A bootstrap interval recorded through `analyze-runs.ts` at or before 0.133.0 is
  not reproducible — that call site passed no seed and `makeRng` fell back to
  `Math.random`.

Full evidence, per-statistic verdicts, and the dependency argument:
[`docs/design/statistics-decisions.md`](./docs/design/statistics-decisions.md).

### Consumer notice — `HeldOutGate` promoted candidates that scored nothing on most held-out items

Every release through 0.133.2 decided a promotion over the items where BOTH arms
produced a finite score, and dropped the rest without a word. An item the candidate
crashed on, timed out on, or wrote no row for simply left the comparison.

**Measured, deterministic fixture, no model calls:** 26 held-out items, a candidate
that produced no score at all on 20 of them and 0.95 on the 6 it answered against a
0.60 baseline. Published 0.133.2 and `origin/main` PROMOTE it at every threshold
from −0.05 to +0.30 — `productiveRuns: 6`, `unpairedBaselineRuns: 20` sitting in the
evidence, read by nothing. The control, the same 20 failures scored as the 0 they
earned, is correctly refused at a mean paired delta of −0.3808. An agent that failed
77 % of its tasks was promoted, and the paired-delta, overfit-gap and cost gates all
sat behind that filter.

A second shape, same cause: a crashed first attempt plus a scored retry at the same
`(experimentId, scenarioId, seed)` PROMOTED on 0.133.2, even though the gate's own
docstring says duplicate identities throw — the crashed row was filtered out before
the duplicate could be seen. It now throws, exactly as two scored rows already did.

**How to re-check a decision you already made.** Read `unpairedBaselineRuns` and
`unpairedCandidateRuns` on any recorded `GateDecision`: a nonzero value means the
verdict was computed over a subset. `productiveRuns` below the number of held-out
items you dealt means the same thing. Those promotions are not valid at the stated
threshold and should be re-run on this release.

### Fixed

- `HeldOutGate`'s cost median is taken over the rows that DECIDED the verdict — the
  matched pairs on both splits — instead of over every row the caller passed. The old
  population was a denominator nobody measured and was trivially movable: 48 rows tagged
  `dev` at \$0.0001, which the gate never scores, drag a real \$5.00/task candidate to a
  reported \$0.0001 and clear a \$1.00 `costPerTaskCeiling`. Measured on `origin/main`
  (2789970): 12 fully-covered items at \$5.00/task, ceiling \$1.00 — 0 pad rows rejects
  with `cost_ceiling`, 24 pad rows reports \$2.50005, 48 pad rows reports \$0.0001 and
  PROMOTES. The population is derived from the pairing rather than from a list of split
  tags, so there is no tag that sits outside the rule. On a comparison with no rows
  outside the two decided splits the reported number is unchanged.
- `HeldOutGate` requires COVERAGE before it decides anything: on both the search and
  the holdout split, `answered / dealt` must be at least the new `minCoverage`
  (default **1** — every item the comparison was dealt carries a real score on both
  arms), else it refuses with the new `incomplete_coverage` rejection code. The
  denominator is measured, not declared: it is what `pairRunRecords` reports when
  given every row of a split rather than only the scored ones, so an item counts as
  dealt because a row for it exists on at least one arm. The gate does not impute a
  value for a missing score — it does not know the failure value of the caller's
  metric, and a caller who does knows to write it onto the record before calling.
  `GateEvidence` gains `holdoutCoverage` and `searchCoverage` (`SplitCoverage`:
  `dealt`, `answered`, `unscoredPairs`, `candidateOnly`, `baselineOnly`, `coverage`),
  so a shrunken denominator can never be read without seeing it.
  Verified monotone against `origin/main` over 6000 randomised comparisons: on
  complete inputs the verdict, rejection code, CI and n are identical in 3000/3000
  cases; across both sweeps there are 0 cases where the new gate promotes something
  the old one refused.
- `regularizedIncompleteBeta` takes the mandatory symmetry branch `I_x(a,b) = 1 − I_{1−x}(b,a)`.
  `studentTCdf(0.005, 100)` returned `0.89152130` against a true `0.50198972`; a
  perfectly null paired result reported `p < 0.05`. This survived 0.133.1, which
  corrected the normal CDF but not the beta continued fraction beneath it, and
  0.133.2, which changed no statistics math.
- `mannWhitneyU` and `wilcoxonSignedRank` compute an EXACT conditional p by default
  inside the enumeration thresholds, conditioning on the observed tie pattern.
- `mannWhitneyU` chooses exact computation from bounded state and work estimates,
  so imbalanced designs such as 1 v 24 remain exact without admitting expensive
  balanced designs. Its automatic permutation seed is invariant to observation
  order and to swapping the two groups.
- Deleted `wilcoxonSignedRank`'s `n < 6` hard return of `{w: 0, p: 1}`.
- The asymptotic rank-test path applies the tie correction and the continuity
  correction; both were missing.
- `mannWhitneyU` and `wilcoxonSignedRank` reject non-finite input. A single `NaN`
  previously spun forever: the tie-grouping loop advanced on `===`, and
  `NaN === NaN` is false.
- `bonferroni` and `benjaminiHochberg` reject at the inclusive boundary (`p ≤ α`,
  `q ≤ fdr`), matching `holm`, and validate `alpha`/`fdr` and the p-value range.
  `bonferroni([0.0125]×4, 0.05)` returned all-false where `holm` returned all-true.
  BH q-values use R's `(n/rank)·p` form; `(p·n)/rank` lands one ULP above the
  boundary at `p = 0.05, n = 3`.
- `interRaterReliability` groups by (dimension, item) across judges. It was
  bucketing consecutive scores from the SAME judge, so it measured within-judge
  spread: two identical judges returned `−0.5` where the true α is `+1.0`.
- `mulberry32(0)` is its own stream. `seed | 0 || 0x9e3779b9` collapsed seed 0 onto
  the golden-ratio constant, so two runs a caller believed were independent
  replicates were the same run. Non-finite seeds now throw.
- Unseeded bootstraps derive their seed from the data instead of `Math.random`, so
  an interval is reproducible whether or not the caller passes a seed.
- `studentTCdf` uses the regularized incomplete beta for every finite degree of
  freedom. The deleted normal shortcut changed `df = 102, t = 1.98` from the true
  two-sided `p = 0.050398` to `0.047703`.
- At the default 95% confidence, campaign promotion decisions use an exact
  one-sided sign test from 6 through 19 paired observations and the bootstrap
  interval from 20 onward. Samples too small to attain the requested confidence
  remain inconclusive.
- Prior-period reports use the shared Welch implementation. Zero-variance and
  under-sized comparisons carry an explicit status and null inferential fields
  instead of fabricated `p = 1`, `d = 0`, and a zero-width interval.

### Changed — BREAKING

- `mannWhitneyU(a, b, opts?)` returns `{ u, uA, p, method, pFloor }`. `p` is now the
  exact conditional p inside the threshold: `mannWhitneyU([1,2,3],[4,5,6]).p` moves
  from `0.03769147` to `0.10000000`, which is the smallest p attainable at 3 v 3.
  `uA` carries the direction that `u = min(u₁,u₂)` discards.
- `wilcoxonSignedRank(before, after, opts?)` returns
  `{ w, p, method, pFloor, nNonZero }`.
- Both take `method: 'auto' | 'exact' | 'asymptotic'`, default `'auto'`. `'auto'`
  never selects `'asymptotic'`. Requesting `'asymptotic'` where an exact answer
  exists THROWS a `ValidationError` naming the attainable floor, and requesting
  `'exact'` above the threshold throws rather than enumerating an unbounded
  distribution.
- `pairedTTest` returns `{ t: number | null, df, p: number | null }`. A non-zero
  constant delta returned `{t: Infinity, p: 0}` — absolute certainty from three
  observations — and now returns null, matching `pairedCohensDz`. An all-zero delta
  is still `{t: 0, p: 1}`.
- `cohensD` returns `number | null`. It returned a silent `0` for a maximal
  zero-variance separation and for under-sized groups.
- `MetricVerdict.cohensD` and `LiftInsight.pValue` are nullable accordingly.
- `PairedBootstrapResult` carries `gateEligible`, false below
  `BOOTSTRAP_GATE_MIN_N = 20`.
- `welchsTTest` returns a status-tagged full result with means, delta, standard
  error, degrees of freedom, Student-t interval, p-value, and Cohen's d.
- Prior-period `MetricDelta` values carry the same status. Invalid inference has
  null `ci95`, `pValue`, and `cohensD`, and the comparison lists those metric
  names in `inconclusiveMetrics`.

### Added

- `scripts/generate-statistics-oracle.py` + `tests/fixtures/statistics-oracle.json`:
  154 scipy/statsmodels-generated golden values across 22 statistics, asserted by
  `tests/statistics-oracle.test.ts`. scipy is a CI oracle and is never a runtime
  dependency.
- `tests/statistics-library-crosscheck.test.ts` cross-checks untied exact null
  distributions against `lib-r-math.js`. Multiple-comparison functions are pinned
  to statsmodels-generated fixture values; `@stdlib/stats-padjust` was removed.
- First test coverage for `welchsTTest` / `compareToBaseline`, which gated
  improved / regressed / stable verdicts with nothing asserting their numbers.
- Exported `normalCdf`, `studentTCdf`, `BOOTSTRAP_GATE_MIN_N`,
  `MANN_WHITNEY_EXACT_MAX_STATES`, `MANN_WHITNEY_EXACT_MAX_WORK`,
  `WILCOXON_EXACT_MAX_N`, `DEFAULT_PERMUTATIONS`, and `pairedDeltaTest`.

### Trusted-head recovery

#### Fixed

- A trusted-head pin write that fails after its journal row is already durable no longer leaves that row permanently unpinned.
  Retrying the same `eventId` moves the pin up to the acknowledged entry when the entry is ahead of the pin, so the last row of a ledger — the promotion decision — cannot be truncated away undetected after a full disk or a read-only mount.
- A pin whose journal was deleted or rebuilt is recoverable instead of refusing every later append and replay forever.
  The refusal still stands, since a missing journal beside a live pin is the deletion the pin exists to catch, but it now names the sidecar file and the operation that resolves it.
- Trusted-head read and write faults are reported through the journal codec's error taxonomy instead of escaping as raw Node filesystem errors.

#### Added

- `clearTrustedHeadFile`, exposed as `FileLedgerJournal.clearTrustedHead()` and `SearchLedger.clearTrustedHead()`, discards a pin and returns the guarantee it gave up.
- `SearchLedger.pinTrustedHead()`, the campaign-level route to adopting a pin for a ledger that has none.
- `readTrustedHeadFile` is exported from `@tangle-network/agent-eval/ledger-core`, so a consumer of `verifyEntriesAgainstTrustedHead` has a shape-validating way to load a pin.

#### Changed

- **Breaking:** `verifyEntriesAgainstTrustedHead` takes `{ subject, trustedHeadPath }` as its fourth argument instead of a bare `subject` string, so every refusal can name the sidecar file. Passing the old string throws a `TypeError`.
- **Breaking:** `SearchLedger` declares `pinTrustedHead` and `clearTrustedHead`; an external implementation of the interface must supply them.

## [0.133.2] - 2026-07-27 - protect final evaluation data

### Fixed

- Disabled labeled-store capture for deferred, baseline, winner, and neutralized final-evaluation campaigns.
  Search baseline and candidate campaigns continue to populate optimization data, while final cases remain unavailable to later proposal rounds.
- Deferred OpenCode's SQLite dependency loading until a reader opens the database, so importing rollout readers remains safe in runtimes without Node's native module loader.
- Rejected non-finite and zero-width paired intervals before threshold comparison, preventing tie-pinned regressions from clearing negative promotion thresholds.

## [0.133.1] - 2026-07-27 - correct asymptotic statistics

### Fixed

- Corrected the standard normal CDF used by the normal-approximation paths for Mann-Whitney, Wilcoxon, McNemar power, paired t, and Welch t calculations.
  A z-score of 1.96 now yields a two-sided p-value of approximately 0.05 instead of 0.038.
- Removed duplicate normal and Student-t implementations so every caller uses the same internal functions.

## [0.133.0] - 2026-07-27 - remove unused belief-state API

### Removed

- Removed `@tangle-network/agent-eval/belief-state`, which had no producers or consumers.
  Use `@tangle-network/agent-eval/rl` for off-policy analysis and `@tangle-network/agent-eval/meta-eval` for calibration.

## [0.132.0] - 2026-07-27 - sealed profile improvement execution

### Added

- Paired profile-improvement measurements now reserve their complete signed spend before dispatch, retain observed versus estimated cost provenance, and record separate preparation, measurement, and total accounting.
- Profile-improvement experiments and receipts bind the runner that performed the measurement, so a later activation can require the same runner evidence.

## [0.131.1] - 2026-07-27 - worker-safe profile cells

### Added

- `@tangle-network/agent-eval/profile-cell` exports the portable agent-profile identity API without importing local transcript readers or Node-only SQLite support.

## [0.131.0] - 2026-07-27 - profile improvement measurements

### Added

- Profile improvement measurement contracts in `/contract` that seal an exact profile diff and held-out task set, execute paired host-owned cells, and recompute the published score, uncertainty, cost, latency, and decision from complete receipts.

### Fixed

- `maxConcurrency` now limits individual host executions across both experiment arms.
- A failed or cancelled execution stops new work, cancels active siblings, and settles them before returning.
- Final sufficiency uses the observed paired interval instead of a conservative baseline-only planning estimate.

## [0.130.1] - 2026-07-26 - safe DSPy disk caching

### Fixed

- `DspyJudgeMetric` now rejects DSPy's unrestricted disk-cache pickle mode at construction and on every metric call.
- Configure DSPy's official restricted cache with `dspy.configure_cache(restrict_pickle=True)`, or disable disk caching before creating the metric.

## [0.130.0] - 2026-07-26 - current dependency and build cohort

### Changed

- Updated Agent Core to `0.4.24` and Agent Interface to `0.35.0`.
- Updated TypeScript to `7.0.2` and replaced the unsupported declaration build with `tsdown`.
- Replaced the TypeScript compiler import in the score derivation source check with `oxc-parser`.
- Updated GitHub Actions to their current stable major releases.

### Fixed

- Release checks now validate package metadata and every ESM and bundler type entrypoint before publish.
- Removed two obsolete declaration build scripts and stale release instructions.

## [0.129.0] - 2026-07-25 - provider-neutral chat and canonical rollout training

### Changed

- **Breaking:** benchmark, driver, executor, judge, completion-checker, tracing, and analyst APIs now accept `ChatClient`.
- **Breaking:** removed the exported provider SDK type, direct provider SDK dependency, provider-specific retry fields, and custom completion-checker error receipt callback.
- **Breaking:** `LlmClientOptions.maximumAttempts` replaces the misleading `maxRetries` name, which already represented total attempts.
- **Breaking:** `toGrpoRows`, `toSftRows`, `extractPreferences`, and `buildRlDataset` accept only `MintedRolloutLine[]`.
  Convert run records once with `mintRolloutRows`.
- **Breaking:** removed `rolloutReward`, record-input training overloads, record-only reward hooks, duplicate line lookup and preference option types, and the duplicate dataset split map.
- **Breaking:** removed scalar belief-state and off-policy `qHat` fields; contextual estimates require `qHatChosen` and `vHatTarget` together.
- **Breaking:** removed `CampaignAggregates.totalCostUsd`, `CostLedgerEntry`, `VerifiableReward.breakdown`, and the fixed-prompt `JudgeFn` factories.
- **Breaking:** removed the unused `OptimizationProposer` alias; use `SurfaceProposer`.
- **Breaking:** `CampaignStorage.append` is required; read/write-only storage adapters are no longer accepted.
- **Breaking:** `RawAnalystFinding` now has one plural `evidence` field.
  Removed the duplicate `CanonicalRawAnalystFinding` names, singular-evidence adapters, the second
  recovery callback, `AnalystRunSummary.cost_usd`, and finding-metadata cost accounting.
- Paid calls read canonical `ChatResponse.content`, usage, model, duration, and cost.
- Cost reservations derive provider retries from `ChatClient.maximumAttempts`; capped calls reject clients that do not declare a finite attempt count.
- `createChatClient({ transport: 'custom' })` adapts external SDKs and transports without importing them into Agent Eval.
- Updated Agent Core to `0.4.22` and Agent Interface to `0.34.0`.
- No compatibility aliases, overloads, environment fallbacks, or alternate readers preserve these
  removed fields and functions.
- Settled cost events accept one current receipt shape, and execution summaries read only
  `outcome.raw.execution_error_count`.
- Single-run locks accept only structured owner records; plain-PID lock files are rejected.

### Fixed

- **A run flagged as gamed exported at full positive reward through every RL path.** The realness gate
  (`outcome.realness.gated`) existed in exactly one function, `rolloutReward`, called from exactly one
  place — `mintRolloutRows`. The same derivation, `outcome.holdoutScore ?? outcome.searchScore`, was
  hand-rolled at 20 other sites with no gate. Six of those sites feed exported training data: the GRPO
  default reward and the SFT row metadata (`rl/exporters.ts`), the DPO preference ordering
  (`rl/preferences.ts`), the probabilistic verifiable-reward fallback (`rl/verifiable-reward.ts`), the
  corpus `minScore` filter (`rl/corpus.ts`), and the published datasheet's reward statistics
  (`rl/dataset.ts`). A gamed run therefore trained at its claimed score, and in DPO it became the
  *chosen* side of a pair against its honest sibling. Every one of those six now derives its reward
  through the gate.

### Added

- `trainingScore`, `trainingReward`, `observedScore`, `isRealnessGated`, and the `ScorePreference`
  type — the score derivation now lives once, in `src/rollout/reward.ts`, behind two names that force
  the caller to state intent. `trainingScore` / `trainingReward` are gated and required for anything a
  trainer or an exported dataset consumes; `observedScore` is raw and documented as unsafe for
  training data. Raw is a legitimate choice — reward-hack detection, scorecards, and curriculum
  allocation need the ungated number, and gating a detector's proxy would make it report "clean" on
  precisely the population being gamed — so the fix names the choice rather than removing it.
- A regression test (`src/rollout/reward-invariant.test.ts`) with two halves: a source-level check that
  the bare derivation appears nowhere outside `rollout/reward.ts`, and a behavioural check that pushes
  one gated record with a 0.95 score through mint, GRPO, SFT, DPO, verifiable reward, the dataset
  bundle, and the corpus filter, asserting 0 in each. Against the pre-fix tree the source check reports
  21 offending lines and 7 of the 10 tests fail.

### Changed

- `rolloutReward` was removed.
  Use `trainingReward` for score derivation or `rolloutRewardFields` when producing a rollout outcome.
- The 14 analysis, reporting, and detection sites that legitimately want the raw number now call
  `observedScore` explicitly. Behaviour is unchanged at all 14, including the two sites that
  deliberately prefer the search split (`rl/active-curriculum.ts`, via the new `ScorePreference`
  argument). (`description-length-gate.ts` reads through `runTaskScore`, which 0.127.0 stripped of
  its obsolete `raw.score` fallback.)

### Fixed — second pass (the waist now enforces its own invariant)

An adversarial review of the pass above found the hole still open on 13 paths. Its core finding:
`validateRolloutLine({outcome: {reward: 0.95, realness_gated: true}})` returned **zero errors**. It
type-checked `reward` and it type-checked `realness_gated`, and never once checked the RELATIONSHIP
between them. `RolloutLine` was a plain structural interface, so any object literal of that shape WAS
one — "the input is a rollout line" guaranteed nothing, and the ledger round-tripped a poisoned line
unchanged.

- **The invariant now lives in the validator.** `validateRolloutLine` / `assertRolloutLine` reject
  `reward > 0` together with `realness_gated: true`, with an error that explains the rule rather than
  naming the fields. Because `writeRolloutLedger` and `readRolloutLedger` both assert, a poisoned line
  can neither enter a ledger nor leave one — which closes the published-CLI path (`agent-eval
  rollout-release`) at its entrance: `buildHfDataset` reads through `readRolloutLedger`, so the gated
  line is refused before `verifiers/train.jsonl` and `rft/train.jsonl` are written. The dataset card's
  claim about the flag was a **false claim on a published artifact** until now; it is now enforced, and
  the card states the count of gated lines it shipped.
- **And in the type system.** `MintedRolloutLine` brands the line with a phantom `unique symbol`
  (nothing at runtime, identical JSON). It is produced only by `mintRolloutRows`, `readRolloutLedger`,
  or an explicit `assertMinted` / `assertMintedLines`. The training exporters now require it:
  `rollout/exporters` (`toSftRows`, `toRewardRows`, `toVerifiersRolloutOutput(s)`, `toRftItem(s)`),
  `rl/exporters` (`toGrpoRows`, `toSftRows`, `PrmLineContext.lines`), `rl/preferences.extractPreferences`,
  and `rl/dataset.buildRlDataset`. Belt and braces on purpose: the brand closes first-party call sites
  at compile time, the validator closes data arriving at runtime.
- **The regex guard is replaced, not extended.** `src/rollout/score-derivation-guard.ts` walks the
  TypeScript AST of `src/**` and flags every READ of `outcome.holdoutScore` / `outcome.searchScore`
  outside a *counted* allowlist (writes and declarations are untouched). The old line regex caught 2 of
  the 7 re-derivations the review planted; the AST rule catches all 7, and they are kept as a permanent
  fixture in `reward-invariant.test.ts` rather than a one-time demonstration.
- **`supervisorRunRolloutLines` was a second minting door**, writing `outcome.reward` from the judge
  score and omitting `realness_gated` entirely. It now states the flag explicitly on every supervisor
  and worker row, and its rows are plain `RolloutLine`s — a caller putting them into a training export
  has to run them through `assertMinted` first.
- **`EvalTraceStore.getBest` ranked few-shot exemplars on the ungated score** while its doc comment
  claimed otherwise. `runScore` is now gated, and `getBest` drops realness-gated runs outright instead
  of ranking them: whatever it returns is pasted into the next agent's prompt as an example to imitate,
  so the SFT rule applies. When every run for a scenario is gated the answer is `null`, not the
  least-bad fake.
- **`release-confidence.passRate` counted a gamed run as a pass.** Gated runs are now excluded from
  both numerator and denominator, and the count ships beside the rate as `metrics.realnessGatedRuns`.
  `HeldOutGate` gets the same treatment: gated runs are dropped from both sides before pairing, with
  `evidence.realnessGatedRuns` surfacing how many. Never a silent 0 — a shrunken denominator has to say
  by how much.
- **Ten remaining hand-rolled derivations routed by classification**: `rl/sim-fidelity.ts` (×2, RAW —
  gating a sim-vs-production divergence measure would report the simulator as more faithful precisely
  where it is gamed), `belief-state/code-agent-corpus.ts` (GATED — its output becomes corpus labels),
  `eval-trace-store.ts` (GATED, above), `contract/analyze-runs.ts` (×3, RAW), `summary-report.ts` (×4,
  RAW), `release-confidence.ts` (RAW), `held-out-gate.ts` (RAW, over an already-degated set).
- **`trainingReward` no longer collapses an unscored record to 0.** It returns `reward: null`, matching
  the schema's own "a labeled gap, never 0" rule; a gated run still returns 0, because that IS a
  verdict. Previously a run nobody graded was indistinguishable from one graded a total failure.

### Fixed — the published dataset (`agent-eval rollout-release`)

- **The card's gate claim is no longer a sentence; it is a rendering of measured counts.** A README that
  STATES what the build does is a claim about bytes it never reads, and it drifts the moment an exporter
  changes — to whoever downloads the dataset. `buildHfDataset` now exports the rows for every selected
  format, measures the realness-gated rows among them (`measureFormatGate`, matched on `rollout_id`),
  checks the measurement against the declared per-format policy, and only then writes. `buildDatasetCard`
  requires that report, renders it, and **throws** if it disagrees with the lines it describes or with the
  policy. A card that contradicts its own data files cannot be produced without failing the build first.
  The measurement also ships on `BuildSummary.gate` and in the CLI's stdout JSON.
- **Nothing is written when any config would ship a gated row above reward 0.** Formats used to be
  exported and written one at a time; a build that failed halfway left a poisoned config on disk for
  someone to `--push`. Rows are now computed and gate-checked for every format before the first byte.
- **The per-format decision is stated once as data**, in `src/rollout/release/gate-report.ts`:
  `sft: 'exclude'` (an SFT row is imitated verbatim — a gamed trajectory must not appear at any weight),
  `verifiers` / `rft` / `raw`: `'zero-and-flag'`. Keeping gated rows in the last three is deliberate: in
  `verifiers` the reward is a signed learning signal, so a gamed trajectory at reward 0 is a correct
  negative, and dropping it would bias the negative population toward honest failures and leave a trainer
  no example of gaming being penalized; `rft` re-samples the completion, so only the prompt and the grader
  reference ship; `raw` is an audit dump, where the gated row is the one an auditor most wants.
- **Reward 0 is never the only label.** Zeroing without the flag makes a faked success indistinguishable
  from an honest failure — it hides the gamed population instead of disclosing it. `VerifiersRolloutOutput.
  info.realness_gated`, `RftItem.reference.realness_gated`, and `RewardRow.metadata.realness_gated` are new
  and always present, so a consumer can filter the population out or select it for a gaming detector.

### Fixed — Harbor ATIF interchange (`src/rollout/interchange/harbor.ts`)

- **Export emitted documents that violate ATIF MUST rule 2.** Tool results were folded into the
  `observation` of whichever step happened to PRECEDE them, so an assistant turn that declared no tool
  calls could carry a `source_call_id`, a result could be attached to a step that declared a different
  call, and an unanswered result rode a synthetic `system` step carrying a `source_call_id` a system
  step can never declare. Results now attach only to the step that declared their `tool_call_id`;
  everything else becomes a carrier step whose observation states no call id and escrows it instead.
  Message order is preserved exactly in every case, and `ruleTwoViolations` checks the whole tree in
  the tests.
- **`logprobs`, `prompt_token_ids`, `completion_token_ids` and per-step `llm_call_count` were adopted
  onto our types but never wired through the interchange.** They were escrowed under
  `extra.tangle.spans`, where no foreign consumer looks, and ATIF's own `step.metrics` /
  `step.llm_call_count` were left empty in both directions — so a Harbor-native file's logprobs were
  read, validated, and dropped. They now travel on the native channel both ways (escrow still wins on
  import for exactness); a step carrying none of them still produces no span.
- **`session_id` was invocation-scoped.** ATIF's `session_id` is RUN-scoped; export set it to the root
  LINE's `rollout_id`, so two roots of one run got different session ids and foreign tooling grouping
  by session split the run. It is now `run_id`, on every node.
- **`is_copied_context` (RFC rule 7) was silently dropped on import.** It is now a field on
  `ChatMessage`, validated, carried both ways on ATIF's native step field, and — the part the RFC
  actually mandates — `toSftRows` excludes those turns, dropping the row entirely if nothing else is
  left.
- **An escrowed split was trusted from any document.** `extra.tangle.task.split: 'search'` in a
  hand-written or third-party file imported as a TRAINABLE split; the escrow key is namespaced, not
  authenticated. Import now forces `holdout` unconditionally, and promotion is an explicit, greppable
  step (`relabelImportedSplit`) so `grep` enumerates every place foreign data was declared trainable.
- **Round-tripping was not idempotent.** `provenance.gap` accreted one copy of the import note per
  pass, and imported messages were assembled in an order that depended on which optional fields were
  present, so a ledger hashed on serialized bytes saw a diff. The gap is now composed as a
  de-duplicated ordered set and every imported message is built in the canonical schema key order.
- **The interchange was not root-exported.** `import { toHarborTrajectory } from
  '@tangle-network/agent-eval'` failed — the symbols existed only on the `/rollout` subpath while every
  other rollout symbol was on both.
- **The reward-absence test was a substring scan.** `expect(serialized).not.toContain('reward')` passed
  only because the fixture happened to have no reward-shaped key in `outcome.metrics`; it says nothing
  about WHERE a match is and false-positives on any metric named e.g. `reward_hack_rate`. It is now a
  structural walk that reports the PATH of every label-shaped key, exempting the escrowed metrics bag
  by path.

### Known gap (not fixed here)

- `mintRolloutRows` hardcodes `tool_defs: []`, so `agent.tool_definitions` is absent on every minted
  line's ATIF export. This is a capture-side gap, not an interchange one: neither `RunRecord` nor the
  trace-span projection carries a tool schema, so there is nothing for mint to read. Fixing it means
  recording the harness's tool definitions at capture time.

### Fixed — unrelated flake encountered on the way

- `node:sqlite` is loaded through `createRequire` in `rollout/readers/opencode-sqlite.ts` and its test.
  esbuild and Vite both rewrite an `import()` of a builtin and strip the `node:` prefix, producing a bogus
  `sqlite` package lookup; composing the specifier at runtime did not reliably defeat it, so the failure
  moved between workers whenever a test file was added. A require obtained from `createRequire` is not an
  analyzable module reference in either tool.

### Added — second pass

- `MintedRolloutLine`, `MintedRolloutOutcome`, `assertMinted`, `assertMintedLines` (rollout barrel +
  root barrel).
- `observedSplitScore` (the raw score on ONE split, no cross-split fallback — what every split-scoped
  report and promotion gate actually wants) and `scoreOrigin` / `ScoreOrigin` (which split carried the
  score, or that none did — the provenance `reward_source` is built from).
- `malformedRolloutLine` in `rollout/fixtures` for tests whose subject is the validator itself;
  `fixtureRolloutLine` now validates on every construction and returns a `MintedRolloutLine`.
- `rollout/release/gate-report`: `FORMAT_GATE_DISPOSITION`, `GateDisposition`, `GateReport`,
  `FormatGateCounts`, `ReleaseRowRef`, `gatedRolloutIds`, `releaseRowRefs`, `measureFormatGate`,
  `assertGateReport` (rollout barrel). `BuildSummary.gate` and `DatasetCardInputs.gate` are new;
  `DatasetCardInputs.gate` is required, so a card cannot be rendered without the measurement.

### Fixed — third pass (one canonical training input)

Trainer-facing APIs now accept canonical minted lines only.
Artifacts that carry run ids without embedded reward state still require explicit line context.

- **Record-input preference and trainer overloads were removed.**
  Their custom reward hooks and independent filtering rules created alternate paths around the canonical rollout checks.
  Callers now mint once and every downstream transform reads the same reward and split fields.
- **`extractVerifiableRewardsFromRecords` gated only its judge-fallback branch.** The deterministic
  branch — the highest-credibility channel the module emits, `determinism: 'deterministic'`,
  `confidence: 1`, and what the module header calls "the RL training signal" — returned the layer
  score untouched, so a gated run carrying `outcome.raw['layer.test'] = 1.0` exported at value 1 and
  `filterDeterministicallyRewarded` kept it. That is exactly the shape of a reward-hacked coding run:
  `realness.gated` means the success signal was faked, and a test suite reporting green on a stubbed
  integration IS the deterministic layer being the thing that got faked. The gate applies to that
  channel most, not least. `value` and every `components` entry are now 0 on a gated run — zeroing
  `value` alone would let a consumer re-weighting per source reconstruct the refused reward — and the
  new `VerifiableReward.realnessGated` distinguishes "measured a genuine failure" from "claimed a
  success we refuse to believe", which a bare 0 cannot.
- **`toPrmRows(triples, lookups)` — the deprecated 2-arg form — applied no gate and now fails
  closed.** A `PrmTrainingTriple` carries a bare `chosenReward` number, so without the minted lines
  the exporter has no way to learn that its chosen step belongs to a run that faked its success; the
  rows it produced trained a process-reward model to prefer the gaming move at the exact step the
  gaming happened. The overload is removed (TypeScript callers fail to compile) and the runtime
  throws for everyone else.
- **`supervisorRunRolloutLines` no longer writes the reward pair by hand.** `reward` and
  `realness_gated` come out of one call in the module that owns the gate — `rolloutRewardFields` for
  `mintRolloutRows`, `unscreenedRewardFields` for a producer with a score but no `RunRecord` behind
  it. Two minting doors is the same class of defect as two reward derivations; there is now one
  writer of the pair, so a future third door cannot state one field and forget the other.
- **`EvalTraceStore.compareRuns` counted a gamed run as a silent zero.** Gating `runScore` (second
  pass, above) fixed few-shot seeding and quietly changed this: a gamed run entered the paired
  comparison at 0, which reads as "this candidate failed the scenario" when what happened is "this
  candidate's result is not evidence". Gated runs are now excluded and counted in
  `CandidateComparison.realnessGatedRuns` — the same never-a-silent-0 rule `passRate` follows.

#### Deliberately NOT gated

`rl/reward-hacking.ts` reads the deterministic reward through the new
`VerifiableRewardExtractionOptions.applyRealnessGate: false`, which preserves its previous behaviour
exactly. Its `judge_drift` and `reward_disagreement` signals measure the GAP between the judge reward
and the deterministic one; a deterministic reward another gate already forced to 0 opens that gap by
construction on the gamed population, so the detector would fire on its own input rather than on
evidence it found. Same reasoning as its ungated `DEFAULT_PROXY`. The option defaults to `true` and an
empty options object gates — the opt-out is explicit and greppable.

### Known, not fixed here

- `description-length-gate.ts` gives a gated run claiming `score: 1.0` the largest possible improvement
  to its objective, and `product-benchmark/export.ts` publishes a gated run with `pass: true`. Each
  site carries a comment naming the hole.
- `extractVerifiableReward(report)` — the `VerificationReport` signature — cannot gate and does not
  claim to: `realness` lives on the `RunRecord`, not on the report. Documented on the function.

## [0.128.2] - 2026-07-25 - current core contract

### Changed

- Require `@tangle-network/agent-core` 0.4.21 so Eval cannot retain Interface 0.32 through an existing lockfile.

## [0.128.1] - 2026-07-25 - certified context contract

### Changed

- Require `@tangle-network/agent-interface` 0.33.0 so Eval, Knowledge, and Runtime use one certified context contract.

## [0.128.0] - 2026-07-25 - canonical task failure evidence

### Changed

- Both OTel run-record import paths read `tangle.task.failure_class` and `tangle.task.failure_mode` from process roots.
- Invalid or conflicting root labels fail loudly, and child-span labels cannot become task failures.
- `failureMode` is valid only as detail under a non-success `failureClass`.
- Product benchmark rows expose canonical `failureClass` plus optional `failureDetail`; failed rows cannot omit classification.
- `InsightReport.failureClasses` replaces `failureModes`; each row exposes `failureClass`, `count`, and `share`.
- `ReleaseConfidenceMetrics.failureClassCounts` replaces `failureModeCounts`, and direct trace evidence accepts canonical `failureClass` instead of free-form `failureMode`.
- Analysis and release decisions validate every `RunRecord`; campaign projections validate before returning.
- `selfImprove()` uses the concrete model from paid-call receipts, or the new `model` option for unmetered agents, instead of writing a fabricated campaign model.
- Failed control stop decisions can supply a canonical failure class that is preserved in the result.
- A control stop that omits `pass` is recorded as a failed task with an `unknown` class.

## [0.127.0] - 2026-07-25 - explicit run evidence and truthful release checks

### Changed

- Execution reports now separate runs with execution errors from explicit terminal outcomes.
- `RunRecord` now requires `scenarioId`, `terminalOutcome`, and `costProvenance`.
- Uncaptured cost is represented as `costUsd: null` with `{ kind: 'uncaptured', usd: null }`; it is never converted to zero.
- `ExecutionInsight.failures` is replaced by `executionErrors` and `terminalOutcomes`; report renderers must label these independently.
- `RunRecord.terminalOutcome` records `succeeded`, `failed`, `cancelled`, `incomplete`, or `unknown` only from root-run or process evidence.
- `executionErrors.byTerminalOutcome` cross-tabulates reported errors, reported zeroes, and missing error telemetry without asserting recovery causality.
- `executionErrors.fraction` is `null` when no run supplies error telemetry instead of reporting a false zero rate.
- OTel and code-agent intake count tool, model, and child-agent failures as execution errors while keeping process, guardrail, evaluator, propagated parent, and unknown errors in separate raw counters.
- OTel trace analysis preserves `EVALUATOR` as a distinct span kind instead of reducing it to `UNKNOWN`.
- Execution-only `RunRecord` rows may omit both task scores; OTel and code-agent intake no longer derive task quality from internal errors or process telemetry.
- Rollout, RL corpus, product-benchmark, and release-confidence paths no longer convert missing task scores into zero-quality labels.
- Held-out promotion now rejects missing search or holdout evidence explicitly, and public statistics use `null` instead of fake zero or `NaN` values when no measurement exists.
- Run comparisons now pair only on `(experimentId, scenarioId, seed)`, reject missing or duplicate identities, report unmatched rows, and never fall back to input order.
- Trace ranking ignores unlabeled execution rows without dropping them from storage.
- `MultiLayerVerifier.taskScore` is present only for a complete scoring panel; partial blends remain diagnostic, and errored or timed-out layers cannot become task or training labels.
- RL exports require trainable rows: SFT is the safe default, GRPO must be requested and needs at least two rewarded completions per group, unscored trajectories require explicit SFT opt-in, and requested empty formats fail loudly.
- RL and rollout training exports use only the `search` split by default.
- `dev` remains evaluation-only, and held-out training requires `allowHeldOutTrainingData: true`.
- Minted rollout terminal fields now reflect `RunRecord.terminalOutcome`, and SFT excludes failed, cancelled, incomplete, and unknown-terminal runs.
- Release confidence reports quality and reliability separately; terminal process failure no longer becomes a low task-quality score, and missing measurements remain `null`.
- Cost-bounded held-out and release decisions reject incomplete cost evidence instead of treating uncaptured cost as zero.
- Release confidence uses run rows as the primary source for cost, latency, and pass rate, avoiding duplicate aggregation from trace summaries.
- Campaign, profile-matrix, and self-improvement projections now share one mapper that records explicit terminal outcomes, execution-error counts, actual token usage, and unlabeled error cells.
- Hosted campaign snapshots omit failed judge dimensions rather than publishing invalid values.
- Hosted clients and the reference receiver validate complete request payloads, reject header/body version disagreement, scope retry keys by endpoint, and merge incremental generation snapshots without losing earlier generations.
- Hosted trace timestamps are exact base-10 strings so JSON cannot truncate OTLP nanoseconds.
- Rollout rows require experiment and candidate keys plus `outcome.realness_gated`; the obsolete `train` split and `ROLLOUT_FORMAT` alias were removed.
- Paired reports use within-pair Cohen's dz and paired sample-size calculations.
- Hosted ingest now emits wire version `2026-07-24.v1`; cells carry terminal outcomes and execution-error counts, missing task scores are `null`, and old aggregate reports must be recomputed from their original run rows because the former mixed failure count cannot be migrated losslessly.
- `GateResult.contributingGates` now records `pass`, `fail`, or `not_evaluated` instead of a boolean that could not distinguish missing evidence from failure.
- `defaultProductionGate` enables reward-hacking and canary monitoring independently through `rewardHacking` and `canary`.
- Canary reports identify which enabled detectors had enough observations to run.
- Loop provenance rejects obsolete boolean contributions instead of accepting a record whose runtime shape contradicts its TypeScript type.

### Fixed

- Missing or insufficient evidence remains `not_evaluated`; required unevaluated checks hold the release decision separately.
- Valid run histories without independent truth observations or usable canary metadata cannot produce successful monitoring checks.
- Empty critical-dimension configuration, incomplete cost accounting, unsupported red-team cases, and missing held-out evidence hold without being mislabeled as evaluated failures.

## [0.126.7] - 2026-07-24 - dependency security refresh

### Changed

- Updated Ax, Hono, Zod, OpenAPI, Biome, Node types, lint-staged, and Vitest to their current compatible releases.
- Pinned patched Vite, esbuild, PostCSS, and WebSocket transitive versions; the npm dependency audit now reports zero known vulnerabilities.

## [0.126.6] - 2026-07-24 - optimizer model provenance

### Added

- Proxied GEPA and SkillOpt runs now record the configured optimizer model in `OptimizationMethodProvenance.optimizerModel`; GEPA engines without a configured optimizer omit it.

## [0.126.5] - 2026-07-24 - published GEPA compatibility

### Fixed

- The standard GEPA engine now runs against the published `gepa[full]==0.1.4` package instead of requiring an unreleased source API.
- GEPA source-only engines and composition functions still fail explicitly unless the documented official source revision is installed.

## [0.126.4] - 2026-07-24 - train-only GEPA optimization

### Fixed

- Official GEPA optimization accepts an empty selection set, reuses the non-empty training set for candidate comparison, and labels that comparison as a training-set fallback.

## [0.126.3] - 2026-07-24 - execution-bound optimizer resume

### Added

- `runCampaign({ abortOnCellError: true })` stops scheduling after the first dispatch or judge error, aborts and drains active sibling cells, then rejects with the original error.
- Failed cells write `<cell>/failure-receipt.json` before cancellation, including the exact cell result, call IDs, and settled agent-plus-judge cost and token totals.

### Fixed

- Official GEPA, SkillOpt, and generic external optimizer resume identities include the caller's exact dispatch identity, so changed agent, retrieval, judge, model, or service behavior cannot restore incompatible optimizer state.
- `compareOptimizationMethods()` passes its final-scoring dispatch identity into method optimization and rejects conflicting identities.

## [0.126.2] - 2026-07-24 - fail-closed candidate ranking

### Added

- `runOptimization()` and `selfImprove()` accept a fixed-length `selectionRankKey` so domain-specific reliability metrics can choose candidates during every generation.

### Fixed

- Candidate rank keys must be non-empty, fixed-length, and finite.
- A candidate must strictly beat the incumbent on the configured rank key before it can become the next parent or final winner.
- Method-reported spend above `costCeiling` is rejected before final scoring.

## [0.126.1] - 2026-07-24 - optimizer lifecycle integrity

### Changed

- `compareOptimizationMethods()` uses one caller-visible spend limit across optimizer models, train and selection evaluation, and final scoring.
- Candidate surfaces are detached before every optimizer and scoring callback.
- SkillOpt receives complete non-secret model settings automatically while provider credentials remain in the local Node proxy.

### Fixed

- Aborting a comparison now stops official optimizer subprocess groups, callback work, and model proxy requests.
- Resumed final scoring retains the original cost identity and reports cumulative spend instead of resetting cached calls to zero.
- Model-backed GEPA fails before search when the full upstream dependency set is missing instead of silently returning the baseline after swallowed reflection errors.

## [0.126.0] - 2026-07-24 - official optimizer engines

### Added

- `skillOptOptimizationMethod()` delegates skill optimization to Microsoft's official `ReflACTTrainer`.
- `gepaOptimizationMethod()` delegates sequential, adaptive, best-of, vote, and Omni recipes to the official GEPA package.
- `engineModules` lets callers register custom engines through GEPA's public engine registry.
- `DspyJudgeMetric` exposes an `agent-eval-rpc` judge as a native DSPy metric.
- `externalTextOptimizationMethod()` adapts another optimizer to the same text or component-surface contract without adding a named local algorithm.
- Optimizer runs record optimizer and bridge package identity, source commits and source-tree hashes, Python runtime, custom engine module hashes, recipe, configuration, evaluation count, tokens, cost, and resume compatibility.

### Changed

- `selfImprove()` requires an explicit `OptimizationMethod` or caller-owned `SurfaceProposer`.
- `selfImprove({ budget: { candidateConcurrency } })` can score independent candidate campaigns concurrently.
- `callLlmJson()` accepts `jsonPayloadMode: 'exact'` to reject fenced, prose-wrapped, or multi-root responses.
- `CostLedger.listPending()` distinguishes active, late, and interrupted paid calls so durable runs can reconcile reservations before resuming.
- GEPA and SkillOpt share one OpenAI-compatible optimizer model configuration with request, output, response-size, timeout, and dollar limits.
- Model credentials remain in the Node process.
  Official Python libraries receive only a temporary loopback endpoint and credential.
- `compareOptimizationMethods()` owns pairwise-disjoint train, selection, and final test sets.
  Methods never receive final test rows, and final test scoring starts only after every method completes.
- Independent methods and candidate campaigns can run concurrently under the same exact cost accounting.
- Resume files use atomic writes, exclusive run locks, and one content-derived identity shared by Node and Python.
- `runCampaign()` gives cancelled dispatches five seconds to stop by default.
  `dispatchShutdownTimeoutMs` changes that bound.
- AppWorld and GSM8K comparisons reject unequal candidate-evaluation limits and record every model, split, limit, rate, actual call count, and cost basis.
- CI installs GEPA and SkillOpt from exact official source commits for compatibility testing.
  Users install either optimizer separately when they need its bridge.
  DSPy remains a separate optional environment because DSPy 3.2.1 currently requires an older GEPA release.

### Fixed

- Reserve worst-case optimizer spend before each provider call and settle it from provider-reported cost or complete token usage.
- Preserve cached input, cache creation, reasoning, and output token classes without double counting.
- Price cache-read tokens at the configured cache rate when providers omit billed cost.
- Reject incomplete usage, conflicting token details, hidden provider endpoints, hidden credentials, unsupported streaming, oversized input or output, and process descendants that outlive any bridge exit.
- Abort active candidate evaluations when an optimizer exits or times out, and bind cached scores to the exact evaluation identity.
- Require explicit trust and local ownership checks before restoring GEPA pickle state.
- Hash packaged prompts and other behavior files in optimizer identity, and report failed model attempts separately from successful calls.
- Reject native Windows optimizer subprocesses rather than claiming process-tree cleanup that cannot be proven; Linux and WSL use verified POSIX process groups.
- Abort and drain sibling campaign lanes after the first lane failure.
- Delay campaign results until cancelled dispatches and their paid calls settle, so late receipts cannot change reported cost after return.
- Preserve both the primary operation error and any subprocess, temporary-directory, callback, or model-proxy cleanup error.
- Keep optimizer, evaluation, and final test costs separate when a shared cost ledger contains unrelated receipts.
- `LlmClientOptions.jsonSchemaTransport: 'json-object'` supports providers that do not implement native JSON Schema enforcement.
- `InsightReport.interRater.kappa` reports quadratic weighted kappa.
  `interRater.pearson` preserves the previous correlation measure, with ICC and Spearman reported separately.
- Contextual-bandit doubly robust estimates keep logged-action and target-policy value terms separate and report which rows use DR, IPS, or the deprecated scalar path.

### Breaking

- Remove the local GEPA, SkillOpt, ACE, FAPO, HALO, policy-edit, memory-curation, trace-analyst, evolutionary, and composite proposer implementations.
  Use the official GEPA or SkillOpt method, `externalTextOptimizationMethod()`, or pass a caller-owned `SurfaceProposer`.
- Remove `runSkillOpt()`, built-in optimization method factories, lineage loops, skill-patch parsing, analyst policy editing, and the experimental distillation workflow.
- Remove stale examples and generated comparison results tied to the deleted local implementations.

## [0.125.0] — 2026-07-24 — Claude Code supervision reader and path-bound policy edits

### Added

- `claudeCodeSupervisorRunReader()` reads Claude Code root and subagent transcripts into the existing supervision-tree report and rollout formats, while declaring source limits instead of fabricating unavailable spend, verdict, or deliverable data.
- `llmPolicyEditProposer({ valueSchemaByJsonPath })` binds each allowed edit path to an exact JSON Schema in both the provider response contract and local admission.

### Fixed

- Deduplicate repeated Claude Code worker cancellation events and preserve available worker cache-token counts.
- Reject policy-edit values that do not match their target path before a candidate can enter a campaign.

## [0.124.0] — 2026-07-24 — rollout and supervisor-run subpaths

### Added

- `callLlm()` and `callLlmJson()` accept request-level or client-default `thinking: 'enabled' | 'disabled'`; GEPA, SkillOpt, and policy-edit authors expose the same per-proposer override, and the exact mode is preserved in cost bounds, raw request capture, and provider traffic.
- `@tangle-network/agent-eval/rollout` subpath: the single owner of the `tangle.rollout.v1` serialization — canonical schema + fail-loud validation, ledger file API (`writeRolloutLedger`/`appendRolloutLines`/`readRolloutLedger`), harness-store intake readers (opencode sqlite, Claude Code project jsonl), exporters (SFT, reward rows, Prime Intellect verifiers `RolloutOutput`, OpenAI RFT), deterministic 9-rule scrubber, HuggingFace dataset-card generation, and the `agent-eval rollout-release` CLI (build + optional `--push`). Ported from the agent-runtime bench rollout-ledger and reconciled with the PR #410 row shape; see `docs/rollout.md` for the decision table.
- `@tangle-network/agent-eval/supervisor-run` subpath: supervision-tree analysis alongside single-rollout trace analysis. `analyzeSupervisorRun(runDir | reader | sources)` returns a `SupervisorRunReport` — steer count with per-worker breakdown, spawn waves + sizes, max concurrency, respawns/repeated labels/delegation depth, supervisor wall + idle wall + worker utilization, accepted vs rejected vs empty-pass, evidence→respawn vs blind respawn, tokens/USD by role, judge verdict + patch stats — and `rollupSupervisorRuns` aggregates across runs. Every metric is `Measured<T> = T | {unavailable: reason}`, so a missing artifact never reads as a measured zero. The input contract is a `SupervisorRunReader` over already-read bytes; `loopsSupervisorRunReader` is one implementation (the loops `.loops/supervisor/*` on-disk layout). `supervisorRunRolloutLines` emits the tree as `tangle.rollout.v1` rows keyed by `parent_rollout_id`, so a supervision tree lands in the same ledger as solo rollouts. Ported from the agent-runtime bench run-report; byte-identical on both committed backfill fixtures.

### Changed

- `mintRolloutRows` now emits canonical `tangle.rollout.v1` lines (snake_case wire shape) instead of the interim `RolloutRow`; records without trace spans become labeled gap lines AND are listed in `missingTraces` instead of being skipped. `toSftRows`/`toRewardRows` operate on the new lines; `toSftRows` additionally enforces the trainable-split filter (holdout/dev/canary never export). The realness gate still forces reward 0 and SFT exclusion.

### Fixed

- `openOpencodeDb` composes the `node:sqlite` specifier at runtime so neither esbuild nor Vite rewrites it, keeping the opencode rollout reader working in the bundled package.

## [0.123.8] — 2026-07-23 — reasoning-token accounting

### Fixed

- Preserve OpenAI-compatible `completion_tokens_details.reasoning_tokens` through `LlmCallResult`, cost receipts, and cost-ledger summaries.

## [0.123.7] — 2026-07-23 — publishable GEPA bridge metadata

### Fixed

- Keep the unreleased GEPA Optimize Anything commit pinned as a source-checkout dependency group and document its explicit installation, instead of embedding a Git URL in the `agent-eval-rpc` wheel metadata that PyPI rejects.
- Build and inspect Python distributions during pull-request and release verification so a direct-URL runtime dependency cannot split npm and PyPI releases again.

## [0.123.6] — 2026-07-23 — optimization and rollout exports

### Added

- `mintRolloutRows()` joins existing run records and traces into `tangle.rollout.v1` rows; `toSftRows()`, `toRewardRows()`, and `toJsonl()` serialize clean-success and reward-labeled training data while preserving missing-trace and realness-block evidence.
- `gepaOptimizationMethod()` delegates bounded single-engine and Omni-shaped `optimize_best_of()` then `optimize_anything()` recipes to GEPA through the Python bridge.
  The caller chooses the train and selection fields sent to GEPA, final comparison cases remain inside `agent-eval`, and proposer spend without agent-eval receipts is reported as incomplete.

## [0.122.2] — 2026-07-17 — premeasured optimization continuation

### Added

- `runOptimization()` accepts a surface-bound, split-validated complete campaign as `premeasuredBaseline`, preserves its artifacts for analysis, and skips duplicate baseline dispatch.

## [0.121.0] — 2026-07-15 — one measured-comparison contract

### Changed

- Emit the single current measured-comparison shape without a schema version field.
- Consume `@tangle-network/agent-interface` 0.28, which removes unused candidate compatibility formats and speculative version fields.

## [0.120.1] — 2026-07-15 — configurable improvement deadlines

### Fixed

- `selfImprove()` forwards `dispatchTimeoutMs` to baseline, candidate, and held-out campaign cells so long-running workers use the caller's declared deadline instead of the 600-second default.

## [0.120.0] — 2026-07-14 — exact measured provenance

### Changed

- Give each campaign a canonical split digest over the full scenario payload and replicate count, and require the exported benchmark to identify that exact heldout design.
- Emit self-addressed `tangle.loop-provenance` records from one shared loop-result translator, and derive prompt or code diffs from the exact measured surfaces instead of accepting caller-authored text.
- Retain one strict hash per scenario so consumers can verify the tested split without persisting customer task payloads.

### Breaking

- Require the exact baseline surface and bind portable evidence to every search, winner, heldout, and neutralized campaign; the full decision; the reconstructed receipt ledger; duration; power analysis; and validated candidate history.
- Require every scored row to link to a successful model receipt; reject contradictory provenance, duplicate scenarios, broken cell identity or pairing, failed judges, and invalid cost, latency, or token measurements before products can publish an improvement proposal.
- Stop optimization when a proposer returns no candidates, reject empty or non-contiguous generation records, and refuse a shipped no-op.
- Remove the duplicate worker-record collector and caller-authored diff hook; settled receipts and exact surfaces are now the only evidence path.
- Remove `@tangle-network/agent-eval/primeintellect`, which generated a legacy single-turn Verifiers package with unsafe substring scoring. Use `@tangle-network/agent-runtime/primeintellect` for task packaging, real runtime execution, and full trace import.
- Verify the same npm archive implementation used by the release workflow.

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
- Loop provenance preserves complete candidate measurement lineage: baseline score, parent chain, coverage, eligibility, and exact surface fields.

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
- Code-surface provenance now uses content-addressed hashes instead of mutable paths.
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
