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
| **`selfImprove()`** | You want candidate generation, scoring, and a release decision in one call. | scenarios, agent, judge, baseline surface | report, winner surface, and a `gateDecision` (see below) |
| **`loadEvalFixtureScenarios()`** | You want agents to add evals as folders with `PROMPT.md`, checks, and starter files. | `evals/<name>/PROMPT.md + EVAL.ts + package.json` | `Scenario[]` that runs through `runCampaign`; pair with `planEvalFixtureRun()` before spending tokens |
| **`analyzeRuns()`** | You have existing runs and do not need to invoke an agent. | `RunRecord[]` and options | `InsightReport` |
| **Intake adapters** (`fromFeedbackTable`, `fromOtelSpans`) | Your data isn't already in `RunRecord` shape: it's in Obsidian, Sheets, an OTel collector, etc. | source-specific input | `RunRecord[]` ready to pipe into `analyzeRuns()` |
| **`sealExperiment()` / `openSealedExperiment()`** | The result must convince a reader who does not trust you, so the rules must be fixed before the data arrives. | arms, admission funnel, estimand, interval, decision table | a hashed rule tree plus executors that can run no other rule ([`experiment.md`](./experiment.md)) |
| **`runEquivalenceCheck()`** | The work has no held-out test suite, so no answer key exists to grade against. | a claim, two blind arms, an injected checker | a certification naming who vouched and how it can fail ([`verification-strategies.md`](./verification-strategies.md)) |
| **`AnalystRegistry.runExact()`** | A batch of runs failed and you need cited findings, with the caller owning every execution choice. | recorded evidence, a declared analyst list | findings with evidence references, an execution plan, and a receipt ([`trace-analysis.md`](./trace-analysis.md)) |

