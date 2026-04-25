---
name: agent-eval
description: Trace-first evaluation framework. Use for any code generator / LLM-in-the-loop evaluation: sandbox harness + build gates, BuilderSession (builder-of-builders), three-layer scoring (builder → app-build → app-runtime), meta-judge with compile short-circuit, workspace snapshots + assertions. Directives encode 10+ shipped-bug lessons — read before writing integration code.
---

# agent-eval — usage directives

One authoritative doc. The README is a pointer to here. No JSDoc essay
duplicates this content — APIs use short pointer comments (`see SKILL.md
§<section>`). Update this file, not a sidecar.

The rules below were paid for in real bugs. Each one has a shipped-and-caught
incident log entry behind it; skip one and the bug class reappears.

---

## When to use agent-eval

- **Code generator evaluation**: LLM emits a scaffold, manifest, config, or
  patch; you need to know if it compiles, runs, and matches the intent.
- **Multi-turn agent benchmarks**: scenario fixtures + judges + convergence
  over turns; see `BenchmarkRunner`, `executeScenario`.
- **Builder-of-builders** ("an agent that builds an app"): runs nest — a
  builder run contains child build runs contains grandchild runtime runs;
  see `BuilderSession`, `three-layer-eval`.
- **Offline A/B on prompts or models**: `ExperimentTracker`,
  `PromptOptimizer`, `PairwiseSteeringOptimizer`.
- **Guardrails on LLM quality**: `createAntiSlopJudge`, `RunCritic`,
  `red-team`, `contamination-guard`.

If your use case is any of these, don't build a parallel harness. Extend
this one (see §"Extend, don't duplicate").

---

## Minimal working path (builder-of-builders)

The pattern that ships in every closed-loop generation project:

```ts
import {
  InMemoryTraceStore, BuilderSession, SubprocessSandboxDriver,
  runAssertions, fileExists,
} from '@tangle-network/agent-eval'

const store = new InMemoryTraceStore()
const driver = new SubprocessSandboxDriver()           // ← no constructor arg
const session = new BuilderSession(store, { projectId: 'my-app' }, driver)

await session.startChat()
const ship = await session.ship({
  harness: {
    setupCommand: 'pnpm install --prefer-offline',
    testCommand: 'pnpm exec tsc --noEmit',             // ← strict, fail-loud
    cwd: composedScaffoldDir,                           // ← MUST be in HarnessConfig
    timeoutMs: 180_000,
  },
})
await session.endChat({ pass: ship.result.passed, score: ship.result.score })

// Structural check complements the build gate
const assertions = [fileExists('package.json'), fileExists('src/main.ts')]
const structural = runAssertions(snapshot, assertions)
```

Three things this example is deliberately doing:
1. **Driver takes no args.** `cwd` goes in `HarnessConfig`, not the
   constructor. (§Footgun 1)
2. **testCommand is strict** — no `|| true` swallow. (§Footgun 2)
3. **Structural + build gates are both run.** Build-only misses missing
   manifest files; structural-only misses broken code. (§Rule: both)

---

## Footgun 1: `cwd` belongs in `HarnessConfig`, not the driver constructor

```ts
//  BROKEN — cwd is silently dropped (pre-0.7.1)
//  FIXED in 0.7.1 — constructor honors cwd/env as fallbacks
new SubprocessSandboxDriver({ cwd: dir })

//  CORRECT — cwd travels with the call
new SubprocessSandboxDriver()
session.ship({ harness: { cwd: dir, testCommand: 'pnpm exec tsc --noEmit', ... } })
```

**Why this matters**: `SubprocessSandboxDriver.exec(phase, command, config)`
spawns with `cwd: config.cwd`. The driver is stateless-per-call by design so
one driver can serve many concurrent sandboxes. Constructor args used to
be silently dropped. 0.7.1 accepts `{cwd?, env?}` as FALLBACKS when the
per-call config omits them — per-call config always wins.

