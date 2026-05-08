# Changelog

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
