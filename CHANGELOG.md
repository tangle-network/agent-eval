# Changelog

## Unreleased

### Added

- `researchReport`, an executive research-report layer for coding-vertical
  benchmark runs. Composes `summaryTable`, `paretoChart`, `gainHistogram`,
  held-out gate decisions, and optional `failureClusterView` output into
  promote / hold / equivalent / reject / needs-more-data guidance with
  rationale, risks, next actions, markdown, HTML, and JSON chart specs.
  - Decisions are made on paired evidence — never on marginal means alone.
  - ROPE (Region of Practical Equivalence) supported via the `rope` option;
    candidates whose paired-delta CI is fully inside the ROPE are returned
    as `equivalent` rather than `hold`.
  - Bayesian-bootstrap-style Pr(Δ>0) and Pr(Δ∈ROPE) summaries on the mean
    paired delta (Rubin 1981 bootstrap-prior duality), reported per
    candidate alongside the bootstrap CI on the median.
  - Per-candidate minimum detectable paired effect at the configured power
    and α via the new `pairedMde` primitive in `power-analysis`, so a
    `needs_more_data` verdict is actionable.
  - SHA-256 `runFingerprint` over the canonicalised input run set + an
    optional `preregistrationHash` field so the report can cite a signed
    `HypothesisManifest`.
  - Soft floor `minPairs` (default 20) and a hard floor of 6 pairs
    (`RESEARCH_REPORT_HARD_PAIR_FLOOR`) below which any paired call returns
    `needs_more_data` regardless of the option.
  - Embedded methodology section in the rendered markdown plus a standalone
    [`docs/research-report-methodology.md`](./docs/research-report-methodology.md)
    with assumptions, alternatives, when-not-to-apply, and citations
    (Benjamini & Hochberg 1995; Wilcoxon 1945; Efron 1979; Rubin 1981;
    Kruschke 2018).
- `pairedMde` in `power-analysis`: closed-form minimum detectable paired
  effect inverse to the paired-t / sign-rank power formula.

### Changed

- `researchReport` is now async (uses Web Crypto via `hashJson` for the run
  fingerprint).

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
