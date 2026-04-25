---
name: agent-eval
description: Trace-first evaluation framework for code-generator + LLM-in-the-loop systems. Sandbox harness + build gates, BuilderSession, three-layer scoring, meta-judge with compile short-circuit, LLM client with graceful degrade, multi-layer verification pipeline, semantic-concept judge, multi-toolchain layer merge. Directives below encode shipped-bug lessons — read before writing integration code.
---

# agent-eval — usage directives

**One authoritative doc.** `README.md`, `CLAUDE.md`, inline JSDoc all
point here. The rules below were paid for in real bugs; skip one and
the bug class reappears.

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

Extend, don't fork — see §"Extend, don't duplicate."

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
//  BROKEN — cwd silently dropped (pre-0.7.1)
new SubprocessSandboxDriver({ cwd: dir })

//  CORRECT — cwd travels with the call
new SubprocessSandboxDriver()
session.ship({ harness: { cwd: dir, testCommand: 'pnpm exec tsc --noEmit', ... } })
```

**Why**: `SubprocessSandboxDriver.exec(phase, command, config)` spawns
with `cwd: config.cwd`. The driver is stateless-per-call by design so
one driver serves many concurrent sandboxes. 0.7.1+ treats
`{cwd?, env?}` as fallbacks only — per-call config always wins.

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

## Regression tests worth writing

- **`HarnessConfig.cwd` honored end-to-end** — real spawn, not source-grep.
  `realpathSync` the temp dir on macOS or the test fails on Darwin.
- **Muffled-gate invariant scanner** — code-grep for the seven patterns
  above. Template: starter-foundry's `tests/muffled-gate-invariant.test.ts`.
- **Planted-regression smoke** — periodically revert one fix and confirm
  the invariant catches it with exact `file:line`. An invariant that's
  never been seen failing might not actually work.

---

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
