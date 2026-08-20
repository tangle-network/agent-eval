# Receive Hosted Events Locally

## When to use this

Use this example when a run configures `hostedTenant` and you want to see the exact events it emits, without any hosted service.
The server is the executable form of [`docs/hosted-ingest-spec.md`](../../docs/hosted-ingest-spec.md): any receiver must accept what it accepts and reject what it rejects.

## How to run it

```sh
TENANT_KEY=dev-token TENANT_ID=acme pnpm tsx examples/hosted-ingest-server/server.ts
```

The startup banner prints the accepted wire version and one ready-to-paste `curl` command.
Every request needs three headers: `Authorization: Bearer <key>`, `X-Tangle-Tenant-Id`, and `X-Tangle-Wire-Version`.
A missing or wrong wire version is a 400.

Check it is alive:

```sh
curl http://localhost:8080/healthz
```

Then point a run at it:

```ts
selfImprove({
  // ...
  hostedTenant: { endpoint: 'http://localhost:8080', tenantId: 'acme', apiKey: 'dev-token' },
})
```

## What it does

1. `POST /v1/ingest/eval-runs` and `POST /v1/ingest/traces` validate every event against the wire schemas and merge run updates by `runId`.
2. `GET /v1/runs`, `GET /v1/runs/:runId`, and `GET /v1/runs/:runId/traces` read the stored state back.
3. Repeated requests with the same `Idempotency-Key` return the recorded response instead of re-ingesting.

## Why it is built this way

The `createReferenceReceiverApp` factory returns a fresh in-memory app per call.
The package's round-trip test binds the same factory to a random port, so a wire drift between the client and this receiver fails CI instead of surfacing in production.
Storage is in-memory on purpose: the file is a reference for receiver behavior, not a database.
