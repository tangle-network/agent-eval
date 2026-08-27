# Adoption Paths

Choose the path that matches the data and code you already have.

| Starting point | API | Result |
|---|---|---|
| Completed OpenTelemetry spans | `fromOtelSpans()` and `analyzeRuns()` | Failure, score, token, and cost summaries |
| Human ratings | `fromFeedbackTable()` and `analyzeRuns()` | Reviewer agreement, largest disagreements, and score distributions |
| A runnable agent, scenarios, and a judge | `defineAgentEval()` | Repeatable evaluation and optional prompt improvement |

All three paths return plain objects and run in your process.
They call a remote service only when you pass a model client, exporter, or hosted endpoint.

## 1. Analyze Existing Traces

Use this path when the agent already emits OpenTelemetry spans and you do not want to run it again.

```ts
import { analyzeRuns, fromOtelSpans } from '@tangle-network/agent-eval/contract'

const runs = fromOtelSpans({ spans: yourOtelSpans })
const report = await analyzeRuns({ runs })

console.log(report.composite)
console.log(report.costQuality)
console.log(report.recommendations)
```

`fromOtelSpans()` groups spans by run ID and reads recorded scores, failures, model IDs, token counts, and costs.
It does not infer values that are missing from the spans.

Add model-based failure clustering only when you need it:

```ts
const report = await analyzeRuns({
  runs,
  analyst,
})

console.log(report.failureClusters)
```

Runnable example: [`examples/customer-otel-traces`](../examples/customer-otel-traces/)

## 2. Analyze Human Ratings

Use this path when multiple people score the same outputs in a database, spreadsheet, or review tool.

```ts
import { analyzeRuns, fromFeedbackTable } from '@tangle-network/agent-eval/contract'

const ratings = [
  { runId: 'answer-1', rater: 'alice', rating: true },
  { runId: 'answer-1', rater: 'bob', rating: false },
  { runId: 'answer-2', rater: 'alice', rating: true },
  { runId: 'answer-2', rater: 'bob', rating: true },
]

const { runs, raterScores } = fromFeedbackTable({ ratings })
const report = await analyzeRuns({ runs, raterScores })

console.log(report.interRater?.kappa)
console.log(report.interRater?.icc)
console.log(report.interRater?.disagreementCases)
```

Weighted kappa and ICC measure absolute agreement.
Pearson and Spearman measure correlation and are reported separately because reviewers can correlate while using different score levels.

Review the largest disagreements before using those labels to calibrate a model judge.
Test the judge on human ratings that were not used during calibration.

Runnable example: [`examples/customer-feedback-loop`](../examples/customer-feedback-loop/)

## 3. Evaluate Or Improve A Runnable Agent

Use this path when you can call the agent for a scenario and score the returned artifact.

```ts
import { defineAgentEval } from '@tangle-network/agent-eval/contract'

const evalKit = defineAgentEval({
  scenarios,
  agent: async (prompt, scenario) => yourAgent.run({ prompt: String(prompt), scenario }),
  judge: {
    name: 'task-quality',
    dimensions: [
      { key: 'correct', description: 'The answer is correct' },
      { key: 'complete', description: 'The answer covers the whole request' },
    ],
    score: ({ artifact, scenario }) => scoreArtifact(artifact, scenario),
  },
  baselineSurface: currentPrompt,
})

const baseline = await evalKit.evaluate()
const candidate = await evalKit.evaluate({ surface: proposedPrompt })
```

Call `.evaluate()` when you already have a candidate to compare.
Call `.improve()` when you want the library to generate and test candidates:

```ts
const result = await evalKit.improve({
  llm: {
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4.1-mini',
  },
})

console.log(result.winner.surface)
console.log(result.lift)
console.log(result.gateDecision)
```

The default candidate generator calls the configured model.
The agent and judge may make their own calls depending on your implementation.
Set generation, population, concurrency, and dollar limits through `budget`.

For production use, provide enough scenarios to keep candidate generation and final comparison disjoint.
Use an explicit held-back scenario set when the split must remain stable across runs.

Runnable example: [`examples/selfimprove-quickstart`](../examples/selfimprove-quickstart/)

## Moving Between Paths

The paths compose without changing data formats:

1. Convert traces or ratings into `RunRecord[]` and use `analyzeRuns()` to find recurring failures.
2. Turn those failures into representative scenarios and deterministic checks where possible.
3. Use `defineAgentEval()` to compare changes against the same scenarios.
4. Use `.improve()` only after the evaluation reliably separates known-good from known-bad behavior.

See [`concepts.md`](./concepts.md) for data types and [`examples/README.md`](../examples/README.md) for the full runnable index.
