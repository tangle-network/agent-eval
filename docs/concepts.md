# Concepts

`agent-eval` records agent runs, scores their outputs, compares variants, and applies caller-defined release rules.

An agent can claim success while a build, browser flow, or integration fails.
Required source evidence can also be missing.
This package lets code, model judges, and human feedback check those outcomes through the same run format.

## The top-level functions

Start with `defineAgentEval()` from `/contract` for one agent, judge, case set, and baseline surface.
Its `evaluate()` method returns campaign measurements.
Its `improve()` method searches and returns a final comparison with a release decision.
Use `selfImprove()` directly when you do not need shared configuration.

Use `analyzeRuns()` from `/contract` for existing `RunRecord[]` evidence.
[The README workflows](../README.md#choose-a-workflow) link to runnable examples.
[The surface map](./eval-surface-map.md) lists lower-level execution and analysis APIs.

Root `Scenario`, `JudgeScore`, and `GateDecision` use the same definitions as `/contract` and `/campaign`.
The product-judging shapes have explicit root names: `ProductScenario` and `DimensionJudgeScore`.
The separate `HeldOutGate` class returns `HeldOutGateDecision` over `RunRecord` comparisons.

### The five release decisions

`selfImprove()` returns a `gateDecision` from the campaign `GateDecision` union.
Keep its five values distinct because they require different actions.

| Decision | What it means | What to do next |
|---|---|---|
| `ship` | All required configured checks support release. | Review the evidence and release the candidate. |
| `hold` | The gate does not justify release. A required check can fail or lack sufficient evidence. | Inspect the contributions to distinguish regression from an unresolved comparison. |
| `need_more_work` | The gate reports that more work or evidence is required. | Address the reported gap before another decision. |
| `model_ceiling` | Reserved for a caller-supplied gate that attributes the limit to the model. | Handle it; no gate in this package emits it. |
| `arch_ceiling` | Reserved for a caller-supplied gate that attributes the limit to the architecture. | Handle it; no gate in this package emits it. |

The last two are part of the taxonomy and of the composition order, but no built-in gate returns them today.
Handle all five anyway: a caller's own gate may return either, and the type will not let you ignore them.

Read the contributing checks before interpreting a refused release.
An unresolved comparison does not establish that the candidate is worse.
Absent optional checks remain `not_evaluated`, including when the required checks support `ship`.

When gates are composed, `ship` requires every gate to ship.
Otherwise the strongest hold wins, in this order: `arch_ceiling`, `model_ceiling`, `hold`, `need_more_work`.

`analyzeRuns()` returns an `InsightReport`; `selfImprove()` includes one in its result.
The report includes score distributions, cost, and recommendations.
Paired lift, failure clusters, contamination checks, and outcome associations require their corresponding inputs.
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
The portable profile contract accepts prompt and skill changes.
A host needs an adapter for exact state before measuring tools, MCP servers, hooks, subagents, or external knowledge.

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
| **Composite score** | An aggregate on the judge's declared scale. Gates must use thresholds on that scale. |
| **Rubric version** | A stable hash of the rubric. Scores from different rubric versions are not comparable. |

### Running an evaluation

| Term | Plain English |
|---|---|
| **Case** (`Scenario`) | One task the agent must do. Variants can share an independent source unit. |
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

Keep scenario identifiers disjoint across the three partitions.
For new-unit claims or fresh final evidence, also keep source units separate between development and final cases.
Fixed-roster development can share sources while retaining independent-unit counts in its reports.
Renamed variants from one incident can leak information across splits.
A final comparison supports only the declared population and measured conditions.

### Proving a result

| Term | Meaning |
|---|---|
| **Claim** | The intended use, population, sampling frame, independent unit, generalization target, and optional minimum useful effect. |
| **Independent unit** | The source task, incident, or family that contributes one independent observation to an inference. |
| **Experiment** | Arms, admission, estimand, interval, and decision rules declared before results are inspected. |
| **Seal** | A digest binding the experiment's rules and claim to the executed specification. |
| **Estimand** | The quantity being estimated, such as the mean difference across independent task families. |
| **Funnel** | Counts of input rows, exclusions at each stage, and retained evidence. |
| **Final-evidence reservation** | A durable claim on source units before search; exposure records the evaluated candidates before dispatch. |
| **Verification strategy** | A method of checking a result, with documented assumptions and failure modes. |
| **Certification** | The checker identity, strategy, unverified assumptions, and evidence associated with a verdict. |
| **Analyst** | A function that reads recorded evidence and returns cited findings. |

Use `defineEvaluationClaim()` from `/experiment` to declare what a result can describe.
Pass it as the top-level `claim` when improving a surface or comparing optimization methods.
`fixed-roster` concerns the listed units; `new-units` attempts to generalize to further units from the declared population.
A declared sampling frame does not itself establish representative sampling.

Count repetitions separately from independent units.
For example, 100 retries of one incident produce 100 observations and one independent incident.
Campaign aggregate `n` describes its observed scores.
Registered gates report their independent-unit count and paired-cell count separately.

Set `minimumEffect` when the decision concerns a practically useful change.
Development and absolute-rate claims can omit it.
Sealed power checks assess the declared effect.
A design that detects only much larger effects cannot pass that adequacy check.
Inference also needs the interval and clustering rule to match the claim.

Unit-aware comparison does not require a final-evidence ledger.
For fresh confirmation, add `finalEvidence: { ledger, requestId, evaluatorDigest }` alongside the top-level `claim`.
This reserves final units before search.
Use one durable ledger across related campaigns and stable source identities across renamed variants.
Exposure remains recorded if measurement fails or the process stops.
The host enforces access isolation; the ledger cannot inspect reads outside this workflow.

See [evaluation integrity](./evaluation-integrity.md) for claims, final evidence, and evaluator admission.
[Registered experiments](./experiment.md) describes seals, decision rules, and refusal artifacts.

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

Generated-code evaluations can score the agent session, the build, and the running application.
Each layer detects different failures:

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

`BuilderSession` coordinates these checks.
It opens at `startChat`, runs the build at `ship`, and runs the application check at `runAppScenario`.
Each layer emits a trace span.
`scoreProject` combines their measured scores.

These layers detect different failures:

- L0: The agent crashed during generation and left an incomplete artifact.
- L1: Files exist but do not typecheck or build.
- L2: Code compiles but behaves incorrectly when executed.

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

A rubric is plain data.
Its digest and encoding scheme identify the `rubricVersion`.
Changing the rubric starts a new comparison series.
Evaluate rubric revisions against independent labels before combining their scores.

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

1. Run build checks and structural assertions.
   They detect different failures.
2. Preserve a failed build as a deterministic release failure.
   A semantic score cannot override it.

## Judge calibration

Two questions to answer before trusting any LLM judge:

1. **Does it agree with humans?** `calibrateJudge(golden, candidate)` reports Pearson, MAE, integer-rounded κ, and worst-N miscalibrations vs a human golden set.
2. **Does it agree with other judges?**
   `continuousAgreement()` and `calibrateJudgeContinuous()` report agreement and bootstrap intervals on continuous scores.

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

These agreement intervals use bootstrap resampling.
The middle 95% of the recomputed statistics forms each reported interval.

Import calibration and bias functions from `/meta-eval`.

| Probe | Input | Observation |
|---|---|---|
| `positionalBias()` | The same items judged with their presentation order swapped. | Mean paired score difference by position. |
| `verbosityBias()` | Output lengths and judge scores. | Correlation between length and score. |
| `selfPreference()` | Scores grouped by whether judge and output share a model family. | Difference between the group means. |

These probes are descriptive diagnostics.
Length and family groups can also differ in task quality; an observed association alone does not isolate bias.
Inspect sample counts before interpreting a diagnostic, especially `n: 0`.

Use `auditEvaluator()` for admission against predeclared false-acceptance and false-rejection limits.
Its observation records distinguish fresh controls, development exposure, and unknown judgments.
It counts source families rather than repeated variants and reports simultaneous exact bounds for both error rates.
The host must enforce independent authorship and control access.

Use `rubricPredictiveValidity()` to compare rubric scores with declared deployment outcomes.
Specify whether each outcome should increase or decrease.
The report preserves signed associations, direction-aligned associations, and exclusions.
An `inverse` association is a reason to investigate; it does not prove that reversing a rubric will improve behavior.
See [outcome validity](./outcome-validity.md).

## Trace Model

Instrumented execution writes structured spans into a `TraceStore`.
A builder run can have this tree:

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

Recorded spans preserve their identifiers and relationships.
Trace inspection reads this evidence; executable replay separately reruns recorded operations.
OTLP export sends spans to distributed tracing systems.

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
- **Checking package ownership?** Read [charter.md](./charter.md) for the implemented foundations and host responsibilities.
