---
name: agent-eval
description: Trace-first evaluation framework for code-generator + LLM-in-the-loop systems AND the canonical product-agent adoption guide. Sandbox harness + build gates, BuilderSession, three-layer scoring, meta-judge with compile short-circuit, LLM client with graceful degrade, multi-layer verification pipeline, semantic-concept judge, multi-toolchain layer merge, canonical consumer file layout (eval/scenarios.json + judges + agent-profile + three pnpm scripts), driver-choice decision tree, surface menu. Directives below encode shipped-bug lessons + cross-link the substrate's full surface menu — read before writing integration code OR before wiring a product agent.
---

# agent-eval — usage directives + product-agent adoption

**You're an agent writing integration code?** Read this whole file. Each rule below was paid for in a shipped bug; skip one and the bug class reappears.

**You're wiring a NEW product agent onto the substrate?** Skip ahead to §Consumer adoption (canonical product-agent layout) — but read §Surfaces & how to navigate first so you know what else exists.

**You're a human onboarding?** Read [`docs/concepts.md`](../../../docs/concepts.md) first — 5-minute mental model — then come back. The rest of this file is dense by design (it's a footgun bible AND an adoption guide; not a tutorial).

## Surfaces & how to navigate — the fanout

The substrate exposes many surfaces. Pick where to go based on what you're doing:

### Mental model & onboarding
- [`docs/concepts.md`](../../../docs/concepts.md) — 5-minute mental model, **READ FIRST if human**
- [`README.md`](../../../README.md) — entry points + decision-packet sample + competitor matrix
- [`docs/customer-journeys.md`](../../../docs/customer-journeys.md) — three end-to-end product paths

### The decision packet (no LLM cost, pure analysis)
- [`src/contract/analyze-runs.ts`](../../../src/contract/analyze-runs.ts) — `analyzeRuns()` implementation
- [`src/contract/insight-report.ts`](../../../src/contract/insight-report.ts) — canonical `InsightReport` types
- [`docs/insight-report.md`](../../../docs/insight-report.md) — annotated walkthrough of every section
- [`src/contract/intake/feedback-table.ts`](../../../src/contract/intake/feedback-table.ts) — `fromFeedbackTable()` multi-rater intake
- [`src/contract/intake/otel-spans.ts`](../../../src/contract/intake/otel-spans.ts) — `fromOtelSpans()` OTel intake

### The closed loop (LLM cost, opt-in)
- [`src/contract/self-improve.ts`](../../../src/contract/self-improve.ts) — `selfImprove()` LAND-tier helper
- [`src/campaign/drivers/gepa.ts`](../../../src/campaign/drivers/gepa.ts) — reflective LLM driver (default)
- [`src/campaign/drivers/evolutionary.ts`](../../../src/campaign/drivers/evolutionary.ts) — cheap deterministic mutator wrapper
- [`src/campaign/gates/default-production-gate.ts`](../../../src/campaign/gates/default-production-gate.ts) — promote/hold/inspect gate
- §Consumer adoption below — canonical product-agent layout for wiring all of the above

### Wire protocol & cross-language
- [`docs/wire-protocol.md`](../../../docs/wire-protocol.md) — canonical hosted wire format
- [`docs/hosted-ingest-spec.md`](../../../docs/hosted-ingest-spec.md) — reference receiver spec
- [`clients/python/README.md`](../../../clients/python/README.md) — `agent-eval-rpc` Python client
- [`src/hosted/types.ts`](../../../src/hosted/types.ts) — `EvalRunEvent` + `HOSTED_WIRE_VERSION`

### Runnable examples (clone + `pnpm tsx`)
- [`examples/selfimprove-quickstart/`](../../../examples/selfimprove-quickstart/) — closed loop with synthetic driver (offline)
- [`examples/customer-feedback-loop/`](../../../examples/customer-feedback-loop/) — multi-rater corpus → `InsightReport`
- [`examples/customer-otel-traces/`](../../../examples/customer-otel-traces/) — OTel spans → `InsightReport`
- [`examples/foreign-agent-quickstart/`](../../../examples/foreign-agent-quickstart/) — wire a non-Tangle agent
- [`examples/hosted-ingest-server/`](../../../examples/hosted-ingest-server/) — reference HTTP receiver
- [`examples/multi-shot-optimization/`](../../../examples/multi-shot-optimization/) — population search
- [`examples/distributed-driver/`](../../../examples/distributed-driver/) — split work across cells
- [`examples/held-out-gate/`](../../../examples/held-out-gate/) — gate semantics + paired-delta + overfit-gap
- [`examples/scorecard/`](../../../examples/scorecard/) — release-timeline scorecard (orthogonal to `InsightReport`)
- [`examples/same-sandbox-harness/`](../../../examples/same-sandbox-harness/) — share sandbox across cells
- [`examples/fine-tune-with-prime-rl/`](../../../examples/fine-tune-with-prime-rl/) — eval → RL training data
- [`examples/marketing-agent-canonical/`](../../../examples/marketing-agent-canonical/) — end-to-end product-agent reference
- [`examples/production-loop/`](../../../examples/production-loop/) — CI cron pattern with auto-PR-promote on ship

### Architecture & design docs
- [`docs/three-package-architecture.md`](../../../docs/three-package-architecture.md) — substrate / runtime / knowledge layering
- [`docs/design/product-self-improvement-loop.md`](../../../docs/design/product-self-improvement-loop.md) — the canonical loop pattern
- [`docs/design/self-improvement-engine.md`](../../../docs/design/self-improvement-engine.md) — phase diagram
- [`docs/design/loop-taxonomy.md`](../../../docs/design/loop-taxonomy.md) — driver categorization (evolutionary / gepa / agentic)

### Observability & adapters
- [`src/adapters/otel.ts`](../../../src/adapters/otel.ts) — OTel bridge
- [`src/adapters/langchain.ts`](../../../src/adapters/langchain.ts) — LangChain adapter
- [`src/adapters/http.ts`](../../../src/adapters/http.ts) — distributed-driver dispatcher
- [`docs/adapters-observability.md`](../../../docs/adapters-observability.md) — adapter inventory + usage

### RL bridge (eval → training)
- [`src/rl/`](../../../src/rl/) — preferences, reward extraction, off-policy estimation
- [`docs/feedback-trajectories.md`](../../../docs/feedback-trajectories.md) — preference-trajectory extraction

## Vocabulary you need before reading the rules

| Term | Plain English |
|---|---|
| **Artifact** | The thing being judged. Often a workdir; sometimes text. |
| **Snapshot** | Frozen view of an artifact (`files: Record<path,string>`). What judges read. |
| **Harness** | Description of how to run the artifact: setupCommand, testCommand, cwd, timeoutMs. |
| **Sandbox driver** | The thing that actually runs commands. `SubprocessSandboxDriver` runs locally. |
| **Layer** | One stage of a verifier pipeline (install / typecheck / build / semantic / …). |
| **Judge** | A function that scores one artifact. Some are LLM-backed, some deterministic. |
| **Rubric** | Data describing what a judge scores on, with weights. |
| **Trace store** | Append-only log of spans. `BuilderSession` writes here. |
| **Composite score** | 0..1 number combining all dimensions — the gate value. |
| **Muffled gate** | A check that should fail loud but silently passes. The most expensive bug class — see Footgun 1 and §Common bug classes. |
| **L0 / L1 / L2** | Three layers of code-generator eval: agent session / app-build / app-runtime. |

If a term below isn't in this table or in `docs/concepts.md`, that's a bug — file an issue.

---

## Decide where to start

