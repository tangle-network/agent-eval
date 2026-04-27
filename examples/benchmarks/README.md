# Example benchmark wrappers

Reference implementations of `BenchmarkAdapter` for two public benchmarks. They are NOT bundled — they're intentionally shipped as source you read, copy, and adapt.

| Wrapper | What it does | Why it's an example, not core |
|---|---|---|
| [`gsm8k/`](./gsm8k) | Exact-match grading on the final numeric answer of GSM8K (Cobbe et al.) | The dataset isn't ours and isn't bundled. The wrapper points to a local JSONL via `AGENT_EVAL_GSM8K_PATH`. |
| [`swebench-lite/`](./swebench-lite) | Pass/fail grading via an external SWE-Bench grader command | The grader is a separate binary; the wrapper stubs the integration via `AGENT_EVAL_SWEBENCH_GRADER_CMD`. |

The novel benchmark we ship and own — the synthetic routing task — lives in `src/benchmarks/routing/` and IS in the bundle.

## Using these wrappers

Two paths.

**Option A — read and inline.** Copy the wrapper file into your project. Replace the import paths from `../../../src/benchmarks/types` and `../../../src/run-record` with `@tangle-network/agent-eval`. Done.

**Option B — import from agent-eval source.** If your project sits in this monorepo (or you've cloned the repo), import directly:

```ts
import * as gsm8k from '@tangle-network/agent-eval/examples/benchmarks/gsm8k'
```

This requires adding `examples/**/*.ts` to your TypeScript paths. Easier to just copy.

## What every BenchmarkAdapter exports

```ts
loadDataset(split: 'search' | 'dev' | 'holdout'): Promise<DatasetItem[]>
evaluate(item, response): Promise<{ score: number, raw: Record<string, unknown> }>
assignSplit(itemId: string): 'search' | 'dev' | 'holdout'
```

`assignSplit` uses `deterministicSplit(itemId, BENCHMARK_SPLIT_SEED)` — same item gets the same split everywhere. Don't change the seed; it's load-bearing for reproducibility.

## Adding a new benchmark

1. Create `examples/benchmarks/<your-benchmark>/index.ts`.
2. Export `loadDataset`, `evaluate`, `assignSplit`. Optionally a typed `Adapter` class.
3. Use `deterministicSplit` from `@tangle-network/agent-eval` for split assignment.
4. Fail loud on missing config (env vars, paths). Never default to silent-pass.
5. Document config requirements in a per-benchmark README.

If your benchmark is novel and broadly useful, propose moving it into `src/benchmarks/` as core surface (PR welcome). The bar is: novel rubric, reusable across projects, low maintenance burden.
