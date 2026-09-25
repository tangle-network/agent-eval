# Optimization Methods And Candidate Generators

Agent Eval supports two different extension points.

An `OptimizationMethod` owns a complete search procedure and returns one selected surface.
Use it for official GEPA, official SkillOpt, or another optimizer with its own search and selection behavior.

A `SurfaceProposer` suggests candidates inside Agent Eval's campaign loop.
Use it for caller-defined logic, an agent-runtime worker, or declared parameter combinations.

Do not wrap a complete external optimizer in `SurfaceProposer`.
That would split its search state from its own selection behavior and make budgets harder to compare.

## Choose The Entry Point

An `OptimizationMethod` plugs into exactly two entry points.
`selfImprove()` from `/contract` is the improvement entry: one call gives the method disjoint train and selection partitions, re-scores the selected surface on a held-out split, and returns a `gateDecision`.
Use it to search for a better surface and inspect the final decision.
`compareOptimizationMethods()` from `/campaign` is the measurement entry: it gives every method equal inputs and scores the selected surfaces on final cases no method received.
Use it to compare selected surfaces under declared resource limits.
Runnable versions: [`examples/self-improve-optimizer`](../examples/self-improve-optimizer/) and [`examples/compare-optimization-methods`](../examples/compare-optimization-methods/).

## Compose searches over a candidate

Use `scopedOptimizationMethod()` to change one projection while scoring the complete candidate.
The caller supplies `project` and `merge`; Eval does not prescribe profile names or learning procedures.
Their roundtrip must preserve the exact baseline before any child search runs.
Scoped artifact paths and dispatch identity include the complete parent hash to prevent reuse across different evaluation contexts.
A text or component surface can include serialized profiles, working evaluation definitions, and immutable state references.
The host must resolve and verify those references when executing a candidate.
Keep final decision cases outside the working candidate and every optimizer callback.

Use `sequentialOptimizationMethod()` to pass each selected candidate into the next method.
It does not require an intermediate candidate to beat the original baseline.
Each child can use GEPA, SkillOpt, or an arbitrary `OptimizationMethod` callback.
Use the existing GEPA recipe when only the optimizer engines change over one shared surface.

```ts
const learnerThenSpecialist = sequentialOptimizationMethod({
  name: 'learner-then-specialist',
  methods: [
    scopedOptimizationMethod({
      name: 'learner', method: learnerSearch,
      project: selectLearner, merge: replaceLearner,
    }),
    scopedOptimizationMethod({
      name: 'specialist', method: specialistSearch,
      project: selectSpecialist, merge: replaceSpecialist,
    }),
  ],
})
```

Pass this method and a joint method to `compareOptimizationMethods()` to compare their final candidates.
Its existing `optimizationConcurrency` controls independent searches; stages inside a sequence run in order.
All children share the spend account and receive only train and selection cases.
Child costs are reconciled separately and summed without adding ledger charges.
The returned `composition.stages` preserves each baseline hash, selected surface, cost, provenance, token usage, and history receipt.
Missing child usage remains missing in that child's provenance.
Comparison scores retain this composition.

Hosts can supply `OptimizationMethodInput.invokeMethod` to enforce controls at each method invocation, including every composed child.
The adapter calls `method.optimize(input)` after installing its candidate guards and accounting scope.
Use `input.surfaceToRoot` to map a child's baseline or proposal into the complete candidate before validation.
An absent mapper means the local surface is already complete.
Scoped methods compose this mapping through every projection; sequential stages preserve it as their baselines change.
Validate the active child's mapped baseline before starting that optimizer because it can export baseline evidence before dispatch.

Set `searchHistoryPolicy: 'require-complete'` on the outer comparison or `selfImprove()` call to require every child receipt.
Set `searchHistoryVerification: 'ledger'` to verify each referenced ledger before final assessment.
Composite history coverage contains recursive `stages`; it does not fabricate one aggregate receipt.
Any parent receipt supplied by a custom method is also verified; it cannot replace missing child evidence.

## Read An Improvement Result

`selfImprove({ method })` executes the complete method once and measures its selected surface on final cases.
The method may select the unchanged baseline; that result returns `gateDecision: 'hold'` and an empty diff.
`winner` means the optimizer's selection, which can score worse on final cases.
Inspect `gateDecision` and its contributions before treating the selected surface as an improvement.
Agent Eval does not score train and selection cases again or choose a different surface after the method finishes.