| You want to… | Start with |
|---|---|
| Evaluate a code generator (scaffold / patch / config) end-to-end | §Minimal working path · `BuilderSession` + `SubprocessSandboxDriver` |
| Verify a workdir across install → typecheck → build → lint → serve → semantic | `MultiLayerVerifier` + `multiToolchainLayer` (§Verification pipeline) |
| Score multi-turn agents against scenarios + judges | `BenchmarkRunner` + `executeScenario` + `ConvergenceTracker` |
| Run an agent's N-shot propose→verify→review loop | `propose-review` + your own `ReviewFn` |
| Call an LLM with retry + backoff + json-schema degrade + fence-strip | `callLlmJson` / `LlmClient` |
| Judge "did the artifact implement the asked-for concepts?" | `runSemanticConceptJudge` (LLM) + `runKeywordCoverageJudge` (deterministic, no cost) |
| Count compiler errors from stderr across tsc/pytest/rustc/go/eslint | `extractErrorCount` + `ERROR_COUNT_PATTERNS` |
| Detect contamination / run red-team / guard anti-slop | `contamination-guard`, `red-team`, `createAntiSlopJudge` |
| A/B prompts, optimize steering, bisect regressions | `ExperimentTracker`, `PromptOptimizer`, `bisector` |
| Budget tokens/$/wall, track cost, export traces | `BudgetGuard`, `CostTracker`, `observability` (OTLP) |
| Gate a candidate against held-out before promoting | `HeldOutGate` (paired-delta + overfit-gap, three rejection codes) |
| Standardize a paper-grade run record (snapshot-pinned, hashed, costed) | `RunRecord` + `validateRunRecord` |
| Detect silent judge fallback / calibration drift / distribution shift | `runCanaries` |
| Emit an A/B summary table or Pareto / gain figure spec | `summaryTable` / `paretoChart` / `gainHistogram` |
| Build a launch-decision-grade research report (paired stats, ROPE, MDE, fingerprint, methodology) | `researchReport` (§Research reports) |
| Run a matrix of variants × scenarios × seeds with capture integrity by construction | `runEvalCampaign` (§EvalCampaign — preferred starting point for new evals) |
| Re-run / re-judge / determinism-audit a past campaign for free | `ReplayCache` + `createReplayFetch` (§Replay & sequential evaluation) |
| Ship the moment evidence is decisive, with anytime-valid α control across rolling looks | `pairedEvalueSequence`, `evaluateInterimReleaseConfidence` (§Replay & sequential evaluation) |
| Tell load-bearing rubrics from decorative ones using deployment outcomes | `rubricPredictiveValidity` (§Outcome calibration) |
| Bridge legacy optimization output to canonical `RunRecord[]` | `trialToRunRecord`, `verificationReportToRunRecord` (§RL bridge) |
| Extract a clean reward signal for RL training (compile / test / schema vs judge) | `extractVerifiableReward`, `filterDeterministicallyRewarded` (§RL bridge) |
| Produce DPO / PPO / KTO `(chosen, rejected)` triples from `RunRecord[]` | `extractPreferences` (§RL bridge) |
| Estimate the value of a new policy on old trajectories without re-running | `inverseProbabilityWeighting`, `selfNormalizedImportanceWeighting`, `doublyRobust`, `offPolicyEstimateAll` (§RL bridge) |
| Step-level credit assignment / PRM training data | `extractStepRewards`, `prmTrainingPairs` (§RL bridge) |
| Detect benchmark contamination via held-out perturbations | `runContaminationProbe`, stock perturbations (§RL bridge) |
| Pairwise tournament ratings for many-candidate sweeps | `fitBradleyTerry`, `applyEloUpdate`, `buildPairwiseFromCampaign` (§RL bridge) |
| Active search for inputs the policy fails on | `adversarialScenarioSearch` (§RL bridge) |
| Characterize a candidate across compute budgets (`bestOfN`, self-consistency, curves) | `runComputeCurve`, `bestOfN`, `selfConsistency`, `paretoFrontier` (§RL bridge) |
| Capture every provider HTTP request/response for forensics | `RawProviderSink` + `LlmClientOptions.rawSink` (§Capture integrity Directive 1) |
| Fail loud if the eval would silently use the wrong route | `assertLlmRoute` (§Capture integrity Directive 2) |
| Assert at run-end that the artifact is complete | `assertRunCaptured` + `throwIfRunIncomplete` (§Capture integrity Directive 3) |
| Auto-execute the trace analyst on every run | `traceAnalystOnRunComplete` + `TraceEmitterOptions.onRunComplete` (§Capture integrity Directive 4) |
| Stable hook for an external research-driver agent | `Researcher` (interface) + `NoopResearcher` (placeholder) |
| Wire a NEW product agent onto the substrate (eval/ layout, three pnpm scripts, drivers, surface choice) | §Consumer adoption (canonical product-agent layout) |
| Render the decision packet from a `RunRecord[]` you already have | `analyzeRuns({ runs })` → `InsightReport` |
| Run a closed-loop improvement cycle one-shot (LAND-tier) | `selfImprove({ scenarios, agent, judge, baselineSurface, driver, budget })` |
| Choose between `gepaDriver` vs `evolutionaryDriver` vs a custom driver | §Driver choice — decision tree |
| Decide which string to optimize (system prompt vs addendum vs judge) | §Surface menu — what string to pick |

Extend, don't fork — see §"Extend, don't duplicate."

---

## Production-rigor primitives

| Primitive | Module | What it does |
|---|---|---|
| `HeldOutGate` | `held-out-gate.ts` | Paired-delta + overfit-gap gate. Three rejection codes: `few_runs`, `negative_delta`, `overfit_gap`. Use before promoting an optimizer's top-1. Pairs with `promotion-gate.ts` (bootstrap CI for "is this real?") — use both. |
| `RunRecord` | `run-record.ts` | Typed run schema. `validateRunRecord` throws on missing fields and on bare model aliases — record the snapshot (`claude-sonnet-4-6@2025-04-15`). |
| `pairedBootstrap`, `pairedWilcoxon`, `bhAdjust` | `paired-stats.ts` | Stats primitives. Pass `seed` to `pairedBootstrap` when the result feeds a CI / promotion decision. |
| `runCanaries` | `canary.ts` | Silent fallback (constant confidence), calibration drift (KS), distribution shift (chi-square). Returns a report; doesn't fail tests — wire it to a notification. |
| `summaryTable`, `paretoChart`, `gainHistogram` | `summary-report.ts` | A/B reporting. `summaryTable` emits markdown with bootstrap CIs + paired Wilcoxon p (BH-adjusted) + Cohen's d. The other two return vega-lite-friendly specs. |
| `researchReport` | `summary-report.ts` | Async, launch-decision-grade artifact: paired-evidence-only verdicts (`promote` / `hold` / `equivalent` / `reject` / `needs_more_data`), ROPE, Pr(Δ>0), per-candidate MDE via `pairedMde`, SHA-256 `runFingerprint`, optional `preregistrationHash`, embedded methodology. See [`docs/research-report-methodology.md`](../../../docs/research-report-methodology.md). |
| `runEvalCampaign` | `eval-campaign.ts` | The capture-integrity directives, made structural. Variants × scenarios × seeds → `RunRecord[]` + integrity reports + (optional) `researchReport`. Wires `assertLlmRoute` at preflight, builds `TraceStore` + `RawProviderSink` + `TraceEmitter` per run, asserts `requireRawCoverageOfLlmSpans` at run-end, runs the analyst on completion. See §EvalCampaign. |
| `ReplayCache` + `createReplayFetch` + `iterateRawCalls` | `replay.ts` | Turns a populated `RawProviderSink` into a `(canonical request → cached response)` cache + a `fetch`-shaped shim. Pass via `LlmClientOptions.fetch` and `callLlm` reads from the cache transparently; zero LLM cost for re-judging, post-hoc scoring, or determinism audits. See §Replay & sequential evaluation. |
| `pairedEvalueSequence`, `evaluateInterimReleaseConfidence` | `sequential.ts` | Anytime-valid sequential evaluation: predictable plug-in betting martingale (Waudby-Smith & Ramdas 2024) + empirical Bernstein confidence sequence (Howard et al. 2021). Verdict at every interim look is type-I-error-controlled at α regardless of how many times you peeked. Pair with `runEvalCampaign` for ship-when-decisive. |
| `rubricPredictiveValidity` | `meta-eval/rubric-predictive-validity.ts` | The outcome-calibration loop: joins campaign `RunRecord`s to deployment `OutcomeStore` and ranks rubrics by `\|spearman\|` against each outcome metric, with bootstrap CI. Buckets: `'load_bearing' \| 'informative' \| 'decorative'`. Use to deprecate decorative rubrics, re-weight composites, trigger recalibration when validity drops. |
| `RawProviderSink` + `callLlm({ rawSink })` | `trace/raw-provider-sink.ts`, `llm-client.ts` | First-class HTTP-level capture alongside `LlmSpan`. `Authorization` / `X-Api-Key` / credential-shaped body fields auto-redacted; `event.redactedFields` records what was stripped. `FileSystemRawProviderSink` rolls at 32 MiB. **Every eval run wires this** — see Directive 1. |
| `assertLlmRoute` | `llm-client.ts` | Pure preflight guard. Throws `LlmRouteAssertionError` on missing baseUrl, blocked URL, missing auth, wrong provider. Call once at matrix-runner construction. See Directive 2. |
| `assertRunCaptured` + `throwIfRunIncomplete` | `trace/integrity.ts` | Read-only run-completion check. `requireRawCoverageOfLlmSpans` catches the bug class where structured spans were emitted but raw HTTP capture went to a different sink. See Directive 3. |
| `onRunComplete` hooks + `traceAnalystOnRunComplete` | `trace/emitter.ts`, `trace-analyst/hook.ts` | Declarative auto-orchestration after `endRun` / `abortRun`. Errors are swallowed and logged by default (auto-orchestration must not crash the underlying flow). See Directive 4. |
| `Researcher` (interface) + `NoopResearcher` | `researcher.ts` | Stable hook for an external agent that drives the meta-loop. Real implementations live downstream. |
| `BenchmarkAdapter` + `routing` benchmark | `benchmarks/` | One adapter contract + the synthetic routing task we own. Reference wrappers for GSM8K and SWE-Bench-Lite live under `examples/benchmarks/`. `BENCHMARK_SPLIT_SEED = "agent-eval-v1"` — never change it. |

