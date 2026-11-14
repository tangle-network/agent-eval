# Example benchmark wrappers

Reference implementations of `BenchmarkAdapter` for two public benchmarks. They are NOT bundled: they're intentionally shipped as source you read, copy, and adapt.

| Wrapper | What it does | Why it's an example, not core |
|---|---|---|
| [`gsm8k/`](./gsm8k) | Exact-match grading on the final numeric answer of GSM8K (Cobbe et al.) | The dataset isn't ours and isn't bundled. The wrapper points to a local JSONL via `AGENT_EVAL_GSM8K_PATH`. |
| [`swebench-lite/`](./swebench-lite) | Pass/fail grading via an external SWE-Bench grader command | The grader is a separate binary; the wrapper stubs the integration via `AGENT_EVAL_SWEBENCH_GRADER_CMD`. |

The novel benchmark we ship and own: the synthetic routing task: lives in `src/benchmarks/routing/` and IS in the bundle.

## Using these wrappers

Read and inline them. Copy the wrapper file into your project, then replace
imports such as `../../../src/benchmarks/types` and `../../../src/run-record`
with `@tangle-network/agent-eval`. These examples are repository source, not
published npm subpaths.

## What every BenchmarkAdapter exports

```text
loadDataset(split: 'search' | 'dev' | 'holdout'): Promise<DatasetItem[]>
evaluate(item, response): Promise<{ score: number, raw: Record<string, unknown> }>
assignSplit(itemId: string): 'search' | 'dev' | 'holdout'
```

`assignSplit` uses `deterministicSplit(itemId, BENCHMARK_SPLIT_SEED)`: same item gets the same split everywhere. Don't change the seed; it's load-bearing for reproducibility.

## Running a benchmark

Use `runBenchmarkAdapter` when you want a campaign-backed run with resumability, traces, cost, latency, split reporting, and persisted report artifacts.