The result type has two modes:

| Mode | Result | Search evidence | Cost |
|---|---|---|---|
| `proposer` | `SelfImproveProposerResult` | Native `raw.generations`, `generationsExplored`, and optional `searchHistory` | Shared `cost` ledger summary |
| `method` | `SelfImproveMethodResult` | Actual `raw.method` and its optional `searchHistory` | Combined method and final `cost`; receipt breakdown in `ledgerCost` |

Both types are exported from the package root and `/contract`.
`SelfImproveResult` is their union; branch on `result.mode` before reading mode-specific fields.
Calls with a concrete `method` or `proposer` infer the corresponding result type.
Method mode has no native generation count or fabricated native search measurements.
Its durable `method-provenance.json` uses schema `tangle.method-improvement` and records partition, measurement, and cost-receipt digests.
Proposer mode retains `LoopProvenanceRecord`.

When method holdout is deferred, `baseline` and `winner.compositeMean` are `null`, `lift` is absent, and the decision is `hold`.
The selected surface remains available in `winner.surface`.
Method cost preserves the larger of reported search spend and newly recorded search receipts, then adds final measurements without counting receipts twice.
Underreported spending and incomplete receipts remain explicit; `raw.method.cost` retains the original report.
Inspect `cost.accountingComplete` and `cost.incompleteReasons` before treating the known subtotal as complete spending.
The shared dollar limit controls calls admitted through the cost ledger; arbitrary off-ledger callbacks must enforce their own spending limits.

Native generation records carry no interval; a candidate's paired contrast with its parent or the baseline is `estimateNode` over the run's search ledger.
Final comparisons retain their independently computed statistics.
Every final case and replica must have complete execution and judge results before comparison.

## Bind Cached Measurements To Their Evaluator

Candidate surface content is part of native search and final measurement identity.
Pass a stable `dispatchRef` for execution behavior outside that surface, such as the worker revision and tool configuration.
Change it when that behavior changes; function names cannot identify captured state.
Set `judgeVersion` when a judge's scoring behavior changes.

To reuse `premeasuredBaseline` in proposer mode, measure the same train cases, seed, replicas, execution revision, and judges.
The standalone campaign must use `dispatchRef: surfaceDispatchRef(baselineSurface, dispatchRef)` from `/campaign`.
Agent Eval refuses a prior baseline whose evaluator manifest differs.

## Adapt A Third-Party Text Optimizer

`externalTextOptimizationMethod()` is the general adapter for a package that already owns text or component search.
The starting candidate is a string for a text surface or a `Record<string, string>` for named components.
The returned candidate must keep the same form.

The `run` callback receives only `trainSet` and `selectionSet`.
It does not receive final test cases.
Pass `context.evaluate` to the optimizer so every candidate is executed and scored by the configured Agent Eval path.
Unknown case IDs and calls beyond `maxEvaluations` are rejected.

Optimizer-owned model or service calls must use `context.cost.runPaidCall()`.
The example below assumes the upstream package enforces `maxCostUsd` for the complete run and returns aggregate usage.
If the package exposes a model callback instead, wrap each model call separately with the same cost ledger and phase.

```ts
import { externalTextOptimizationMethod } from '@tangle-network/agent-eval/campaign'
import { optimize } from 'your-text-optimizer'

interface SupportCase {
  id: string
  kind: 'support'
  question: string
}

interface SupportArtifact {
  answer: string
}

const method = externalTextOptimizationMethod<SupportCase, SupportArtifact>({
  name: 'your-text-optimizer',
  source: {
    kind: 'package',
    package: 'your-text-optimizer',
    version: '2.3.1',
    sourceUrl: 'https://github.com/your-org/your-text-optimizer',
    revision: '4f17c2a',
  },
  objective: 'Improve answer accuracy and citation quality.',
  evaluationId: 'support-quality',
  maxEvaluations: 60,
  maxOptimizerCostUsd: 2,
  resume: 'if-compatible',
  describeScenario: (scenario) => ({ question: scenario.question }),
  describeArtifact: (artifact) => ({ answer: artifact.answer }),
  run: async (context) => {
    const paid = await context.cost.runPaidCall({
      actor: context.name,
      model: 'your-text-optimizer',
      maximumCharge: { externallyEnforcedMaximumUsd: 2 },
      execute: (signal) =>
        optimize({
          initialCandidate: context.seedCandidate,
          train: context.trainSet,
          selection: context.selectionSet,
          evaluate: context.evaluate,
          maxEvaluations: context.maxEvaluations,
          maxCostUsd: 2,
          seed: context.seed,
          stateDir: context.stateDir,
          resume: context.restoreRequested,
          artifactDir: context.artifactDir,
          signal,
        }),
      receipt: (result) => ({
        model: 'your-text-optimizer',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        actualCostUsd: result.usage.costUsd,
      }),
    })
    if (!paid.succeeded) throw paid.error
    if (context.restoreRequested && !paid.value.resumed) {
      throw new Error('The optimizer could not restore the requested compatible state.')
    }
    return {
      bestCandidate: paid.value.bestCandidate,
      resumed: context.restoreRequested,
      costAccounting: { kind: 'metered' },
    }
  },
})
```

