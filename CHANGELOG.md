# Changelog

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