**Shipped incidents**: starter-foundry Gen 8b (promoters), starter-foundry
Round 0 post-Gen-9 (runtime eval). Both silent-passed broken scaffolds with
`exitCode=0` because the constructor arg was dropped and spawn inherited
node's cwd, where the same tsc passed against the wrong project.

**Regression guard**: if your project has a `tests/muffled-gate-invariant.*`
file (recommended — see §"Regression tests worth writing"), add a finder
for the `new SubprocessSandboxDriver({cwd: ...})` shape. A comment
annotation `// muffle-ok: <reason>` opts out.

---

## Footgun 2: Build gate must fail loud

Every build command in an eval harness must propagate nonzero exit codes.

```ts
//  BROKEN — swallows every failure
testCommand: 'pnpm run validate || pnpm run build || true'

//  CORRECT — strict typecheck
testCommand: 'pnpm exec tsc --noEmit'

//  OK — legitimate best-effort setup, annotated
setupCommand: 'forge install --no-git || true', // muffle-ok: forge build is the real gate
```

**Why this matters**: the fidelity/meta judge cannot reliably spot compile
errors. If the build gate returns 0, a broken scaffold scores ~0.8 on
fidelity, passes the gate, ships. Shipped 3 bugs (React 17 imports, .ts
JSX, `esbuild.loader` hallucination) through a `|| true` gate before the
pattern was closed.

**Rule**: the build gate is the signal of truth. If you `|| true` it, you
have no signal. If a specific failure is expected and tolerable, catch
it explicitly in the runner, not in the shell chain.

---

## Footgun 3: Pair the meta judge with a build outcome

`invokeMetaJudge` (or any LLM-as-judge on code) **must** short-circuit on
`buildOutcome.passed=false`:

```ts
if (buildOutcome?.passed === false) {
  return {
    verdict: 'fail',
    overall: 0,
    issues: [{ severity: 'high', description: `build failed: ${buildOutcome.stderr.slice(-400)}` }],
    rationale: 'Build/typecheck failed — scaffold cannot run. LLM scoring skipped.',
  }
}
```

**Why**: LLM judges rate code they CAN'T run. A scaffold that doesn't
compile can still "look right" — imports from the right package, plausible
component structure, idiomatic layout. The judge happily gives 0.85.
Goodhart's Law: the metric (fidelity) rewards what looks right, not what
works. Pair fidelity with a ground-truth gate or the metric lies.

---

## Footgun 4: Snapshot blobs ≠ files

`WorkspaceSnapshot` has two channels:

- `files: Record<string, string>` — UTF-8-valid text, full content.
- `blobs: Record<string, { size, hash?, mimeType? }>` — binaries. Size +
  hash only; no content.

Assertions like `fileExists(path)` check both. Assertions like
`fileContains(path, needle)` only work against `files`. If a test seems to
fail inexplicably on a `.wasm` / `.zkey` / `.png`, it's in the blob channel
— verify with `snapshot.blobs[path]` not `snapshot.files[path]`.

---

## Rule: both gates, not either

Every scaffold eval must run **both** `SandboxHarness.run()` (build gate)
and `runAssertions()` (structural gate). They catch orthogonal failure
classes:

- Build-only misses: manifest promised 10 files; scaffold wrote 7. Build
  passes. Users notice when they open an empty file.
- Structural-only misses: all files exist, one has a TS error. Assertions
  pass. Build would have caught it.

`runAssertions(snapshot, [fileExists(...)...])` is cheap (no subprocess);
run it unconditionally.

---

## Rule: single source of truth for per-language dispatch

If you have a table mapping `taxonomy.language → {setupCommand, testCommand,
timeoutMs}`, export it ONCE from a single module and import everywhere.
Do not copy-paste it into promoters, audit scripts, and CI configs.

Incident: starter-foundry had three copies; Gen 8b fixed two; Gen 9
discovered the third was still muffled. The Gen 9 invariant test now
asserts exactly one copy exists.

---

## Rule: Phase 1.5 audit walks entry-point scripts

Before calling a structural fix complete, grep every file that imports
from `@tangle-network/agent-eval` — not just the lib/ layer.

