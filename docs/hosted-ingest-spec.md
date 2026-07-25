# Hosted-ingest wire spec: `2026-07-24.v1`

This is the only hosted-ingest wire format implemented by the current package.
Clients and servers reject every other wire version.

This is the contract between `@tangle-network/agent-eval` and any hosted
or self-hosted orchestrator. A builder can:

- Use our orchestrator at `https://orchestrator.tangle.tools/v1`.
- Self-host the reference receiver from
  `examples/hosted-ingest-server/`.
- Implement their own orchestrator against this spec.

All three are wire-compatible by definition.

---

## Transport

Two endpoints, both `POST`, both JSON. Headers on every request:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <tenant-key>` (the orchestrator issues this) |
| `Content-Type` | `application/json` |
| `X-Tangle-Tenant-Id` | The tenant's stable id (the orchestrator's primary key for the tenant) |
| `X-Tangle-Wire-Version` | `2026-07-24.v1` (this spec) |
| `Idempotency-Key` | Non-empty request key, at most 256 characters; clients generate one per call and reuse it across retries |

Responses are JSON of shape `{ accepted: number, rejected: Array<{ index, reason }> }`.
Clients validate the complete response before returning it.
The server can return 202 for asynchronous acceptance or 200 for synchronous acceptance.

### `POST /v1/ingest/eval-runs`

Body: `IngestEvalRunsRequest = { wireVersion, events: EvalRunEvent[] }`.

One ingest call per logical eval-run; generations stream in
incrementally via repeated calls with the same `runId`. The
orchestrator deduplicates by `(tenantId, runId, generation.index)`.

### `POST /v1/ingest/traces`

Body: `IngestTracesRequest = { wireVersion, spans: TraceSpanEvent[] }`.

Standard OTLP-shaped spans with a few additional attributes
(`tangle.runId`, `tangle.generation`, `tangle.cellId`,
`tangle.scenarioId`) so the orchestrator can pivot between the
eval-run stream and the underlying execution trace.

---

## `EvalRunEvent`

```ts
interface EvalRunEvent {
  runId: string                      // stable; same id across all generations of one run
  runDir: string                     // logical run directory (mem://... or filesystem path)
  timestamp: string                  // ISO-8601
  status:                            // lifecycle stage this event represents
    | 'started'
    | 'baseline-complete'
    | 'generation-complete'
    | 'gate-decided'
    | 'finished'
    | 'errored'
  labels: Record<string, string>     // free-form (env, branch, model id, etc.)
  baseline?: EvalRunGenerationSnapshot   // present when status >= baseline-complete
  generations: EvalRunGenerationSnapshot[]
  gateDecision?:                     // present when status >= gate-decided
    | 'ship' | 'hold' | 'need_more_work' | 'model_ceiling' | 'arch_ceiling'
  holdoutLift?: number               // winner-on-holdout - baseline-on-holdout
  totalCostUsd: number
  totalDurationMs: number
  errorMessage?: string              // present when status === 'errored'
  insightReport?: InsightReport      // current report contract
}
```

## `EvalRunGenerationSnapshot`

```ts
interface EvalRunGenerationSnapshot {
  index: number                      // 0 is baseline; 1..N are improvement generations
  surfaceHash: string                // stable hash of the candidate surface (pivot key)
  surface?: MutableSurface           // OMITTED to avoid PII when consumer prefers
  cells: EvalRunCellScore[]
  compositeMean: number | null       // null when no cell has a task-quality label
  costUsd: number
  durationMs: number
}
```

## `EvalRunCellScore`

```ts
interface EvalRunCellScore {
  scenarioId: string
  rep: number                        // 0 for the default; > 0 when reps > 1
  compositeMean: number | null       // null when the cell is unscored
  dimensions: Record<                // successful scores; failed or missing judges are absent
    string,
    Record<string, number>
  >
  terminalOutcome: 'succeeded' | 'failed' | 'cancelled' | 'incomplete' | 'unknown'
  executionErrorCount: number | null // null when the producer cannot classify errors
  errorMessage?: string              // present for a dispatch or judge error
}
```

## `TraceSpanEvent`

```ts
interface TraceSpanEvent {
  // Standard OTel
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string // canonical unsigned 64-bit integer encoded in base 10
  endTimeUnixNano: string   // canonical unsigned 64-bit integer encoded in base 10
  attributes: Record<string, string | number | boolean>
  events?: Array<{
    timeUnixNano: string    // canonical unsigned 64-bit integer encoded in base 10
    name: string
    attributes?: Record<string, string | number | boolean>
  }>
  status?: { code: 'OK' | 'ERROR' | 'UNSET', message? }

  // Tangle additions (all optional) for pivoting
  'tangle.runId'?: string
  'tangle.generation'?: number
  'tangle.cellId'?: string
  'tangle.scenarioId'?: string
}
```

---

## Server requirements

Any orchestrator implementing this spec MUST:

1. **Validate auth**: reject without `Authorization` header (401), with a
   mismatched bearer token (401), or without a recognized `X-Tangle-Tenant-Id`
   (404).
2. **Validate wire version**: reject incompatible wire versions (400 with
   a clear error message). The major component is the breaking-change axis.
3. **Validate tenant isolation**: queries with `tenantId` X never return
   data tagged with `tenantId` Y. Test this adversarially.
4. **Honor idempotency**: require an `Idempotency-Key`; when it matches a prior request to the same endpoint from the same tenant in the last 24 hours, return the same response without processing the body again.
5. **Deduplicate spans**: store at most one span for each `(tenantId, traceId, spanId)` identity.
   Accept an exact duplicate as already stored and reject a conflicting payload with the same identity.
6. **Keep run state monotonic**: accept forward lifecycle transitions, but never replace `finished` or `errored` with a late event.
   Delayed events can add a missing generation without replacing terminal totals, labels, or status.
7. **Persist eval-runs durably**: at least the event + cell scores must
   survive an orchestrator restart. Trace spans MAY be best-effort.
8. **Provide read access**: GET endpoints for the tenant to list + fetch
   their own runs. Wire format for reads is NOT part of this spec: each
   orchestrator can pick its own (REST + JSON, gRPC, GraphQL).

Servers SHOULD also:

- Provide a webhook callback per tenant for `gate-decided` events.
- Provide a billable-events emitter (Stripe meter / equivalent) per ingest
  call so consumption can be metered.
- Provide a dashboard or API to view + diff per-scenario lifts over time.

---

## Reference implementation

`examples/hosted-ingest-server/` is a Hono receiver for local development and contract tests.
It validates auth, request and response shapes, versions, exact nanosecond strings, request keys, span identity, and monotonic run state.
It is not production storage because process restart clears its in-memory data.

```sh
TENANT_KEY=dev-token TENANT_ID=acme pnpm tsx examples/hosted-ingest-server/server.ts
```

In another terminal:

```sh
HOSTED_ENDPOINT=http://localhost:8080 \
HOSTED_TENANT_KEY=dev-token \
HOSTED_TENANT_ID=acme \
pnpm tsx examples/foreign-agent-quickstart/index.ts
```

The quickstart's eval-run gets POSTed to the reference receiver; the
receiver's `GET /v1/runs` lists it back.

---

## Version

`HostedWireVersion` is `"2026-07-24.v1"`.
The current clients emit only this value.
Servers return 400 for every other value and list the accepted version.
There are no compatibility readers or migration branches.
