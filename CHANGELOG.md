# Changelog

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
- **`paperTable`, `paretoFigure`, `gainDistributionFigure`**
  (`src/paper-report.ts`) — Table 1 + Pareto + gain-distribution specs.
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
- See `.claude/skills/agent-eval/SKILL.md` for usage directives and
  pitfalls; `## Pitfalls` section added in this release.

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
