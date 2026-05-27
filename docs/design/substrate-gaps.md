# Substrate gaps — design-partner readiness

What's missing from `@tangle-network/agent-eval` substrate (this repo) and `~/code/agent-dev-container/products/intelligence/` (the orchestrator) to credibly hand to a first design partner.

This doc is the engineering-side mirror of `~/company/gtm/experiments/2026-05-27/design-partner-readiness.md` — gtm tracks the partner-facing readiness, this tracks the code that backs each bar.

## Current substrate state

Shipped in v0.47:
- `selfImprove({ scenarios, judges, dispatch, hostedTenant })` one-shot helper
- `defaultProductionGate(deltaThreshold)` autonomous-ship gate
- Wire format frozen at `HOSTED_WIRE_VERSION = '2026-05-26.v1'`
- `/hosted/client.ts` — bearer auth, idempotency, bounded retries on 5xx/408/429
- `examples/hosted-ingest-server/` — reference receiver implementing the spec
- `docs/hosted-ingest-spec.md` — semver-locked wire spec
- `docs/design/phase-d-rfc.md` — scope decisions + deferred items
- `docs/quickstart-external.md` — foreign-agent quickstart
- `docs/phase-b-pairing-kit.md` — partner discovery script
- `adapters/langchain` + `adapters/http`

## Engineering gaps keyed to first-partner readiness

### Substrate gaps (this repo)

**S1. TraceAI/OTel adapter (`adapters/traceai`).**
Future AGI's `traceai` library is the strongest OTel-native instrumentation in the TS ecosystem. Partners using it should be able to wire its emitted spans into our hosted ingest via one config line. The adapter receives OTel spans, normalizes them to `TraceSpanEvent`, ensures the `tangle.runId` attribute is present, and forwards via the existing hosted client.

Path: `src/adapters/traceai.ts`. Export from `tsup.config.ts`. Add to `docs/adapters-observability.md`.

Estimate: 6-8h. Owner: claude. Priority: medium (Tier C in partner-readiness — defer until first partner asks, but pre-build the contract).

**S2. Run-diff data primitive.**
The orchestrator needs to render "v3 vs v4" comparisons. The substrate should expose a `diffRuns(runA: EvalRunEvent, runB: EvalRunEvent): RunDiff` helper that computes cell-by-cell judge-score deltas, artifact-text diff (using a stable diff algorithm), and lift summary. Without this, every consumer rebuilds the diff logic.

Path: `src/contract/diff.ts`. Add to `/contract` entry.

