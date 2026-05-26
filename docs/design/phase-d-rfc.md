# Phase D RFC — hosted-tier substrate

Pinned scope decisions for the EXPAND tier. What we built, what we
deliberately did NOT, and what's gated on Phase B evidence.

---

## What's in this version

**Wire-format substrate (shipped):**

1. `@tangle-network/agent-eval/hosted` — public client + types for shipping
   eval-run events + trace spans to any orchestrator that speaks the wire
   format.
2. `docs/hosted-ingest-spec.md` — semver-committed wire spec
   (`HostedWireVersion = "2026-05-26.v1"`).
3. `examples/hosted-ingest-server/` — minimal hono-based reference
   receiver (~200 LOC). Executable spec. Stays as the reference even
   after the production orchestrator ships.
4. `selfImprove({ hostedTenant })` opt-in — when set, the substrate
   POSTs the final eval-run event to the configured endpoint. Failures
   are logged but never fail the loop (LAND tier never blocks on
   EXPAND-tier infra).

**Production orchestrator (started):**

5. HTTP ingest service in `@tangle-network/monorepo` accepting the wire
   format. Lives under the orchestrator app. Tenant auth + isolation
   + persistent storage + read endpoints. *Started this session — see
   the @tangle-network/agent-dev-container PR. Not feature-complete:
   tenant CRUD + adversarial isolation tests pending.*

## What's deliberately deferred

The wedge doc gates these on Phase B evidence — partner-validated
signal about what the hosted product actually needs to do. Shipping
them without that signal risks building the wrong thing.

| Deferred until Phase B passes | Why |
|---|---|
| **Metered billing wire-up (Stripe + cost-ledger)** | The billable units (per-eval-run, per-ingested-MB, per-seat) depend on actual partner consumption patterns. Picking dimensions in a vacuum locks us into wrong pricing. |
| **Multi-tenant dashboard UX** | Partners' first dashboard request defines the right default views. We have a stub list-runs page; the rest is post-signal. |
| **Webhook callbacks per tenant** | The events partners want pushed (gate-decided, cost-threshold, regression-alert) are partner-shaped. Add them when a partner asks. |
| **Cross-tenant aggregation / benchmarking** | This is the "Datadog for agents" tier — explicit roadmap, requires user volume we don't have. |
| **Sandbox-cost roll-up into hosted billing** | Cross-product billing integration requires PLATFORM-tier partners. Out of scope until at least one. |
| **Trace UI** | OTel-shape spans store fine. Visualization comes after partners ask. Phoenix / Jaeger / any OTLP-compatible viewer covers it in the interim. |
| **Soc2 / compliance audit work** | Required for enterprise; not required for design partners. |

## Architecture decisions locked

These are committed and won't change without a major-version wire bump
or a documented migration:

1. **Wire format is JSON over HTTP**, not gRPC. Reasons: works in
   browsers + edge + node + curl; OTel-compatible at the trace stream
   level; lowest possible barrier to a self-hosted orchestrator.
2. **Tenant auth is bearer-token + tenant-id header**, not OIDC /
   service-account / mutual-TLS. Reasons: simplest thing that's
   actually secure with proper key handling; defers complex IAM until
   enterprise demand.
3. **Idempotency via header, not transactional API**. Servers MUST
   dedupe by `(tenantId, Idempotency-Key)` for 24h. Simpler than
   making clients commit transactions.
4. **Eval-runs and traces are SEPARATE streams** with pivot keys
   (`tangle.runId` etc.) on spans. Reasons: traces can be best-effort
   (lossy) without corrupting eval-run semantics; orchestrators can
   prioritize eval-run durability without forcing trace durability.
5. **Wire version is a date.v-N string**, not semver. Reasons: dates
   communicate "when was this contract frozen"; v-N captures
   incremental breaking changes between dates.

## Open questions for Phase B to answer

When the design-partner pairing happens, capture answers to these
explicitly:

1. **Surface confidentiality**: do partners want the verbatim surface
   (system prompt) shipped, or just the hash? Today the wire format
   has `surface?` as optional; partner default is what we ship.
2. **Trace sampling**: at what cells-per-second do trace spans become
   noise? What's the right default sampling rate?
3. **Cost attribution granularity**: per cell? per generation? per
   run? Per judge dimension? Partner needs determine what we surface
   in billing reports.
4. **Replay**: do partners want to re-run an old eval-run from the
   stored data? That would require us to store more than the summary —
   actual artifacts + prompts. Storage cost implication.
5. **PII / sensitive scenarios**: how do partners want to handle
   scenarios containing user data? Encryption-at-rest is table stakes;
   redaction-at-ingest may be required for some.

The partner pairing kit (`docs/phase-b-pairing-kit.md`) has discovery
questions that probe these.

## Non-goals (explicit)

This RFC does NOT plan for:

- Replacing Langfuse / Phoenix / Arize. We INGEST OTel; we don't
  build a generic trace viewer. The dashboard is eval-run-shaped, not
  trace-shaped.
- Becoming a model gateway. Tangle Router exists; the hosted
  orchestrator routes to Tangle Router by default but doesn't
  duplicate its function.
- Becoming an LLM-call CDN. Caching is the consumer's job (their
  agent code, their HTTP client). We don't intercept LLM calls.
- Building an "agents IDE." Substrate, not surface.

## Migration path (post Phase B)

When Phase B passes the gate, the production orchestrator finishes:

1. Replace in-memory store with Postgres (tenant data) + S3 (large
   artifacts) OR Cloudflare D1 + R2 (Workers-native).
2. Wire metered events to Stripe + the cost-ledger.
3. Tenant CRUD UI + onboarding flow.
4. Multi-tenant dashboard MVP (list runs, drill into one, diff
   generations, view shipped prompt).
5. Adversarial tenant-isolation test battery in CI.
6. Webhooks + observability for the orchestrator itself.

Estimated effort post-Phase-B: ~1 week focused work for one engineer.
This is fast precisely BECAUSE the wire format is locked and the
reference receiver exists — the production server is a different
implementation of the same contract.
