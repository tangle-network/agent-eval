# Trace Analysis

A trace analyst is a recursive research program that answers a question by choosing which trace data to inspect.
It is not a single prompt over a prebuilt trace dump.

Agent Eval separates five concerns:

| Part | Responsibility |
|---|---|
| Analyst definition | The question, investigation policy, allowed tools, and limits |
| Analysis engine | Runs the recursive investigation |
| Trace store | Provides bounded reads over OTLP traces |
| Finding | Records one structured claim with exact evidence |
| Analysis result | Returns the prose answer, findings, investigation steps, model calls, tool calls, and runtime |

The built-in model-backed analysts use the official DSPy `RLM`.
DSPy runs the research loop and a sandboxed Python interpreter.
Agent Eval owns trace access, credentials, cancellation, cost accounting, and output validation.

`callLlmJson()` and `createPublicBenchmarkDirectRunner()` are direct-call baselines.
They are not trace analysts.

## Install

Install the TypeScript package and the matching Python package with DSPy:

```sh
pnpm add @tangle-network/agent-eval
python -m venv .venv
.venv/bin/pip install "agent-eval-rpc[dspy]"
```

The Python extra pins the tested stable DSPy and Deno versions.

## Answer One Question

```ts
import {
  createDspyRlmTraceEngine,
} from '@tangle-network/agent-eval/analyst'
import {
  analyzeTraces,
} from '@tangle-network/agent-eval/traces'

const engine = createDspyRlmTraceEngine({
  baseUrl: process.env.LLM_BASE_URL!,
  apiKey: process.env.LLM_API_KEY!,
  model: process.env.LLM_MODEL!,
  pricing: {
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  },
  maxCostUsd: 0.50,
  runner: { command: '.venv/bin/python' },
})

const result = await analyzeTraces(
  { question: 'What first caused this run to fail?' },
  {
    source: 'run.otlp.jsonl',
    engine,
    toolGroup: 'singleTrace',
    limits: {
      maxIterations: 8,
      maxLlmCalls: 4,
      maxToolCalls: 32,
    },
  },
)

console.log(result.answer)
console.log(result.findings)
console.log(result.trajectory)
```

Omit `pricing` only when Agent Eval already recognizes the exact model or model family.
Unknown pricing fails before the first model call.

The provider key remains in the Node process.
The Python process receives an authenticated loopback model endpoint with an ephemeral credential.
Each trace read also crosses an authenticated loopback callback and counts against `maxToolCalls`.

## Define A Reusable Analyst

An analyst definition contains no model, credentials, or execution state.
The same definition can run with DSPy or another engine that implements `TraceAnalysisEngine`.

```ts
import {
  defineTraceAnalyst,
  runTraceAnalyst,
} from '@tangle-network/agent-eval/analyst'
import {
  OtlpFileTraceStore,
} from '@tangle-network/agent-eval/traces'

const repeatedFailure = defineTraceAnalyst({
  id: 'repeated-tool-failure',
  description: 'Finds the repeated tool failure with the largest impact.',
  area: 'tool-use',
  version: '1.0.0',
  question: 'Which repeated tool failure should we fix first?',
  instructions: [
    'Compare frequency and downstream impact.',
    'Cite the failing span and at least one affected downstream span.',
    'Return no finding when the traces do not support a repeated failure.',
  ].join('\n'),
  toolGroup: 'all',
  minimumEvidenceCitations: 2,
  limits: {
    maxIterations: 10,
    maxLlmCalls: 6,
    maxToolCalls: 40,
  },
})

const store = new OtlpFileTraceStore({ path: 'runs.otlp.jsonl' })
await store.ensureIndexed()

const result = await runTraceAnalyst({
  definition: repeatedFailure,
  engine,
  store,
  context: { runId: 'release-42' },
})
```

Keep product policy in the definition.
Keep model transport, recursion mechanics, secrets, and accounting in the engine.
Keep exact trace facts in deterministic tools or checks.

## Run The Built-In Set

The default registry always includes deterministic behavior checks.
It adds the four recursive analysts only when an engine is supplied:

- `failure-mode`
- `knowledge-gap`
- `knowledge-poisoning`
- `improvement`

```ts
import {
  buildDefaultAnalystRegistry,
} from '@tangle-network/agent-eval/analyst'

const registry = buildDefaultAnalystRegistry({ engine })
const run = await registry.run('release-42', { traceStore: store })

for (const finding of run.findings) {
  console.log(finding.analyst_id, finding.claim, finding.evidence_refs)
}
```

`run.per_analyst` records each analyst's status, latency, calls, tokens, and cost.
One analyst failure does not become an agent failure.