Estimate: 4-6h. Owner: claude. Priority: high (orchestrator's run-diff view depends on this).

**S3. Sampling controls in hosted client.**
The Phase D RFC flags trace sampling as an open question. Add `sampling: { traces: number /* 0-1 */ }` to `createHostedClient` options. Default 1.0. Document the cost implication. Reservoir-sample if over budget.

Path: `src/hosted/client.ts`. Update `docs/hosted-ingest-spec.md` accordingly.

Estimate: 2h. Owner: claude. Priority: medium (Tier B partner-readiness).

**S4. Auto-instrumentation library (`@tangle-network/agent-eval/auto`).**
LangSmith's `@traceable` decorator + auto-wrap of OpenAI/Anthropic SDKs is their highest-leverage adoption tool. Build the equivalent: a `traceable()` HOF that emits OTel spans with `tangle.runId` attribute and forwards via the hosted client. Optional auto-wrap of `OpenAI` / `Anthropic` SDK clients.

This is the biggest unlock for non-LangChain TS partners. Defer until at least one partner asks — pre-shipping costs 16-20h and may be the wrong shape without partner signal.

Path: `src/auto/index.ts` (new entry). Estimate: 16-20h. Owner: claude. Priority: low (Tier C — defer).

**S5. Surface-confidentiality option in wire format.**
RFC open question 1. Add `surfaceMode: 'verbatim' | 'hashed' | 'omitted'` to `selfImprove` config. When `'hashed'`, ship `surfaceHash` instead of `surface` on the eval-run event. When `'omitted'`, ship neither.

This is partner-shaped — wait for the first conversation. But the wire format should accommodate it without a breaking version bump. Add the optional field to types now.

Path: `src/hosted/types.ts` (add `surfaceHash?: string`). Estimate: 1h to land the type change; later partner work to wire selfImprove. Priority: low until asked.

### Orchestrator gaps (`agent-dev-container/products/intelligence/`)

These are the gtm-doc's Tier A items rephrased for engineering tracking.

**O1. Adversarial tenant-isolation test suite.**
`tests/auth.test.ts` exists. Need `tests/isolation.test.ts` covering: cross-tenant header mismatch, cross-tenant `/v1/runs/:id` reads, webhook tenant scoping, idempotency-key tenant scoping, raw-SQL cross-tenant query, JWT replay after revocation. Use `VITEST_INTEGRATION=1` with a real Postgres in CI.

Estimate: 4-6h. Owner: claude. Priority: **critical** (blocker for any partner conversation).

**O2. Web dashboard MVP.**
List runs + run detail + login. See gtm doc A2 for shape. Pages: `/login`, `/runs`, `/runs/:id`, `/keys`. Use `intelligence-web` Vite scaffold; wire to `/v1/runs*` reads.

Estimate: 12-16h. Owner: claude. Priority: **critical** (without UI, partner can't show anyone in their org).

**O3. Free-tier plan limits enforcement.**
`lib/plans.ts` defines limits. `routes/ingest.ts` does not enforce them. Add per-tenant counters (eval-runs/mo, trace-spans/day), check against plan, return 429 with clear message + reset time on exceed.

Estimate: 3-4h. Owner: claude. Priority: medium (Tier B partner-readiness).

**O4. Stale README sweep.**
`api/README.md` lists T0-3..T0-8 as "next/pending" when 5 of them are shipped. Broken link to `../../../docs/intelligence-product-rfc.md` (gitignored path; should be `../RFC.md`).

Estimate: 30min. Owner: claude. Priority: **must-fix-now** (5-min job, awful first impression for anyone reading the repo).

**O5. Onboarding partner-facing doc.**
Engineer-shaped `quickstart-external.md` exists in this repo. Partner-facing 10-minute walkthrough does not. Lives at `intelligence.tangle.tools/docs` once provisioned; for now, write at `products/intelligence/docs/partner-onboarding.md`.

Estimate: 2-3h. Owner: claude. Priority: high (Tier A — needed for any partner call).

## Recommended sequencing (engineering view)

**Sprint 1 — partner-ready (≤ 1 week):**
- O4 (README sweep) — ship today
- O1 (isolation tests) — 4-6h
- O2 (dashboard MVP) — 12-16h
- O5 (partner onboarding doc) — 2-3h
- S2 (run-diff primitive) — 4-6h (substrate side of O2 follow-up)

Total: ~25-32h focused work. One engineer-week.

**Sprint 2 — concurrent with first partner conversations:**
- O3 (plan limits enforcement) — partner will hit it
- S3 (trace sampling) — partner will ask about cost

**Sprint 3 — after first partner ships to prod:**
- S1 (TraceAI adapter)
- Stripe billing wire-up in orchestrator

**Holding for partner signal:**
- S4 (auto-instrumentation library) — 16-20h speculative without ask
- S5 wiring (surface confidentiality) — partner-shaped

## Cross-references

- `docs/design/phase-d-rfc.md` — substrate scope decisions (this doc operationalizes its "what's deferred until Phase B")
- `docs/hosted-ingest-spec.md` — wire format spec (any change here is a wire-version bump)
- `~/company/gtm/experiments/2026-05-27/design-partner-readiness.md` — partner-facing readiness, mirrors this
- `~/company/gtm/products/tangle-intelligence.md` — product hub
- `~/company/gtm/competitor-analysis/agent-improvement.md` — competitive frame
