# Candidate Generation and Method Comparison

`SurfaceProposer` generates candidate prompts or configs.
It does not run an agent, score output, or choose a winner.

`OptimizationMethod` runs a complete search procedure on train and selection data.
It returns one selected surface plus its optimization cost.

`compareOptimizationMethods` runs multiple methods, waits for every method to finish, then scores their selected surfaces on the same final test data.

| API | Responsibility |
|---|---|
| `SurfaceProposer` | Suggest the next candidate surface. |
| `runOptimization` | Run and score candidates on training scenarios. |
| `runImprovementLoop` | Optimize one surface and apply a release rule on separate scenarios. |
| `OptimizationMethod` | Adapt one complete optimization procedure for comparison. |
| `compareOptimizationMethods` | Compare selected surfaces on shared final test data. |

## Candidate Generators

Every `SurfaceProposer.propose(ctx)` receives the current surface, prior candidate scores, findings, requested candidate count, generation number, and cancellation signal.
It may also receive a larger analysis report, a labeled scenario store, or Pareto parents when the caller provides them.

A proposer may return a bare surface or a labeled candidate:

```ts
{
  surface: 'the complete new prompt or config',
  label: 'require-citations',
  rationale: 'three training failures omitted source references',
}
```

Use a labeled `ProposedCandidate` when you need the result to retain why the candidate was generated.

| Factory | Use it for | Surface |
|---|---|---|
| `gepaProposer` | Rewrite a prompt from prior scores and findings. | string |
| `skillOptProposer` | Apply bounded edits to a structured skill or runbook. | string |
| `aceProposer` | Append distinct lessons from findings. | string |
| `memoryCurationProposer` | Deduplicate and compact lessons from findings. | string |
| `parameterSweepProposer` | Apply declared changes to a JSON config. | JSON string |
| `fapoProposer` | Try prompt, parameter, and optional structural changes under one escalation policy. | caller-defined |

## Compare Complete Methods

The following call owns the shared baseline, runner, judges, directories, and three data sets.
Method configuration contains only settings that differ by method.

```ts
import {
  type BuiltinOptimizationMethodConfig,
  compareOptimizationMethods,
  gepaParetoMethod,
  gepaReflectionMethod,
  skillOptMethod,
} from '@tangle-network/agent-eval/campaign'

const methodConfig: BuiltinOptimizationMethodConfig<MyScenario, MyArtifact> = {
  llm,
  model,
  target: 'the complete prompt or config being improved',
  populationSize: 2,
  maxGenerations: 3,
  maxEpochs: 6,
}

const comparison = await compareOptimizationMethods<MyScenario, MyArtifact>({
  methods: [
    gepaReflectionMethod(methodConfig),
    gepaParetoMethod(methodConfig),
    skillOptMethod(methodConfig),
  ],
  baselineSurface,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges,
  runDir,
  optimizationRunOptions: {
    costCeiling: 5,
    dispatchTimeoutMs: 60_000,
    maxConcurrency: 4,
  },
  optimizationConcurrency: 2,
  costCeiling: 2,
  maxConcurrency: 4,
  confidence: 0.95,
})
```

The runnable version is [`examples/compare-optimization-methods`](../examples/compare-optimization-methods/).

## External GEPA

`gepaOptimizationMethod()` passes a text surface, such as a prompt or JSON retrieval policy, to GEPA's own `optimize_anything` API.
GEPA remains the source of truth for built-in and caller-registered engine names.
It does not edit a repository, ingest a knowledge base, or replace a retrieval engine.

Install the optional Python bridge first:

```sh
pip install 'agent-eval-rpc[gepa]'
```

The extra pins a GEPA source commit because the published `gepa==0.1.4` package does not contain this multi-engine API.
Update the pin only after repeating the integration smoke and comparison benchmarks.

```ts
import { gepaOptimizationMethod } from '@tangle-network/agent-eval/campaign'

const externalGepa = gepaOptimizationMethod<MyScenario, MyArtifact>({
  recipe: {
    kind: 'best-of-then-continue',
    explore: [
      { engine: 'gepa', maxEvaluations: 6, maxProposerCostUsd: 5 },
      { engine: 'autoresearch', maxEvaluations: 6, maxProposerCostUsd: 5 },
      { engine: 'meta_harness', maxEvaluations: 6, maxProposerCostUsd: 5 },
    ],
    continueWith: { engine: 'gepa', maxEvaluations: 6, maxProposerCostUsd: 5 },
  },
  objective: 'Return a better retrieval policy as JSON.',
  describeScenario: (scenario) => ({ id: scenario.id }),
})

const comparison = await compareOptimizationMethods({
  methods: [gepaParetoMethod(methodConfig), externalGepa],
  baselineSurface,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges,
  runDir,
})
```

