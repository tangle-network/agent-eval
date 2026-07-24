# Optimization Methods And Candidate Generators

Agent Eval supports two different extension points.

An `OptimizationMethod` owns a complete search procedure and returns one selected surface.
Use it for official GEPA, official SkillOpt, or another optimizer with its own search and selection behavior.

A `SurfaceProposer` suggests candidates inside Agent Eval's campaign loop.
Use it for caller-defined logic, an agent-runtime worker, or declared parameter combinations.

Do not wrap a complete external optimizer in `SurfaceProposer`.
That would split its search state from its own selection behavior and make budgets harder to compare.

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

An optimization method never receives the final test cases.
After every method finishes, Agent Eval scores the selected surfaces on the same final cases and reports paired lift estimates.

```ts
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  skillOptOptimizationMethod,
} from '@tangle-network/agent-eval/campaign'

const optimizer = {
  model: 'gpt-4.1-mini',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  budget: {
    maxCostUsd: 5,
    maxRequests: 100,
    maxRequestBytes: 2_000_000,
    maxResponseBytes: 2_000_000,
    maxOutputTokensPerRequest: 32_768,
    pricing: {
      inputUsdPerMillion: Number(process.env.OPTIMIZER_INPUT_USD_PER_MILLION),
      outputUsdPerMillion: Number(process.env.OPTIMIZER_OUTPUT_USD_PER_MILLION),
    },
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
      maxEvaluations: 40,
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

`costCeiling` is one limit shared by optimizer-model calls, train and selection evaluations, and final test scoring.
`comparison.scores` contains the final-case baseline score, selected score, lift, simultaneous interval, cost status, duration, and selected surface for each method.
Official method scores contain optimizer and bridge package versions, source revisions and source-tree hashes, Python runtime, custom engine module hashes, compatible run ID, exact attempt ID, resume status, evaluation count, artifact directory, and available optimizer token usage.
`comparison.pairwise` compares the highest-ranked method with every other method.
Ranking follows estimated lift, so inspect intervals before claiming a difference.

The runnable version is in [`examples/compare-optimization-methods`](../examples/compare-optimization-methods/).

## Install Official GEPA

Install the bridge and the source revision tested by this release:

```sh
python -m pip install agent-eval-rpc
python -m pip install "gepa @ git+https://github.com/gepa-ai/gepa.git@f919db0a622e2e9f9204779b81fe00cc1b2d808f"
```

The published `gepa==0.1.4` wheel does not contain the required Optimize Anything API.
The Agent Eval Python package cannot declare a Git dependency in its PyPI metadata, so the GEPA source install is separate.

From this repository:

```sh
cd clients/python
uv sync --frozen --group gepa-source
```

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

Each engine run requires `maxEvaluations` and `maxProposerCostUsd`.
`engineConfig` carries the JSON-safe subset of configuration for the registered GEPA engine.
GEPA validates the engine name and those values.
Python callables, classes, custom loggers, and callbacks cannot be serialized through this TypeScript bridge.
For a custom engine, set `engineModules` to public dotted Python modules that call GEPA's official `register_engine()` function when imported.
The optimizer process imports those modules before GEPA resolves the engine name.

The standard GEPA engine accepts the official `GEPAConfig` fields.
Give Agent Eval the model, exact endpoint rates, and provider connection separately:

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
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY!,
    budget: {
      maxCostUsd: 8,
      maxRequests: 100,
      maxRequestBytes: 2_000_000,
      maxResponseBytes: 2_000_000,
      maxOutputTokensPerRequest: 32_768,
      pricing: {
        inputUsdPerMillion: 0.4,
        outputUsdPerMillion: 1.6,
      },
    },
  },
  describeScenario: (scenario) => ({ input: scenario.input }),
  describeArtifact: (artifact) => ({ output: artifact.output }),
})
```

Replace the rates with the exact rates charged by your endpoint.
With `optimizer`, every recipe stage must use the standard `gepa` engine.
Agent Eval keeps the provider key outside Python, enforces the shared model budget, and records exact provider usage.
`maxProposerCostUsd` also limits each individual GEPA engine stage.

Other official engines can still receive their own settings:

```ts
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

Their external model spend remains incomplete unless that engine reports it.
Keep API keys in environment variables or `runner.env`.
Do not place credentials in `engineConfig` because run settings are persisted.

`describeScenario()` controls the train and selection data sent to GEPA.
`describeArtifact()` controls the execution evidence returned after a candidate is scored.
Neither callback can receive a final test case.

## Install Official SkillOpt

Install the SkillOpt source revision tested by this release:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "skillopt @ git+https://github.com/microsoft/SkillOpt.git@61735e3922efc2b90c6d6cab561e62e98452ca90"
```

From this repository:

```sh
cd clients/python
uv sync --frozen --group skillopt-source
```

The published `skillopt==0.2.0` wheel omits the prompt files required by `ReflACTTrainer`.
The tested source revision contains all 21 files.

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

Do not convert a DSPy program into an `OptimizationMethod`.
Install `agent-eval-rpc[dspy]`, create `DspyJudgeMetric`, and pass it to official DSPy:

```python
import dspy

from agent_eval_rpc import DspyJudgeMetric

metric = DspyJudgeMetric(rubric_name="answer-quality")
gepa = dspy.GEPA(
    metric=metric.feedback,
    reflection_lm=dspy.LM("openai/gpt-4.1-mini"),
    max_metric_calls=100,
)
mipro = dspy.MIPROv2(metric=metric, auto="light")
```

This keeps program compilation, traces, demos, and optimizer state inside DSPy.
Agent Eval supplies the shared rubric and returns rich feedback for `dspy.GEPA`.
DSPy 3.2.1 requires GEPA 0.0.27.
Run it in a separate Python environment from the general GEPA bridge, which uses GEPA 0.1.4.

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

## Data And Cost Rules

- Train and selection cases are visible to complete optimization methods.
- Train and selection cases may influence candidate generation, selection, and stopping.
- Final test cases may only compare surfaces after every method finishes.
- The same dispatch and judges score every method.
- Missing cost remains unknown.
- A method must declare bounded work before it starts.
- Credentials belong in process environment variables.
- Resumed state must match every input that can change the result.

These rules make method comparisons inspectable without pretending different optimizers have identical internals.