Pass `definitions` to replace the four built-ins.
Omit `engine` for deterministic-only analysis.

## Trace Tools

The engine receives only the tool group declared by the analyst:

| Group | Use |
|---|---|
| `singleTrace` | Inspect one known trajectory |
| `discoveryAndSearch` | Find relevant traces and spans across a dataset |
| `all` | Use every bounded trace operation |

The canonical operations are:

- `getDatasetOverview`
- `queryTraces`
- `countTraces`
- `viewTrace`
- `viewSpans`
- `searchTrace`
- `searchSpan`

Use `buildTraceAnalysisToolDescriptors({ store })` to bind the same operations into another runtime.
Each descriptor includes its name, namespace, description, JSON input schema, and bounded handler.
Do not copy the schemas or reimplement the handlers in another adapter.

Custom stores implement `TraceAnalysisStore`.
`OtlpFileTraceStore`, `otlpTextToTraceAnalysisStore()`, and `toolSpansToTraceAnalysisStore()` provide common adapters.
Store results are checked for missing fields, undeclared fields, inconsistent counts, invalid continuation flags, oversized responses, and unsafe search patterns.

## Result Contract

Every recursive run returns:

| Field | Meaning |
|---|---|
| `answer` | Direct answer to the analyst question |
| `findings` | Valid cited claims accepted by the analyst policy |
| `trajectory` | DSPy RLM investigation steps |
| `modelCalls` | Successful provider completions used by the engine |
| `toolCalls` | Trace reads admitted for execution, including a read that later fails |
| `runtime` | Engine, package, sandbox identity, provider attempts, and successful completions |

Each finding requires exact `trace://` or `finding://` evidence.
Trace citations must resolve to an existing span.
When a citation includes an excerpt, the exact text must occur in that span or referenced finding.
Unknown, transformed, or fabricated identifiers are rejected.
An empty findings array means no submitted claim passed the evidence rules.
It does not prove the run was correct.

## Measure Analyst Quality

Measure the analyst on labeled traces before using its findings for automated changes.
At minimum, report issue recall, finding precision, exact evidence accuracy, trusted-negative false positives, repeat agreement, failures, calls, tokens, cost, and latency.

The certified reference for the shipping CodeTraceBench configuration lives in `benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/` (pre-registered two-sealed-split protocol, all arms and paired CIs disclosed); cite numbers from there, never from spent dev splits.
Cross-run and pooled comparisons use `benchmarks/trace-analysis/tools/compare-analyst-runs.mjs`.

`runAnalystBenchmark()` compares any `AnalystBenchmarkRunner` implementations.
`agent-eval analyst-benchmark` runs the public AgentRx or CodeTraceBench adapters with:

1. an empty-finding baseline,
2. the actual DSPy RLM trace analyst.

```sh
agent-eval analyst-benchmark \
  --dataset codetracebench \
  --labels .artifacts/manifest.jsonl \
  --trace-dir .artifacts/traces \
  --artifact-dir .artifacts/results \
  --out .artifacts/analyst-run \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --split verified \
  --base-url http://127.0.0.1:3355/v1 \
  --api-key-env CLI_BRIDGE_BEARER \
  --model claude-code/sonnet \
  --python .venv/bin/python \
  --limit 20 \
  --seed 7 \
  --concurrency 1 \
  --max-cost-usd 5
```

`--rlm-samples <k>` (CodeTraceBench, `dspy-rlm` only) runs the recursive engine `k` times per case and scores the step-level majority: a step survives when at least `ceil(k/2)` samples flag it, surviving steps reassemble into blocks, and the abstention fallback fires once, only when no step reaches the threshold.
Per-sample blocks, the full voting record, and per-sample cost land in the observation's runner metadata; `k` is recorded in the run identity and `result.json`.

`--instructions-file <path>` (`dspy-rlm` only) replaces the shipped recursive analyst instructions with the file's text — the certification path for optimizer-produced candidates.
The recorded protocol digest then binds the stock protocol digest to the override text's SHA-256, `result.json` records `instructionsOverrideSha256` under `inputs.execution`, and an unreadable or empty file fails the run before any model call.
With the flag absent the recorded digest is byte-identical to a stock run, so override runs and stock runs are never confusable.
The abstention fallback keeps the stock direct prompt either way.

The command writes every observation before producing `result.json` and `report.md`.
It can resume without repeating completed cases.
Dataset revisions, selected case IDs, input hashes, trace hashes, result artifacts, usage, errors, and comparison settings remain in the output.

Use fresh development cases while changing questions or instructions.
Report final quality only on an untouched holdout.
