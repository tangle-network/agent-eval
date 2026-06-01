# Self-Improvement Substrate — Closed-Loop Roadmap

Single source of truth for the agent self-improvement program: the architecture decisions, the end-to-end loop, and a completable checklist. Companion to [`self-improvement-engine.md`](./self-improvement-engine.md) (the phase diagram) — this doc is the *execution* plan.

## North star

One system under test. **Prod chat == eval == benchmark == self-improvement candidate** all run through the same execution path — a trading-desk backtester you also deploy live. Every improvement is *measured* against that path before it ships, on **any model**, with the full evidence vector preserved (never a scalar collapse).

## The closed loop (what we are completing)

```
   RUN ───────────► OBSERVE ─────────► DIAGNOSE ─────────► PROPOSE ─────────► EVALUATE ─────────► GATE ─────────► PROMOTE ──┐
 (ExecutionEnv:   (OTLP traces,     (EYES: competing    (HANDS: competing  (evidence VECTOR:   (pluggable,    (PR / config)  │
  chat=eval=       RunRecords)       analysts/HALO →     drivers →          per-dim judges +    versioned,                    │
  benchmark)                         AnalystFinding[])   candidates)        Pareto frontier +   benchmarkable                 │
        ▲                                                                   counterfactual)     POLICIES)                     │
        └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Two architectural invariants, both load-bearing:

### Invariant 1 — Unify the *contract*, pluralize the *strategies*. Never collapse the vector.

The temptation ("merge the two loops under one gate") is wrong if it means one scalar criterion. The correct design, mirroring a quant desk:

- **Evidence Bus** — a typed, high-dimensional record. Every judge dimension, every driver's proposal, every finding, every counterfactual verdict is preserved. Backed by what we already have: per-dimension `JudgeScore`, `computeParetoFrontier` (`pareto.ts`), the per-driver `DriverComparison` rows (`compare-drivers.ts`). **Nothing is averaged away.**
- **Proposers** — gepa, skill-opt, evolutionary, analyst-findings, HALO, memory-curation, ACE, and *whatever ships next year* — all implement one `ImprovementDriver`/proposer contract and **compete** on the bus, each proposing different changes. `compareDrivers` already runs this head-to-head; make it first-class for findings-driven proposers too.
- **Promotion Policies** — pluggable, versioned, and themselves benchmarkable. A policy is a function over the evidence *vector* (Pareto-dominance + per-dimension significance + safety gates), **not** a scalar threshold. Different loops may run different policies; policies compete and are A/B-backtested like strategies.

The only thing that is truly *shared* is the **interface** (evidence schema + proposer contract + policy contract). New loops plug in forever. The one non-negotiable: a write path (the findings loop's auto-apply) must flow through *a* policy — today it ships on a bare confidence float with none. Plurality of policies, yes; zero policy on a git-write, no.

### Invariant 2 — Everything is a versioned, benchmarkable surface. Including the signatures.

Prompts are already optimizable surfaces (GEPA via `analyst-surface.ts`). The **signatures/schemas themselves** (Ax I/O contract, the `AnalystFinding` schema, the kind taxonomy) are currently hand-fixed and unsearched. Three layers, staged by cost:

- **(a) Fix known-wrong structure now** — empirically caught, not speculative. The `subject` grammar rejected a valid finding; the kind taxonomy had no "successful-but-suboptimal" lens. → Track A.
- **(b) Make signatures/schemas versioned + A/B-benchmarkable** through `compareDrivers` (e.g. `findings:json[]` vs `report, findings:json[]` becomes a measured choice). → Track A.
- **(c) Search signature *structure* + let the analyst critique its own schema** (run the trace-analyst on its own runs; a "schema-fit" finding like "I dropped a row because subject grammar X" — we already have the first such data point). Program/architecture search, expensive, discrete. → **Track B research. Must not block shipping.**

---

## Track A — Ship (weeks). In-substrate, proven mechanism, properly tested.

### A0. Analyst → model-agnostic, HALO-parity  *(the live problem; ~2–3 wks to a measured result)*

Root cause (probe-verified): our Ax-RLM **fuses** reasoning + JS-sandbox + a strict typed-array emission into every turn; a weak model resolves the fused contract by emitting nothing. HALO **decouples** exploration (free-form + native tool-calls, no schema) from structuring (a deferred sub-call). Fix = decouple + recover-don't-drop + deterministic reducers (the real any-model guarantee) + the right lens.

- [x] **A0.1 — Recover the dropped finding (0→1, deterministic).** Widen cluster regex to admit `.`/`_` (exclude `:` — no prefix collision); fix `deriveQuestion` to pass a task directive, not the bare kind id. *Done — `finding-subject.ts:173`, `kind-factory.ts:224`; regression tests in `finding-subject.test.ts` (dotted-subject accepted + prefixed-subjects still route); 93 analyst tests green.*
- [x] **A0.2 — Forgiving pre-parser** — `src/analyst/parse-tolerant.ts` (`stripCodeFences`/`coerceJson`/`coerceToFindingRows`), wired into `parseRawFinding` (coerce-then-retry before dropping). *Done — 3 tests incl. the arXiv:2605.02363 fence case.*
- [x] **A0.3 — Deterministic behavioral reducers + analyst** (the any-model keystone). `src/trace-analyst/behavioral-metrics.ts` (`computeTraceMetrics` + signal detectors) + `src/analyst/behavioral-analyst.ts` (`behavioralAnalyst`, `cost.kind:'deterministic'`, + `deriveEfficiencyFindings`). *Done — went past "reducers feeding a prompt": the behavioral class is emitted DIRECTLY by a zero-LLM analyst, so it's any-model by construction (not per-model-measured). E2E on the real `530b157_1`: **4 findings exactly matching HALO's four** (13.1× input growth, 157→75 output decay, 7× single-tool, no self-verify), `status:ok`, deterministic cost. 7 unit tests + 94 suite green.*
- [~] **A0.4 — Two-phase: free-form `report` + structuring pass.** `src/analyst/structure-findings.ts` BUILT + stub-tested (de-fence → coerce → Zod → reask-once; typed outcome). *Remaining (Gen 3):* change the Ax signature to `report:string, findings:json[]` and call `structureFindings` from `kind-factory` on an empty/invalid harvest + the live no-`final`-exhaust probe.
- [ ] **A0.5 — New `efficiency` kind + broaden `failure-mode`.** Non-error-scoped, seeded with the `behavioral` block (HALO's 4 diagnoses); add the `span.attributes['llm.input_tokens']` projection hint. ~2d.
- [~] **A0.6 — Fail-loud on empty harvest.** `structureFindings` returns a typed `{ outcome: 'extraction_failed' | 'ok' }` and distinguishes a substantive-report extraction failure from a legitimate short-report empty (no silent zero). *Remaining (Gen 3):* surface that outcome from `kind-factory`/registry so a real analyst run fails loud, not just the structurer.

**Gen-2 also shipped (not in the original A0 list):** `buildDefaultAnalystRegistry` (`src/analyst/default-registry.ts`) — the missing "default suite" primitive: always registers the deterministic `behavioralAnalyst`, adds the agentic kinds when an `ai` is supplied. Carries the **any-model CI regression gate** (≥4 behavioral findings, no LLM). Consumers stop hand-wiring `new AnalystRegistry()`.
- [ ] **A0.7 — Reflexion retry** in agent-runtime `runAnalystLoop` (the one piece that belongs in runtime, not substrate): Evaluator checks the harvest, on `extraction_failed` appends a critique and retries once. Add a **per-analysis call-count budget** (critique: the pipeline adds ≤4 model calls vs HALO's 1). ~1–2d.
- [ ] **A0.8 — Terminal gate (reframed, honest).** Re-run the probe on `530b157_1` with deepseek-chat **and** moonshot-v1-128k via the `efficiency` kind; assert ≥4 findings, ≥3 overlapping HALO's four. **Prove with the structurer disabled** (reducer-seeded prose alone) so "any model" is *measured*, not assumed. Wire as a `compareDrivers`/`runProfileMatrix` CI invariant; GEPA-optimize the structurer + efficiency prompts vs goldens for the compounding lift number. ~2–3d.

> Honest scorecard: A0.1 is a proven 0→**1** *correctness* finding (zero overlap with HALO's 4 behavioral findings). HALO-parity (≥4) rests on A0.3+A0.5 and is a **hypothesis to measure**, not yet a result.

### A1. Evidence Bus + competing pluggable policies *(Invariant 1; ~2–3 wks)*

- [ ] **A1.1 — Light the dead EYES→HANDS wire.** `gepa.ts`/`skill-opt.ts` `propose()` consume `ctx.findings`/`ctx.report` (plumbed via `run-optimization.ts`, currently unread). *Gate:* `compareDrivers` findings-fed vs findings-blind on one campaign → lift delta + paired-bootstrap CI.
- [ ] **A1.2 — Promotion-policy contract.** Extract the gate into a pluggable, versioned `PromotionPolicy` over the evidence *vector* (Pareto + per-dim significance + safety), default = the existing `defaultProductionGate`. Multiple policies registerable + benchmarkable. No scalar collapse.
- [ ] **A1.3 — Route the findings-loop write path through a policy.** agent-runtime `run-analyst-loop.ts` auto-apply flows through a substrate-exported policy instead of the bare confidence float. (Runtime calls down — no upward dep.)
- [ ] **A1.4 — MAST-typed findings.** `analyst/types.ts` `area:string` → a MAST-aligned enum reconciled with `FailureClass` (drop multi-agent-only modes). Counterfactual verification (extend `counterfactual.ts` → `verifyFindingCausally`) on a *sampled/triaged* subset, not every finding (frontier LLMs attribute <10% zero-shot — budget it).

### A2. More drivers *(fast wins; days each)*

- [ ] **A2.1 — ACE driver** (`src/campaign/drivers/ace.ts`): delta-structured append-mostly playbook (not `memory.ts` dedup); introduces the `playbook` `MutableSurface` kind (mutate/diff/apply). Forcing function: `compareDrivers` on AppWorld through the router on an **open model**, target ACE's 59.4% (DeepSeek-V3.1 = GPT-4.1 CUGA). *Gate:* CI'd vs gepa/memory on a 20-task slice. ~1wk.
- [ ] **A2.2 — `majorityVoteReward`** (`rl/verifiable-reward.ts`): TTRL consensus pseudo-labels over best-of-N fanout, **verifiable subset only** (tax by-line, AppWorld — out of scope for rubric domains), through `heldoutSignificance` + the reward-hacking guard. ~2–3d.

### A3. Execution-Environment seam *(the keystone; ~3–4 wks, staged, highest blast radius)*

The one-SUT precondition. Specced at `agent-spine.md:58`, never built (zero code refs). `src/loops` and `src/conversation` share zero code today (loop kernel lacks the journal/idempotency/circuit-breaker the conversation kernel has).

- [ ] **A3.1 — Define `ExecutionEnvironment`** (`agent-runtime/src/loops/execution-environment.ts`): `{ tools(), invoke(call), workspace, artifacts() }` with `WorkerEnv`/`SandboxEnv`/`DispatchEnv` impls. Additive; `runLoop` accepts an env, default preserves current path.
- [ ] **A3.2 — Route eval + benchmark + self-improve through it** (lowest-risk paths first). *Gate:* one AppWorld run and one self-improve campaign through the **same** `DispatchEnv` → identical `RunRecord` shape + trace correlation.
- [ ] **A3.3 — Lift the conversation kernel's distributed primitives** (`journal-sql.ts`/`turn-id.ts`/`call-policy.ts`) into the shared layer; migrate the conversation kernel **last**, behind a deletable shim once parity is proven.

---

## Track B — Research (months, uncertain). Flagship bets; must NOT block Track A.

- [ ] **B1 — Logprob-free causal step credit-assignment** (`rl/belief-delta.ts`): ΔP(success) via ablate-and-replay through the opaque `DispatchFn` (no logprobs — the regime everyone ships on; `process-reward.ts:29-33` concedes the gap). Publish a labeled attribution benchmark + leaderboard. *Risk:* replay non-determinism vs N; tool side-effects break replay. SOTA: AgenTracer (2509.03312).
- [ ] **B2 — Self-distilled small models** (offline): an RLM trace-analyst + a causal-attribution model trained on our corpus exhaust (traces + outcome truth + causally-verified MAST-typed findings). Removes the frontier-root-LM dependency → kills 0-findings brittleness at the root. *Gated on:* B1 producing enough labels + a data-governance/redaction story. SOTA: AgenTracer-8B beats Gemini-2.5-Pro +18%.
- [ ] **B3 — AZR self-play curriculum with a published anti-reward-hacking guarantee** (`drivers/proposer.ts`): a driver that *emits* scenarios, scored by learnability variance, gated by the reward-hacking detector + bootstrap-CI. The *guarantee* (non-collapse over cycles) is the research deliverable, not a mitigated risk. SOTA: Absolute Zero (2505.03335), TTRL.
- [ ] **B4 — Signature-structure search + analyst-self-schema-critique** (Invariant 2, layer c): a meta-driver that proposes signature/schema variants and benchmarks them; a "schema-fit" analyst kind that critiques the finding schema. Architecture search — expensive, discrete.
- [ ] **B5 — Trainable rubric reward models as product** (`rl/rubric-reward-export.ts`) + a Vertical Reward-Model leaderboard. Hypothesis: production-grounded GenRMs beat synthetic OOD. SOTA: GenRM (2410.12832).
- [ ] **B6 — Verified Vertical RL-Environment Exchange** (`exportVerifiersEnvironment`): wrap `MultiLayerVerifier` as a PrimeIntellect-verifiers Environment so every product agent auto-publishes a verified vertical RL env. *Blocked on legal/compliance for regulated traces (see Out of Scope).*

---

## Out of scope (now) — not an engineering sprint

- Reselling/open-weighting on regulated tax/legal traces: PII/privilege/consent/membership-inference. Legal + compliance gated. B2/B6 must train only on a redacted, consented, gold-ladder-admitted slice; the de-identification pipeline for financial/legal artifacts is itself unsolved.

## Research difficulty index

| Easy (days) | Medium (1–4 wks) | Hard / research (months) |
|---|---|---|
| A0.1✓ A0.2 A0.3 A0.5 A0.6 A2.1 A2.2 | A0.4 A0.7 A0.8 A1.* A3.* B5 | B1 B2 B3 B4 B6(+legal) |

## Verification discipline (every box)

Real e2e (mock only at process boundaries), name the regression each test catches, extend the existing suite, assert exact shapes/CIs, adversarial inputs, fail-loud. The `530b157_1` probe is the analyst-track instrument throughout; `compareDrivers`/`runProfileMatrix` is the CI forcing-function for every driver and the any-model parity gate.