---

## Minimal working path (builder-of-builders)

The pattern every closed-loop generation project uses:

```ts
import {
  InMemoryTraceStore, BuilderSession, SubprocessSandboxDriver,
  runAssertions, fileExists,
} from '@tangle-network/agent-eval'

const store = new InMemoryTraceStore()
const driver = new SubprocessSandboxDriver()             // ← no constructor arg
const session = new BuilderSession(store, { projectId: 'my-app' }, driver)

await session.startChat()
const ship = await session.ship({
  harness: {
    setupCommand: 'pnpm install --prefer-offline',
    testCommand: 'pnpm exec tsc --noEmit',               // ← strict, fail-loud
    cwd: composedScaffoldDir,                             // ← MUST be in HarnessConfig
    timeoutMs: 180_000,
  },
})
await session.endChat({ pass: ship.result.passed, score: ship.result.score })

// Both gates — orthogonal failure classes.
const structural = runAssertions(snapshot, [fileExists('package.json'), fileExists('src/main.ts')])
```

**Contract** — `BuilderSession` emits three layers of traces:
`builder` (L0 = startChat→endChat) → `app-build` (L1 = ship) →
`app-runtime` (L2 = runAppScenario, only after L1 passes). `ship()` is
at most once per chat; `runAppScenario` throws if called without a
successful ship. `scoreProject` / `scoreAllProjects` aggregate; pass
`kind: 'scaffold-only'` when there's no L2.

---

## Verification pipeline (for pipelines larger than one gate)

When the eval runs N ordered layers (install → typecheck → build →
lint → serve → semantic), use `MultiLayerVerifier` directly — it
handles dependency skip, per-layer findings with severity, soft-fail,
and weighted `blendedScore` aggregation.

```ts
import {
  MultiLayerVerifier, multiToolchainLayer, gradeSemanticStatus,
  localCommandRunner,
} from '@tangle-network/agent-eval'

const verifier = new MultiLayerVerifier<VerifyEnv>([
  multiToolchainLayer({
    name: 'install',
    adapters: detectedToolchains,                 // [pnpm, npm, cargo, forge]
    adapterName: (a) => a.name,
    run: (a, ctx) => a.runInstall(ctx.env.runner, ctx.env.workdir),
  }),
  multiToolchainLayer({
    name: 'typecheck',
    adapters: detectedToolchains,
    adapterName: (a) => a.name,
    dependsOn: ['install'],                       // skip on install fail
    run: (a, ctx) => a.runTypecheck(ctx.env.runner, ctx.env.workdir),
  }),
  {
    name: 'semantic',
    weight: 3,                                     // 3x in blendedScore
    failContributesToScore: true,                  // count semantic-fail at its numeric score
    run: async (ctx) => {
      const r = await runSemanticConceptJudge(...)
      return { layer: 'semantic', status: gradeSemanticStatus(r), score: r.score, durationMs: r.durationMs, findings: [...] }
    },
  },
])

const report = await verifier.run({ env: { runner: localCommandRunner, workdir, ... } })
// → { layers, passCount, failCount, skippedCount, allPass, blendedScore, durationMs }
```

Use `multiToolchainLayer` when a stage fans across N adapters
in parallel and results merge (install, typecheck, build). Use plain
`Layer` when there's one way (semantic judge, dependency audit).

`CommandRunner` (abstracted subprocess + fs surface) is what
layers call out through. `localCommandRunner` is the host-process impl;
swap for a sandbox runner in tests or in-container prod paths — layer
code doesn't change.

---

## Footgun 1: `cwd` belongs in `HarnessConfig`, not the driver constructor

```ts
//  BROKEN — cwd silently dropped
new SubprocessSandboxDriver({ cwd: dir })

//  CORRECT — cwd travels with the call
new SubprocessSandboxDriver()
session.ship({ harness: { cwd: dir, testCommand: 'pnpm exec tsc --noEmit', ... } })
```

**Why**: `SubprocessSandboxDriver.exec(phase, command, config)` spawns
with `cwd: config.cwd`. The driver is stateless-per-call by design so
one driver serves many concurrent sandboxes. `{cwd?, env?}` on the
constructor are fallbacks only — per-call config always wins.

**Shipped incidents**: starter-foundry Gen 8b (promoters), Round 0
post-Gen-9 (runtime eval). Silent-passed broken scaffolds with
`exitCode=0` because spawn inherited node's cwd, where the same tsc
passed against the wrong project.

**Regression guard**: `tests/muffled-gate-invariant.*` should flag
`new SubprocessSandboxDriver({cwd: ...})`. Opt-out: `// muffle-ok: <reason>`.

---

## Footgun 2: Build gate must fail loud

```ts
//  BROKEN — swallows every failure
testCommand: 'pnpm run validate || pnpm run build || true'

//  CORRECT
testCommand: 'pnpm exec tsc --noEmit'

//  OK — legitimate best-effort setup, annotated
setupCommand: 'forge install --no-git || true', // muffle-ok: forge build is the real gate
```

**Why**: fidelity / meta judges cannot reliably spot compile errors.
If the build gate returns 0 on a broken scaffold, fidelity scores ~0.8
and ships. Three bugs shipped through a `|| true` gate before the
pattern was closed.

---

## Footgun 3: Pair the meta judge with a build outcome

`invokeMetaJudge` (or any LLM-as-judge on code) must short-circuit on
`buildOutcome.passed=false`:

```ts
if (buildOutcome?.passed === false) {
  return {
    verdict: 'fail', overall: 0,
    issues: [{ severity: 'high', description: `build failed: ${buildOutcome.stderr.slice(-400)}` }],
    rationale: 'Build/typecheck failed — scaffold cannot run. LLM scoring skipped.',
  }
}
```

**Why**: LLM judges rate code they can't run. Non-compiling code can
still "look right." Goodhart's Law: fidelity rewards what looks right,
not what works. Pair with a ground-truth gate or the metric lies.

---

## Footgun 4: Snapshot blobs ≠ files

