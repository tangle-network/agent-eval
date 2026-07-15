# Distributed campaign execution — coordinator-on-A, workers-on-B

The coordinator process (running `runCampaign` / `runImprovementLoop` /
`gepaProposer`) and the worker (running your actual agent) **do not have to live in the
same process, machine, region, or cloud.** `Dispatch` is just a
function: scenario in, artifact out. Whatever returns the artifact is
the worker — local, remote, sandboxed, or fanned out across a fleet.

## Why you'd want this

| Pattern | Reason |
|---|---|
| **Coordinator on your VPC, workers on our sandbox fleet** | Coordinator holds secrets, training data, prompt corpus; workers stay stateless and scale horizontally |
| **Multi-region campaigns** | Each cell runs in the region closest to its target API (latency, compliance, data residency) |
| **Coordinator-as-a-service** | Long-running optimization process; reuses across many short-lived worker invocations |
| **Heterogeneous workers** | One cell on a CPU container, another on a GPU box, another against a third-party API — same Dispatch shape, different placement |
| **Budget-isolated workers** | Worker boxes get scoped, time-bounded credentials; coordinator never holds production keys |

## Two new pieces in 0.45.0

| Where | What |
|---|---|
| **`DispatchContext.placement?: string`** | Opaque placement key the substrate forwards to the Dispatch. |
| **`RunCampaignOptions.cellPlacement?(input) → string \| undefined`** | Strategy function the substrate calls per cell to compute the placement key. |
| **`@tangle-network/agent-eval/adapters/http`** | `httpDispatch` (client) + `runDispatchServer` (server) — wire shape for HTTP-based remote workers. |

Both ends of the wire are in the same package; no peer dep, no separate
install. The substrate doesn't strategy-pick; you provide the
`cellPlacement` function, the substrate forwards its result, the
Dispatch reads it. Clean seam, no policy baked in.

## The three reference topologies

### 1. In-process (the default — what you already have)

```ts
await runCampaign({
  scenarios,
  dispatch,            // runs in-process
  judges: [judge],
  storage,
  runDir,
})
```

`ctx.placement` is `undefined`; nothing changes for existing consumers.
This shipped in 0.40.

### 2. Single remote worker

Coordinator-on-A talks to one worker-on-B over HTTP.

**Coordinator side (machine A):**

```ts
import { httpDispatch } from '@tangle-network/agent-eval/adapters/http'

const dispatch = httpDispatch<MyScenario, MyArtifact>({
  url: 'https://worker.your-infra.com/dispatch',
  auth: process.env.WORKER_TOKEN,
  timeoutMs: 5 * 60 * 1000,
  retries: 2,
})

await runImprovementLoop({ scenarios, baselineSurface, dispatchWithSurface: (surface, s, ctx) =>
  dispatch(s, { ...ctx, /* pass the surface through your own protocol */ }),
  /* ... */ })
```

**Worker side (machine B):**

```ts
import { runDispatchServer } from '@tangle-network/agent-eval/adapters/http'

const handle = await runDispatchServer<MyScenario, MyArtifact>({
  dispatch: async (scenario, ctx) => {
    // your agent — call OpenAI, LangChain, your sandbox, anything.
    const artifact = await runMyAgent(scenario, ctx.signal)
    return artifact
  },
  port: 8080,
  auth: process.env.WORKER_TOKEN,  // required; `false` only for closed networks
})
console.log(`worker listening on ${handle.port}`)
```

Cancellation, retries on 5xx / 408 / 429, bounded timeouts, optional
custom auth headers, optional `fetchImpl` override — all there.

### 3. Multi-region fan-out

The coordinator picks a region per cell; the same `httpDispatch` routes to
different worker URLs based on placement.

```ts
import { httpDispatch } from '@tangle-network/agent-eval/adapters/http'

const REGION_URLS: Record<string, string> = {
  'us-east': 'https://worker-use1.your-infra.com/dispatch',
  'eu-west': 'https://worker-euw1.your-infra.com/dispatch',
  'ap-south': 'https://worker-aps1.your-infra.com/dispatch',
}

const dispatch = httpDispatch<MyScenario, MyArtifact>({
  resolveUrl: ({ placement }) => REGION_URLS[placement ?? 'us-east'],
  auth: process.env.WORKER_TOKEN,
})

await runCampaign({
  scenarios,
  dispatch,
  judges: [judge],
  storage,
  runDir,
  cellPlacement: ({ scenario }) => {
    if (scenario.tags?.includes('eu')) return 'eu-west'
    if (scenario.tags?.includes('ap')) return 'ap-south'
    return 'us-east'
  },
  maxConcurrency: 8,  // 8 cells fan across regions in parallel
})
```

`cellPlacement` is a pure function the substrate calls per cell — no
state. Use whatever signal you want (tags, hash of scenario id,
round-robin, region-affinity from a previous run, scheduling table).

## What's preserved across the wire

| Concern | How |
|---|---|
| **Cancellation** | The coordinator's `AbortSignal` forwards into the HTTP request; server translates `AbortError` → `499` so client doesn't retry. |
| **Timeouts** | Per-call `timeoutMs` on the client; server can layer its own. |
| **Retries** | Idempotent retries on 5xx / 408 / 429 with exponential backoff + jitter. Coordinator aborts never retry. |
| **Auth** | Bearer token on `Authorization`; pluggable via `auth: string \| () => string \| Promise<string>` for rotation/refresh. |
| **Payload size** | Server enforces `maxBodyBytes` (default 10 MB). |
| **Traces** | Both ends emit OTel — if both point at the same OTLP collector, you get a unified trace per cell. See `docs/adapters-observability.md`. |
| **Cost** | Worker's `ctx.cost.runPaidCall(...)` writes durable receipts in the worker process. Roll up those receipts server-side and attach them to worker telemetry; they are not forwarded to the coordinator automatically. |

## Running the reference example

See `examples/distributed-driver/`:

```sh
# Terminal 1 — worker
pnpm tsx examples/distributed-driver/worker.ts

# Terminal 2 — coordinator
WORKER_URL=http://localhost:8080/dispatch \
WORKER_TOKEN=dev-token \
pnpm tsx examples/distributed-driver/driver.ts
```

Two processes, one local TCP loopback, full self-improvement loop end
to end. Scaling out is dropping `WORKER_URL` to a non-loopback hostname
and using `cellPlacement` to fan across many of them.

## Known gaps + follow-ups

- **Cost roll-up across the wire** — worker-side `ctx.cost` observations
  stay on the worker. We need to forward them in the response body so
  `defaultProductionGate`'s `budgetUsd` ceiling reflects total spend, not
  coordinator-side spend. Tracked as a 0.45.x follow-up.
- **Per-cell artifact streaming** — when the worker writes intermediate
  artifacts via `ctx.artifacts.write`, those land on the worker's
  storage. For multi-worker campaigns you'll want a shared object store
  (S3/GCS) reachable from both sides; today consumers wire that as a
  `CampaignStorage` impl. A reference S3-backed storage is on the
  roadmap.
- **gRPC / NATS / Temporal transports** — the wire is HTTP today by
  default because everything speaks HTTP. Other transports can ship as
  additional adapters; the `Dispatch` interface itself is
  transport-agnostic.
