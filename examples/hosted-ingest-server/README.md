# Receive Search Ledgers Locally

## When to use this

Use this example to see exactly what a producer ships to a hosted store, without any hosted service.
The server is the executable form of [`docs/hosted-ingest-spec.md`](../../docs/hosted-ingest-spec.md): it applies the same batch rule and state machine a production store must.

## How to run it

```sh
TENANT_KEY=dev-token TENANT_ID=acme pnpm tsx examples/hosted-ingest-server/server.ts
```

The startup banner prints the accepted wire version and one ready-to-paste `curl` command.
Every request needs three headers: `Authorization: Bearer <key>`, `X-Tangle-Tenant-Id`, and `X-Tangle-Wire-Version`.
A missing or wrong wire version is a 400.

Ship a search ledger to it:

```sh
TANGLE_INGEST_URL=http://localhost:8080 TANGLE_INGEST_API_KEY=dev-token TANGLE_TENANT_ID=acme \
  pnpm exec agent-eval search ship runs/x/search-ledger.jsonl --run-kind optimization
```

Or let a loop ship its own ledger while it runs:

```ts
selfImprove({
  // ...
  searchLedger: { ledger: openSearchLedger({ path, searchId }), identity },
  hostedTenant: { endpoint: 'http://localhost:8080', tenantId: 'acme', apiKey: 'dev-token' },
})
```

## What it does

1. `PUT /v1/search-blobs/<sha256>` re-hashes and stores a blob.
2. `GET /v1/ingest/search-ledger/<searchId>/head` returns where its copy of the chain ends.
3. `POST /v1/ingest/search-ledger` verifies each line with `admitSearchLedgerBatch`, replays new entries through `SearchState`, and answers 409 with its head on a gap or a fork.
4. `GET /v1/searches/<searchId>` returns the head and the replayed audit, so you can compare it with the local ledger.
5. `POST /v1/ingest/traces` and `GET /v1/runs/<runId>/traces` store and read trace spans.

## Why it is built this way

The `createReferenceReceiverApp` factory returns a fresh in-memory app per call, so a caller can bind isolated receivers.
Storage is in memory on purpose: the file is a reference for receiver behavior, not a database.
