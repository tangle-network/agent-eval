# Composing agent-eval with your observability stack

`@tangle-network/agent-eval` records runs and spans in a `TraceStore` and
writes them as OTLP/JSON: `exportRunAsOtlp(store, runId)` for one run and
`convertTraceStoresToOtlp` for a directory of stores, both from
`@tangle-network/agent-eval/traces`. **It's just OTel**: same protocol as
Langfuse SDK, OpenLLMetry, Arize Phoenix, TraceAI, and the OpenTelemetry
GenAI semantic conventions.

To stream spans to a collector while a run executes, use
`createOtelExporter` from `@tangle-network/agent-runtime`. It bounds its
queue, checks every response, and counts written and dropped spans, so a
missing trace is never mistaken for an empty run.

That means: if you already instrument your agent with any OTel-native
observability tool, the two compose **for free at the protocol layer**.
This doc shows the composition pattern; no agent-eval-specific adapter
code required.

## TL;DR: one collector, two independent emitters

1. Set up an OTel collector endpoint (or service mesh) that every side exports to.
2. Configure your observability tool (TraceAI / Langfuse / OpenLLMetry /
   Phoenix) to register its instrumentations against a tracer provider that
   points at that endpoint.
3. Post agent-eval's OTLP export (`exportRunAsOtlp`) to the same endpoint's
   `/v1/traces`, or stream with agent-runtime's `createOtelExporter`, which
   reads `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`.
   Neither needs an `@opentelemetry/*` SDK dependency.
4. Run a campaign. Both sets of spans land at your OTel collector.
5. Filter / route / fan-out at the collector layer: Jaeger, Tempo,
   Phoenix, Langfuse cloud, your private collector, whatever.

The Tangle substrate doesn't compete with the observability tool;
they're orthogonal. The tool tells you *what your agent did*; the
substrate tells you *what the campaign / judge / mutator decided about
it*. Unified at the trace level, you see both as one timeline per cell.

## Per-tool notes

### TraceAI (Future-AGI)

- TS SDK auto-instruments OpenAI/Anthropic SDKs + LangChain.
- Compatible with the OpenTelemetry GenAI semantic conventions.
- Compose: register TraceAI's instrumentations on the global tracer
  provider, then either point both at your OTLP collector or at
  TraceAI's hosted backend if you want their UI.
