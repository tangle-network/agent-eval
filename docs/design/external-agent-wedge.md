# External-Agent Wedge — plug-in self-improvement for any agent

**Status:** proposed · **Owner:** Drew · **Tracking:** ops-board #507 (epic) · **Updated:** 2026-05-26

> One sentence: **expose the self-improvement engine our own fleet runs on as a drop-in library any agent builder can install — land free, bill the hosted intelligence.**

This doc locks direction so the team executes without thrash. It is deliberately short. If a question isn't answered here, the default is "do the cheapest thing that keeps the LAND tier free and the EXPAND tier billable."

---

## Why now

Repeated signal from agent founders (latest: a high-quality GTM/social-marketing agent, sharp CTO): **no evals, no observability, hand-built, no way for the agent to improve itself.** This is the median serious agent team. They don't need another trace viewer — they need their agent to *get better on its own* and proof that it did.

We already built that engine and hardened it the hard way: **6 of our own agents** (tax, legal, creative, gtm, agent-builder, physim) now run the *same* `runCampaign` / `runImprovementLoop` / `gepaProposer` / gate surface. It is `@tangle-network/agent-eval` — already on npm, runtime-agnostic, dogfooded in production. Exposing it externally is distribution of an asset we already own, not a new product to invent.

## Positioning — self-improvement first, not observability

If we sell "observability," we are a worse Langfuse/Braintrust/Arize and it's a margin race. Our wedge is the **closed self-improvement loop** (eval campaign → reflective `gepaProposer` prompt optimization → gated promotion → Bradley-Terry tournaments → predictive-validity calibration). Observability is the *byproduct*, not the pitch.

**The pitch:** "Plug us in. Your agent runs a closed self-improvement loop against your own use case, gated so it never ships a regression — and you get the eval + trace observability for free as it does."

### Backend-agnostic by design — the sandbox is swappable, not required

The whole stack already runs **without our sandbox**, at two granularities:
- **`agent-eval`** (the self-improvement engine) touches the sandbox only as a *type* — the LAND tier needs no sandbox.
- **`agent-runtime`** is runtime-decoupled too: every sandbox import is `import type`, and the sandbox backend takes an *injected* instance. Its `Backend` seam already ships `createOpenAICompatibleBackend` (pure LLM) and `createIterableBackend` (bring-your-own) next to `createSandboxPromptBackend`. A builder runs the full runtime + self-improvement loop on **their own execution backend**, no Tangle sandbox installed.

So adoption is *graduated*, and the builder picks the depth: (1) **trace-analysis only** over their existing runtime; (2) the **full self-improvement loop** on their own backend; (3) **our sandbox as a swap-in backend** for the batteries. Our sandbox becomes the best *option*, never the cost of entry. The only work to make this explicit: mark the `@tangle-network/sandbox` peer `optional` in agent-runtime + document the `Backend` interface as the swap seam (Phase A).

## The surface — three tiers (land → expand → platform)

| Tier | What they do | What they get | Billing |
|---|---|---|---|
| **LAND** (exists today) | `npm i @tangle-network/agent-eval`, wrap their agent behind one `dispatch` seam, bring a judge | Full self-improvement loop + **local** trace/eval artifacts. Any infra, no sandbox. | Free (lib) — **with optional Tangle Router as a $0-friction inference upsell.** When a builder points `OPENAI_BASE_URL` at `router.tangle.tools/v1`, every campaign call (agent + judge + reflective mutation) routes through us; we earn the routing margin. Same code, opt-in monetization vector that ships today. |
| **EXPAND** (the build) | Route trace/eval/labeled-scenario data to our orchestrator | Hosted dashboards, cross-run intelligence, the capture flywheel as a service | **Metered** — composes with existing sandbox Stripe + cost-ledger |
| **PLATFORM** (the carrot) | Move execution into our sandbox (agent-dev-container) | Substrate + orchestrator data/intelligence pre-wired, batteries included | Sandbox usage |

