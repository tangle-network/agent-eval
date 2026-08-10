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
Agent Eval owns trace access, cancellation, cost accounting, and output validation.
The calling application owns model execution, credentials, retries, and provider policy.

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
  type DspyRlmTraceEngineOptions,
} from '@tangle-network/agent-eval/analyst'
import {
  analyzeTraces,
} from '@tangle-network/agent-eval/traces'

type ModelOwner = Pick<
  DspyRlmTraceEngineOptions,
  'call' | 'callRef' | 'recordExecution'
>

export async function answerOneQuestion(modelOwner: ModelOwner) {
  const engine = createDspyRlmTraceEngine({
    ...modelOwner,
    model: 'deepseek-v4-flash',
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
}
```

Omit `pricing` only when Agent Eval already recognizes the exact model or model family.
Unknown pricing fails before the first model call.

Agent Eval never receives the provider key.
The caller-supplied model owner runs the exact Runtime path and returns one typed outcome, measured usage receipt, and finite execution record per admitted request.
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

## Analyst Definitions

`AnalystDefinition` (`src/analyst/definition.ts`, exported from `@tangle-network/agent-eval/analyst`) is the declarative unit behind an analyst arm.
One definition value declares everything the arm can say to a model: the question, the task text, the `ReplyContract` row grammar, the `EvidenceProjection` (`inline` | `chunked` | `repl-variable` | `agent-tools`), a profile fragment (pinned model and reasoning-effort hints), the budget, and the repair-turn count.
`bindAnalyst(definition, transports)` compiles a definition plus a transport binding (`prime-bridge` or `model-owner`) into a runnable `AnalystBenchmarkRunner`.

The three benchmark arms are expressed this way:

| Arm | Definition builder | Projection | Repair turns |
|---|---|---|---|
| `direct` | `publicDirectAnalystDefinition(dataset, args)` | `chunked` (descending per-attribute byte caps) | 0 |
| `dspy-rlm` | `publicRlmAnalystDefinition(dataset, args)` | `repl-variable` (store bound as an engine REPL variable) | 1 (engine-internal typed repair) |
| `prime` | `primeCodeTraceAnalystDefinition(args)` | `inline` (serialized JSON with a capped refetch) | 0 or 1 |

`createPublicBenchmarkDirectRunner`, `createPublicBenchmarkRlmRunner`, and `createPrimeBenchmarkRunner` are thin shells over those builders, so no consumer changes.
The parity suite (`src/analyst/definition-parity.test.ts`) runs each compiled definition and its entry point over the same fixture rows with a fake transport and asserts byte-identical request bodies plus equal protocol digests.
A mismatch fails CI: expression loss between the declarative layer and the executing arm is caught by construction.
Do not loosen those assertions; report the construct that cannot be expressed and extend the definition slots instead.

`analystDefinitionProtocolSha256(definition)` digests the definition's protocol content; for an inline definition it equals the digest the prime arm records (`primeAnalystProtocolSha256()`).
`analystDefinitionAsymmetries(definitions)` compares arms on equal terms: it refuses a set whose definitions declare unequal repair turns (a retry is a second sample) and renders the declared differences — projection mode, reasoning effort, budget — beside each arm.
A definition a strategy cannot compile fails loud with `AnalystExpressivenessError` naming the construct.

`AnalystContext.probe` (`ExecutionProbe`) is the optional live-execution port: a runtime that owns a sandbox or checkout fills it so an analyst can run a bounded command against the run's produced state and read a typed outcome.
This package defines only the port; an absent probe means the analyst works from recorded evidence.

## Measure Analyst Quality

Measure the analyst on labeled traces before using its findings for automated changes.
At minimum, report issue recall, finding precision, exact evidence accuracy, trusted-negative false positives, repeat agreement, failures, calls, tokens, cost, and latency.

The certified reference for the shipping CodeTraceBench configuration lives in `benchmarks/trace-analysis/codetracebench-glm52-certified-20260801/` (pre-registered two-sealed-split protocol, all arms and paired CIs disclosed); cite numbers from there, never from spent dev splits.
Cross-run and pooled comparisons use `benchmarks/trace-analysis/tools/compare-analyst-runs.mjs`.

`runAnalystBenchmark()` compares any `AnalystBenchmarkRunner` implementations.
`agent-eval analyst-benchmark` runs the public AgentRx or CodeTraceBench adapters with:

1. an empty-finding baseline,
2. the scored analyst `--analyst` selects: the recursive DSPy RLM engine (`dspy-rlm`, default), the one-shot `direct` baseline, or the `prime` RLM coding agent behind an OpenAI-compatible cli-bridge (CodeTraceBench only; see [prime-analyst.md](./prime-analyst.md) for bridge prerequisites and the prime-vs-dspy reproduce commands).

```sh
agent-eval analyst-benchmark \
  --dataset codetracebench \
  --labels .artifacts/manifest.jsonl \
  --trace-dir .artifacts/traces \
  --artifact-dir .artifacts/results \
  --out .artifacts/analyst-run \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --split verified \
  --model-owner-module ./dist/runtime-model-owner.mjs \
  --model deepseek-v4-flash \
  --python .venv/bin/python \
  --limit 20 \
  --seed 7 \
  --concurrency 1 \
  --max-cost-usd 5
```

The model-owner module exports `createModelExecutionOwner({ model, environment })` and returns `call`, `callRef`, `recordExecution`, plus exact pricing when the model is not in Agent Eval's catalog.
Runtime-backed products use that module to materialize one exact agent profile; the benchmark command never receives provider credentials or adds provider retries.

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