Replace the import and field names with the upstream package API.
`source` records caller-declared package identity.
`evaluationId` identifies the execution and scoring behavior; use a commit, content hash, or another stable identifier and change it whenever that behavior changes.
Agent Eval derives the run ID from the complete compatible input instead of requiring a private schema number.
The callback writes checkpoints under `stateDir`, restores them only when `restoreRequested` is true, and reports whether restoration occurred.
Agent Eval adds the run ID, evaluation count, artifact directory, source identity, and optimizer token usage to the method result.

## Compare Complete Methods

`compareOptimizationMethods()` gives every method the same:

- starting surface,
- train cases,
- selection cases,
- execution function,
- judges,
- seed,
- campaign defaults.

The method input contains train and selection cases, without final test cases.
After every method finishes, Agent Eval scores the selected surfaces on the same final cases and reports paired lift estimates.
The host must also exclude final cases from callback closures, shared files, and prior optimizer state.
The API partition does not provide process or filesystem isolation.

```ts
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  skillOptOptimizationMethod,
} from '@tangle-network/agent-eval/campaign'

const optimizer = {
  model: optimizerModelId,
  // Supplied by the package that owns execution. Discovery derives these
  // from Runtime and one exact AgentProfile.
  call: optimizerExecution.call,
  callRef: optimizerExecution.callRef,
  budget: {
    maxCostUsd: 5,
    maxRequests: 100,
    maxRequestBytes: 2_000_000,
    maxResponseBytes: 2_000_000,
    maxOutputTokensPerRequest: 32_768,
    pricing: optimizerTokenPricing,
  },
}

const gepa = gepaOptimizationMethod<MyCase, MyArtifact>({
  name: 'gepa',
  objective: 'Improve the instructions so the agent emits valid JSON.',
  evaluationId: 'json-agent',
  recipe: {
    kind: 'engine',
    run: {
      engine: 'gepa',
      maxEvaluations: 80,
      maxProposerCostUsd: 5,
    },
  },
  optimizer,
  describeScenario: (scenario) => ({ input: scenario.input }),
  describeArtifact: (artifact) => ({ output: artifact.output }),
})

const skillopt = skillOptOptimizationMethod<MyCase, MyArtifact>({
  name: 'skillopt',
  objective: 'Improve the instructions so the agent emits valid JSON.',
  evaluationId: 'json-agent',
  trainer: {
    epochs: 2,
    batchSize: 4,
  },
  optimizer,
  maxEvaluations: 80,
  describeScenario: (scenario) => ({ input: scenario.input }),
  describeArtifact: (artifact) => ({ output: artifact.output }),
})

const comparison = await compareOptimizationMethods({
  methods: [gepa, skillopt],
  baselineSurface,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges,
  runDir: '.agent-eval/optimizer-comparison',
  optimizationRunOptions: {
    maxConcurrency: 4,
  },
  costCeiling: 23,
  confidence: 0.95,
})
```

These snippets assume caller-defined cases, dispatch, judges, `optimizerExecution`, model ID, and current token pricing.
They illustrate configuration; the linked examples provide complete scripts.
Both methods above declare the same evaluation ceiling.
Their actual evaluations, model calls, and spend can differ.