The free lib casts the widest possible net at near-zero cost (it's already published). LAND is **not actually zero-revenue** — pointing the loop at Tangle Router is a one-line config change with no other code differences, so we monetize inference for any LAND-tier adopter who opts in. The wedge ladder is therefore four steps: no-revenue install → router routing margin (LAND with router) → metered data hosting (EXPAND) → sandbox usage (PLATFORM). Each step a one-line config change, never a rewrite. Value capture concentrates at EXPAND (hosting their data/intelligence is the biggest billable surface), but LAND-with-router is the immediate upsell available from day one.

## Plan & gates — land-first, validate, then build

The non-negotiable discipline: **do not build the hosted/billing tier before the free LAND is validated on a foreign agent.** Reality on someone else's real agent is cheaper than our imagination.

- **Phase A — unblock (ungated, now):** upgrade agent-dev-container to the latest substrate; export `OutcomeStore`/`DeploymentOutcome` from `/rl`; mark agent-runtime's `@tangle-network/sandbox` peer `optional` + document the `Backend` swap seam (make sandbox-free adoption explicitly supported). Pure wins, correct regardless of the wedge.
- **Phase B — design-partner LAND validation (forcing function):** wrap the founder's agent behind `dispatch`, author a marketing-quality judge, run one real campaign + `gepaProposer` loop. Instrument integration friction, judge cold-start, and actual quality lift.
- **GATE — go/no-go + pricing:** decided from Phase B evidence, not theory.
- **Phase C — LAND ergonomics:** external 15-minute quickstart + a stable `dispatch`/judge/scenario contract + ≥1 reference framework adapter.
- **Phase D — EXPAND (gated):** hosted OTLP/eval-run HTTP sink (client in agent-eval) + multi-tenant orchestrator ingest + metered billing + minimal dashboard (server in `@tangle-network/monorepo`).

## Success metrics

- **Phase B:** ≥1 measurable quality lift on the partner's own use case; integration ≤ a 1–2 day pairing.
- **LAND:** time-to-first-self-improvement-loop for a new external agent < 1 day from the quickstart.
- **EXPAND:** first external tenant routed + first metered dollar.

## Risk register

**Knowns (high confidence)**
- The substrate is a portable lib; it wraps our 6 agents behind `dispatch`/judge/gate in production.
- It's runtime-agnostic (FS + in-memory storage, Node + edge) and emits OTLP traces.
- **agent-runtime is already sandbox-decoupled at runtime** — sandbox is type-only + dependency-injected; the `Backend` seam (`createOpenAICompatibleBackend` / `createIterableBackend` / `createSandboxPromptBackend`) makes the sandbox one swappable option. Only the peer-dep label needs to change.
- The orchestrator/observability/billing platform lives in `@tangle-network/monorepo`.

**Known-unknowns (Phase B answers these)**
- Does `dispatch` wrap a *foreign* agent as cleanly as ours, or are there hidden Tangle assumptions?
- Judge cold-start: can a team with no prior evals author a usable judge for a subjective domain (marketing quality)?
- Data cold-start: no evals = no scenarios = no labels; how do they bootstrap the flywheel day 1?
- Orchestrator multi-tenancy: it's only run internally — external auth/isolation/privacy is unbuilt.
- Pricing line + OSS boundary (the lib is already public).

**Unknown-unknowns (instrument, don't predict)**
- Integration-surface explosion → keep a tiny stable contract + reference adapters; refuse to special-case.
- Foreign-domain eval semantics we've never seen → the design partner is the discovery mechanism.
- Multi-tenant orchestrator failure modes at external/adversarial scale.
- Supply-chain/trust — we enter their dependency tree; our security posture becomes their procurement question.
- *Mitigation for all:* land-first-with-a-partner surfaces surprises cheaply, on a real agent, before any hosted spend. Timebox Phase D behind the gate.

## Non-goals (anti-thrash)

- **Not** a standalone observability product. Observability ships only as a byproduct of self-improvement.
- **Not** building the hosted/billing tier before Phase B validates the lib.
- **Not** per-framework bespoke integrations — one stable contract + a couple of reference adapters.
- **Not** re-architecting the substrate for hypothetical external needs — extend at the `dispatch`/judge/store seams only.
- **Not** changing the sandbox/products roadmap — this *exposes the same engine*, it doesn't fork it.

## Tracking

ops-board epic **#507** + children: agent-dev-container stack upgrade (eng), foreign-agent adoption surface (eng), design-partner LAND validation (gtm), hosted orchestrator routing + billing (eng, blocked on the gate), GTM-fit + pricing decision (gtm).
