# Composing agent-eval with your observability stack

`@tangle-network/agent-eval` ships its own OpenTelemetry pipeline
(`createOtelExporter`, from `@tangle-network/agent-eval/traces`) that
emits spans for every cell, judge invocation, mutator proposal, and
gate decision. **It's just OTel**: same protocol as Langfuse SDK,
OpenLLMetry, Arize Phoenix, TraceAI, and the OpenTelemetry GenAI
semantic conventions.

That means: if you already instrument your agent with any OTel-native
observability tool, the two compose **for free at the protocol layer**.
This doc shows the composition pattern; no agent-eval-specific adapter
code required.

## TL;DR: one collector, two independent emitters

1. Set up an OTel collector endpoint (or service mesh) that every side exports to.
2. Configure your observability tool (TraceAI / Langfuse / OpenLLMetry /
   Phoenix) to register its instrumentations against a tracer provider that
   points at that endpoint.
3. Configure agent-eval's exporter (`createOtelExporter`, from
   `@tangle-network/agent-eval/traces`) against the same endpoint. It has no
   `@opentelemetry/*` SDK dependency of its own — it reads
   `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` directly, so
   pointing both sides at the same collector is usually just sharing env vars.
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
- Compose: set up Traceloop's exporter; agent-eval's exporter shares
  the same trace context per cell.

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

// 3. agent-eval's exporter is not built on the OTel SDK provider above —
//    it's a minimal OTLP/JSON poster with no `@opentelemetry/*` dependency
//    of its own. It reads the same OTEL_EXPORTER_OTLP_ENDPOINT env var, so
//    pointing it at the same collector is usually the only step needed:
import { createOtelExporter } from '@tangle-network/agent-eval/traces'
const exporter = createOtelExporter()  // undefined if no endpoint is configured
// Feed it spans as your campaign's TraceEmitter closes them; call
// `exporter?.shutdown()` when the campaign ends to flush pending spans.

// 4. Run your campaign: both sets of spans land at the collector.
import { runEval } from '@tangle-network/agent-eval/contract'
await runEval({ /* ... */ })
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
observability stack you want; agent-eval's exporter emits the same
OTLP wire format independently, keyed on the endpoint you point it at.