```ts
import { maximumChargeForLlmRequest } from '@tangle-network/agent-eval'
import { runBenchmarkAdapter, routing } from '@tangle-network/agent-eval/benchmarks'

const result = await runBenchmarkAdapter({
  adapter: new routing.RoutingAdapter(),
  runDir: 'routing-smoke',
  respond: async ({ item, context }) => {
    const request = buildRouterRequest(item.payload.prompt, { maxTokens: 256 })
    const paid = await context.cost.runPaidCall({
      actor: 'routing-worker',
      model: request.model,
      maximumCharge: maximumChargeForLlmRequest(request),
      execute: (signal) => callRouter(request, signal),
      receipt: (route) => route.receipt,
    })
    if (!paid.succeeded) throw paid.error
    return paid.value
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

## Harbor datasets

`createHarborBenchmarkAdapter` imports a checkout of a [Harbor](https://harborframework.com) dataset, such as Terminal-Bench, as a `BenchmarkAdapter`.
It recursively reads `tasks/**/task.toml` and `instruction.md` into items, including the nested Terminal-Bench-Science layout. IDs are stable paths relative to `tasks/`; same-named leaves in different domains stay distinct. Discovery stops at each task and does not follow directory symlinks.
The item holds the instruction verbatim, timeouts, resources, the complete native configuration, metadata, and artifact declarations including destination, service and exclusions. `artifacts` keeps its existing source-path list for compatibility. The execution owner must preserve verifier isolation and network policy from the native configuration.
Pin the checkout: `source.revision` is the commit, and `source.rules` and `source.contamination` state the upstream rules and what is known about training-data exposure.

The dataset's own verifier is the scorer.
The caller's `grade(item, artifact)` runs it and returns the reward as a typed outcome.
A grader that fails raises an error. It never produces a score of zero.
`loadAll()` returns every task regardless of split, because a public benchmark reports all of its tasks.

`gradeHarborPatch` remains the code-patch replay helper. For an existing genuine Harbor trial, create an output directory outside the source trial, then use `gradeHarborTrial({ trialsDir, rewardKey })` with `{ trialDir }`. It calls upstream `harbor trial regrade`, which restores recorded artifacts and runs a separate verifier. The source trial remains unchanged and the new trial/result/logs stay in `trialsDir`. The helper requires a native `reward_valid: true`, an explicit reward key in [0, 1], and a result bound to the original trial; missing rewards and unsupported/shared verification fail. Optional `sourceTrialId`, `sourceTaskChecksum`, and `sourceResultDigest` in the artifact check expected original identities before invocation. Original result/config/manifest identities and the current verifier's source/config remain distinct in the retained, redacted attempt receipt. A changed verifier is permitted: this is regrading produced work, not a new agent solve. It does not construct a trial from arbitrary files or silently run a new agent.

The regrade command and semantics are pinned to [Harbor ec6aeab7](https://github.com/harbor-framework/harbor/tree/ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4): [CLI flags](https://github.com/harbor-framework/harbor/blob/ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4/src/harbor/cli/trials.py), [artifact-manifest/coverage checks](https://github.com/harbor-framework/harbor/blob/ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4/src/harbor/trial/regrade.py), and [reward validity including exception policies](https://github.com/harbor-framework/harbor/blob/ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4/src/harbor/models/trial/result.py). The pinned CLI help was executed during development. Docker-backed regrading was not qualified in this workspace; a compatible installed Harbor CLI, complete native trial, and verifier environment remain execution prerequisites.

## Native research benchmarks

`defineBenchmark` validates a JSON measurement definition: pinned source, exact task roster, native metric units/direction/aggregation, an explicit score-normalization policy, and the intended checker identity/strategy/assumptions. `benchmarkDefinitionDigest` uses the stack's canonical JSON owner. This is a planned measurement contract; it does not certify execution.

`createNativeBenchmarkAdapter` binds that definition to a loader and the existing `StrategyChecker`. It returns the ordinary `BenchmarkAdapter` plus `loadAll()` and `evaluateResult()`. The loader is snapshotted once, native splits are retained, and missing splits require an explicit caller policy. A public showcase is not automatically a held-out dataset. The checker must return a finite score in [0, 1], an explicit `passed`, and raw native evidence. It may keep unbounded native metrics in `dimensions` and `raw`; the package does not invent a normalization or official leaderboard aggregate.

Set `implementationRef` to the exact adapter/normalization implementation. For file or directory artifacts supply `artifactDigest` that hashes their actual bytes; its default hashes the JSON value, which is not file-content identity. Evaluation refuses a changed admitted task, contradictory certification, or an artifact that changes during checking. `evaluateResult` returns the shared `BenchmarkResult` with definition, task and artifact identities. `benchmarkResultEvidenceDigest` binds those identities and the complete measurement. `defineBenchmarkResult` validates serialized receipts; digests detect drift but do not authenticate an untrusted producer or enforce hidden-data isolation.

`runBenchmarkAdapter` retains raw evidence and certifications in existing campaign cells. Defined resumable benchmarks require a `dispatchRef` that pins the responder/model/prompt; changing it or the grader identity invalidates cached scores. Reports identify measured and unmeasured cells separately. Their score mean summarizes normalized Eval scores, and `nativeAggregation: 'not-computed'` prevents interpreting it as an official native statistic. Inspect the native evidence and implement any upstream rank, geometric or rubric aggregation explicitly.

See [research benchmark recipes](./research/README.md) for verified upstream formats, public versus gated assets, and execution prerequisites. Native verification, container isolation, judge transport, reference staging and spend remain caller responsibilities.

## Adding a new benchmark

1. Create `examples/benchmarks/<your-benchmark>/index.ts`.
2. Export `loadDataset`, `evaluate`, `assignSplit`. Optionally a typed `Adapter` class.
3. Preserve native split assignments; use an explicit `deterministicSplit` policy only for a newly declared study split.
4. Fail loud on missing config (env vars, paths). Never default to silent-pass.
5. Document config requirements in a per-benchmark README.

If your benchmark is novel and broadly useful, propose moving it into `src/benchmarks/` as core surface (PR welcome). The bar is: novel rubric, reusable across projects, low maintenance burden.
