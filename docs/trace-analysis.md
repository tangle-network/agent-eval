# Trace Analysis

Trace analysis is the bridge between raw product telemetry and useful eval work.

```txt
live product run
  -> TraceEmitter / TraceStore
  -> TraceAnalyst investigates trace corpora
  -> findings become ASI, failures, replay cases, and release actions
```

## When To Use TraceAnalyst

Use `TraceAnalyst` when you have more than a few traces and need to answer:

- which failure modes are recurring?
- which spans explain a regression?
- did retrieval, integrations, sandbox, or policy block the run?
- are failed runs missing evidence that the optimizer needs?
- which product surfaces deserve the next fix?

Use summary tables and release confidence for promotion decisions. Use
TraceAnalyst to explain the evidence behind those decisions.

## Minimal Flow

```ts
import {
  OtlpFileTraceStore,
  analyzeTraces,
} from '@tangle-network/agent-eval'

const abortController = new AbortController()
const result = await analyzeTraces({
  question: 'Why did app-runtime holdout runs fail this week?',
}, {
  source: new OtlpFileTraceStore({ path: 'traces/otlp.jsonl' }),
  ai,
  model: 'gpt-4o-2024-11-20',
  maxSubqueries: 4,
  maxParallelSubqueries: 2,
  signal: abortController.signal,
})

console.log(result.findings)
```

Products can implement `TraceAnalysisStore`; they do not need to use the file store in production.
Custom stores provide `hasTrace` and batched `hasSpans` alongside the seven reads, and accept a `TraceAnalysisStoreContext` so cancellation reaches storage and scans.
The binding validates every custom-store result.
Missing fields, undeclared fields, inconsistent counts, and false continuation flags throw `TraceAnalysisStoreContractError` with code `backend_integrity`.
The analyst runs one Ax executor loop and accepts only an explicit structured `final(task, { report, findings })` result; max-turn fallback text fails loud.

### Bind the same reads into another agent environment

`buildTraceAnalysisToolDescriptors()` is the canonical definition of the analyst's seven bounded read operations and does not expose Ax types.
Each descriptor carries the stable `traces` namespace, function name, description, JSON input schema in `parameters`, and a handler already bound to the supplied `TraceAnalysisStore`.
`buildTraceAnalystTools()` adapts those descriptors into Ax functions; it does not define a second tool surface.
The bound handlers wrap custom stores with `createBoundedTraceAnalysisStore()`, so page limits, byte ceilings, not-found errors, and cancellation do not depend on the transport or adapter.

```ts
import {
  buildTraceAnalysisToolDescriptors,
  type TraceAnalysisStore,
} from '@tangle-network/agent-eval/traces'

declare const store: TraceAnalysisStore
declare function qualifyToolName(namespace: string, name: string): string

const tools = buildTraceAnalysisToolDescriptors({ store }).map(
  ({ namespace, name, description, parameters, handler }) => ({
    name: qualifyToolName(namespace, name),
    description,
    inputSchema: parameters,
    handler,
  }),
)
```

Map these fields into the host's existing tool transport.
The host owns namespace encoding; use its existing convention instead of inventing one here.
Do not copy the schemas or reimplement the handlers in an MCP, Runtime, or provider adapter.

`queryTraces.limit`, `viewSpans.span_ids`, and search `max_matches` caps are present in the JSON Schemas and enforced before store calls.
Invalid arguments throw `TraceAnalysisValidationError` with code `validation`; responses that cannot fit their byte ceiling throw `TraceAnalysisLimitError` with code `limit_exceeded`.
Search patterns use RE2 syntax, which rejects backreferences and lookaround instead of allowing exponential-time expressions.
Search results return `hits` and an exact `has_more` flag; they do not invent a total after a capped scan.
`viewSpans` partitions every requested id across `spans`, `missing_span_ids`, and `omitted_span_ids`; `has_more` is true when omitted ids must be retried.
Attribute and match text shortening includes a deterministic marker.
Trace pages set `has_more`, and the overview returns every error cluster or fails explicitly when the configured response limit is too small.

### Analyze captured tool spans in memory

Use `toolSpansToTraceAnalysisStore()` when a live worker already returns canonical `ToolSpan[]` records.
The function snapshots the records immediately, groups them by `runId`, and exposes the same bounded reads and searches as the file-backed store.

```ts
import {
  analyzeTraces,
  toolSpansToTraceAnalysisStore,
  type ToolSpan,
  ToolTraceMissingError,
} from '@tangle-network/agent-eval/traces'

declare const capturedToolSpans: ToolSpan[] | undefined

if (!capturedToolSpans?.length) throw new ToolTraceMissingError()
const source = toolSpansToTraceAnalysisStore(capturedToolSpans)
const result = await analyzeTraces({ question: 'Why are tools failing?' }, { source, ai, model })
```

`undefined`, `null`, and an empty array throw `ToolTraceMissingError` with code `capture_integrity`.
An empty tool list cannot distinguish a real tool-free run from broken capture, so the adapter never reports it as a clean trace set.
Use a complete OTLP trace source when proving that a run executed successfully without tools.

## Deterministic failure coverage (no LLM)

Before (or alongside) the LLM analyst, `OtlpFileTraceStore.getOverview()` returns a
`DatasetOverview` whose `error_clusters` are computed deterministically: error
spans are grouped by a normalized failure signature (uuids / hex ids / numbers /
absolute paths / durations collapsed), each cluster carrying its prevalence,
exemplar `trace_id`/`span_id`, and a verbatim sample. This is a zero-LLM,
reproducible failure checklist the analyst then explains and closes:

```ts
const overview = await store.getOverview()
for (const c of overview.error_clusters) {
  console.log(`${c.trace_count}× ${c.signature}: e.g. trace ${c.exemplar_trace_ids[0]}`)
}
```

See `failureClusters` in [insight-report.md](./insight-report.md) and the
`ErrorCluster` type doc-comments for the field-level contract.

## Required Trace Shape

Every serious product run should include:

- `runId`, `projectId`, `scenarioId`, `variantId`, and `layer`
- commit, prompt hash, config hash, model fingerprint, and dataset version
- LLM spans with model, inputs, outputs, token counts, and cost
- tool/integration spans with arguments, result summaries, and error codes
- retrieval spans with query, source ids, hit scores, and freshness metadata
- sandbox/build/test/deploy spans with exit codes and log artifacts
- custom events for knowledge readiness and integration gates
- final run outcome with pass/score/failure class

Do not put secrets, raw OAuth tokens, or unredacted PII in traces.

## Product Loop

The product loop should not treat traces as a separate debug dump. The intended
path is:

1. Wrap the real workflow in `runAgentControlLoop` or the product runtime.
2. Emit canonical spans/events while the user task runs.
3. Convert the completed run to `FeedbackTrajectory` for replay.
4. Convert promotion-grade runs to `RunRecord` with `controlRunToRunRecord`.
5. Run TraceAnalyst over failure-heavy trace sets.
6. Feed findings into `ActionableSideInfo`, failure clusters, and release
   reports.

That makes normal product usage become eval data instead of isolated logs.
