# Hosted-ingest wire spec — `2026-05-26.v1`

The schema **every** orchestrator (ours, partners' self-hosted ones,
any future open implementation) must accept. Frozen under semver:
**new minors only add optional fields. Breaking changes mean a major
bump and a new `HostedWireVersion` literal.**

This is the contract that decouples the LAND-tier substrate
(`@tangle-network/agent-eval`) from the EXPAND-tier hosted product. A
foreign builder can:

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
| `X-Tangle-Wire-Version` | `2026-05-26.v1` (this spec) |
| `Idempotency-Key` (optional) | UUID; servers MUST treat repeated keys as dedup |

Responses are JSON of shape `{ accepted: number, rejected: Array<{ index, reason }> }`. The
server SHOULD return 202 (accepted, async) or 200 (accepted, synchronous);
both are equivalent for the wire's purposes.

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
}
```

## `EvalRunGenerationSnapshot`

```ts
interface EvalRunGenerationSnapshot {
  index: number                      // 0 is baseline; 1..N are improvement generations
  surfaceHash: string                // stable hash of the candidate surface (pivot key)
  surface?: MutableSurface           // OMITTED to avoid PII when consumer prefers
  cells: EvalRunCellScore[]
  compositeMean: number
  costUsd: number
  durationMs: number
}
```

## `EvalRunCellScore`

```ts
interface EvalRunCellScore {
  scenarioId: string
  rep: number                        // 0 for the default; > 0 when reps > 1
  compositeMean: number              // composite across all judges + dimensions
  dimensions: Record<                // outer key = judge name; inner = dimension name → score
    string,
    Record<string, number>
  >
  errorMessage?: string              // present when the dispatch threw
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
  startTimeUnixNano: number
  endTimeUnixNano: number
  attributes: Record<string, string | number | boolean>
  events?: Array<{ timeUnixNano, name, attributes? }>
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
4. **Honor idempotency**: when an `Idempotency-Key` matches a prior
   request from the same tenant in the last 24h, return the same response
   without double-processing.
5. **Persist eval-runs durably**: at least the event + cell scores must
   survive an orchestrator restart. Trace spans MAY be best-effort.
6. **Provide read access**: GET endpoints for the tenant to list + fetch
   their own runs. Wire format for reads is NOT part of this spec — each
   orchestrator can pick its own (REST + JSON, gRPC, GraphQL).

Servers SHOULD also:

- Provide a webhook callback per tenant for `gate-decided` events.
- Provide a billable-events emitter (Stripe meter / equivalent) per ingest
  call so consumption can be metered.
- Provide a dashboard or API to view + diff per-scenario lifts over time.

---

## Reference implementation

`examples/hosted-ingest-server/` — a minimal hono-based receiver. ~200
LOC. Validates auth, accepts ingest, stores in memory, exposes a
read endpoint. Runs anywhere Node runs.

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

## Versioning

`HostedWireVersion` is `"2026-05-26.v1"`.

- Adding an optional field → no version change.
- Adding a new endpoint or new event type → minor wire bump
  (`2026-05-26.v2`).
- Changing the shape of an existing field, removing a field, or
  changing semantics of an existing field → major wire bump
  (`2026-11-XX.v1`); a server may accept both versions during a
  transition window.

Servers MUST reject requests with `X-Tangle-Wire-Version` they don't
support, with a 400 listing the versions they DO accept.

The version string IS the spec id — pin against it.
