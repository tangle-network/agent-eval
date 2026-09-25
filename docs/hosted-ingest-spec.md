# Hosted-ingest wire spec: `2026-07-24.v1`

This is the only hosted-ingest wire format the current package implements.
Clients and servers reject every other wire version.

This is the contract between `@tangle-network/agent-eval` and any hosted or self-hosted store.
A builder can use our store, self-host the reference receiver from `examples/hosted-ingest-server/`, or implement this spec.

The wire carries two streams:

- **Search ledgers.** A producer ships a search's hash-chained ledger and the blobs its entries name.
  The ledger is the search's record: nodes, edges, cells, decisions and the claim ([search ledger](./search-ledger.md)).
- **Trace spans.** OTLP-shaped spans with `tangle.*` pivots, so a store can join a cell to its execution.

The shapes are exported from `@tangle-network/agent-eval/hosted` as zod schemas.
A store imports them instead of copying them.

---

## Transport

Headers on every request:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <tenant-key>` |
| `X-Tangle-Tenant-Id` | The tenant's stable id |
| `X-Tangle-Wire-Version` | `2026-07-24.v1` |
| `Idempotency-Key` | On `POST` and `PUT`: at most 256 characters, reused across retries |

A client retries network errors, 408, 429 and 5xx.
When the response carries `Retry-After` (delay-seconds or an HTTP date), the client waits exactly that long before the next attempt; otherwise it backs off exponentially.

---

## Search ledgers

A producer ships in this order, so a store has an entry's content before the entry.

### `PUT /v1/search-blobs/<sha256 hex>`

Body: the exact bytes an artifact ref names.
`Content-Type` is `application/json` for the JSON blobs the recorder writes, otherwise `application/octet-stream`.

The store re-hashes the bytes and refuses a mismatch with 422.
The call is idempotent by content.
Response (`SearchBlobPutResponseSchema`): `{ sha256, byteLength, state }`, where `state` is `stored`, `masked` or `withheld`.
A store masks or withholds bytes its redaction scan or the tenant's content posture refuses; it never rejects the entry that names them.

### `GET /v1/ingest/search-ledger/<searchId>/head`

Response (`SearchLedgerHeadSchema`): `{ searchId, nextSequence, headHash }`.
`nextSequence` is the number of entries the store holds, and `headHash` is the hash of the last one, or null when it holds none.
A restarted producer starts here.

### `POST /v1/ingest/search-ledger`

Body (`IngestSearchLedgerRequestSchema`):

```ts
{
  wireVersion: '2026-07-24.v1'
  searchId: string
  runKind: 'optimization' | 'eval'   // an eval is a one-node search
  fromSequence: number               // the sequence of lines[0]
  lines: string[]                    // canonical ledger lines, without newlines
}
```

At most 1,000 lines and 1 MiB of line bytes per request.
Each line is the producer's own ledger bytes, so producer and store hash identical input.

The store applies `admitSearchLedgerBatch` to the batch, in one transaction:

1. `fromSequence` past the store's head: `409 sequence_gap`.
2. Each line must verify alone with `parseSearchLedgerLine`: the schema tag, the entry and event schemas, canonical bytes, its `entryHash`, and its `searchId`. A line that does not: 422.
3. A line below the head with the stored hash is a no-op; a different hash is `409 chain_conflict`.
4. The first new line must extend the stored head; if it does not, `409 chain_conflict`.
5. The new entries pass the `SearchState` state machine, or the batch returns 422 and stores nothing.

Response (`SearchLedgerHeadSchema`): the head after the batch.
A 409 body (`SearchLedgerConflictSchema`) is `{ error: 'sequence_gap' | 'chain_conflict', message, head }`.

A producer resends from `head.nextSequence` after a gap.
It stops on a fork: the store holds a different chain for the same search, and nothing is overwritten.

`runKind` is fixed by the first batch; a later batch with another kind is a 422.

### The shipper

`shipSearchLedger({ tenant, ledger: { path, searchId }, runKind })` ships every complete line of a ledger file and returns the store's head and blob counts.
`startSearchShipper(...)` tails the file while the search runs: the search never waits on the network, and `stop()` ships the rest.
`agent-eval search ship <ledger> --run-kind optimization|eval` does the same from a terminal, reading the store from `TANGLE_INGEST_URL`, `TANGLE_INGEST_API_KEY` and `TANGLE_TENANT_ID`.
`selfImprove({ hostedTenant, searchLedger })` runs the tailing shipper for its own ledger.

`content: 'digests'` ships entries without blobs, so the store holds refs and digests but no text.
A blob whose local bytes are missing or do not match their ref is not uploaded and is reported under `blobs.missing`; the entries still ship.

---

## Trace spans

### `POST /v1/ingest/traces`

Body (`IngestTracesRequestSchema`): `{ wireVersion, spans: TraceSpanEvent[] }`.
Response (`IngestResponseSchema`): `{ accepted, rejected: Array<{ index, reason }> }`.

```ts
interface TraceSpanEvent {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string // canonical unsigned 64-bit integer in base 10
  endTimeUnixNano: string
  attributes: Record<string, string | number | boolean>
  events?: Array<{ timeUnixNano: string; name: string; attributes?: Record<string, string | number | boolean> }>
  status?: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string }
  'tangle.runId'?: string
  'tangle.generation'?: number
  'tangle.cellId'?: string
  'tangle.scenarioId'?: string
}
```

A store keeps at most one span per `(tenantId, traceId, spanId)`.
It accepts an exact duplicate as stored and rejects a conflicting payload with the same identity.
When an `Idempotency-Key` matches a request from the same tenant in the last 24 hours, it returns the recorded response.

---

## Server requirements

A store that implements this spec must:

1. Reject a request without a valid bearer token (401) or with an unknown tenant (404).
2. Reject every wire version other than `2026-07-24.v1` (400) and name the accepted one.
3. Isolate tenants: a read for tenant X never returns tenant Y's data, and a blob, search or span of another tenant reads as absent.
4. Apply the search-ledger batch rule above, and store a batch whole or not at all.
5. Keep search entries, blobs and their metadata durably; trace spans may be best-effort.

---

## Reference implementation

`examples/hosted-ingest-server/` is an in-memory Hono receiver for local development.
It applies `admitSearchLedgerBatch` and `SearchState` to every batch, re-hashes blobs, and serves `GET /v1/searches/<searchId>` with the replayed audit.
A process restart clears it.

```sh
TENANT_KEY=dev-token TENANT_ID=acme pnpm tsx examples/hosted-ingest-server/server.ts
```