See [`customer-journeys.md`](./customer-journeys.md) for runnable paths from existing logs, human ratings, and a callable agent.
The [README front-door table](../README.md#which-front-door) lists every callable entry point with a runnable example.

### The five release decisions

`selfImprove()` and every gate return a `GateDecision`, not a two-way ship/hold flag.
Folding the last three into `hold` throws away the action each one names.

| Decision | What it means | What to do next |
|---|---|---|
| `ship` | Every gate passed on sufficient evidence. | Release the candidate. |
| `hold` | A gate failed on sufficient evidence. | Reject this candidate. |
| `need_more_work` | A gate could not decide: the evidence was missing, or the paired sample was too small to claim significance. | Gather more runs, then gate again. |
| `model_ceiling` | Reserved for a caller-supplied gate that attributes the limit to the model. | Handle it; no gate in this package emits it. |
| `arch_ceiling` | Reserved for a caller-supplied gate that attributes the limit to the architecture. | Handle it; no gate in this package emits it. |

The last two are part of the taxonomy and of the composition order, but no built-in gate returns them today.
Handle all five anyway: a caller's own gate may return either, and the type will not let you ignore them.

`need_more_work` is not a quiet `hold`.
"Gather more evidence" and "reject this candidate" are different actions, and folding the first into the second abandons a real gain that was only underpowered.

When gates are composed, `ship` requires every gate to ship.
Otherwise the strongest hold wins, in this order: `arch_ceiling`, `model_ceiling`, `hold`, `need_more_work`.

`analyzeRuns()` and the high-level contract return the same `InsightReport` shape.
It contains score distributions, paired lift intervals, judge agreement, cost, failure clusters, contamination checks, outcome correlation, and recommendations.
[`insight-report.md`](./insight-report.md) defines every field.

## Package Boundary

`agent-runtime` and `agent-knowledge` may import `agent-eval`.
`agent-eval` must not import either package.

Run records, scenarios, judge scores, statistics, and release decisions belong here because they work without an agent runtime.
Agent sessions, worker coordination, sandbox execution, and runtime-specific profiles belong in `agent-runtime`.

## Measuring a complete profile

Use the profile improvement functions from `/contract` when a host owns immutable agent-profile snapshots.
`sealAgentProfileImprovementExperiment()` freezes the exact baseline, candidate diff, held-out tasks, model, limits, and policy.
`runAgentProfileImprovementExperiment()` asks the host to execute every frozen baseline/candidate cell and requires one complete receipt per execution.
`measuredComparisonFromAgentProfileImprovementExperiment()` recomputes scores, uncertainty, cost, latency, and the release decision from those receipts.
`RunTokenUsage.tokensKnown: false` marks incomplete provider usage; its counts are known subtotals, and token-efficiency ratios stay absent.

This API never activates a candidate or runs an agent itself.
The host owns authorization, billing, task isolation, profile materialization, execution, and durable evidence.
The first portable profile contract accepts prompt and skill changes only; a host must add its own exact-state adapter before measuring tools, MCP servers, hooks, subagents, or external knowledge.

## Main Objects

| Thing | What it is | One-line example |
|---|---|---|
| **Judge** | A function that scores one piece of output. | "Did this scaffold implement async fetching?" |
| **Rubric** | The recipe a judge uses: what to score on, with what weights. | "Score on buyer_quality (0.5), voice (0.3), signal (0.2)." |
| **Verifier** | A pipeline of judges run in order, with dependencies. | "install → typecheck → build → semantic" |
| **Feedback trajectory** | A multi-shot record of attempts, approvals, rejections, edits, metrics, and policy outcomes. | "draft → user rejects → revised draft → approved → measured" |

Traces, datasets, optimization, statistics, and reports build on these objects.

## Release check results

Every entry in `GateResult.contributingGates` has a `status` of `pass`, `fail`, or `not_evaluated`.
`pass` and `fail` mean the check ran with sufficient input.
`not_evaluated` means the check lacked enough evidence to run.
`defaultProductionGate` always requires held-out significance.
Its other checks are optional until their input is configured or their name is included in `requiredChecks`.
A required check with missing or insufficient evidence remains `not_evaluated` and holds the release decision.
An absent optional check records `not_evaluated` and never appears as a successful check.
Run history is shared input only.
Enable reward-hacking and canary monitoring independently with `rewardHacking` and `canary`.

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

### Running an evaluation

| Term | Plain English |
|---|---|
| **Case** (`Scenario`) | One task the agent must do. The unit every score is per. |
| **Surface** | The value being changed: a prompt, a skill, or a serialized configuration. |
| **Dispatch** | The function that runs your agent on one case and returns the artifact. |
| **Campaign** | One complete pass of every case, executed, scored, and cached under a run directory. |
| **Cell** | One (case × replicate) of a campaign. Cells are cached, so a rerun skips the ones that finished. |
| **Receipt** | The record of what one paid call actually cost, in dollars and tokens. Absent when nothing measured it. |
| **Cost ledger** | The spend account receipts are written to. A capped ledger refuses a call that would exceed the cap. |
| **Provenance** | Where a number came from: the package version, the source revision, the run identity, the exact attempt. |
| **`RunRecord`** | The analysis-time projection of one run: who ran, on what, with which seed, at what cost, and what it scored. |

### Improving a surface

| Term | Plain English |
|---|---|
| **Optimizer** | Any procedure that writes candidate surfaces and picks one. |
| **GEPA** | An open-source optimizer that mutates text using reflection over failures. It searches; this package executes and scores. |
| **SkillOpt** | Microsoft's skill optimizer. Same division of labour. |
| **Engine** | One named search procedure inside GEPA. |
| **Recipe** | How several engines are composed: in order, adaptively, best-of, or by vote. |
| **Train cases** | Evidence the optimizer reads to write candidates. |
| **Selection cases** | Evidence the optimizer reads to choose among its candidates. |
| **Final cases** | Held back from the optimizer entirely. They produce the reported lift. |

The three-way split is the reason a reported lift means anything.
An optimizer that saw the final cases can score well on them without the agent getting better.

### Proving a result

| Term | Plain English |
|---|---|
| **Experiment** | The rules — arms, funnel, estimand, interval, decision — written as data before the data arrives. |
| **Seal** | A hash of that whole rule tree. The execution surface accepts no rule outside it. |
| **Estimand** | The exact quantity being measured, for example the paired difference in pass rate. |
| **Funnel** | The denominator chain: how many rows entered, what each stage removed, and how many remain. |
| **Verification strategy** | One of ten ways to certify a result, each with a documented way it can certify a wrong one. |
| **Certification** | Who vouched for a verdict, with what checker version, and what the checker did not check. |
| **Analyst** | A function that reads recorded evidence and returns findings that cite it. |

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
  installLayer, // runs `pnpm install`
  typecheckLayer, // runs `tsc --noEmit`, depends on install
  buildLayer, // runs `pnpm build`, depends on typecheck
  semanticLayer, // LLM judge, weight 3, depends on build
])