This recipe is GEPA's published Omni shape: the bridge calls GEPA's `optimize_best_of(...)` for the parallel exploration stage, then its `optimize_anything(...)` for the fresh continuation stage.
It does not implement a local optimizer or scheduler.
GEPA reports Omni winning its matched-budget, 10-task Frontier-CS experiment, but that is not evidence that it wins your task.
Run it alongside current methods and select only on fresh final cases.

The bridge serializes only the values returned by `describeScenario()` for train and selection cases.
Final test cases remain in `compareOptimizationMethods()` and are first scored after GEPA exits.
By default, GEPA starts in its empty run directory.
Do not set `runner.cwd` to a location that contains final cases.

Each engine run declares its own `maxEvaluations` and `maxProposerCostUsd`.
The local callback enforces the sum of the recipe's evaluation limits before it runs an agent or judge.
The sum of `maxProposerCostUsd` values is a requested GEPA spend cap, but GEPA's reported cost is not an agent-eval receipt.
The comparison therefore marks that method's cost accounting incomplete and never treats a reported `$0` as confirmed spend.

Use `{ kind: 'engine', run: { ... } }` to call one GEPA engine directly.
`engineConfig` is passed directly to that GEPA engine.
The bridge accepts any trimmed engine string and GEPA validates whether it is installed or registered.

For `agent-knowledge`, use this only to compare a text retrieval policy against `runRetrievalImprovementLoop()`.
Keep source acquisition, knowledge writes, provenance, freshness, memory, and promotion in `agent-knowledge`.

## Data Use

| Set | Who can read it | Purpose |
|---|---|---|
| Train | Optimization methods and candidate generators | Generate and fit candidates. |
| Selection | Optimization methods | Accept candidates, stop early, and select one surface per method. |
| Test | `compareOptimizationMethods` only | Estimate final lift and rank methods. |

All three sets must be non-empty and pairwise disjoint by scenario ID.
Test must contain at least two scenarios.
Two is only an API minimum; use enough scenarios to detect the effect size that matters for your product.

Each method receives independent copies of train and selection scenarios.
The final test set is absent from `OptimizationMethodInput`.
Every method finishes before the first test call starts.
When `optimizationConcurrency` is greater than one, the shared runner and judges must support concurrent calls.

## Execution And Cost

`optimizationConcurrency` controls how many methods run at once.
`optimizationRunOptions.maxConcurrency` controls scenario calls inside each method.
Top-level `maxConcurrency` controls scenario calls during final test scoring.

`optimizationRunOptions.costCeiling` is a separate limit for each method.
Top-level `costCeiling` is one shared limit across baseline and selected-surface scoring on final test.

The result reports three cost objects:

```ts
comparison.optimizationCost
comparison.testCost
comparison.totalCost
```

Each object contains `totalCostUsd`, `accountingComplete`, and `incompleteReasons`.
An unknown provider charge therefore cannot appear as a trustworthy zero-dollar total.
Cost breaks a lift tie only when every method in that tied group reports complete accounting.

## Read The Result

```ts
for (const method of comparison.scores) {
  console.log({
    rank: method.rank,
    name: method.name,
    lift: method.lift,
    interval: method.liftCi,
    scenarios: method.scenarioScores,
    optimizationCostUsd: method.optimizationCost.totalCostUsd,
    costComplete: method.optimizationCost.accountingComplete,
  })
}
```

`rank` orders methods by estimated lift, then by cost only when every method with that lift has complete cost accounting.
It does not mean the higher-ranked method is conclusively better.
Read `liftCi` and `comparison.pairwise[].favored` before making that claim.
`scenarioScores` contains the paired values used to compute each method's result.

Repetitions are averaged within each test scenario before scenarios are resampled.
The intervals assume scenarios are the independent sampling units.

`confidence: 0.95` applies to the complete family of method-vs-baseline and possible method-vs-method contrasts.
The implementation adjusts each interval for that family and raises the default resample count when more methods require finer interval tails.
An explicit resample count that is too small is rejected before optimization starts.

The final test data is spent when this function ranks methods.
If you choose a method from this result and later claim its deployed effect, confirm that claim on new data that was not used for this ranking.

## FAPO

`fapoProposer` can move from prompt edits to declared parameter edits and then to an injected structural proposer.
Every level must accept and return the same surface representation.

`agent-eval` does not generate repository code itself.
Pass a code-capable `structuralProposer` from your runtime or application when structural edits are part of the comparison.

Use `fapoEscalationMethod(config)` to compare the complete FAPO procedure with other methods.

## Common Errors

- Do not pass a raw `SurfaceProposer` to `compareOptimizationMethods`.
- Do not let a custom `OptimizationMethod` load final test rows from another source.
- Do not compare methods with different runners, judges, or final test scenarios.
- Do not read `method.optimizationCost` as total comparison cost.
- Do not report a dollar total as complete when `accountingComplete` is false.
- Do not reuse the final test set for repeated method selection and continue calling it untouched.
