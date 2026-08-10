# Prime Analyst Runner

The `prime` analyst runs an RLM coding agent as a trace analyst through an OpenAI-compatible cli-bridge.
It is the third scored arm of `agent-eval analyst-benchmark`, beside the recursive `dspy-rlm` engine and the one-shot `direct` baseline, and it exists so the prime-vs-dspy comparison is reproducible from this repository alone.
It speaks the CodeTraceBench failure-block contract only; `--analyst prime` with `--dataset agentrx` is rejected.

Implementation: `src/analyst/benchmark-runner-prime.ts` (`createPrimeBenchmarkRunner`) binds the CodeTraceBench block grammar to the shared protocol in `src/analyst/prime-protocol.ts` and `src/analyst/prime-bridge-transport.ts`.
The arm is declared as `primeCodeTraceAnalystDefinition()` and the creator is a thin shell over it; see the Analyst Definitions section in [trace-analysis.md](./trace-analysis.md).
Wiring: `--analyst prime` in `src/analyst/benchmark-command.ts`.

## What the runner does

The benchmark command prepares every case identically for every runner: it loads the label-free trajectory, appends the row's final-verification artifacts as benchmark-verification spans, and hands each runner the same trace store.
The prime runner adds nothing to that input.

Per case it:

1. Projects the full span set with `viewTrace` and serializes it as inline JSON in the prompt.
   Prime has no REPL and no trace tools, so the same projection the dspy typed path binds as a REPL variable is delivered as text.
2. Sends one user message to `<bridge>/v1/chat/completions`: the CodeTraceBench task definition (`CODE_TRACE_BENCH_ANALYST_PROMPT`), a strict block-JSON output contract, the trajectory JSON, and the final-verification spans.
3. Parses the reply's fenced JSON object (`{ "answer", "blocks": [...] }`), validates each block row, and expands accepted blocks into one scored finding per member step with the published `expandCodeTraceFailureBlocks` — the exact conversion every benchmark runner uses.

Findings carry `analyst_id: 'prime'` and score through the same evidence resolution, comparison, and calibration paths as every other arm.

## Reproduce: prime vs dspy-rlm on the same rows

Case selection is deterministic in `--labels`, `--limit`, and `--seed`, so two runs that share those flags (and the same `--trace-dir`, `--artifact-dir`, `--revision`, `--split`) score exactly the same rows.
Run the two arms into two output directories and compare:

```sh
# Arm 1: prime through the cli-bridge (no model-owner module; the bridge owns execution)
agent-eval analyst-benchmark \
  --dataset codetracebench \
  --analyst prime \
  --bridge-url http://localhost:4181 \
  --labels .artifacts/manifest.jsonl \
  --trace-dir .artifacts/traces \
  --artifact-dir .artifacts/results \
  --out .artifacts/prime-run \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --split verified \
  --model prime/zai/glm-5.2 \
  --timeout-ms 1200000 \
  --limit 20 \
  --seed 7 \
  --concurrency 1

# Arm 2: the recursive DSPy engine on the SAME rows (same labels/limit/seed)
agent-eval analyst-benchmark \
  --dataset codetracebench \
  --analyst dspy-rlm \
  --labels .artifacts/manifest.jsonl \
  --trace-dir .artifacts/traces \
  --artifact-dir .artifacts/results \
  --out .artifacts/dspy-run \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --split verified \
  --model-owner-module ./dist/runtime-model-owner.mjs \
  --model opencode/zai-coding-plan/glm-5.2 \
  --python .venv/bin/python \
  --timeout-ms 1200000 \
  --limit 20 \
  --seed 7 \
  --concurrency 1

node benchmarks/trace-analysis/tools/compare-analyst-runs.mjs \
  .artifacts/prime-run/result.json .artifacts/dspy-run/result.json
```

`--model` keeps its normal semantics; for prime it is the bridge model id in `<backend>/<provider>/<model>` form (`prime/zai/glm-5.2`), which the bridge maps to its configured backend model.
Prime analyses routinely exceed the 300-second default deadline, so set `--timeout-ms` explicitly (the proven external rig used 1200000).
`--no-repair` disables the bounded repair turn described below.

## Bridge prerequisites

The runner needs a running cli-bridge whose `prime` backend is enabled:

- `BRIDGE_BACKENDS=prime` — enable the prime backend in the bridge.
- `PRIME_BIN` — absolute path to the prime binary (on nix installs, the nix store path of the `prime` executable).
- `PRIME_MODELS_JSON` — the bridge's model table mapping bridge model ids such as `prime/zai/glm-5.2` to the backend provider and model the prime agent runs.