const report = await verifier.run({ env })
report.allPass // boolean: every layer passed
report.taskScore // complete task score, or undefined
report.blendedScore // diagnostic weighted aggregate, possibly partial
report.layers // per-layer status, findings, duration
```

`env` carries the sandbox driver, the working directory, and the harness commands each layer runs.

Use `taskScore` when creating task labels or training data.
An errored, timed-out, skipped, or incomplete scoring panel leaves `taskScore` undefined.
Use `blendedScore` only to inspect the measurements that did complete.

Two rules that will save you bugs:

1. **Run both gates.** Build gates catch code that doesn't compile; structural assertions catch missing files. Run both unconditionally: they catch orthogonal failures.

2. **Pair LLM judges with build outcomes.** An LLM judge will rate non-compiling code as "looks right" (0.8). Always short-circuit on `buildOutcome.passed === false` before any LLM judging.

## Judge calibration

Two questions to answer before trusting any LLM judge:

1. **Does it agree with humans?** `calibrateJudge(golden, candidate)` reports Pearson, MAE, integer-rounded κ, and worst-N miscalibrations vs a human golden set.
2. **Does it agree with itself / other judges?** `continuousAgreement(scores)` and `calibrateJudgeContinuous(golden, candidate)` report κ_w + ICC(2,1) + Pearson + Spearman with bootstrap 95% CIs on the raw [0,1] scores.

Each statistic answers a different question:

| Statistic | What it answers | What it misses |
|---|---|---|
| Pearson | Do the two raters move together? | Constant offset and constant scaling |
| Spearman | Do they rank the same way? | The size of any gap |
| MAE (mean absolute error) | How far apart are they, on average? | Whether the gap is systematic |
| κ (Cohen's kappa) | Do they agree more than chance? | Everything below the rounding step |
| ICC(2,1) | Do they agree in absolute value, not just in shape? | — |

Use two flavours of κ for one reason.
`calibrateJudge` rounds each score to an integer first.
For a fine-grained judge that throws information away: 0.78 and 0.81 both round to 1 and look perfectly agreed.
Use `calibrateJudgeContinuous`, or `continuousAgreement` for two or more raters, when the scores are continuous.

ICC(2,1) catches a bias Pearson cannot see.
If judge B always scores twice judge A, the two move together perfectly and Pearson stays near 1, while ICC drops.
That drop is the signal.

Every reported interval is a bootstrap 95 % interval: the statistic is recomputed on many resamples of the data, and the middle 95 % of those values is the interval.

`verbosityBias` is the one exported bias probe: it finds a judge that rewards length regardless of quality.
The `JudgeInsight` report shape also carries optional `positionalBias` and `selfPreference` fields for caller-computed probes.
No built-in computes those two fields.

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
- **Diagnosing failures across a batch of runs?** Read [trace-analysis.md](./trace-analysis.md) for the recursive DSPy-RLM analyst and the public benchmark it's calibrated against.
- **Building a driver and worker loop?** Read [control-runtime.md](./control-runtime.md) for coding, browser, computer-use, and research patterns.
- **Turning review feedback into reusable data?** Read [feedback-trajectories.md](./feedback-trajectories.md) for dataset, optimization, and preference-memory examples.
- **Building a code-generator eval?** → Start with `BuilderSession`, `SandboxHarness`, and `MultiLayerVerifier`.
- **Multi-layer verifier?** → Use [control-runtime.md](./control-runtime.md) and `MultiLayerVerifier` for ordered gates with dependencies.
- **Adding a new judge or rubric?** → `src/wire/rubrics.ts` for the cross-language path; `src/anti-slop.ts` and `src/judges.ts` for the in-process path.
- **Registering an experiment before the data arrives?** Read [experiment.md](./experiment.md) for the rule AST, the seal, the funnel, and the refusals.
- **Certifying a result with no answer key?** Read [verification-strategies.md](./verification-strategies.md) for the ten-member family and the blind two-arm protocol.
- **Reading a verdict someone else produced?** Read [verdicts.md](./verdicts.md) for what `certification` carries and what an absent one means.
- **Grading a finding by executing its repair?** Read [trace-repair-grader.md](./trace-repair-grader.md), and [trajectory-replay.md](./trajectory-replay.md) for re-executing a recorded failure.
- **Wondering why this package exists at all?** Read [charter.md](./charter.md) for the four end-states it is built against.
