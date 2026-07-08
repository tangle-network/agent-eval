# Example benchmark wrappers

Reference implementations of `BenchmarkAdapter` for two public benchmarks. They are NOT bundled — they're intentionally shipped as source you read, copy, and adapt.

| Wrapper | What it does | Why it's an example, not core |
|---|---|---|
| [`gsm8k/`](./gsm8k) | Exact-match grading on the final numeric answer of GSM8K (Cobbe et al.) | The dataset isn't ours and isn't bundled. The wrapper points to a local JSONL via `AGENT_EVAL_GSM8K_PATH`. |
| [`swebench-lite/`](./swebench-lite) | Pass/fail grading via an external SWE-Bench grader command | The grader is a separate binary; the wrapper stubs the integration via `AGENT_EVAL_SWEBENCH_GRADER_CMD`. |

The novel benchmark we ship and own — the synthetic routing task — lives in `src/benchmarks/routing/` and IS in the bundle.

## Using these wrappers

Read and inline them. Copy the wrapper file into your project, then replace
imports such as `../../../src/benchmarks/types` and `../../../src/run-record`
with `@tangle-network/agent-eval`. These examples are repository source, not
published npm subpaths.

## What every BenchmarkAdapter exports

```ts
loadDataset(split: 'search' | 'dev' | 'holdout'): Promise<DatasetItem[]>
evaluate(item, response): Promise<{ score: number, raw: Record<string, unknown> }>
assignSplit(itemId: string): 'search' | 'dev' | 'holdout'
```

`assignSplit` uses `deterministicSplit(itemId, BENCHMARK_SPLIT_SEED)` — same item gets the same split everywhere. Don't change the seed; it's load-bearing for reproducibility.

## Running a benchmark

Use `runBenchmarkAdapter` when you want a campaign-backed run with resumability, traces, cost, latency, split reporting, and persisted report artifacts.

```ts
import { runBenchmarkAdapter, routing } from '@tangle-network/agent-eval/benchmarks'

const result = await runBenchmarkAdapter({
  adapter: new routing.RoutingAdapter(),
  runDir: 'routing-smoke',
  respond: async ({ item, context }) => {
    const route = await callRouter(item.payload.prompt)
    context.cost.observe(0.001, 'router')
    return route
  },
})

console.log(result.report.score.mean)
console.log(result.reportMarkdownPath)
```

Before treating a benchmark metric as real evidence, run `calibrateBenchmarkMetric` with an intentionally weak and intentionally strong artifact.
The default pass condition is weak score at most `0.3`, strong score at least `0.7`, and gap at least `0.4`.

## Standard retrieval formats

`@tangle-network/agent-eval/benchmarks` also exports dependency-free helpers for BEIR/MTEB/MS MARCO/TREC/MIRACL-style files:

- `parseBeirCorpusJsonl`
- `parseBeirQueriesJsonl`
- `parseQrels`
- `buildStandardRetrievalItems`
- `createRetrievalIdBenchmarkAdapter`
- `evaluateStandardRetrieval`

These helpers normalize public retrieval datasets into the same `BenchmarkDatasetItem` shape.
The retrieval evaluator accepts ranked document IDs and reports nDCG@k, recall@k, precision@k, MRR@k, and hit@k.
It does not copy the full corpus into every query payload unless `includeCorpusInPayload` is explicitly set.
Domain packages such as `agent-knowledge` can then map those items into their own RAG scenario types instead of re-parsing every public benchmark.

## Adding a new benchmark

1. Create `examples/benchmarks/<your-benchmark>/index.ts`.
2. Export `loadDataset`, `evaluate`, `assignSplit`. Optionally a typed `Adapter` class.
3. Use `deterministicSplit` from `@tangle-network/agent-eval` for split assignment.
4. Fail loud on missing config (env vars, paths). Never default to silent-pass.
5. Document config requirements in a per-benchmark README.

If your benchmark is novel and broadly useful, propose moving it into `src/benchmarks/` as core surface (PR welcome). The bar is: novel rubric, reusable across projects, low maintenance burden.
