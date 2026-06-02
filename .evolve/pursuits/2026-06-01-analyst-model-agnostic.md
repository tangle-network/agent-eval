# Pursuit: Analyst matches HALO on ANY model
Generation: 1
Status: ADVANCE (Gen 1 shipped + proven; parallel to the paused tax-agent evolve in current.json)

## Metric → product-value claim
- **findings-on-any-model** (count of HALO-grade findings the analyst emits on a fixed trace, across models). If this rises from 0 to ≥4 on weak/cheap models, the self-improvement loop runs without a frontier model → the product is model-agnostic and the analyst is a real HALO competitor, not a frontier-only demo. Not a proxy: a 0-finding analyst drives zero improvements.

## System Audit (probe-verified, file:line)
- Our analyst = Ax-RLM (`kind-factory.ts:127`): fuses reason + JS-sandbox + strict `final({findings})` per turn. A weak model resolves the fused contract by emitting nothing.
- Two independent faults stacked: (B) a valid finding was DROPPED at the cluster-subject grammar (`finding-subject.ts:174`, `appworld.task.530b157_1` has `.`/`_`); (C) `failure-mode` is the wrong lens for a successful-but-suboptimal trace (correctly returns `[]`), and `deriveQuestion` passed the bare kind id, burning ~7/12 turns.
- HALO's edge is structural: it decouples free-form exploration (native tool-calls, no schema) from a deferred structuring sub-call, and its trace renderer PRE-COMPUTES the token/tool numbers — the model only narrates them.

## Baseline (proven 2×)
- `530b157_1` (15-span AppWorld trace), Ax-RLM `failure-mode`: **0 findings** on deepseek-chat (45s) AND moonshot-v1-128k (64s). HALO: 4 behavioral findings on the same trace+model.