`costCeiling` is one limit shared by optimizer-model calls, train and selection evaluations, and final test scoring.
It applies to calls admitted through the cost ledger.
Leave enough capacity for every method and the final measurements.
`comparison.scores` contains the final-case baseline score, selected score, lift, simultaneous interval, cost status, duration, and selected surface for each method.
Official method scores contain optimizer and bridge package versions, source revisions and source-tree hashes, Python runtime, custom engine module hashes, compatible run ID, exact attempt ID, resume status, evaluation count, artifact directory, and available optimizer token usage.
`comparison.pairwise` compares the highest-ranked method with every other method.
Ranking follows estimated lift.
`best` can therefore name a method whose improvement is unresolved.
Read each score's `decision` and the pairwise `favored` value before claiming a difference.
Intervals account for the method-versus-baseline contrasts and every possible method pair using a Bonferroni confidence adjustment.
The reported pairwise list contains only the observed best versus the alternatives.

By default, final replicates are averaged within scenarios before inference.
A `claim` can group scenarios into declared independent units and set `minimumEffect`.
Read `unitScores`, `scenarioScores`, `units`, and `pairedCellN` together to retain both units and raw observation counts.
Optional `finalEvidence` records fresh final-case exposure across calls sharing its ledger.
See [evaluation integrity](./evaluation-integrity.md) for reusable claims and their boundaries.

The runnable version is in [`examples/compare-optimization-methods`](../examples/compare-optimization-methods/).

## Install Official GEPA

From the repository root, install the bridge and locked standard-engine dependencies:

```sh
cd clients/python
uv sync --frozen --group gepa-release
cd ../..
export OPTIMIZER_PYTHON="$PWD/clients/python/.venv/bin/python"
```

