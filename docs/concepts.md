# Concepts

`agent-eval` records agent runs, scores their outputs, compares variants, and applies caller-defined release rules.

A model can say a task is complete while the build fails, a browser flow is broken, an integration is disconnected, or required sources are missing.
This package lets code, model judges, and human feedback check those outcomes through the same run format.

## The top-level functions

Start with `/contract` and `defineAgentEval()` for a new integration.
Use the lower-level functions when you need direct control over execution, storage, or statistics.

| Function | When to call it | What you give it | What you get back |
|---|---|---|---|
| **`defineAgentEval()`** | You have scenarios, an agent, a judge, and a baseline surface, and you want one object you can score or improve. | scenarios, agent, judge, baseline surface | `{ evaluate(), improve() }` where `evaluate()` returns a campaign result and `improve()` returns a report |
| **`selfImprove()`** | You want candidate generation, scoring, and a release decision in one call. | scenarios, agent, judge, baseline surface | report, ship/hold decision, winner surface |
| **`loadEvalFixtureScenarios()`** | You want agents to add evals as folders with `PROMPT.md`, checks, and starter files. | `evals/<name>/PROMPT.md + EVAL.ts + package.json` | `Scenario[]` that runs through `runCampaign`; pair with `planEvalFixtureRun()` before spending tokens |
| **`analyzeRuns()`** | You have existing runs and do not need to invoke an agent. | `RunRecord[]` and options | `InsightReport` |
| **Intake adapters** (`fromFeedbackTable`, `fromOtelSpans`) | Your data isn't already in `RunRecord` shape: it's in Obsidian, Sheets, an OTel collector, etc. | source-specific input | `RunRecord[]` ready to pipe into `analyzeRuns()` |

See [`customer-journeys.md`](./customer-journeys.md) for runnable paths from existing logs, human ratings, and a callable agent.

`analyzeRuns()` and the high-level contract return the same `InsightReport` shape.
It contains score distributions, paired lift intervals, judge agreement, cost, failure clusters, contamination checks, outcome correlation, and recommendations.
[`insight-report.md`](./insight-report.md) defines every field.

## Package Boundary

`agent-runtime` and `agent-knowledge` may import `agent-eval`.
`agent-eval` must not import either package.

Run records, scenarios, judge scores, statistics, and release decisions belong here because they work without an agent runtime.
Agent sessions, worker coordination, sandbox execution, and runtime-specific profiles belong in `agent-runtime`.

## Main Objects

| Thing | What it is | One-line example |
|---|---|---|
| **Judge** | A function that scores one piece of output. | "Did this scaffold implement async fetching?" |
| **Rubric** | The recipe a judge uses: what to score on, with what weights. | "Score on buyer_quality (0.5), voice (0.3), signal (0.2)." |
| **Verifier** | A pipeline of judges run in order, with dependencies. | "install → typecheck → build → semantic" |
| **Feedback trajectory** | A multi-shot record of attempts, approvals, rejections, edits, metrics, and policy outcomes. | "draft → user rejects → revised draft → approved → measured" |

Traces, datasets, optimization, statistics, and reports build on these objects.

When the thing being evaluated is an agent that should keep working, use
[`runAgentControlLoop`](./control-runtime.md). It turns validators into a
runtime loop: observe typed state, validate it, decide the next action, act,
and repeat until the task passes, blocks, times out, spends too much, or stops
making progress.

When normal agent usage should become reusable training or eval data, use
[`FeedbackTrajectory`](./feedback-trajectories.md). It captures approvals,
rejections, edits, option choices, metrics, and policy blocks as portable data
that can seed memory, replay scenarios, and optimization.

## Terms

| Term | Plain English |
|---|---|
| **Artifact** | The thing being judged. Often a workdir of files, sometimes a string of text. |
| **Snapshot** | A frozen view of an artifact (every file path → content). This is the input the judge reads. |
| **Harness** | A description of *how to run* the artifact: setup command, test command, working dir, timeout. |
| **Sandbox driver** | Executes commands inside the harness, using a local subprocess or remote container. |
| **Layer** | One stage of a verifier pipeline (install, typecheck, build, semantic, …). |
| **Finding** | A specific issue a judge found: file, line, severity, message. |
| **Trace store** | The append-only log of every span/event during a run. Replay = read this back. |
| **Composite score** | A 0..1 number combining all dimensions. The single number you gate on. |
| **Rubric version** | A stable hash of the rubric. Scores from different rubric versions are not comparable. |

## The feedback trajectory loop

Normal review activity can provide labels without a separate labeling interface:

```text
agent proposes -> user approves/rejects/edits/selects -> agent revises -> outcome is measured
```

`FeedbackTrajectory` is the portable record of that loop. Browser agents can
store task outcomes, coding agents can store patch review plus test results,
and research agents can store reviewer corrections. The domain changes; the
shape stays the same.

Those trajectories can be converted into preference memory, `DatasetScenario`
rows, optimizer rows, and held-out examples for overfit checks.

## Code Generator Eval

When the artifact is generated code, agent-eval scores it at three independent layers. Each layer fails differently, and you want to know which one broke:

```
L0  builder        Did the agent's session itself work?
                   (Did it produce an artifact at all?)
                              │
                              ▼
L1  app-build      Does the artifact build / typecheck / test?
                   (Static signal, ground-truth gate.)
                              │
                              ▼
L2  app-runtime    Does the artifact actually run end-to-end?
                   (Dynamic signal: only worth checking if L1 passed.)
```