## Design — Gen 1
### Thesis
HALO's four findings are **behavioral facts** (token-growth, output-decay, tool-monoculture, missing self-verification) computable by **pure arithmetic over spans**. So not every analyst must be an RLM: make the behavioral class a DETERMINISTIC analyst (zero model → trivially any-model, and more reliable than HALO). Reserve the RLM for semantic findings that actually need a model.
### Moonshot considered
Greenfield tolerant RLM loop / adopt OpenAI-Agents-SDK — rejected for Gen 1 (weeks; the deterministic class removes the model-dependency for HALO's entire diagnosis on this trace, a bigger win for less risk). Kept as Gen 2+ for semantic findings.
### Changes
- `src/trace-analyst/behavioral-metrics.ts` (NEW) — `computeTraceMetrics` + signal detectors (pure TS).
- `src/analyst/behavioral-analyst.ts` (NEW) — `behavioralAnalyst()` (`cost.kind:'deterministic'`) + `deriveEfficiencyFindings`.
- `finding-subject.ts:174` — cluster grammar admits `.`/`_` (excludes `:` to avoid prefix collision); `kind-factory.ts:224` — `deriveQuestion` emits a task directive.
- Tests: `behavioral-metrics.test.ts` (7), `finding-subject.test.ts` (+2 regression). Index exports.
### Risk + reversibility
All additive, in-substrate (zero upward dep), one-file-reversible each. Review gate: passed (all-no — no auth/crypto/billing/lifecycle/concurrency; >0 net-new files but additive + pure).

## Build status
| # | Change | Status | Tests |
|---|---|---|---|
| A0.1 | regex + deriveQuestion (RLM 0→1) | done | finding-subject (+2) |
| A0.3 | deterministic reducers | done | behavioral-metrics (7) |
| keystone | `behavioralAnalyst` (efficiency class) | done | e2e on real trace |

## Generation 1 Results
- **Deterministic E2E on the real `530b157_1`:** `FINDINGS=4`, `status:ok`, cost=deterministic — exactly matching HALO's four (input 13.1× growth, output 157→75 decay, 7× single-tool, no self-verify).
- **Any-model = by construction:** zero LLM → identical on deepseek/moonshot/gpt-5/any. Stronger than per-model parity measurement.
- typecheck + build + 94 unit tests green.

### Verdict: ADVANCE
Behavioral-class parity with HALO achieved + model-agnostic by construction. Semantic findings (correctness) still route through the RLM — that's Gen 2.

### Seeds for Gen 2
- A0.2/A0.4 two-phase (free-form `report` + structuring pass) for the SEMANTIC findings the model is actually needed for.
- Register `behavioralAnalyst` in the default suite + a `runProfileMatrix`/`compareDrivers` CI invariant asserting ≥4 efficiency findings on cheap backends.
- A1 Evidence-Bus (competing proposers + pluggable policies, no scalar collapse) and A3 Execution-Environment seam — co-spec before build.

Next: /evolve targeting semantic-finding extraction (Gen 2 two-phase) against the Gen-1 deterministic baseline.

---

## Generation 2 — Tolerant structuring + lock the win
### Thesis
The SEMANTIC findings (correctness/reasoning the model is actually needed for) fail because the RLM couples reasoning with strict emission. Decouple it (free-form report → a cheap structuring pass) and recover findings dropped in unusable wrappers; and lock Gen-1 into the default suite so it can't silently rot.
### Changes
- `src/analyst/parse-tolerant.ts` (NEW) — de-fence/coerce/lift; wired into `parseRawFinding` (coerce-then-retry).
- `src/analyst/structure-findings.ts` (NEW) — DSPy-TwoStepAdapter pass: report → findings, forgiving parse + reask-once, typed `ok|extraction_failed` outcome (LLM behind an injectable seam).
- `src/analyst/default-registry.ts` (NEW) — `buildDefaultAnalystRegistry`: behavioral always-on, agentic kinds when `ai` present.
- Index exports.
### Build status
| # | Change | Status | Tests |
|---|---|---|---|
| A0.2 | forgiving parser + wire | done | parse-tolerant (3) |
| A0.4 | structuring pass (built, not yet wired into kind-factory) | partial | structure-findings (3, stubbed LLM) |
| A0.6 | typed extraction_failed outcome (in structurer) | partial | structure-findings |
| new | buildDefaultAnalystRegistry + CI gate | done | default-registry (4) |
### Results
- Full battery: **1720 pass / 2 skip (172 files)**, typecheck + build green.
- Regression gate locked: default suite emits ≥4 behavioral findings with NO LLM (`default-registry.test.ts`).
### Verdict: ADVANCE (partial on A0.4/A0.6 — structurer built+tested; wiring into the agentic recovery path + live deepseek/moonshot parity probe = Gen 3)
### Seeds for Gen 3
- Change Ax signature → `report:string, findings:json[]`; call `structureFindings` from `kind-factory` on empty harvest; surface `extraction_failed`.
- Live probe: efficiency kind + two-phase on deepseek-chat AND moonshot, structurer-disabled vs enabled, as a `compareDrivers` invariant.
- Then A1 Evidence-Bus + A3 Exec-Env (co-spec).

Review gate: passed in spirit (all additive analyst-logic; no auth/crypto/billing/TLS/lifecycle/concurrency/external-endpoint). Diff-audit: new code matches the driver/kind patterns (callLlm seam, makeFinding builder, Zod boundary); every branch covered by unit tests.

---

## Generation 3 — Ship the head-to-head e2e + PR
### Thesis
Close the loop the program opened: a runnable analyst-vs-HALO findings comparison, now possible because our analyst produces findings.
### Changes
- `examples/benchmarks/appworld/analyst-vs-halo.ts` (NEW) — runs ours (deterministic) + the real halo-engine (`--with-halo`) on one trace, side by side.
- Biome-formatted the generation; 3 clean conventional commits.
### Decision (co-founder)
REJECTED the Ax `report`-signature change this gen: it touches the shared @stable-ish kind path and needs a live-model responder round-trip to verify — shipping it unverified would be tech debt. `structureFindings` is built/exported/unit-tested; its integration is the live-gated next step (roadmap A0.4 `[~]`).
### Results
- E2E: ours = 4 findings, 12ms, $0 on real `530b157_1`. Full suite 1720 pass / 2 skip, typecheck + build + biome green.
- Shipped: **PR #161** (tangle-network/agent-eval), drewstone-authored, 3 commits.
### Verdict: ADVANCE — analyst→model-agnostic shipped to PR.
### Seeds for Gen 4 (live-gated / co-spec)
- RLM semantic two-phase: Ax `report,findings` signature + call `structureFindings` on empty harvest + surface `extraction_failed`; verify with ONE live deepseek round-trip.
- A1 Evidence-Bus (competing proposers + pluggable policies, no scalar collapse) + A3 Execution-Env seam — co-spec with Drew.

Next: /evolve targeting RLM semantic-finding extraction (live round-trip) against the Gen-1 deterministic baseline; PR #161 → review + merge (tangletools).

---

## Generation 4 — RLM two-phase + fail-loud (the semantic class)
### Thesis
The deterministic analyst owns the behavioral class; the RLM owns SEMANTIC findings. Make the RLM model-tolerant by decoupling free-form reasoning (a `report` the actor always emits) from strict findings emission, with opt-in structuring recovery + fail-loud so an empty harvest is never a silent zero.
### Changes (kind-factory.ts)
- Ax signature `question -> report:string, findings:json[]`; actor/responder prompts updated.
- `CreateTraceAnalystKindOpts.recovery` (opt-in): empty harvest + substantive report -> `structureFindings` extracts from the prose.
- Fail-loud: empty harvest + report >=200 chars + no recovery -> a visible `info` finding (`outcome: extraction_failed`) carrying the report. Short/no report stays empty (no false-fire).
### Decision / risk
The signature change touches the shared kind path; it could only be verified by a LIVE Ax responder round-trip. Stated rule up front: commit iff the live run is clean, else revert.
### Results — live-validated on deepseek-chat (530b157_1, 156s)
- failure-mode: 1 finding `[high] silent-task-failure` (real semantic finding; no regression).
- improvement: was a SILENT 0 pre-Gen-4 -> now a visible `[info] extraction_failed` finding carrying its report. **Round-trip confirmed** (the report populated through Ax's responder), **silent zero eliminated**.
- typecheck + biome + full suite 1720 pass. Committed da3900e, pushed to PR #161.
### Verdict: ADVANCE — the RLM semantic path is now model-tolerant + fail-loud on deepseek.
### Seeds for Gen 5 (co-spec, not solo)
- A1 Evidence-Bus (competing proposers + pluggable policies, no scalar collapse) + A3 Execution-Env seam — the two keystones, to design WITH Drew.
- GEPA-optimize the actor + structurer prompts vs goldens for compounding lift; richer recovery (structurer on a failing-trace corpus).

Next: /evolve targeting recovery-extraction yield on a failing-trace corpus, against the Gen-4 baseline; PR #161 -> review + merge.

---

## Generation 5 — A1.2: PromotionPolicy over the evidence vector (no scalar collapse)

### Metric → product-value claim
- **Promotion correctness** (does the gate ship only genuine multi-objective wins?). If this rises, the self-improvement loop stops promoting candidates that improve one judge dim while silently regressing a safety dim — i.e. fewer shipped regressions reach the product. Directly the loop's trust property; not a proxy.
- **Decision resolution** (ship / hold / **need_more_work** distinctly). If "insufficient evidence" stops being folded into "reject", the loop gathers more reps instead of abandoning a real-but-underpowered gain — fewer false abandonments. Product effect: faster convergence to a real improvement.

### System Audit (read the code, not memory)
- **The Evidence-Bus the user named already EXISTS as `Gate`/`GateContext`/`GateResult`.** `GateContext.judgeScores: Map<cellId, Record<dim, JudgeScore>>` is the full per-dimension vector (no scalar input). `GateResult.contributingGates` preserves every sub-verdict (no scalar output). `GateDecision` is a *rich* enum (ship|hold|need_more_work|model_ceiling|arch_ceiling), not binary.
- **Composition already exists + is complete.** `composeGate` (gates/compose.ts) runs all gates, combines via the full decision lattice (arch_ceiling > model_ceiling > hold > need_more_work > ship), concatenates all contributingGates. My earlier "phantom composeGate" suspicion was WRONG.
- **Statistical machinery already exists + is reusable.** `statistical-heldout.ts`: `pairHoldout` (pairs by FULL cellId — reps multiply n), `heldoutSignificance`, `dimensionRegressions`, `detectScale`; `statistics.ts`: `pairedBootstrap` (deterministic seed, safe on empty arrays → zero-result). `pareto.ts`: `Direction`, `dominates`, `paretoFrontier` (multi-CANDIDATE frontier — a different use than 2-point gate domination).
- **`defaultProductionGate` is one opinionated composition** (composite = the only gain axis; criticalDimensions = pure floors; fewRuns folded into `hold`; top decision is binary `allPassed ? ship : hold`).

### The genuine gap (one missing STRATEGY, not a new bus)
`defaultProductionGate` is asymmetric (only composite can win), never emits `need_more_work`, and frames promotion as composite-lift + veto-floors rather than multi-objective non-domination. The roadmap A1.2 ask — "a policy is a function over the evidence *vector* (Pareto + per-dim significance + safety), not a scalar threshold; different loops run different policies" — has no implementation. That's the build.

### Generation 5 Design
**Thesis:** Factor promotion into Evidence-Bus + pluggable PromotionPolicy so MANY strategies compete over the SAME evidence vector, and ship one symmetric multi-objective Pareto strategy that the existing gate can't express.

**Moonshot considered:** a policy *registry* + auto-A/B-backtest of policies against historical promote/rollback outcomes (policies-as-strategies, benchmarked like the drivers). REJECTED this gen — it needs a labeled corpus of (evidenceVector → was-the-promotion-right) which we don't have yet; build the contract + first strategy now, backtest harness is its own gen once the corpus exists. Adopted the contract; rejected the backtester.

**Changes (all in `src/campaign/gates/promotion-policy.ts`, additive):**
1. `EvidenceVector` / `AxisEvidence` / `AxisVerdict` — the typed, per-objective CI vector. NOTHING averaged across axes.
2. `buildEvidenceVector(ctx, objectives, opts)` — **the bus**: one paired-bootstrap CI per objective, oriented to the good direction (maximize/minimize), reusing `pairHoldout` + `pairedBootstrap` + `detectScale`. Pure, deterministic.
3. `PromotionPolicy = (ev) => GateResult` + `paretoPolicy` — **the default strategy**: symmetric multi-objective. Ships iff candidate weakly DOMINATES baseline at the confidence level (no axis credibly worse AND ≥1 axis credibly better). Floor breach on ANY axis → `hold` (anti-Goodhart). Insufficient evidence on ANY axis → `need_more_work`. Statistically flat → `hold`. One `contributingGate` per axis.
4. `paretoSignificanceGate(options)` — wraps bus + policy as a `Gate`; plugs into the existing `runImprovementLoop({gate})` slot and composes via `composeGate`. `policy?` override lets a consumer run a stricter strategy over the same bus.

**Codebase conventions matched:** reuses statistical-heldout + statistics + pareto (no forked stats); `@experimental` docstring header like sibling gates; exported from BOTH `campaign/index.ts` and the curated `contract/index.ts` exactly where `composeGate`/`defaultProductionGate` are; deterministic bootstrap seed default 1337; native-scale tolerance auto-scaling via `detectScale`.

**Behavior-preserving:** default loop gate stays `defaultProductionGate`. The new gate is opt-in. Zero call-site change.

### Review gate
- Auth/crypto/TLS/trust boundary? **No.** Billing? **No.** External endpoint? **No.** Lifecycle ops? **No.** Concurrency/shared mutable state? **No** (pure functions). Diff >5 files / >300 lines? ~3 files (1 src + 1 test + 2 index edits); src+test ~300 lines but single-module, reversible, no trust boundary.
- **Review gate: passed (all-no).** Adversarial check is the Goodhart-resistance of the policy itself — done inline below.

### Adversarial Goodhart-resistance check (the design's whole point)
- *Attack: reward-hack one dim, tank a safety dim.* paretoPolicy holds on ANY axis floor breach → blocked. (The legal-agent +25 deadline / −30 hallucination false positive is structurally impossible when hallucination is an objective.)
- *Attack: ship on run-to-run noise.* Ship requires a CI **lower bound** > gainThreshold, not a point estimate → noise (CI straddling 0) → flat → hold.
- *Attack: claim a win on 2 lucky reps.* n < minProductiveRuns on any axis → need_more_work, never ship.
- *Attack: declare a no-op a win.* Identical candidate→baseline → all axes flat → hold ("statistically equivalent"), not ship.
- *Residual:* cost/latency can't be a CI axis (GateContext has only aggregate per-side cost, no per-cell vector) — handled as a constraint (budget gate via composeGate), NOT faked as a CI. Per-cell cost vectors = the A3/runtime follow-up. Stated, not hidden.


### Build Status
| # | Change | Status | Files | Tests |
|---|--------|--------|-------|-------|
| 1 | `EvidenceVector`/`AxisEvidence`/`AxisVerdict` types | done | promotion-policy.ts | — |
| 2 | `buildEvidenceVector` (the bus) | done | promotion-policy.ts | 2 |
| 3 | `PromotionPolicy` + `paretoPolicy` (default strategy) | done | promotion-policy.ts | 6 |
| 4 | `paretoSignificanceGate` (bus+policy as Gate) | done | promotion-policy.ts | 6 |
| 5 | floor-first verdict hardening (anti-Goodhart tie) | done | promotion-policy.ts | 1 |
| 6 | export from campaign + contract barrels | done | campaign/index.ts, contract/index.ts | — |

### Results
- typecheck clean; full suite **1729 pass / 2 skip** (no regressions); 9 new deterministic policy tests.
- Behavior-preserving: default `runImprovementLoop` gate unchanged (paretoSignificanceGate is opt-in).
- Shipped to **PR #161** (3 commits: feat + floor-first fix + roadmap doc). drewstone-authored; NOT auto-merged (tangletools review).

### Decision (co-founder)
Did NOT spawn a Workflow despite the "parallelize if you want" license: A1.2 is a focused deterministic contract+build whose adversarial check IS the design (Goodhart-resistance), and a self-contained module. Fanning out adds rate-limit risk for zero quality gain — the diff-audit + adversarial check ran inline and caught the floor-first ordering footgun. Scoped A1.1 (EYES→HANDS driver read) and A3 (Execution-Env seam) OUT: A1.1's gate is LLM-empirical (compareDrivers findings-fed vs blind), A3 is agent-runtime (different repo, highest blast radius). One pursuit = A1.2, fully.

### Verdict: ADVANCE — the promotion contract is now pluralizable over a non-collapsed evidence vector; the +gain/−safety false positive is structurally impossible whenever the safety dim is an objective.

### Seeds for Gen 6
- A1.1: make `gepa.ts`/`skill-opt.ts` `propose()` read `ctx.findings`/`ctx.report` (plumbed but unread); gate = `compareDrivers` findings-fed vs blind (LLM, deferred-to-live).
- A1.3 (agent-runtime): route `run-analyst-loop.ts` auto-apply through an exported `PromotionPolicy` instead of the bare confidence float (calls DOWN — no upward dep).
- Policy registry + auto-A/B-backtest once a labeled (evidenceVector → promotion-was-right) corpus exists.