Use `--group gepa-source` instead of `--group gepa-release` for composed recipes and source-only engines.
Those groups select different GEPA implementations and cannot coexist in one environment.
Pass the Python executable as `runner.command` when configuring a method directly.
The runnable examples read `OPTIMIZER_PYTHON` for that setting.
See the [Python GEPA guide](../clients/python/README.md#gepa) for other installation paths and compatibility checks.
Keep dependency revisions in the Python manifest and lock rather than copying them into integration code.

## Configure GEPA

`gepaOptimizationMethod()` accepts text surfaces and component surfaces.
A component surface has this shape:

```ts
const baselineSurface = {
  kind: 'components' as const,
  components: {
    planner: 'Plan the task.',
    executor: 'Execute the plan.',
  },
}
```

The `recipe` maps directly to official GEPA operations:

| Recipe | Official behavior |
|---|---|
| `engine` | Run one registered GEPA engine. |
| `sequential` | Run engines in order and retain the best result across stages. |
| `adaptive-sequential` | Switch engines after a configured period without improvement. |
| `best-of` | Run independent engines and choose the highest selection score. |
| `vote` | Run independent engines and use GEPA's vote composition. |
| `omni` | Run official best-of exploration, then continue from its winner. |

Each engine run requires `maxEvaluations`.
`maxProposerCostUsd` is optional and should be supplied only when the execution owner can enforce billed USD.
`engineConfig` carries the JSON-safe subset of configuration for the registered GEPA engine.
GEPA validates the engine name and those values.
Python callables, classes, custom loggers, and callbacks cannot be serialized through this TypeScript bridge.
For a custom engine, set `engineModules` to public dotted Python modules that call GEPA's official `register_engine()` function when imported.
The optimizer process imports those modules before GEPA resolves the engine name.

The standard GEPA engine accepts the official `GEPAConfig` fields.
Give Agent Eval the model, caller-owned execution callback, stable callback identity, and exact endpoint rates only when they are known:

```ts
const method = gepaOptimizationMethod({
  objective: 'Improve the complete system prompt.',
  evaluationId: 'support-agent',
  recipe: {
    kind: 'engine',
    run: {
      engine: 'gepa',
      maxEvaluations: 60,
      maxProposerCostUsd: 8,
      maxConcurrency: 8,
    },
  },
  optimizer: {
    model: optimizerModelId,
    call: optimizerExecution.call,
    callRef: optimizerExecution.callRef,
    budget: {
      maxCostUsd: 8,
      maxRequests: 100,
      maxRequestBytes: 2_000_000,
      maxResponseBytes: 2_000_000,
      maxOutputTokensPerRequest: 32_768,
      pricing: optimizerTokenPricing,
    },
  },
  describeScenario: (scenario) => ({ input: scenario.input }),
  describeArtifact: (artifact) => ({ output: artifact.output }),
})
```

`optimizerTokenPricing` must contain the current input and output USD rates per million tokens for the selected endpoint.
If billed USD is unknown, omit `maxCostUsd`, `pricing`, and `maxProposerCostUsd`; the recorded cost remains unknown rather than becoming a guessed zero.
With `optimizer`, every recipe stage must use the standard `gepa` engine or a metered agent CLI engine (below).
The optimizer proxy receives no provider key.
It enforces the declared request and token limits and records the owner's usage and opaque finite JSON evidence.
`maxProposerCostUsd` also limits each individual GEPA engine stage.

`optimizer.call` supplies the model transport for this bridge.
Its execution owner holds the provider credentials.

For agent-runtime, use its maintained `profileOptimizerModelCall` adapter for the selected `AgentProfile`.
Keep runtime configuration in the execution-owning package.
For a direct endpoint, adapt [the example execution owner](../examples/_shared/openai-compatible-owner.ts) to your transport.
It implements `ExternalOptimizerModelCall` and returns a typed success or failure with a receipt and execution evidence.
The callback must resolve with that outcome; rejection loses the execution record and fails the optimizer attempt.
The optimizer proxy enforces its declared model limits around the supplied callback.

### Metered agent CLI engines

The `autoresearch` and `meta_harness` engines drive a `claude` CLI subprocess.
They ship only in the tested official source revision, not in the published `gepa` package (see [Install Official GEPA](#install-official-gepa)).
Set `optimizer.anthropicEndpoint: true` to admit them in proxied mode.
The loopback proxy then also serves `POST /v1/messages` (Anthropic Messages API) and the bridge child receives `ANTHROPIC_BASE_URL`, an ephemeral `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` in its environment.
Every CLI call becomes one canonical execution-owner call with the same reservation, receipt, and budget pipeline as reflection traffic; the run fails if the receipt count differs from the admitted call count.
Each agent engine run must set `engineConfig.model` to `optimizer.model`, because the engines pass `--model` and that flag beats the injected environment.
The endpoint translates text and tool-use conversations.
Anthropic `tools`, `tool_choice`, `tool_use`, and `tool_result` map onto the canonical execution-owner contract, and a tool-calling response is synthesized back as the Anthropic stream shape the CLI expects.
System text translates from both slots the CLI uses: the top-level `system` field and system-role turns injected inside `messages`.
Claude-specific control fields (`thinking`, `context_management`, `output_config`) carry no token-billing semantics on the owner wire; the shim strips them and records the names in the ledger tag `strippedFields`.
It still refuses images, server tools, `top_p`, `top_k`, and `stop_sequences` with a loud Anthropic error envelope.
A budget refusal surfaces to the CLI as HTTP 402, which the CLI treats as terminal instead of retrying.
Agent sessions are chatty: size `budget.maxRequests` for tens of calls per engine run.
Without the flag, agent engines stay rejected in proxied mode.

**The `-inf` trap.**
GEPA scores an agent-engine candidate as one aggregate evaluation over the whole train set.
That one registering evaluation costs `trainSet.length` callback evaluations against `maxEvaluations`.
When `maxEvaluations` is below the train-set size, the callback rejects mid-aggregate and GEPA records the candidate score as `-inf`.
Set `maxEvaluations` to at least the train-set size for every registering evaluation you expect.

Without `optimizer`, an engine runs unproxied and can receive its own settings:

```text
recipe: {
  kind: 'engine',
  run: {
    engine: 'autoresearch',
    maxEvaluations: 60,
    maxProposerCostUsd: 8,
    engineConfig: {
      command: ['python', 'run_research.py'],
    },
  },
}
```

Its external model spend remains incomplete unless that engine reports it.
Supply provider API keys only through `runner.env`.
The child does not inherit exported provider credentials automatically.
The spawn builds the child environment from a fixed allowlist of benign variables (PATH, HOME, locale, `PYTHONPATH`) plus `runner.env`, so the parent environment is stripped by construction.
When `optimizer` is set, `removeCredentialEnvironment` also deletes credential-shaped keys from `runner.env`; the child then receives only the loopback proxy URL and an ephemeral key inside the input JSON.
Do not place credentials in `engineConfig` because run settings are persisted.

`describeScenario()` controls the train and selection data sent to GEPA.
`describeArtifact()` controls the execution evidence returned after a candidate is scored.
Agent Eval calls these callbacks only for train and selection cases; caller-owned context must respect the same boundary.

A direct standard GEPA run records `provenance.gepaCandidatePopulation`.
Pass that summary to `readGepaCandidatePopulationArtifact()` to verify and read every accepted candidate, its parent indices, and its selection scores.
Use `readExternalOptimizerObservationArtifact()` for every distinct callback submission, including proposals that GEPA rejected or the callback refused.
`provenance.evaluationCount` is the callback-metered evaluation total.
`provenance.upstreamReportedEvaluations` is GEPA's self-reported total; a difference means upstream skipped, cached, or double-counted work.

## Runtime controls

Set limits for the execution path you actually use.
Long-running dispatches and agent CLI engines can need different limits from short text evaluations.

| Setting | Default | When to change it |
|---|---|---|
| Method `timeoutMs` | 30 minutes | Bound the entire bridge run, including slow evaluations and checkpointing. |
| Campaign `dispatchShutdownTimeoutMs` | 5 seconds | Allow pending paid calls to settle after dispatch cancellation. |
| `optimizer.servedModelPolicy` | `exact` | Use `allow-within-family` only when substitutions within a model family are acceptable for the claim. |
| `reflection_lm_kwargs.num_retries` | Upstream setting | Set explicitly when bounding retry attempts in the GEPA reflection configuration. |
| `reflection_lm_kwargs.max_tokens` | Optimizer output cap | Use a limit supported by the endpoint and sufficient for the model's reasoning and output. |
| `recipe.run.maxProposerCostUsd` | Unset | Bound a GEPA stage separately when dollar accounting is available. |
| `recipe.run.maxEvaluations` | Required | Allow enough candidate-case calls for each intended aggregate evaluation. |
| `optimizer.budget.maxRequests` | Required | Bound optimizer calls; agent CLI sessions can use many calls per stage. |
| `selfImprove({ expectUsage })` | `assert` | Set `off` only for deterministic evaluation with no paid calls. |

Put reflection settings under `recipe.run.engineConfig.reflection.reflection_lm_kwargs` for a direct engine recipe.
Model substitutions remain recorded; accepting one does not establish performance of the originally requested model.
Request limits count calls admitted to the execution owner.
The owner must report its internal retries and enforce their declared bounds.

## Install Official SkillOpt

From the repository root:

```sh
cd clients/python
uv sync --frozen --group skillopt-source
cd ../..
export OPTIMIZER_PYTHON="$PWD/clients/python/.venv/bin/python"
```

Add `--group gepa-source` to the same sync command when comparing both methods.
Use the source group selected by the lock; the bridge's compatibility checks cover that implementation.
See the [Python SkillOpt guide](../clients/python/README.md#skillopt) for package requirements and validation.

`skillOptOptimizationMethod()` runs SkillOpt's official `ReflACTTrainer`.
Agent Eval supplies an environment adapter that sends each candidate and case back to the TypeScript execution and judging path.
SkillOpt's own test evaluation is disabled.
This integration uses SkillOpt's OpenAI-compatible optimizer backend so every model call can pass through the metered proxy.
Use SkillOpt directly when you need one of its CLI or provider-specific backends.

`maxEvaluations` is a hard callback limit, not a prediction of SkillOpt's internal work.
The official trainer decides how many rollouts each enabled phase needs.
The callback rejects the first request beyond the declared limit, including work from slow updates or meta-skill phases.

SkillOpt connects to a local proxy rather than receiving the provider key.
The proxy enforces the declared model limits before each call and records provider token usage at the rates supplied in `optimizer.budget`.
Missing token usage, an oversized request or response, a wrong model, streaming, and a call beyond budget all fail loudly.

## Use Official DSPy Optimizers

Keep DSPy programs and their optimizer state inside DSPy.
`DspyJudgeMetric` supplies Agent Eval rubric scores and feedback to official DSPy optimizers.
Configure the judging client and use the [Python DSPy guide](../clients/python/README.md#dspy) for installation and examples.
Use a separate environment when its GEPA dependency conflicts with the general optimizer bridge.

## Resume A Compatible Run

Both official methods default to `resume: 'never'`.
Use `resume: 'if-compatible'` to restore matching SkillOpt state or a matching direct GEPA engine.
Use `resume: 'required'` when missing or incompatible state should fail.
Direct GEPA resume also requires `trustResumeState: true` because upstream checkpoints use Python pickle.
Set it only for checkpoints created locally in a directory you control.
Composed GEPA recipes restart and never report that official state was restored.

A match includes:

- optimizer and bridge package versions, revisions, and source-tree hashes,
- Python runtime and custom engine module hashes,
- recipe or trainer settings,
- starting surface,
- train and selection descriptions,
- evaluation ID for execution and scoring behavior,
- seed,
- limits that affect the run.

Use a commit, content hash, or another stable value for `evaluationId`.
Change it whenever dispatch behavior, judges, model settings, or scoring logic changes.
Concurrent processes cannot write the same compatible run at the same time.

## Write A Custom Candidate Generator

Use `SurfaceProposer` when your code or runtime owns candidate creation.
The proposer receives the current surface, prior campaign history, findings, generation number, requested population size, and cancellation signal.
Every proposal finding must declare `proposal_origin: 'search' | 'production'`.
`runOptimization()` rejects unclassified findings before it calls the proposer.
Opaque reports and capture stores are not proposal input.
Convert analysis into explicit findings or close over a caller-owned knowledge source in your proposer.
Any caller-owned source must exclude final evaluation cases and results.

```ts
import type { SurfaceProposer } from '@tangle-network/agent-eval/campaign'

const proposer: SurfaceProposer = {
  kind: 'product-rules',
  async propose({ currentSurface, populationSize }) {
    const prompt = String(currentSurface)
    return [
      {
        surface: `${prompt}\nReturn JSON only.`,
        label: 'json-only',
        rationale: 'Training failures included prose around the JSON object.',
      },
      {
        surface: `${prompt}\nInclude every required field, using null when unknown.`,
        label: 'required-fields',
        rationale: 'Training failures omitted fields.',
      },
    ].slice(0, populationSize)
  },
}
```

Return a label and rationale when they will help later analysis.
Candidate creation must not read final test results.

A proposer may attach `attribution`: an opaque JSON-safe record stored with the proposal in the search ledger and retained on `GenerationCandidate.attribution` and in loop provenance.
The loop never interprets it.
Tag it with a schema field and validate it on readback.
`makePolicyEditCandidateRecord` from `/analyst` records an edit forecast that can later be compared with the measured change.

A candidate is a content-addressed node in the run's search ledger.
A candidate identical to a surface the search already holds, including the baseline, is a re-proposal: the ledger records a second edge into the existing node, and the surface is not measured again.
Use `reps` when one surface needs repeated measurements.
Lineage lives in the ledger: read a node's parents from its edges and its paired contrast from `estimateNode`, not from the generation record.

### Choose The Parent

`runOptimization()` runs on the search kernel with a `SearchPolicy` ([search ledger](./search-ledger.md#run-a-search-the-kernel)).
The default, `incumbent()`, is the hill climb: each proposal extends the leader once every earlier candidate is measured, and a candidate that scored every scenario leads when it beats the leader on the scenarios they share.
Pass `policy: crowdedFrontierParent({ seed })` to draw the parent from the Pareto frontier instead: a seeded NSGA-II crowded tournament that prefers isolated frontier members.
The proposer receives that parent as `ctx.currentSurface` and `ctx.parentOutcome`; `ctx.incumbentOutcome` stays the leader, and only a candidate that beats the leader leads.
`selfImprove({ policy })` forwards the same policy in proposer mode.

```ts
import { crowdedFrontierParent, runOptimization } from '@tangle-network/agent-eval/campaign'

const result = await runOptimization({
  // ...scenarios, dispatchWithSurface, judges, proposer, populationSize, maxGenerations, runDir
  policy: crowdedFrontierParent({ seed: 42 }),
})
```

`runOptimization` always writes its search ledger, at `<runDir>/search/ledger.jsonl` unless `searchLedger` puts it elsewhere, and returns the receipt on `searchHistory`.
Running it again on the same run directory continues an interrupted search and reruns nothing that settled; after a finished search it starts the next one beside it.

## Data And Cost Rules

- Train and selection cases are visible to complete optimization methods.
- Train and selection cases may influence candidate generation, selection, and stopping.
- Final test cases may only compare surfaces after every method finishes.
- The same dispatch and judges score every method.
- Missing cost remains unknown.
- Bound method work before it starts, including any caller-owned operations outside the ledger.
- Bridge children inherit a small environment allowlist; pass unproxied provider credentials only through `runner.env`.
- The metered proxy path replaces provider credentials with a loopback URL and an ephemeral key.
- Resumed state must match every input that can change the result.