The bridge listens on `http://localhost:4181` by default; pass `--bridge-url` when it listens elsewhere.
Provider credentials live in the bridge process, never in this command: for `--analyst prime` there is no `--model-owner-module`, and passing one is an error.

## Protocol notes

- **Short-strings contract, no rationale.**
  The output contract caps every string the model must emit and forbids a `rationale` field.
  Why: stream-splice corruption on long strings was measured on the live bridge path — the bridge splices its backend's streamed output into one reply, and long strings arrive corrupted often enough to void otherwise-correct work.
  Short claims survive the splice; block coordinates carry the signal.
- **One bounded repair turn.**
  A structurally malformed reply (no parseable JSON object, or no `blocks` array) gets exactly one stateless follow-up call carrying the malformed reply plus the output contract — never the trajectory — mirroring the dspy arm's typed-adapter repair so both arms face the same structured-output affordance.
  Still malformed after repair = failed observation with a typed error (`PrimeMalformedReplyError`), recorded exactly as a dspy-rlm failure is.
  Zero valid blocks from a well-formed reply is an honest null, not a failure.
- **Oversized traces fall back to chunked projection.**
  When the full `viewTrace` response is oversized, or the rendered JSON exceeds the 360k-char inline budget, the runner re-projects every span through chunked `viewSpans` at a 1200-byte per-attribute cap, in store order, and fails loud if any span drops or the result is still oversized.
- **Usage receipts.**
  Token counts are the bridge's exact reported counts; USD is a rate-based estimate from the model's catalog rates (for `prime/zai/glm-5.2`, the z.ai coding-plan list rates: 0.6/2.2 USD per million input/output tokens).
  A reply without usage stays uncaptured — never a silent zero — and a repair turn's usage merges into the case's receipt, poisoning each side independently so a measured count survives a missing partner.
  A reply that reports only one side lands in `AnalystUsageReceipt.partialTokens` with `tokens: null`, `cost` uncaptured, and the reported side priced into `knownCostUsd` as a lower bound: `RunTokenUsage` has no nullable side, so carrying a one-sided count in `tokens` would mean writing a zero nobody measured.
  When the bridge reports `estimated: true` — it derived the counts from character lengths because the backend CLI reported none — the receipt carries `tokensEstimated: true`, which is what separates a rate estimate over exact tokens from one over derived tokens.
- **Per-observation protocol digest.**
  Every prime observation records `primeAnalystProtocolSha256()` in its runner metadata, hashing the question, task prompt, output contract, repair contract, and projection limits that actually ran.

## Reusing the protocol outside this benchmark

`src/analyst/prime-protocol.ts` is the consumer-agnostic core, exported from `@tangle-network/agent-eval/analyst`.
It speaks raw rows and names no finding type, so an analyzer with a different row grammar — span-grounded findings against its own artifact, say — binds it without importing CodeTraceBench types:

- `PrimeReplyContract<TRow>` supplies the rows field name, the contract lines spliced into both prompts, a single-pass `decodeRow`, and an optional `maxRows` cap applied to ACCEPTED rows so malformed rows never consume a slot.
- `buildPrimePrompt` / `buildPrimeRepairPrompt` compose the prompts; the repair prompt never carries the trajectory.
- `runPrimeExchange` runs the call, the bounded repair turn, and row decoding, returning one typed outcome whose `PrimeFailure.kind` separates `transport`, `http-status`, `unparseable-json`, `no-content`, `deadline`, `malformed-reply`, and `aborted`.
  A cancelled run is never recorded as an analyzer verdict.
- `projectPrimeTrajectory` runs the render → measure → fall back → re-measure → fail-loud ladder over a caller-supplied `PrimeProjectionSource`, so the source of the projection stays the consumer's choice.
- `normalizePrimeUsage` / `mergePrimeRawUsage` keep the bridge's report lossless; `analystUsageReceiptFromPrimeUsage` is the agent-eval-only binding to the typed receipt, so a consumer with no pricing table simply does not call it.
- `primeProtocolSha256` hashes the ACTUALLY composed contract, so two consumers that both stamp `analyst_id: 'prime'` while asking different questions get different digests by construction.

## Status

The first prime-vs-dspy comparison batch (20+ live CodeTraceBench cases through cli-bridge on `prime/zai/glm-5.2`) is in flight on the proven external rig this runner was ported from.
Numbers land in `benchmarks/trace-analysis/` when the batch completes; until then this document makes no accuracy claim for the prime arm.
