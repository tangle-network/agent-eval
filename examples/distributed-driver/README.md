# Distributed-driver reference

Two-process demo showing how `runEval` / `runCampaign` /
`runImprovementLoop` decouple from worker placement. Driver runs in one
terminal; worker(s) run in another (or many others, in other regions).

## Two terminals — single worker

```sh
# Terminal 1 — worker
pnpm tsx examples/distributed-driver/worker.ts

# Terminal 2 — driver
pnpm tsx examples/distributed-driver/driver.ts
```

The driver POSTs each scenario to the worker over HTTP, the worker
returns the artifact, the substrate aggregates judge scores as if
everything were in-process.

## Multi-region fan-out

Start three workers (different ports, different machines, different
regions — doesn't matter):

```sh
PORT=8081 WORKER_ID=us pnpm tsx examples/distributed-driver/worker.ts
PORT=8082 WORKER_ID=eu pnpm tsx examples/distributed-driver/worker.ts
PORT=8083 WORKER_ID=ap pnpm tsx examples/distributed-driver/worker.ts
```

Run the driver pointing at all three:

```sh
WORKER_URL_US=http://localhost:8081/dispatch \
WORKER_URL_EU=http://localhost:8082/dispatch \
WORKER_URL_AP=http://localhost:8083/dispatch \
pnpm tsx examples/distributed-driver/driver.ts
```

The driver's `cellPlacement` reads the scenario tag (`us` / `eu` /
`ap`) and routes each cell to the matching worker. With
`maxConcurrency: 4` you'll see the four cells dispatch in parallel,
each to its target region.

## What this proves

- **`Dispatch` is location-transparent.** Worker can be local-loopback,
  cross-region, cross-cloud, behind a load balancer, in an autoscaling
  fleet — the driver doesn't know and doesn't care.
- **`cellPlacement` is a pure function.** Substrate calls it per cell;
  whatever string it returns becomes `ctx.placement` on the Dispatch.
  `httpDispatch.resolveUrl` reads that and picks a URL.
- **Cancellation works across the wire.** `AbortSignal` in the driver
  forwards to the worker; the worker translates abort → 499 so the
  client doesn't retry a deliberately-cancelled request.
- **Retries are bounded + idempotent-only.** 5xx / 408 / 429 are
  retried with backoff; 4xx is terminal; caller-driven aborts are
  never retried.

## Production wiring

In production you'd swap:

- The stub agent in `worker.ts` for your real one (LangChain chain,
  OpenAI Agents call, your sandbox runtime).
- The `dev-token` for a real bearer credential or rotating creds via
  the `auth: () => Promise<string>` form.
- The driver running locally for a long-lived "driver service" — same
  binary, deployed on its own infrastructure, holding the
  optimization state across many campaign cycles.
- The console-logged `onRequest` worker callback for an OTel exporter
  pointed at your observability stack
  (see `docs/adapters-observability.md`).

See `docs/distributed-driver.md` for the architectural rundown.
