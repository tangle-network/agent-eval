---
name: agent-eval
description: Trace-first evaluation framework for code-generator + LLM-in-the-loop systems. Sandbox harness + build gates, BuilderSession, three-layer scoring, meta-judge with compile short-circuit, LLM client with graceful degrade, multi-layer verification pipeline, semantic-concept judge, multi-toolchain layer merge. Directives below encode shipped-bug lessons — read before writing integration code.
---

# agent-eval — usage directives

**You're an agent writing integration code? Read this whole file.** Each rule below was paid for in a shipped bug; skip one and the bug class reappears.

**You're a human onboarding?** Read [`docs/concepts.md`](../../../docs/concepts.md) first — 5-minute mental model — then come back. The rest of this file is dense by design (it's a footgun bible, not a tutorial).

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
| Capture every provider HTTP request/response for forensics | `RawProviderSink` + `LlmClientOptions.rawSink` (§Capture integrity Directive 1) |
| Fail loud if the eval would silently use the wrong route | `assertLlmRoute` (§Capture integrity Directive 2) |
| Assert at run-end that the artifact is complete | `assertRunCaptured` + `throwIfRunIncomplete` (§Capture integrity Directive 3) |
| Auto-execute the trace analyst on every run | `traceAnalystOnRunComplete` + `TraceEmitterOptions.onRunComplete` (§Capture integrity Directive 4) |
| Stable hook for an external research-driver agent | `Researcher` (interface) + `NoopResearcher` (placeholder) |

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

## Capture integrity (REQUIRED for launch-grade adoption)

A run that *appears* successful but lost its forensic evidence is worse than a failed run — a launch reviewer can't distinguish "we measured a real win" from "we measured nothing on the wrong route." The four directives below are the operational discipline that turns the analytical primitives into a launch-grade artifact. **Skip one and the consumer's run is descriptive, not anchoring** — the same failure mode that prompted the 0.21.0 release.

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

**Shipped incident**: same `blueprint-agent` matrix run silently used the public router; 0.21 ships this so the next consumer fails closed at preflight.

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

12. **`researchReport` is async (0.21+).** Web Crypto is used for the run fingerprint; `await` it. The only caller you might miss is a synchronous test helper.

13. **`researchReport.minPairs` defaults to 20 (0.21+).** The pre-0.21 default was 6; that was the soft floor of a rigorous report and got bumped because the previous default invited promotion calls on under-powered evidence. The hard floor (`RESEARCH_REPORT_HARD_PAIR_FLOOR`) is 6 and overrides any caller setting below it.

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

## Status of this doc

**Sole source of truth for agent-eval usage directives.**

- `README.md` points here.
- `CLAUDE.md` points here.
- Inline JSDoc uses `see .claude/skills/agent-eval/SKILL.md §<section>`.

If you update the API and this file goes out of sync, the API change is
incomplete. Same rule for the footguns and rules — they were written
from shipped incidents. Extending the list is welcome; silently
deleting an entry is not.