`BuilderSession` orchestrates this. It opens at `startChat`, runs the build at `ship`, runs the runtime check at `runAppScenario`. Each layer emits a trace span. Composite score aggregates them with `scoreProject`.

Why three? Because each catches a different failure mode:
- L0 misses: agent crashed mid-generation, you have a half-written file.
- L1 misses: files exist but typecheck fails. LLM judges can't reliably catch this.
- L2 misses: code compiles but does the wrong thing at runtime.

If you only check one layer, you ship the bugs that the other two layers would have caught.

## How rubrics work

A rubric describes:
1. **Dimensions**: the axes you score on (e.g. `buyer_quality`, `voice`, `signal`).
2. **Weights**: how to combine dimensions into a composite (`0.5 * buyer_quality + 0.3 * voice + 0.2 * signal`).
3. **Failure modes**: named patterns the judge looks for ("ai-cadence", "vague-claim").
4. **Wins**: named positive patterns ("specific-component", "earned-detail").
5. **System prompt**: what to tell the judging LLM about the persona and the task.

Built-in rubrics ship in `src/wire/rubrics.ts`, including `anti-slop` for technical-buyer voice.
You can also pass the same rubric shape inline at the call site.

A rubric is plain data. The hash of that data is the `rubricVersion`. Two scores are only comparable if they used the same `rubricVersion`: change the rubric and you start a new comparison series.

## How verifiers work

When you have a multi-step pipeline (install → typecheck → build → lint → semantic), use `MultiLayerVerifier`:

```ts
const verifier = new MultiLayerVerifier([
  installLayer,      // runs `pnpm install`
  typecheckLayer,    // runs `tsc --noEmit`, depends on install
  buildLayer,        // runs `pnpm build`, depends on typecheck
  semanticLayer,     // LLM judge, weight 3, depends on build
])

const report = await verifier.run({ env: { runner, workdir, ... } })
report.allPass        // boolean: every layer passed
report.blendedScore   // 0..1: weighted aggregate
report.layers         // per-layer status, findings, duration
```

Two rules that will save you bugs:

1. **Run both gates.** Build gates catch code that doesn't compile; structural assertions catch missing files. Run both unconditionally: they catch orthogonal failures.

2. **Pair LLM judges with build outcomes.** An LLM judge will rate non-compiling code as "looks right" (0.8). Always short-circuit on `buildOutcome.passed === false` before any LLM judging.

## Judge calibration

Two questions to answer before trusting any LLM judge:

1. **Does it agree with humans?** `calibrateJudge(golden, candidate)` reports Pearson, MAE, integer-rounded κ, and worst-N miscalibrations vs a human golden set.
2. **Does it agree with itself / other judges?** `continuousAgreement(scores)` and `calibrateJudgeContinuous(golden, candidate)` report κ_w + ICC(2,1) + Pearson + Spearman with bootstrap 95% CIs on the raw [0,1] scores.

Why two κ flavours: the original `calibrateJudge` rounds scores to ints before computing κ. For fine-grained judges that loses information: 0.78 vs 0.81 both round to "1" and look perfectly agreed. Use `calibrateJudgeContinuous` (or `continuousAgreement` for N≥2 raters) when scores are continuous. ICC(2,1) catches systematic bias that Pearson misses: if judge B scores 2× judge A, Pearson stays ≈ 1 while ICC drops: that's the signal.

Bias probes (`positionalBias`, `verbosityBias`, `selfPreference`) cover the orthogonal failure modes: position-dependent scoring, length-correlated scoring, and judge-prefers-its-own-family.

## Trace Model

Every operation emits structured spans into a `TraceStore`. A run is a tree:

```
builder-session                 [span]
├── chat-turn                   [span]
├── ship                        [span]
│   ├── harness.install         [span]
│   ├── harness.typecheck       [span]
│   └── harness.build           [span]
└── app-runtime                 [span]
    └── scenario.run            [span]
```

Spans are append-only and have stable ids: replay is reading the same store back. OTLP export ships them out for distributed tracing.

You usually should not build this tree by hand. Product runtimes,
`runAgentControlLoop`, harnesses, and verifiers should emit it while they run.
Use traces when debugging a flaky run, building replay data, or explaining a
release decision.

## Where to go next

- **Choosing a candidate-generation method?** Read [campaign-proposers.md](./campaign-proposers.md) for the available methods, their inputs, and runnable composition examples.
- **Choosing a `run*` function or grading produced state?** Read [eval-surface-map.md](./eval-surface-map.md) for a use-case table and complete grading composition.
- **Need the feature map?** Read [feature-guide.md](./feature-guide.md) for integration patterns and operational limits.
- **Scoring a string from another language?** Read [wire-protocol.md](./wire-protocol.md) for the HTTP/RPC interface.
- **Building a driver and worker loop?** Read [control-runtime.md](./control-runtime.md) for coding, browser, computer-use, and research patterns.
- **Turning review feedback into reusable data?** Read [feedback-trajectories.md](./feedback-trajectories.md) for dataset, optimization, and preference-memory examples.
- **Building a code-generator eval?** → Start with `BuilderSession`, `SandboxHarness`, and `MultiLayerVerifier`.
- **Multi-layer verifier?** → Use [control-runtime.md](./control-runtime.md) and `MultiLayerVerifier` for ordered gates with dependencies.
- **Adding a new judge or rubric?** → `src/wire/rubrics.ts` for the cross-language path; `src/anti-slop.ts` and `src/judges.ts` for the in-process path.