Incident: Gen 9 scanned `src/**` and skipped `scripts/agent-eval-scaffold.mjs`,
an entry point. Round 0 found the same cwd bug live there.

**Heuristic for scan roots**: `rg -l '@tangle-network/agent-eval' --type ts
--type mjs --type js`. Every match goes in the invariant scanner's
scan list.

---

## Three-layer eval contract

`BuilderSession` emits three layers of traces:

```
builder (L0)           # startChat → endChat
  └── app-build (L1)   # ship({harness}) → harness exit
        └── app-runtime (L2)  # runAppScenario — only after ship succeeds
```

Contract:
- `startChat()` before anything else.
- `ship()` at most once per `startChat()` (idempotent: re-call throws).
- `runAppScenario()` only after `ship()` returns `passed=true`. Call
  order guarded; throws if you call runtime without a successful build.
- `endChat({pass, score})` closes the builder run. The builder's pass/
  score is YOUR aggregation of the child layers — agent-eval doesn't
  force one.

`scoreProject` / `scoreAllProjects` compute defensible aggregates across
the three layers; pass `kind: 'scaffold-only'` when you only ran
build + structural (no app-runtime).

---

## Regression tests worth writing

Every consumer of agent-eval should carry these tests in its own suite:

### 1. `HarnessConfig.cwd` is honored end-to-end

Not source-grep — real spawn. Prevents regressions where agent-eval's
driver stops reading per-call cwd (unlikely but would be silent):

```ts
it('driver honors HarnessConfig.cwd at spawn time', async () => {
  // macOS: `/var/folders` symlinks to `/private/var/folders` and bash's
  // pwd resolves it. Use realpathSync or the test fails on Darwin.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 't-')))
  const r = await new SubprocessSandboxDriver().exec('run', 'pwd', { cwd: dir })
  expect(r.stdout.trim()).toBe(dir)
})
```

### 2. Muffled-gate invariant scanner

Code-grep test scanning your repo for the patterns that shipped bugs:
`|| true` in command strings, `testCommand: 'true'` literal, `?? 'starter'`
or similar permissive defaults, `if (!expected) return true` in matchers,
`if (p.skipped) return true` in scorers, duplicate per-language switch
tables, `new SubprocessSandboxDriver({cwd: ...})` constructor-drop.

Template implementation: starter-foundry's
`tests/muffled-gate-invariant.test.ts`. Escape hatch: `// muffle-ok:
<reason>` on the same line opts a legitimate fallback out.

### 3. Planted-regression smoke

Once the invariant test exists, periodically revert one of the fixes and
confirm the invariant catches it with exact `file:line`. An invariant
that's never been seen failing might not actually work.

---

## Extend, don't duplicate

Check what agent-eval already has before adding new machinery. The
highest-leverage thing you can do is extend the existing harness, not
fork it. Canonical primitives:

| Need | Use |
|------|-----|
| Run a build with structured result | `SandboxHarness` + `SubprocessSandboxDriver` |
| Parse test output (vitest/jest/pytest) | `composeParsers(...)`, `vitestTestParser`, `pytestTestParser`, `jestTestParser` |
| Score a scaffold | `scoreProject` / `scoreAllProjects` (three-layer-eval) |
| Grade multi-turn agents | `BenchmarkRunner` + judges + `ConvergenceTracker` |
| LLM-as-judge | `createCustomJudge`, `createAntiSlopJudge`, `RunCritic` |
| Meta-agent driving a product | `AgentDriver` |
| Prompt A/B | `ExperimentTracker` + `PromptOptimizer` |
| Find the commit that broke a metric | `bisector` |
| Detect contamination / memorization | `contamination-guard` |
| Red team a model or agent | `red-team` |
| Budget tokens/$ | `BudgetGuard`, `CostTracker` |
| Track completion over turns | `ConvergenceTracker` |
| Export traces | OTLP export via `observability` / trace store |
| Call an LLM with retry + graceful json-schema degrade | `callLlm`, `callLlmJson`, `LlmClient`, `probeLlm` (0.8+) |
| Fence-strip json response from models that wrap output | `stripFencedJson` (0.8+) |
| Run a multi-layer verification pipeline (install → typecheck → build → …) | `MultiLayerVerifier` (0.8+) |
| Grade a semantic-concept pass threshold (score + critical-gap veto) | `gradeSemanticStatus` (0.8+) |
| Ask an LLM "did the artifact implement the asked-for concepts?" | `runSemanticConceptJudge`, `createSemanticConceptJudge` (0.8+) |
| Cheap keyword + element coverage on served HTML | `runKeywordCoverageJudge`, `runKeywordCoverageJudgeUrl` (0.8.2+) |
| Count compiler/runtime errors from stderr (tsc, pytest, cargo, go, eslint) | `extractErrorCount` + `ERROR_COUNT_PATTERNS` (0.8+) |
| Abstract subprocess + fs surface (local vs sandbox) | `CommandRunner`, `localCommandRunner` (0.9+) |
| Run one logical layer across N parallel toolchains + merge | `multiToolchainLayer`, `mergeLayerResults` (0.9+) |

Don't build a "my-project-eval-runner.ts". If something you need isn't
here, the PR that adds it to agent-eval is more valuable than a local
copy that will drift.

### 0.8 / 0.9 extraction history

The table above grew from a measured dedup campaign across VerticalBench
(`blueprint-agent/scripts/experiments/lib/*`). Gen 45 added the
LLM/verifier/judge primitives (0.8.x); Gen 46 added `CommandRunner` +
`multiToolchainLayer` (0.9.0). Consumers that previously shipped their
own versions of these should check this table before adding new
"my-project-*" modules.

Two extractions are intentionally NOT here yet (deferred to a future
generation that does the architectural design first):

- **A default reviewer implementation** for `propose-review`'s
  `ReviewFn` slot. `propose-review` ships the whole loop
  (propose + verify + review + memory); it does NOT yet ship a
  prebuilt reviewer. VerticalBench has one (`shot-reviewer.ts`) —
  when the upstream primitive lands, callers plug it into
  `ProposeReviewConfig.review`.

- **A toolchain-flavored `mergeLayerResults` extension** that supports
  per-layer numeric diagnostics (`layerErrorCount`) and customizable
  finding-message formatting. The 0.9 primitive is cleaner than most
  consumers need; VerticalBench keeps its own flavor today because
  the upstream lacks per-toolchain error-count propagation.

---

## Common bug classes (muffled-gate pattern)

Seven shapes observed in one closed-loop generation project. Audit for
these before shipping any gate:

1. **Fallback-to-pass**: `command || true` — swallows exit codes.
2. **Default-missing-to-permissive**: `options.kind ?? 'starter'` — missing
   value becomes a specific permissive one.
3. **Skip-counts-as-pass**: `if (p.skipped) return true` in a scorer.
4. **Auto-match no-expectation**: `if (!expected) return true` in a matcher
   — inflates accuracy for unlabeled scenarios.
5. **Duplicate drift**: same dispatch table in N files; a fix to N−1
   silently regresses the Nth.
6. **Unknown-case silent default**: `default: return noop` for a value
   that should never be unknown.
7. **Construct-vs-call dropped arg**: `new Driver({cwd})` when `cwd`
   lives on the per-call config. See Footgun 1.

The common shape is "something that should fail loud returns silent
success." Write the gate to fail closed; use `// muffle-ok: <reason>`
for the rare legitimate exception.

---

## Status of this doc

**Sole source of truth for agent-eval usage directives.**

- `README.md` is a pointer to this file.
- `CLAUDE.md` is a pointer to this file.
- Inline JSDoc uses `see .claude/skills/agent-eval/SKILL.md §<section>`.

If you update the API and this file goes out of sync, the API change is
incomplete. Same rule for the 10 footguns/rules above — they were written
from shipped incidents. Extending the list is welcome; silently
deleting an entry is not.
