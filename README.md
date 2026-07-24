# `@tangle-network/agent-eval`

Measure agent behavior, compare changes on the same cases, and improve prompts or skills without exposing final test cases to the optimizer.

[![npm](https://img.shields.io/npm/v/@tangle-network/agent-eval.svg)](https://www.npmjs.com/package/@tangle-network/agent-eval)
[![pypi](https://img.shields.io/pypi/v/agent-eval-rpc.svg)](https://pypi.org/project/agent-eval-rpc/)
[![tests](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/tangle-network/agent-eval/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Use this package to:

- run an agent over representative cases and score every result,
- compare a candidate with a baseline using paired statistics,
- analyze existing runs, traces, or human feedback,
- optimize a prompt or skill with official GEPA or SkillOpt,
- supply your own candidate generator for product-specific changes.

The evaluation path runs in your TypeScript process.
Model calls occur only through the clients and agents you configure.

## Install

```sh
pnpm add @tangle-network/agent-eval
```

The official optimizers use the Python bridge.
Install only the optimizer you plan to run:

```sh
# Microsoft SkillOpt at the tested source revision
python -m pip install agent-eval-rpc
python -m pip install \
  "skillopt @ git+https://github.com/microsoft/SkillOpt.git@61735e3922efc2b90c6d6cab561e62e98452ca90"

# Standard GEPA engine from the published package
python -m pip install agent-eval-rpc
python -m pip install "gepa[full]==0.1.4"

# GEPA Omni and source-only engines
python -m pip install \
  "gepa[full] @ git+https://github.com/gepa-ai/gepa.git@f919db0a622e2e9f9204779b81fe00cc1b2d808f"

# DSPy 3.2.1 with Agent Eval metrics
python -m pip install "agent-eval-rpc[dspy]"
```

The published GEPA package supports the standard `gepa` engine.
Sequential, adaptive, best-of, vote, Omni, AutoResearch, Meta Harness, and Best-of-N currently require the tested official source revision.
Move that revision only after both release and source compatibility tests pass.
The published `skillopt==0.2.0` wheel omits the prompt files required by `ReflACTTrainer`, so the tested SkillOpt source revision is also intentional.
DSPy 3.2.1 requires GEPA 0.0.27, while the general bridge requires GEPA 0.1.4.
Install the DSPy adapter and the general GEPA bridge in separate Python environments.

## Evaluate An Agent

This example is offline.
Replace the agent and judge functions with your product code.

```ts
import { defineAgentEval } from '@tangle-network/agent-eval/contract'

interface SupportCase {
  id: string
  kind: 'support'
}

const evalKit = defineAgentEval<SupportCase, string>({
  scenarios: [
    { id: 'refund', kind: 'support' },
    { id: 'shipping', kind: 'support' },
    { id: 'cancel', kind: 'support' },
  ],
  agent: async (prompt, scenario) =>
    String(prompt).includes('ticket') ? `Ticket ${scenario.id}: on it.` : 'On it.',
  judge: {
    name: 'ticket-id',
    dimensions: [{ key: 'present', description: 'The answer includes the ticket id' }],
    score: ({ artifact, scenario }) => {
      const present = artifact.includes(scenario.id) ? 1 : 0
      return { dimensions: { present }, composite: present, notes: '' }
    },
  },
  baselineSurface: 'Answer politely.',
  expectUsage: 'off',
})

console.log((await evalKit.evaluate()).aggregates.byJudge)
console.log(
  (await evalKit.evaluate({ surface: 'Answer politely and cite the ticket id.' })).aggregates
    .byJudge,
)
```

Each call runs every case, records the artifact, applies the same judge, and returns score distributions.
The surface is the value being changed, such as a prompt, skill, or serialized configuration.

### Stop after the first failed cell

`runCampaign()` normally records a dispatch or judge error on that cell and continues the remaining cases.
Set `abortOnCellError: true` when another failed cell would only waste time or money:

```ts
await runCampaign({
  scenarios,
  dispatch,
  judges: [judge],
  runDir: 'release-candidate',
  abortOnCellError: true,
})
```

The failed cell is written first to `<runDir>/<cell>/failure-receipt.json`.
That receipt contains the original error, the cell result, exact call IDs, and settled agent-plus-judge cost and token totals.
Active sibling cells are cancelled and allowed to finish recording their own receipts before the campaign rejects with the original cell error.
Leaving `abortOnCellError` unset preserves continue-on-error behavior.

## Adapt Another Text Optimizer

Use `externalTextOptimizationMethod()` when an existing package owns search and selection for a text prompt or named text components.
Its `run` callback receives the starting candidate plus serialized train and selection cases, but it never receives final test cases.
The optimizer must score candidates through `context.evaluate()` so Agent Eval can enforce the evaluation limit and use the configured execution and judges.
Every optimizer-owned paid call must use `context.cost.runPaidCall()`.
Set `source` to the package version and revision, and set `evaluationId` to a commit, content hash, or other stable identity for the execution and scoring behavior.
Agent Eval derives the run identity from those values, the exact dispatch identity, the optimizer settings, the starting surface, the described data, and the seed.
The callback returns the selected candidate, whether compatible state was restored, and how optimizer spend was recorded.

See [Adapt A Third-Party Text Optimizer](./docs/campaign-proposers.md#adapt-a-third-party-text-optimizer) for a complete minimal adapter.

## Optimize With Official GEPA

`gepaOptimizationMethod()` delegates candidate search and recipe composition to the installed GEPA package.
Agent Eval supplies the train and selection cases, executes candidates, records cost, and evaluates the selected result on final cases after GEPA exits.

```ts
import { gepaOptimizationMethod } from '@tangle-network/agent-eval/campaign'

const optimizerPricing = {
  inputUsdPerMillion: Number(process.env.OPTIMIZER_INPUT_USD_PER_MILLION),
  outputUsdPerMillion: Number(process.env.OPTIMIZER_OUTPUT_USD_PER_MILLION),
}

const gepa = gepaOptimizationMethod<MyCase, MyArtifact>({
  objective: 'Improve the instructions so the agent returns valid, complete JSON.',
  evaluationId: 'json-agent',
  recipe: {
    kind: 'engine',
    run: {
      engine: 'gepa',
      maxEvaluations: 40,
      maxProposerCostUsd: 5,
    },
  },
  optimizer: {
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY!,
    budget: {
      maxCostUsd: 5,
      maxRequests: 100,
      maxRequestBytes: 2_000_000,
      maxResponseBytes: 2_000_000,
      maxOutputTokensPerRequest: 32_768,
      pricing: optimizerPricing,
    },
  },
  describeScenario: (scenario) => ({ input: scenario.input }),
  describeArtifact: (artifact) => ({ output: artifact.output }),
})
```

GEPA also supports official sequential, adaptive, best-of, vote, and Omni recipes through the same factory.
When every recipe stage uses the standard GEPA engine, Agent Eval keeps the provider key outside Python and records exact reflection usage through a local proxy.
Other official GEPA engines can still run through `engineConfig`, but their model spend remains incomplete unless the engine reports it.
Custom engines can register through GEPA's official registry by listing their Python modules in `engineModules`.

Run the repository example:

```sh
OPTIMIZERS=gepa \
LLM_API_KEY="$OPENAI_API_KEY" \
GEPA_PRICE_IN_PER_M=0.4 \
GEPA_PRICE_OUT_PER_M=1.6 \
pnpm tsx examples/compare-optimization-methods/index.ts
```

Replace the example rates with the exact endpoint rates.

## Optimize With Official SkillOpt

`skillOptOptimizationMethod()` runs Microsoft's `ReflACTTrainer` against the same TypeScript execution and scoring path.
SkillOpt receives train and selection cases but never receives final cases.

```ts
import { skillOptOptimizationMethod } from '@tangle-network/agent-eval/campaign'

const optimizerPricing = {
  inputUsdPerMillion: Number(process.env.OPTIMIZER_INPUT_USD_PER_MILLION),
  outputUsdPerMillion: Number(process.env.OPTIMIZER_OUTPUT_USD_PER_MILLION),
}

const skillopt = skillOptOptimizationMethod<MyCase, MyArtifact>({
  objective: 'Improve the skill so the agent returns valid, complete JSON.',
  evaluationId: 'json-agent',
  trainer: {
    epochs: 2,
    batchSize: 4,
  },
  optimizer: {
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY!,
    budget: {
      maxCostUsd: 5,
      maxRequests: 100,
      maxRequestBytes: 2_000_000,
      maxResponseBytes: 2_000_000,
      maxOutputTokensPerRequest: 32_768,
      pricing: optimizerPricing,
    },
  },
  maxEvaluations: 80,
  describeScenario: (scenario) => ({ input: scenario.input }),
  describeArtifact: (artifact) => ({ output: artifact.output }),
})
```

Replace the example rates with the exact rates for your endpoint.
Agent Eval places a local OpenAI-compatible proxy between each standard optimizer and the provider.
The proxy enforces request, byte, token, and dollar limits before forwarding calls, records exact usage from provider responses, and does not pass the provider key to the optimizer process.

## Optimize A DSPy Program

DSPy owns its program optimizers.
`DspyJudgeMetric` lets them use the same Agent Eval rubric as TypeScript agents.

```python
import dspy

from agent_eval_rpc import DspyJudgeMetric

dspy.configure(lm=dspy.LM("openai/gpt-4.1-mini"))
metric = DspyJudgeMetric(rubric_name="answer-quality")

# GEPA needs both the numeric score and diagnostic feedback.
optimizer = dspy.GEPA(
    metric=metric.feedback,
    reflection_lm=dspy.LM("openai/gpt-4.1-mini"),
    max_metric_calls=100,
)
optimized_program = optimizer.compile(program, trainset=train, valset=selection)

# MIPROv2, SIMBA, and few-shot optimizers use the numeric metric directly.
mipro = dspy.MIPROv2(metric=metric, auto="light")
```

Use official DSPy directly for DSPy programs.
Use `gepaOptimizationMethod()` for text or named component surfaces in non-DSPy agents.
Use agent-runtime's worktree path for executable code changes.

## Compare Complete Methods

`compareOptimizationMethods()` gives each method the same starting surface, execution function, judges, train cases, and selection cases.
It waits for optimization to finish before it evaluates any selected surface on the final cases.

```ts
import { compareOptimizationMethods } from '@tangle-network/agent-eval/campaign'

const result = await compareOptimizationMethods({
  methods: [gepa, skillopt],
  baselineSurface,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges,
  runDir: '.agent-eval/optimizer-comparison',
})

console.table(result.scores)
```

Read `scores` for final-case lift and intervals.
Read `pairwise` before claiming one method beat another.
Read `totalCost.accountingComplete` before using the reported dollars as a complete total.
Each official method score records the optimizer and bridge package versions, source revisions and source-tree hashes, Python runtime, configured optimizer model when present, custom engine module hashes, compatible run ID, exact attempt ID, resume status, evaluation count, artifact directory, and available optimizer token usage in `provenance`.

The [optimizer guide](./docs/campaign-proposers.md) covers recipes, budgets, resuming, and data separation.
The [runnable comparison](./examples/compare-optimization-methods/) can run GEPA, SkillOpt, or both.

## Supply Your Own Candidate Generator

Use `SurfaceProposer` when candidate creation belongs to your product or an agent runtime.
The campaign still owns execution, scoring, history, stopping, and release decisions.

```ts
import {
  defineAgentEval,
  type SurfaceProposer,
} from '@tangle-network/agent-eval/contract'

const proposer: SurfaceProposer = {
  kind: 'product-rules',
  async propose({ currentSurface, populationSize }) {
    const prompt = String(currentSurface)
    return [
      {
        surface: `${prompt}\nReturn JSON only.`,
        label: 'json-only',
        rationale: 'Training failures contained prose around the JSON object.',
      },
    ].slice(0, populationSize)
  },
}

const result = await defineAgentEval({
  scenarios,
  agent,
  judge,
  baselineSurface,
  proposer,
  budget: { generations: 1, populationSize: 1, holdoutFraction: 0.3 },
}).improve()
```

Run the complete offline example:

```sh
pnpm tsx examples/selfimprove-quickstart/index.ts
```

## Start From Existing Runs

You do not need a runnable agent to analyze data you already captured.
Use `analyzeRuns()` for `RunRecord[]`, or use the feedback and OpenTelemetry adapters to normalize existing data first.

See [concepts](./docs/concepts.md), [customer paths](./docs/customer-journeys.md), and [trace analysis](./docs/trace-analysis.md).

## Entry Points

| Import | Use |
|---|---|
| `@tangle-network/agent-eval/contract` | Define an evaluation, run it, improve with a custom candidate generator, and analyze runs. |
| `@tangle-network/agent-eval/campaign` | Control campaigns, official optimization methods, comparisons, storage, and release rules. |
| `@tangle-network/agent-eval/reporting` | Statistical comparisons and report rendering. |
| `@tangle-network/agent-eval/analyst` | Model-assisted failure analysis. |
| `@tangle-network/agent-eval/traces` | Store, replay, and inspect structured traces. |
| `@tangle-network/agent-eval/benchmarks` | Benchmark adapters and retrieval metrics. |
| `@tangle-network/agent-eval/rl` | Export rewards, preferences, and training rows. |
| `@tangle-network/agent-eval/wire` | HTTP and RPC schemas for other languages. |

Prefer these subpaths for new code.
The root export remains broad for compatibility.

## Examples

| Goal | Example |
|---|---|
| Evaluate and improve with a custom candidate generator | [`selfimprove-quickstart`](./examples/selfimprove-quickstart/) |
| Run official GEPA or SkillOpt | [`compare-optimization-methods`](./examples/compare-optimization-methods/) |
| Analyze human feedback | [`customer-feedback-loop`](./examples/customer-feedback-loop/) |
| Analyze OpenTelemetry traces | [`customer-otel-traces`](./examples/customer-otel-traces/) |
| Run public benchmark adapters | [`benchmarks`](./examples/benchmarks/) |

See the [example index](./examples/README.md) for the full list.

## Development

```sh
pnpm install
pnpm typecheck
pnpm typecheck:examples
pnpm test
pnpm build
```

Python compatibility tests use the locked dependencies:

```sh
cd clients/python
uv sync --frozen --extra dev --group gepa-release
AGENT_EVAL_EXPECT_GEPA_RELEASE=1 \
  uv run --frozen --extra dev --group gepa-release \
  pytest tests/test_gepa_release_compatibility.py tests/test_gepa_bridge.py

uv sync --frozen --extra dev --group skillopt-source --group gepa-source
uv run --frozen pytest

uv sync --frozen --extra dev --extra dspy
uv run --frozen pytest tests/test_dspy_metric.py
```

## License

MIT.