`WorkspaceSnapshot` has two channels:
- `files: Record<string, string>` — UTF-8 text, full content.
- `blobs: Record<string, { size, hash?, mimeType? }>` — binaries,
  metadata only.

`fileExists(path)` checks both. `fileContains(path, needle)` only works
against `files`. If a test fails inexplicably on `.wasm` / `.zkey` /
`.png`, check `snapshot.blobs[path]`, not `snapshot.files[path]`.

---

## Rule: both gates, not either

Every scaffold eval runs **both** `SandboxHarness.run()` (build gate)
and `runAssertions()` (structural). Orthogonal misses:

- Build-only misses: manifest promised 10 files; scaffold wrote 7. Build
  passes. User opens empty file.
- Structural-only misses: all files exist, one has a TS error.
  Assertions pass. Build catches it.

`runAssertions` is cheap; run unconditionally.

---

## Rule: single source of truth for per-language dispatch

Tables mapping `taxonomy.language → {setupCommand, testCommand, timeoutMs}`
export from ONE module. Never copy-paste into promoters, audit scripts,
CI configs.

**Incident**: starter-foundry had three copies; Gen 8b fixed two; Gen 9
found the third still muffled. Invariant test asserts exactly one copy.

---

## Rule: Phase 1.5 audit walks entry-point scripts

Before calling a structural fix complete, grep every file that imports
`@tangle-network/agent-eval` — not just `lib/`.

**Incident**: Gen 9 scanned `src/**` and skipped
`scripts/agent-eval-scaffold.mjs`, an entry point. Round 0 found the
same cwd bug live there.

**Scan roots**: `rg -l '@tangle-network/agent-eval' --type ts --type mjs --type js`.
Every match goes in the invariant scanner.

---

## Common bug classes (muffled-gate pattern)

Seven shapes. Audit before shipping any gate:

1. **Fallback-to-pass**: `command || true`.
2. **Default-missing-to-permissive**: `options.kind ?? 'starter'` — missing
   becomes a specific permissive value.
3. **Skip-counts-as-pass**: `if (p.skipped) return true` in a scorer.
4. **Auto-match no-expectation**: `if (!expected) return true` in a
   matcher — inflates accuracy for unlabeled scenarios.
5. **Duplicate drift**: same dispatch in N files; fix to N−1 silently
   regresses the Nth.
6. **Unknown-case silent default**: `default: return noop` for a value
   that should never be unknown.
7. **Construct-vs-call dropped arg**: `new Driver({cwd})` when `cwd` lives
   on per-call config. See Footgun 1.

Common shape: something that should fail loud returns silent success.
Fail closed; use `// muffle-ok: <reason>` for the rare exception.

---

## RL bridge — from eval to policy training

Imported from `@tangle-network/agent-eval/rl` (or the root barrel). Eight modules; each one converts a piece of agent-eval output into a shape an RL pipeline can consume, or implements a canonical RL eval methodology that the rest of the package didn't cover.

### Quick reference

```ts
import {
  trialsToRunRecords,             // bridge legacy optimization output
  extractVerifiableReward,        // clean reward signal (compile/test) vs judge
  extractPreferences,             // (chosen, rejected) triples for DPO/PPO/KTO
  offPolicyEstimateAll,           // IPS + SNIPS + DR side-by-side
  extractStepRewards,             // step-level credit assignment
  prmTrainingPairs,               // PRM training data
  runContaminationProbe,          // held-out perturbation contamination
  fitBradleyTerry, applyEloUpdate, // pairwise tournament ratings
  adversarialScenarioSearch,      // active failure-mode discovery
  runComputeCurve, bestOfN, selfConsistency, paretoFrontier,  // compute-axis evaluation
} from '@tangle-network/agent-eval/rl'
```

### When you actually use each one