- **No OTel-span-to-hosted-ingest bridge ships.** To land finished OTel
  spans in the hosted tier, write your own mapping from the span shape to
  `TraceEvent` rows and post them through `createHostedClient` from
  `@tangle-network/agent-eval/hosted` or the `/v1/traces/ingest` wire
  route ([wire-protocol.md](./wire-protocol.md#tracesingest-batch-ingest-production-trace-events)).
  For run records that already exist, `fromOtelSpans` from `/contract`
  converts collector output into `RunRecord[]` for `analyzeRuns()`.

### Langfuse SDK

- Larger installed base; has its own hosted product + OSS self-host.
- Their OpenTelemetry-compatible mode ships LLM call spans with
  Langfuse-specific attributes preserved.
- Compose: register Langfuse as an OTel processor; agent-eval's
  campaign/judge/mutator spans appear alongside the LLM calls in their
  UI.

### OpenLLMetry (Traceloop)

- OSS auto-instrumentation library; OTel-native by design.
- Wide framework coverage (LangChain, LlamaIndex, Haystack, OpenAI,
  Anthropic).
- Compose: set up Traceloop's exporter and post agent-eval's OTLP export
  to the same collector.

### Arize Phoenix

- OSS observability backend; strong in the eval-tooling community.
- OTel-native ingest; renders trace + span attributes per the GenAI
  semantic conventions.
- Compose: point both exporters at your local Phoenix instance. Phoenix
  becomes the unified UI for both LLM-call traces and campaign spans.

## Wiring pattern (reference)

```ts
import { trace } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

// 1. One shared tracer provider for the process.
const provider = new NodeTracerProvider()
provider.addSpanProcessor(new SimpleSpanProcessor(
  new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
))
provider.register()

// 2. Your observability tool registers against the global provider.
//    Example for TraceAI / OpenLLMetry / Langfuse: call their init.
//    (See each tool's docs.)

// 3. Run your campaign, then post each run's OTLP/JSON to the same collector.
//    exportRunAsOtlp is not built on the OTel SDK provider above and needs no
//    `@opentelemetry/*` dependency. Check the response: a collector that
//    refuses the batch is a lost trace, not an empty one.
import { exportRunAsOtlp } from '@tangle-network/agent-eval/traces'
const body = await exportRunAsOtlp(store, runId)
const res = await fetch('http://localhost:4318/v1/traces', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
if (!res.ok) throw new Error(`collector refused the trace: HTTP ${res.status}`)
```

That's it. No new adapter shipping required: the libs are already
designed to live in the same OTel ecosystem.

## When you'd want a deeper, code-level adapter

The two cases where a thin adapter would add value beyond the
OTel-protocol composition:

1. **Cost-aware judging.** Your observability tool's auto-instrumented
   spans carry token counts + cost. A custom `JudgeConfig` can read
   them via the OTel context and refuse to score artifacts that
   exceeded a per-call budget. Easy to write yourself; no reference
   helper ships today.
2. **Tool-aware judging.** Your instrumentation captures the tool-call
   sequence (`langchain.tool.invoked`, `openai.function.called`, etc.).
   A judge that scores "did the agent use the right tool" reads those
   spans directly. Also straightforward; helper ships when needed.

Both of these are L1-tier ergonomic helpers; the underlying composition
works today without them.

## What this does NOT install

No new dependencies. No new peer deps. No `@traceai/*`, no
`@langfuse/*`, no `@opentelemetry/*` in our manifest. You bring the
observability stack you want; agent-eval's OTLP export is the same wire
format, posted to the endpoint you choose.


## Supervisor-run resource receipts

The `/supervisor-run` reader preserves named-resource measurements in `economics.resourceRecords`.
Each record identifies its node and source within the normalized journal or terminal result.
Journal row indices refer to parsed rows after reader normalization, not original file line numbers.
The Markdown report renders each resource name, unit, amount, and completeness flag.
Comparison cells retain those same records without combining them.

A false `known` flag means the amount is a recorded subtotal, not complete usage.
Missing maps, explicit empty maps, and invalid fields remain distinct from measured zero.
Parent settlements and terminal results can include child usage, so these records are not additive totals.
The reporter reads evidence; it does not enforce budgets or infer missing measurements.

## Supervisor-run transcript coverage

The Runtime reader names each transcript that Runtime retained, and the integrity report counts what is missing.
The root transcript is `root-stream.jsonl`, which Runtime appends as each root provider event arrives.
A worker's turn record is the output blob of each `execution-result` event, which holds that turn's provider events.
A worker's native harness session is the blob that the `harnessTranscript` receipt on its terminal event names.

Each worker source carries three facts:

- `transcriptRef`: the native session blob when it exists, otherwise the newest retained turn output, otherwise null.
- `turns`: the dispatched turns and the turns with a retained output blob.
- `nativeSession`: the retained blob, or Runtime's reason that there is none, verbatim.

The reader checks every named blob on disk; a receipt whose blob is gone reads as `receipt-blob-missing`.

The integrity report uses three issue codes:

- `transcript-unavailable` counts rows with no inlined messages and no transcript reference.
  Its metadata also counts the rows that are retained by reference only.
- `transcript-incomplete` counts closed workers that dispatched more turns than they retained.
- `native-session-unavailable` counts closed workers without a native session, grouped by reason.
  Only the native session records what the harness's own subagents did.

A live worker is not counted as incomplete, because its current turn is still being written.
Rows carry only the artifacts a reader declares; the reader never derives a path from the run directory.