- **You ran an existing `runPromptEvolution` or `runImprovementLoop` sweep** — wrap with `trialsToRunRecords(trials, ctx)` so the output composes with `replayCache`, `pairedEvalueSequence`, `rubricPredictiveValidity`, and the rest of the RunRecord surface. Single line, zero behavior change.
- **You're training a policy with TRL / DPO / PPO / GRPO** — use `extractVerifiableReward` to separate deterministic rewards (compile/test/schema/sandbox) from probabilistic ones (judge), then `extractPreferences` to produce the `(chosen, rejected)` triples in the shape your trainer expects.
- **You changed a policy and want to evaluate it on yesterday's trajectories without re-running** — use `offPolicyEstimateAll` with token log-prob propensity scores. Run all three estimators (IPS, SNIPS, DR); agreement across estimators is much stronger than any single number.
- **You want step-level credit assignment for long-horizon agents** — `extractStepRewards` over the trace spans of completed runs, `prmTrainingPairs` to produce the training data for a PRM, then plug into your favourite trainer (we don't ship gradient descent).
- **You're worried your benchmark scenarios leaked into training data** — `runContaminationProbe` with one of the stock perturbations (`renameVariables`, `shuffleOrder`, `injectIrrelevantClause`). Catches drift before the launch reviewer does.
- **You have ≥ 5 candidates running on shared scenarios** — `fitBradleyTerry` is more sample-efficient than running every candidate against a fixed comparator. Use `applyEloUpdate` for online ratings as new comparisons arrive.
- **You want to find the failure modes the curator didn't think of** — `adversarialScenarioSearch` hill-climbs against a failure indicator using caller-supplied mutation strategies. Pair with the contamination probe for two-sided robustness.
- **You want to characterise a candidate's capability vs cost rather than at one budget** — `runComputeCurve` at `{1×, 4×, 16×}` with `bestOfN` or `selfConsistency` as the per-budget evaluator, then `paretoFrontier` over (candidate, compute) tuples.

### When NOT to use these

- The RL primitives don't replace `runEvalCampaign`. The campaign is the matrix runner with capture-integrity baked in; the RL primitives consume the campaign's `RunRecord[]` output. Keep the campaign as the entry point.
- `doublyRobust` requires a Q-function. We don't ship a learned Q-function trainer — pass a heuristic (running mean per scenario), a regression fit you trained out-of-band, or `null` per-trajectory to fall back to IPS for that entry.
- `prmTrainingPairs` matches trajectories by `(span name, span kind)` prefix. Production use should replace this with a token-level prefix hash; the heuristic is good for early-stage PRM scaffolding.
- Contamination probe's per-scenario q-values use a heuristic pseudo-p — they're a display aid; the load-bearing test is the global Wilcoxon.

---

## Replay & sequential evaluation

Once `runEvalCampaign` standardises the output (every run is a `RunRecord` plus a SHA-256-keyed raw-event log) two compounding capabilities open up:

### Replay — every past run is a re-runnable artifact

Trying a new judge no longer means re-burning a sweep. Build a `ReplayCache` from the populated `RawProviderSink` of a previous run, install `createReplayFetch(cache)` as the `fetch` for `callLlm`, and the network call resolves out of the cache.

```ts
import { ReplayCache, createReplayFetch } from '@tangle-network/agent-eval/traces'

const cache = await ReplayCache.fromSink(yesterdayCampaignSink)
const replayFetch = createReplayFetch(cache, { onMiss: 'fail-closed' })

await callLlm(req, { ...llmOpts, fetch: replayFetch })  // zero LLM cost
```

The cache hashes a canonical projection of the request body (`model + messages + temperature + max_tokens|max_completion_tokens + response_format`), so insertion-order quirks don't cause spurious misses. `onMiss` is `'throw' | 'fallback' | 'fail-closed'` — pick `fail-closed` for "I expect 100% replay; flag any new request as a determinism bug."

For post-hoc scoring that doesn't even need a `fetch` shim, iterate the cached `(request, response)` pairs directly with `iterateRawCalls(sink)` and run your scorer in pure TS.

### Sequential — ship the moment evidence is decisive

Real consumers run campaigns weekly / nightly / per-PR. Each new look at the data silently inflates type-I error under the BH-FDR guarantee, which was for the *first* analysis. `pairedEvalueSequence(deltas, opts)` and `evaluateInterimReleaseConfidence({ deltaSeries })` ship time-uniform inference: Type-I error is bounded by α at *every* stopping time.

```ts
import { evaluateInterimReleaseConfidence } from '@tangle-network/agent-eval/reporting'

const verdict = evaluateInterimReleaseConfidence({
  deltaSeries: candidates.map((c) => ({ candidateId: c.id, deltas: c.pairedDeltas })),
  alpha: 0.05,
  rope: { low: -0.02, high: 0.02 },
})
// → recommendation: { decision: 'promote_now' | 'continue' | 'reject_now' | 'equivalent', candidateId }
```

Methodology: predictable plug-in betting martingale (Waudby-Smith & Ramdas 2024) for the e-value, empirical Bernstein confidence sequence (Howard et al. 2021) for the running mean. Use `decisionFiredAt` to early-stop campaigns that are decisive at, say, 30 paired observations rather than burning all 100 you budgeted for.

**Common pattern:** call after every campaign tick. The recommendation is anytime-valid; if it returns `'continue'`, keep running; if it returns `'promote_now'` or `'reject_now'`, stop and act.

---

## Outcome calibration — does the rubric actually predict deployment?

Without this loop every rubric is faith-based. `rubricPredictiveValidity` joins canonical `RunRecord`s to a `DeploymentOutcomeStore` (matched on `runId`), computes Pearson + Spearman + bootstrap CI per (rubric, outcome) pair, and ranks rubrics by `|spearman|` against the outcomes that actually matter (revenue, retention, CSAT, churn, support-tickets, …).

```ts
import { rubricPredictiveValidity } from '@tangle-network/agent-eval/reporting'
import { FileSystemOutcomeStore } from '@tangle-network/agent-eval'

const validity = await rubricPredictiveValidity({
  runs: lastQuarterRuns,                          // RunRecord[] from runEvalCampaign
  outcomes: new FileSystemOutcomeStore({ root: PROD_OUTCOMES }),
  outcomeMetrics: ['revenue_lift', 'retention_30d', 'csat'],
})

for (const r of validity.ranked) {
  console.log(`${r.rubric} → ${r.bestOutcome}: ρ=${r.spearman.toFixed(2)} (${r.verdict})`)
}
```

Verdict bucketing on `|spearman|`:

- `load_bearing` ≥ 0.7 — keep, weight heavily, defend in launch reviews.
- `informative` ≥ 0.4 — useful as one signal among many; don't gate on it alone.
- `decorative` < 0.4 — score is uncorrelated with the outcome that matters; deprecate, demote in composite weighting, or trigger recalibration. **A rubric with a strong negative correlation against a desired outcome buckets as `load_bearing` by magnitude — inspect the sign before promoting it.**

Wire this on a quarterly cadence. When a previously-load-bearing rubric drifts toward `decorative` it's almost always one of: (a) the model has shifted, (b) the user base has changed, (c) the rubric has been overfit to last quarter's failure modes. Each has a different fix; the calibration check distinguishes them.

`correlationStudy` continues to ship for the lower-level case of joining a `TraceStore` to an `OutcomeStore` over arbitrary eval metrics. `rubricPredictiveValidity` is the campaign-shaped wrapper purpose-built for the `RunRecord` artifact.

---

## EvalCampaign — preferred starting point for new evals

The four capture-integrity directives below are the operational discipline. **`runEvalCampaign` is what wires them by construction.** New consumers should reach for the campaign primitive first; the directives become "things the framework owns," not "things you might forget."

```ts
import { runEvalCampaign } from '@tangle-network/agent-eval'
import { traceAnalystOnRunComplete } from '@tangle-network/agent-eval/traces'
import { FileSystemTraceStore } from '@tangle-network/agent-eval/traces'

const result = await runEvalCampaign({
  campaignId: 'launch-2026-q2',
  commitSha: process.env.GIT_SHA!,
  variants: [
    { id: 'baseline', payload: { prompt: PROMPTS.v1 } },
    { id: 'cand-tool-repair', payload: { prompt: PROMPTS.v2 } },
  ],
  scenarios: scenarios,                        // [{ scenarioId: 'task-1' }, ...]
  seeds: [0, 1, 2, 3, 4],
  llmOpts: { baseUrl, apiKey, defaultTimeoutMs: 60_000 },
  storeFactory: ({ runId }) => new FileSystemTraceStore({ root: `${WORK}/trace/${runId}` }),
  workDir: WORK,                               // FileSystemRawProviderSink lands at WORK/raw-events/<runId>/
  onRunComplete: [traceAnalystOnRunComplete({ analyze: analystOpts, save })],
  preregistrationHash: signedManifest.contentHash,
  report: { comparator: 'baseline', rope: { low: -0.02, high: 0.02 } },
  runner: async (ctx) => {
    await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
    const { result } = await callLlmJson(req(ctx.variant), ctx.llmOpts)   // raw HTTP captured by construction
    const score = await judgeOutput(result.content, ctx.scenarioId, ctx.llmOpts)
    await ctx.emitter.endRun({ pass: score > 0.5, score })
    return {
      pass: score > 0.5, score,
      costUsd: result.costUsd ?? 0,
      tokenUsage: { input: result.usage.promptTokens, output: result.usage.completionTokens },
      model: 'claude-sonnet-4-6@2025-04-15',
      promptHash: hashPrompt(ctx.variant.prompt),
      configHash: hashConfig(ctx.variant),
    }
  },
})

// result.runs:               RunRecord[] for downstream pipelines
// result.integrityReports:   per-run capture-integrity reports
// result.failedRuns:         cells that threw or failed integrity (mark_failed default)
// result.report:             researchReport — promote/hold/equivalent/reject + methodology
// result.campaignFingerprint: SHA-256 over the canonicalised plan
```

**What the campaign owns** so the consumer doesn't:
- `assertLlmRoute(llmOpts, { requireExplicitBaseUrl: true, requireAuth: true })` once at preflight.
- A fresh `TraceStore` and `RawProviderSink` per cell; the runner gets an `LlmClientOptions` already wired with `rawSink` + `traceContext`. Calling an LLM without capturing it requires actively bypassing the campaign.
- `assertRunCaptured(store, runId, { requireRawCoverageOfLlmSpans: true, requireOutcome: true })` after every `endRun`.
- Auto-execution of `traceAnalystOnRunComplete` if you pass an analyst config in `onRunComplete`.
- `researchReport` over the collected runs at the end with the campaign's `preregistrationHash` baked in.

**When NOT to use the campaign:**
- Trajectory-shaped GEPA optimization → `runImprovementLoop` (steered prompts, paired seeds, intermediate metrics).
- Prompt + code evolution with mutation, sandbox pools, lineage → `runPromptEvolution` + `createCompositeMutator`.
- Long-running agent control loops with budgets → `runAgentControlLoop` (the campaign is for *measurement*, not the live runtime).

The four directives below remain the source of truth for *why* the campaign does what it does. Read them when something fails — the issue codes (`missing_raw_events`, `orphan_llm_span`, `no_explicit_base_url`, …) are the campaign's failure modes too.

---

## Capture integrity (REQUIRED for launch-grade adoption)

A run that *appears* successful but lost its forensic evidence is worse than a failed run — a launch reviewer can't distinguish "we measured a real win" from "we measured nothing on the wrong route." The four directives below are the operational discipline that turns the analytical primitives into a launch-grade artifact. **Skip one and the consumer's run is descriptive, not anchoring.**

If you're wrapping agent-eval in a matrix runner, propose-review loop, or `BuilderSession`-driven sweep, you wire all four. Trace evidence + paired stats + held-out gate is the analytical surface; capture + route guard + integrity assertion + auto-orchestration is what makes that surface trustworthy.

### Directive 1 — every eval run wires a `RawProviderSink`

```ts
import { FileSystemRawProviderSink, callLlm } from '@tangle-network/agent-eval'
const sink = new FileSystemRawProviderSink({ dir: `${workDir}/raw-events` })
await callLlm(req, { rawSink: sink, traceContext: { runId, spanId }, ...llmOpts })
```

**Why**: `LlmSpan` records *intent* (model, messages, output, token counts). The raw HTTP body is *ground truth*. Token counts can lie; a proxy can echo a different `model` than answered. Without raw capture you cannot answer "did the verifier hit the wrong route?" or "where did the reasoning tokens go?" after the fact.

**Default redaction** strips `Authorization` / `X-Api-Key` / `X-Auth-Token` / `Cookie` headers and credential-shaped body fields (`apiKey`, `bearer`, `password`, `secret`, `token`, `refresh_token`, …). `event.redactedFields` records the paths so a reviewer sees what was stripped without exposing values. Every retry attempt produces its own `request` and `response` (or `error`) event with `attemptIndex`.

**Sinks**: `InMemoryRawProviderSink` (tests, dev), `FileSystemRawProviderSink` (rolls at 32 MiB, NDJSON), `NoopRawProviderSink` (when explicitly opting out — annotate why). DuckDB / Langfuse / object-store implementations land downstream against the same interface.

**Shipped incident**: `blueprint-agent` matrix run failed launch review because raw events were never written; structured spans alone could not answer "was the verifier hitting the free-tier router?"

### Directive 2 — assert the route at preflight

```ts
import { assertLlmRoute } from '@tangle-network/agent-eval'
assertLlmRoute(llmOpts, {
  requireExplicitBaseUrl: true,                                 // never silently fall back to DEFAULT_BASE_URL
  allowedBaseUrls: [/api\.openai\.com/, /router\.tangle\.tools/],
  requireAuth: true,
  expectedProvider: 'openai',                                   // optional: pin the resolved provider
})
```

**Why**: with `baseUrl` undefined, `callLlm` falls back to `DEFAULT_BASE_URL`. An eval sweep that quietly targets the public/free-tier route produces launch-decision-grade artifacts on the wrong provider — the report scores something the operator never intended to ship. Pure function, no I/O — call from constructors, CI gates, preflight validators.

`LlmRouteAssertionError.code` is structured (`no_explicit_base_url` | `base_url_blocked` | `base_url_not_allowed` | `no_auth` | `wrong_provider`) for programmatic recovery.

### Directive 3 — assert the run captured before declaring done

```ts
import { assertRunCaptured, throwIfRunIncomplete } from '@tangle-network/agent-eval'
const report = await assertRunCaptured(store, emitter.runId, {
  llmSpansMin: 1,
  judgeSpansMin: 1,
  rawSink,
  requireRawCoverageOfLlmSpans: true,    // every LlmSpan has a matching raw `request` event
  requireOutcome: true,
})
throwIfRunIncomplete(report)             // strict; or branch on report.issues for retry
```

**Why**: a run can complete with `status='completed'` and zero raw events (sink wired to wrong dir, fs error swallowed, integrity wired but disk full). Without an end-of-run assertion the partial-capture bug class is invisible until launch review. `requireRawCoverageOfLlmSpans` specifically catches the case where the structured `LlmSpan` was emitted but the raw HTTP capture went to a different sink — the highest-stakes silent failure in the eval pipeline.

Issue codes: `no_run` | `missing_llm_spans` | `missing_judge_spans` | `missing_tool_spans` | `missing_raw_events` | `no_raw_sink` | `orphan_llm_span` | `missing_outcome`.

### Directive 4 — auto-execute the trace analyst via hook, not out-of-band

```ts
import { TraceEmitter } from '@tangle-network/agent-eval'
import { traceAnalystOnRunComplete } from '@tangle-network/agent-eval/traces'

const emitter = new TraceEmitter(store, {
  onRunComplete: [
    traceAnalystOnRunComplete({ analyze: { source, ai }, save: writeAnalysis }),
  ],
})
```

**Why**: out-of-band steps get skipped (CI flag forgotten, env var missing, "I'll run it manually after"). Declarative hooks fire as part of `endRun` / `abortRun` and never get omitted. Hook errors are swallowed and recorded as `log` events by default — auto-orchestration must not crash the underlying flow. Opt into propagation with `hookErrors: 'throw'` for tests.

**Shipped incident**: `blueprint-agent` matrix run never produced an analyst artifact for a sweep the consumer expected to be self-analyzing.

### Composed shape — the four together

```ts
const sink = new FileSystemRawProviderSink({ dir: `${workDir}/raw-events` })
assertLlmRoute(llmOpts, { requireExplicitBaseUrl: true, allowedBaseUrls, requireAuth: true })

const emitter = new TraceEmitter(store, {
  onRunComplete: [traceAnalystOnRunComplete({ analyze: analystOpts, save: writeAnalysis })],
})
await emitter.startRun({ scenarioId, layer: 'app-runtime' })
// LLM calls flow through callLlm with `{ rawSink: sink, traceContext: { runId, spanId } }`.
await emitter.endRun({ pass, score })

const integrity = await assertRunCaptured(store, emitter.runId, {
  llmSpansMin: 1, rawSink: sink, requireRawCoverageOfLlmSpans: true, requireOutcome: true,
})
throwIfRunIncomplete(integrity)
```

If you're skipping any of the four for a reason that isn't "this is a unit test, capture is irrelevant," document the reason inline. The cost of capture is one NDJSON file; the cost of skipping it is the next launch decision.

---

## Pitfalls

1. **Pin the model snapshot.** `validateRunRecord` rejects bare aliases like `claude-sonnet-4-6`. Record `claude-sonnet-4-6@2025-04-15`. Aliases re-map silently; a bare-alias row can't be re-evaluated.

2. **`costUsd` is mandatory.** If you don't have it, record `0` and set `outcome.raw.cost_unknown = 1`. Don't drop the field — the validator throws.

3. **`HeldOutGate` pairs by `(experimentId, seed)`.** A candidate run with no matching baseline seed gets dropped. If productive-run counts look low, your seeds are misaligned.

4. **`splitTag` is load-bearing.** `HeldOutGate` reads `'holdout'` for the paired delta and search-split for the overfit-gap. Mistagging corrupts the verdict.

5. **`pairedBootstrap` needs a seed.** Default is `Math.random()`. Pass `seed` whenever the result feeds a CI / promotion decision; otherwise CIs wobble across runs.

6. **`summaryTable`'s BH correction is local.** Adjusts within the comparator set only. Cross-experiment correction is your job.

7. **Canaries don't fail tests.** `runCanaries` returns a report. Wire it to a notification channel.

8. **Silent-fallback constant defaults to `0.30`** to match `propose-review.ts`. Override if your judge uses a different fallback.

9. **Reference benchmarks fail loud.** GSM8K throws without `AGENT_EVAL_GSM8K_PATH`; SWE-Bench-Lite throws without `AGENT_EVAL_SWEBENCH_GRADER_CMD`. Never default to silent-pass.

10. **Don't re-implement the gate.** Inline "honesty override" / "minimum runs" / "paired delta on holdout" blocks are `HeldOutGate`. Use the primitive.

11. **`Researcher` is an interface, not an implementation.** Real brains live downstream. Keeping this stub-only is what keeps the contract stable.

12. **`researchReport` is async.** Web Crypto is used for the run fingerprint; `await` it. The only caller you might miss is a synchronous test helper.

13. **`researchReport.minPairs` defaults to 20.** Anything below the hard floor `RESEARCH_REPORT_HARD_PAIR_FLOOR` (6) is rejected — promotion calls on under-powered evidence are caller error, not soft warnings.

14. **`RawProviderSink` redaction is allowlist-of-strip, not allowlist-of-keep.** The default redactor strips well-known auth headers and credential-shaped body fields, but a custom header your proxy uses won't be auto-stripped. If a non-standard auth scheme is in play (`X-Org-Token`, etc.), pass a `redactor` that extends `defaultProviderRedactor`. The cost of a leaked token in NDJSON is high.

15. **Hook errors are swallowed and logged by default.** `TraceEmitterOptions.onRunComplete` hooks that throw don't crash the run — that's intentional, auto-orchestration must not fail the underlying flow. If a hook is *load-bearing* for the run's correctness (e.g. a gate that must pass before declaring success), set `hookErrors: 'throw'` or wire the gate as an explicit assertion outside the hook.

---

## Regression tests worth writing

- **`HarnessConfig.cwd` honored end-to-end** — real spawn, not source-grep.
  `realpathSync` the temp dir on macOS or the test fails on Darwin.
- **Muffled-gate invariant scanner** — code-grep for the seven patterns
  above. Template: starter-foundry's `tests/muffled-gate-invariant.test.ts`.
- **Planted-regression smoke** — periodically revert one fix and confirm
  the invariant catches it with exact `file:line`. An invariant that's
  never been seen failing might not actually work.

---

## Evolution loops (prompt + code channels)

When you need to optimize a prompt OR a code surface (a system prompt,
a tool catalog, a scaffold template) against a measurable metric, use
`runPromptEvolution` with `createCompositeMutator` rather than rolling a
loop yourself. Two adapters and a config — that's the contract.

**Adapter shape** (both already have reference impls, you supply the
runtime hookup):

- `ScoreAdapter.score({ variant, scenarioId, rep })` — runs your eval
  for one (variant, scenario, rep) tuple. Returns `TrialResult` with
  `score`, `cost`, `metrics`. The loop calls this in parallel up to
  `scoreConcurrency`. Cache via `JsonlTrialCache` for crash resume.

- `MutateAdapter.mutate({ parent, parentAggregate, topTrials,
  bottomTrials, childCount, generation })` — proposes children of a
  variant. Two reference implementations:
  - `reflective-mutation.ts` (prompt channel) — `buildReflectionPrompt`
    + `parseReflectionResponse` + your LLM. Trace-conditioned: the
    model sees top/bottom trials and reasons about why some variants
    outperformed, instead of blind paraphrase.
  - `createSandboxCodeMutator` (code channel) — invokes a coding agent
    inside a `SandboxPool` slot. Owns checkout/release, telemetry
    write-through (mutations.jsonl, lineage, cost-ledger), failure
    capture. You supply `runner` (invoke the agent) and
    `toVariantPayload` (encode the diff).

**Composite policy** is the load-bearing escape hatch. `policy:
'plateau'` runs the prompt mutator until improvement stalls (delta <
`plateauThreshold` for `plateauPatience` consecutive gens), then
auto-switches to a 50/50 split with the code mutator. Without this,
you either burn budget on prompt rewrites that have hit a structural
ceiling, or you skip the cheap-wins gradient and dive straight into
expensive code edits. The plateau path lets the loop hand its own
flag to the more expensive mutator only when it's earned the cost.

**Telemetry sinks** — pass them in if you want a forensic trail:
`MutationTelemetry` (mutations.jsonl), `TrialTelemetry` (trials.jsonl),
`LineageRecorder` (event-log lineage with optional snapshot via
`compact()`), `CostLedger` (per-channel + per-generation breakdown).
The `code-mutator` writes through automatically when you pass them as
options; the `score-adapter` is yours to wire (call
`trialTelemetry.record(...)` after each scored trial).

### Footguns specific to evolution loops

1. **Don't stash the prompt mutator's LLM responses outside the cache.**
   `JsonlTrialCache` is for trial scores, not LLM responses. If you
   want to dedup mutation calls (same parent + same top/bottom set →
   same proposals), implement that inside your `MutateAdapter`. The
   loop driver doesn't dedup mutations; that's deliberate — even
   "same trial set" runs different LLM completions across reps.

2. **The code channel needs a real reset() in your `SlotFactory`.**
   `git reset --hard origin/main && git clean -fd` is the minimum;
   anything less and child variant N+1 inherits N's diff. The pool
   calls reset before reuse but does NOT call it before the very
   first checkout — the factory's `create()` is responsible for
   leaving the slot in a checked-out clean state.

3. **Pareto objectives have a direction.** `direction: 'maximize'` for
   score, `direction: 'minimize'` for cost. Forgetting `minimize`
   makes the frontier think a $5 variant dominates a $1 variant.

4. **Plateau detection requires reps ≥ 2.** With `reps: 1`, a single
   trial-noise spike looks like real improvement and the loop never
   detects the plateau. Three reps is the floor I'd run; five for
   high-variance scoring.

5. **`MutationChannel` is `'prompt' | 'code'` only.** Tools, scaffold,
   tool descriptions, scoring code — all are `'code'` from the loop's
   perspective (anything that runs through a coding agent in a
   sandbox slot). Don't fork the type.

## Extend, don't duplicate

Before adding machinery, check the "Decide where to start" table above.
If what you need isn't there, the PR that adds it to agent-eval is
more valuable than a local copy that will drift. Consumers that have
lived this (and back-filled primitives into this table): VerticalBench
(`blueprint-agent`), starter-foundry, the bench-report package.

Two primitives are intentionally absent — tracked in `CHANGELOG.md`
for the future generation that ships them:

- **Default reviewer implementation** for `propose-review`'s `ReviewFn`
  slot. `propose-review` ships the loop (propose + verify + review +
  memory); it does not ship a prebuilt reviewer. VerticalBench's
  `shot-reviewer.ts` is the design reference — will land upstream with
  its design review.
- **Toolchain-flavored `mergeLayerResults` extension** that propagates
  per-layer numeric diagnostics (`layerErrorCount`) and customizable
  finding-message prefixes. The 0.9 primitive is cleaner than most
  consumers need; VerticalBench keeps its own flavor until the upstream
  extension lands.

---

## Consumer adoption — canonical product-agent layout

You are wiring a product agent (gtm, creative, legal, tax, agent-builder, physim, or new) onto `@tangle-network/agent-eval`. The substrate has matured (0.50.2+). There is **one canonical file layout, one record shape, one set of entry points**. Use it.

This section is for people writing **product code that consumes the substrate** — different audience from the §Production-rigor primitives above (which is for substrate-internal authoring + API-correctness). Both audiences should know each other's section exists.

### The one canonical layout

```
<product-repo>/
  eval/
    scenarios.json              ← THE canonical scenario list (DatasetScenario[])
    judges.ts                   ← judge ensemble + composite weights
    agent-profile.ts            ← the agent under test (defineAgent / AgentProfile)
    scripts/
      run-campaign.ts           ← pnpm eval — runs scenarios, writes records.jsonl
      insight-report.ts         ← pnpm eval:report — analyzeRuns() + InsightReport
      self-improve.ts           ← pnpm self-improve — selfImprove() closed loop
    .runs/
      <campaign-id>/
        records.jsonl           ← RunRecord[] — the ONLY canonical record shape
        scores.json
        traces.jsonl            ← optional per-span trace dump
```

**Non-negotiable:**

1. **File name is `scenarios.json`** (or `scenarios.ts` if scenarios need code). NEVER `personas.json`, `tasks.json`, `cases.json`. The substrate's `runCampaign` reads `DatasetScenario[]`; renaming creates discovery friction for every new agent author.
2. **Record shape is `RunRecord`** (substrate-native). NEVER a custom golden shape (`{personaId, score, pass, grader, judges, notes}`). Custom shapes break `analyzeRuns()`, the hosted wire format, every downstream adapter. If a consumer needs richer fields, put them in `RunRecord.outcome.raw` (escape hatch) — never restructure the envelope.
3. **`eval/.runs/<campaign-id>/`** is the canonical location. NOT `tests/eval/.runs/`, NOT `data/traces/`, NOT scattered. One predictable path every tool finds.
4. **Three pnpm scripts** are the entire consumer-facing API:
   - `pnpm eval` — fire the campaign (write records.jsonl)
   - `pnpm eval:report` — render the decision packet (no LLM cost)
   - `pnpm self-improve` — run the closed loop (LLM cost, opt-in)

### The three scripts — copy-paste-ready

#### `eval/scripts/insight-report.ts`

```typescript
/**
 * Loads the most recent records.jsonl under eval/.runs/ and renders the
 * agent-eval InsightReport via analyzeRuns(). Run with: pnpm eval:report
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeRuns } from '@tangle-network/agent-eval/contract'
import type { RunRecord } from '@tangle-network/agent-eval'

const RUNS_DIR = 'eval/.runs'

interface LatestHit { path: string; mtime: number }

function findLatestRecordsFile(): string | null {
  // State-holder pattern so closure mutation of `latest` survives TS2339
  // narrowing under strict mode.
  const state: { latest: LatestHit | null } = { latest: null }
  function walk(dir: string) {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) walk(p)
      else if (e === 'records.jsonl' && (!state.latest || s.mtimeMs > state.latest.mtime)) {
        state.latest = { path: p, mtime: s.mtimeMs }
      }
    }
  }
  walk(RUNS_DIR)
  return state.latest?.path ?? null
}

async function main() {
  const path = findLatestRecordsFile()
  if (!path) { console.error(`No records.jsonl found under ${RUNS_DIR}/`); process.exit(1) }
  const runs: RunRecord[] = readFileSync(path, 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as RunRecord)
  console.log(`Loaded ${runs.length} runs from ${path}\n`)
  const report = await analyzeRuns({ runs })
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
```

Package.json: `"eval:report": "tsx eval/scripts/insight-report.ts"`.

#### `eval/scripts/self-improve.ts`

```typescript
/**
 * Closed-loop self-improvement. Costs LLM tokens — opt-in only.
 * Run with: pnpm self-improve (or pnpm self-improve --dry to typecheck only)
 */
import { selfImprove, gepaDriver } from '@tangle-network/agent-eval/contract'
import { scenarios } from '../scenarios'
import { judges } from '../judges'
import { agent, baselineSurface } from '../agent-profile'

async function main() {
  if (process.argv.includes('--dry')) {
    console.log('Dry-run: wiring is type-correct. Pass without --dry to actually run.')
    return
  }
  const result = await selfImprove({
    scenarios, agent, judge: judges[0]!, baselineSurface,
    driver: gepaDriver(),
    budget: { generations: 1, populationSize: 2, holdoutFraction: 0.3 },
  })
  console.log(`Gate decision:  ${result.gateDecision}`)
  console.log(`Lift:           ${result.lift.toFixed(3)}`)
  console.log(`Total cost USD: $${result.totalCostUsd.toFixed(2)}`)
  for (const r of result.insight.recommendations) {
    console.log(`  [${r.priority}] ${r.title}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
```

Package.json: `"self-improve": "tsx eval/scripts/self-improve.ts"`.

### What `selfImprove()` actually mutates — be precise

`MutableSurface = string | CodeSurface`. In every current consumer, **one string** (a system-prompt addendum). The loop does NOT mutate:

| Thing | Mutated by `selfImprove`? |
|---|---|
| The `baselineSurface` string the consumer designates | **Yes** — only this |
| User messages in scenarios | No — scenarios are fixed corpus |
| Scenario list | No |
| Judge prompt / rubric | No by default — pass-through config |
| Reviewer / driver's own reflection prompt | No by default |
| Model / temperature / tools | No — runtime constants |

**The substrate IS surface-agnostic** — you can point a driver at a judge prompt, a reviewer prompt, or even a driver's own reflection prompt, IF you wire (a) that string as the `surface` and (b) a meta-judge that scores the output of running through the new prompt. Nobody does this today; it's a recursive capability waiting for a use case.

### Driver choice — decision tree

```
Do you have ≥5 well-defined transformations to test (e.g. directive enum)?
├── YES → `evolutionaryDriver({ mutator })` with a hand-tuned Mutator
│         • $0 mutation cost (deterministic transform per candidate)
│         • Predictable, CI-cron-friendly
│         • Use for repeated runs against the same prompt family
│
└── NO → does your domain need scoring evidence the driver can't reason about
         (e.g. voice-match, ground-truth rubrics, multi-agent transcripts)?
         ├── YES → custom `ImprovementDriver` that consumes the report
         │         + dataset + findings the way your domain needs
         │
         └── NO → `gepaDriver()` (the default)
                  • Reflective LLM mutation reading per-scenario scores +
                    weakest dimensions
                  • $$ per candidate (LLM call to propose), but discovery
                    breadth wins when the search space is fuzzy
                  • Surface-agnostic: works on any string
```

**Recipe by tier:**

- **Prompt-tier (string surface)** — start with `gepaDriver()`. Escalate to a custom `Mutator` + `evolutionaryDriver` only when you have a known directive enum that beats LLM-discovery.
- **Code-tier (`CodeSurface`)** — use agent-runtime's `improvementDriver` with a `reflectiveGenerator` or `agenticGenerator`. The substrate's drivers don't reason about code diffs.
- **Knowledge-tier** — out of scope here; agent-knowledge owns this.

### Surface menu — what string to pick

When wiring `baselineSurface`, ask: what's the ONE string whose change has the highest measurable effect on the agent's behavior?

Common answers, ranked:

1. **System-prompt addendum** — a markdown file or constant the production prompt appends. Highest impact per character. **Default; all current consumers do this.**
2. **Full system prompt** — replace the whole thing. More powerful but higher regression risk. Use only when (a) the prompt has structural issues, (b) you have a robust gate.
3. **One specific specialist's prompt** — when only one agent role drives the failing dimension.
4. **Judge / reviewer prompt** — recursive; requires a meta-judge. Powerful but operationally complex. Defer until pass-1 prompt evolution converges.
5. **Tool description / function spec** — when failures are tool-selection mistakes.

The recommendation: **pick option 1** for the first selfImprove cycle. Only escalate to 2–5 when option 1 plateaus across 3+ generations.

### Drift you will encounter — fix in place, don't perpetuate

| Drift symptom | Why it exists | Canonical fix |
|---|---|---|
| `personas.json` instead of `scenarios.json` | Product UI is persona-driven; team named the eval file to match. | Rename to `scenarios.json`. `DatasetScenario` IS the persona shape. |
| Custom golden record shape (`{personaId, score, pass, grader, ...}`) | Predates `RunRecord` canonical. | Rewrite the writer to emit `RunRecord` (push custom fields into `outcome.raw`). |
| Records under `tests/eval/.runs/` instead of `eval/.runs/` | Pre-substrate placement, kept by inertia. | Move to `eval/.runs/`. The "tests" prefix lies about what's there. |
| Scenarios scattered across multiple files | Organic growth. | Consolidate into single `eval/scenarios.json`. Re-export during migration; delete scattered files in follow-up. |
| Bespoke `metrics.ts` computing mean / variance / IQR | Predates `analyzeRuns()`. | Delete; replace with `pnpm eval:report`. |
| Bespoke `scorecard-integration.ts` | Wraps `recordRunsToScorecard` + `diffScorecard` — LEGITIMATE substrate primitives, distinct from `analyzeRuns()`. | KEEP. Scorecard timeline is orthogonal to insight packet. |

### Verification checklist

Every product agent should pass:

1. `pnpm eval` — writes a `records.jsonl` whose first line `JSON.parse`s to a `RunRecord` (has `runId`, `outcome.{searchScore | holdoutScore}`, `experimentId`, `costUsd`, `tokenUsage`).
2. `pnpm eval:report` — loads that records.jsonl, prints a JSON `InsightReport` with `composite`, `recommendations`, `costQuality`, `judges`. If `recommendations: []` on a corpus where composite is poor, the substrate has a bug — file it.
3. `pnpm self-improve --dry` — typechecks the wiring without LLM calls. `pnpm self-improve` without `--dry` runs the live loop with real cost.

If any fails, the consumer is not canonically adopted yet.

## Status of this doc

**Sole source of truth for agent-eval usage directives AND product-agent adoption.**

- `README.md` points here.
- `CLAUDE.md` points here.
- Inline JSDoc uses `see .claude/skills/agent-eval/SKILL.md §<section>`.

If you update the API and this file goes out of sync, the API change is
incomplete. Same rule for the footguns, rules, and consumer-adoption
patterns — they were written from shipped incidents and shipped product
agents. Extending the list is welcome; silently deleting an entry is not.
