# `runCampaign` v1.0 — Anthropic Self-Improvement Lens Audit

Reviewer: research scientist hat, RLAIF / Constitutional AI / scalable oversight prior.
Doc: `docs/design/runcampaign-1.0.md` (draft v4, 2026-05-25, 244 lines).
Substrate snapshot read: `contamination-guard.ts`, `held-out-gate.ts`, `production-loop.ts`, `active-learning.ts`, `judge-calibration.ts`, `muffled-gate-scanner.ts`, `red-team.ts`, `reward-model-export.ts`, `src/rl/` (dir present).

---

## Self-improvement research-grade: **4.5 / 10**

A solid productized loop (DSPy/GEPA-style prompt search + held-out gate + auto-PR) sitting on legitimately good substrate (paired bootstrap, Wilcoxon, calibration, ICC(2,1), contamination canaries). But the **design doc itself** materially under-specifies the things that decide whether a closed loop self-improves or self-Goodharts: split discipline, judge drift, mutation diversity, lineage, and meta-monitoring. The substrate has many of the right pieces (`HoldoutAuditor`, `ContaminationGuard`, `judge-calibration`, `muffled-gate-scanner`, `red-team`), but **none of them are referenced in `runCampaign`'s option surface**. The doc treats them as off-stage utilities. In a self-improvement system, those are first-class invariants. Hiding them behind "the consumer wires it up if they want" is exactly how RLHF pipelines silently overfit reward models.

The auto-`config` shape (mutate live production from production-trace-derived candidates with no human in the loop) is the part that would not pass an Anthropic safety review as drawn.

---

## TL;DR

- The loop **closes** in the engineering sense (trace → label → mutate → judge → gate → ship). It does **not** close in the safety sense (no judge-drift detector, no specification-gaming probe in the gate, no provenance chain on the live config).
- `LabeledScenarioStore` as drawn is a **train/test leak by default**. Same store sources `optimizer.scenarios` (training signal) and is the same population the gate's held-out is sampled from. The substrate has `HoldoutAuditor`, but the doc never invokes it.
- `Mutator` is hand-waved. "Reflective | `runMultiShotOptimization` | `AxGEPA` | custom" is a plugin point, not a strategy. There is no diversity floor, no novelty constraint, no anti-collusion check between mutator and judge.
- `autoOnPromote: 'config'` (mutate live production with no human) is the single highest-risk decision in the design. There is no canary rollout, no shadow-deploy comparison, no rollback predicate, no rate limit on prompt churn, no behavioral-diff floor. Anthropic would not ship this shape against an actual user-facing model without all five.
- Judges in this design are **also the reward model**. There is no second-opinion (debate, juror, human), no calibration drift detector tied into the gate, no `judge_promotion` gate. The mutator can — and will — find prompts that boost the judge without improving users.
- No story for **substrate-evaluating-the-substrate**. The mutator, judge, and gate are not themselves under evaluation. The "substrate's substrate is immutable" failure mode is real.

---

## Per-question scores

### 1. Loop sufficiency — **6/10**

The engineering loop closes. The research loop does not.

**Present** (in substrate, not always in the doc):
- Trace capture (`FileSystemTraceStore`, OTEL).
- Labeled-scenario accumulation (the doc says so; the actual data structure isn't sketched — what's a "label"? human? judge? auto-derived?).
- Mutator → candidate population → judge → gate → ship.
- `HeldOutGate` does paired-delta bootstrap on a true holdout split (`held-out-gate.ts:128`). This part is genuinely good.

**Missing primitives that an actual self-improvement system needs**:

| Primitive | Why it matters | Where in this design |
|---|---|---|
| **Judge drift detector** | Judges shift over LLM versions, prompt-wording tweaks, calibration set rot. Without recalibration, gate decisions become meaningless. | Absent. `judge-calibration.ts` exists but is not wired into `runCampaign`. |
| **Mutation diversity floor** | Mutators collapse onto a single attractor (the "verbose chain-of-thought" attractor, the "be more confident" attractor, etc.). | Absent. Population size is the only knob. |
| **Specification-gaming probe** | Detect candidates that boost judge score without boosting independent quality signals (a fresh judge, a behavioral probe, a user-feedback proxy). | Absent. |
| **Counterfactual / negative-control candidates** | Inject a known-bad mutation each generation; if the gate promotes it, the gate is broken. | Absent. |
| **Lineage / provenance chain** | Version 47 of the prompt should be a DAG node with parents = (mutator hash, generation, parent prompt, judge versions used, scenarios used, gate evidence). | Doc has none. Substrate doesn't expose it. |
| **Rate limit on prompt churn** | A loop that ships every cycle introduces variance the user feels. | Absent. |
| **Held-out scenario rotation** | A static holdout becomes a training set over many cycles (the "holdout you keep looking at" pathology). | Absent. |

The doc claims "the substrate IS the product surface" and "the flywheel: more interactions → better profile → more interactions". The flywheel direction is **not guaranteed monotonic**. It is only monotonic with all the primitives above. Without them, the most likely steady state is: judge-overfit prompt that scores 0.92 on internal judges and bores users.

### 2. Train/test contamination — **3/10**

**This is the most serious finding.**

The doc literally says (line 91–95):

> **Data accumulation (default on)** — Where labeled scenarios accumulate. Every artifact + score lands here, available as default scenarios source for the next `runCampaign` invocation. FS adapter for local, Turso for multi-tenant. Off only via `labeledStore: 'off'`.

And the example at line 128:

```ts
scenarios: labeledStore.sample({ count: 30, split: 'train' }),
// ...
gate: composeGate(heldOutGate({ holdoutScenarios }), ...)
```

`holdoutScenarios` materializes out of thin air. There is no API contract that says "the holdout MUST come from a partition disjoint from `labeledStore.sample({split:'train'})`". There is no canary token enforcement at the campaign boundary. There is no temporal split (the obvious safe default: train on data older than T, holdout on data newer than T).

The substrate **has** the right tool — `HoldoutAuditor` in `contamination-guard.ts` wraps a dataset and throws unless callers declare `purpose: 'evaluation'`. **It is never referenced in the design doc and not wired into `runCampaign.options`.** That's a tell. The right abstraction exists and got left in the basement.

**Concrete leak vectors with this design as drawn**:

1. **Implicit split leakage.** A scenario captured from a user trace gets labeled (by judge? by human?) and goes into the store. The next campaign uses `split: 'train'` for the mutator and `split: 'holdout'` for the gate. Nothing prevents the same scenario family (same persona, same root cause) from being in both splits. RLHF literature has hammered this for years (Christiano 2017; Stiennon 2020; Bai 2022 RLAIF appendix on split discipline).
2. **Reward-hacking signal in labels.** If the judge labels are accumulated in the store and the judge later scores candidates against those same scenarios, the optimizer is fitting to its own past mistakes. (DPO/RLAIF papers explicitly warn against this — the policy will collapse onto the reward model's failure modes.)
3. **Held-out exhaustion.** Repeatedly running campaigns against the same `holdoutScenarios` slowly turns it into a training set. After ~20 generations on the same holdout, the gate is rubber-stamping. There is no rotation, no "holdout is single-use per candidate family", no honest re-sampling.
4. **Canary tokens not enforced at write.** `checkCanaries` exists; nothing in `runCampaign` calls it on every artifact going into the store. If a memorized canary lands in the store, future training pulls it in.

**What the doc needed to ship in v1.0**:

- Typed `Split = 'train' | 'holdout' | 'canary' | 'quarantine'`, with the store API requiring a write-time declaration and forbidding cross-split reads in a single campaign without explicit `crossSplit: 'I-know-what-I-am-doing'`.
- Temporal split by default: scenarios get `capturedAt`; holdouts are the most-recent slice.
- Mandatory canary check on every store write (statistical canaries from `contamination-guard.ts`).
- Per-(mutator-family, holdout) staleness counter; gate refuses to run when (count > N) → triggers holdout re-roll.

### 3. GEPA reality check — **4/10**

The doc names three mutators as plug-points:

- "reflective" (no citation)
- `runMultiShotOptimization` (existing repo code)
- `AxGEPA` from `@ax-llm/ax`

**This is plumbing, not a mutation strategy.** Real prompt optimization research (DSPy MIPRO; Khattab et al. 2024; GEPA paper Agarwal et al. 2024; PromptBreeder Fernando et al. 2023) is **not** "call a mutator N times and rank by score". It's:

1. **Bootstrapped few-shot demonstrations** (DSPy's compile step) — find candidate demos from the trace store with high-quality trajectories, not just text mutations.
2. **Reflective updates with structured feedback** — GEPA's reflective optimizer uses *the judge's natural-language critique* as the mutation signal, not just the scalar. The doc has no contract for the judge to emit critique-as-mutation-signal.
3. **Pareto frontier maintenance over multiple objectives** (cost, latency, quality, refusal rate). The design has a single-objective gate (paired delta on quality score). GEPA-style multi-objective Pareto selection is the whole point.
4. **Population-diversity preservation** — explicit novelty constraints (BLEU distance, embedding distance, behavioral diversity on a probe set). PromptBreeder uses *direct novelty mutation operators* (paraphrase, distill, lamarckian). None of this is in the contract.
5. **Trajectory-level optimization, not just system-prompt level** — production agents have multi-step trajectories; GEPA optimizes per-step. The doc's `surfaceExtractor: (profile) => MutableSurface` is single-surface.

**The `AxGEPA` reference is doing a lot of work.** I do not know what `@ax-llm/ax`'s GEPA implementation actually does — but the doc treats it as a drop-in. If `@ax-llm/ax`'s implementation diverges from the published GEPA algorithm (or implements a subset), the design has imported a black box. There's no contract spec that `AxGEPA` and `runMultiShotOptimization` must obey to be interchangeable. They will silently produce different results, and consumers swapping mutators will see "regressions" that are actually different algorithms.

What the design needed: a `Mutator` interface that spells out **what a mutator must guarantee** — diversity, novelty, reflective signal, multi-objective awareness. Then "GEPA" and "Ax" become *instances* with verifiable properties, not opaque plugins.

### 4. Distribution shift — **2/10**

The doc has **no story** for distribution shift. It is the single most consequential omission for a system that runs continuously.

Production distributions shift on every axis: user mix, regulatory environment (the production-loop.ts comment literally says "yesterday's regulation flips today"), model upgrades on the dispatch side, judge model upgrades on the scoring side, seasonal load patterns. The substrate accumulates a `LabeledScenarioStore` that, by month 6, is dominated by scenarios from months 1–4. The optimizer trains on stale data and the gate evaluates on a stale holdout. **The "flywheel" can be a death spiral if the holdout drifts.**

The substrate has *one* relevant primitive (`failureClusterView` in `production-loop.ts`) that detects emergent failure modes — but that's failure-class drift, not input-distribution drift. There is no:

- KL-divergence / population-stability-index (PSI) check between current production input distribution and `labeledStore.sample({split:'train'})`.
- Embedding-shift detector on user inputs over time.
- Time-decay weighting on the labeled store (older = lower sample probability).
- Holdout refresh policy keyed to drift signal.
- Concept-drift literature is rich (Gama et al. 2014 *Survey on concept drift adaptation*; Lu et al. 2018) and the design references none of it.

**Worst case**: a v47-promoted prompt is evaluated against a holdout collected when the product launched. The product's user base has since shifted entirely. The gate says "ship". Real users get worse.

### 5. Reward hacking surveillance — **2/10**

Almost nothing. The substrate has `judge-calibration.ts` (good!) and `red-team.ts` (good!), but **the gate does not consult either by default**.

A real reward-hacking surveillance layer in a self-improvement system needs:

1. **Independent juror judges** — at least two judges (different model families, different rubrics) where gate promotion requires *both* to agree above threshold. The doc allows multiple judges but doesn't require diversity, doesn't require agreement, doesn't penalize judges that always agree (collusion).
2. **Spec-gaming probe** — every Nth generation, inject deliberately-overfit candidates ("be longer", "be more confident", "claim more sources") and verify the gate rejects them. Like a unit test for the gate.
3. **Behavioral diff floor** — promoted candidates must differ from baseline by at least δ on a behavioral probe set (red-team battery; refusal rate; tool-use distribution). If a candidate scores higher with no behavioral difference, that's pure judge-hacking.
4. **Refusal-rate guardrail** — `red-team.ts` exists with a 40-case battery. The gate should require: red-team pass rate of promoted candidate ≥ baseline pass rate. Currently it doesn't.
5. **Counterfactual audit** — for each promoted candidate, hold it out from training and verify it still wins on a forward-collected production sample. (Online A/B with bandits, not the static holdout.)

The most concrete reward-hacking attack against this design: a mutator finds a system-prompt suffix like "End every response with a confident summary and cite three sources". This trivially boosts most LLM-judge rubrics (confidence + citations are weighted positively). Users get hallucinated citations. The gate promotes. The flywheel ships hallucinations.

**`muffled-gate-scanner.ts` is good defensive engineering** (catches silent-pass patterns at the *test* layer). It is not reward-hacking surveillance. It's a different category of safety net.

### 6. Online learning vs eval separation — **2/10**

`autoOnPromote: 'config'` is the danger zone. The doc treats it as symmetric to `autoOnPromote: 'pr'`. They are categorically different.

**`pr`** = a human review gates the live config change. This is recoverable, observable, attributable, reversible.

**`config`** = the loop writes the live agent config row when the gate decides ship. This is autonomous online learning against real users. From the doc:

```ts
runCampaign({
  scenarios: labeledStore.sample({ count: 20, split: 'train' }),
  // ...
  optimizer: { mutator: gepaMutator, populationSize: 4, maxGenerations: 3 },
  gate: composeGate(heldOutGate, conservativeCostGate(5)),
  autoOnPromote: 'config',
  costCeiling: 5,
  // ...
})
```

`conservativeCostGate(5)` — five dollars — is the only thing between "candidate prompt found by GEPA" and "production agent serves real users with that prompt". No canary cohort, no shadow deploy, no holdback group, no rollback predicate, no fleet-wide blast-radius limit, no rate cap on prompt updates per day, no human notification.

The Anthropic norm is **never** to update a production policy from evaluation-derived data without an independent verification layer. This is exactly why Constitutional AI uses a separate constitution-driven SL phase before RLAIF; why scalable-oversight work emphasizes debate / amplification with humans on the slow path; why RLHF papers use frozen reward models and separate validation. **Co-mingling the train set and the live policy via auto-config is the failure mode of the entire research program.**

Concrete minimum bar for `autoOnPromote: 'config'` to be safe:

- Shadow deploy: promoted candidate runs in parallel on T% of traffic for K hours; live comparison; promote only if observed user metrics (not judge scores) hold.
- Per-tenant blast-radius limit: max one prompt change per tenant per day.
- Rollback predicate: any of {error rate spike, user-feedback negative spike, red-team regression} reverts to baseline within minutes.
- Human notification + 24h cooldown override on every promote.
- Cryptographic chain of custody: the config row stores (mutator hash, generation seed, parent prompt hash, judge ensemble hashes, gate evidence hash). Reproducible.

None of this is in v1.0.

### 7. Auditability — **3/10**

The doc says "every artifact + score lands [in the store]". That's not the same as a lineage chain.

For version 47 of a system prompt, I want to be able to query:

- What was the parent prompt (v46) and its hash?
- Which mutator (algorithm + version + seed) produced v47?
- Which scenarios were used as the training signal for v47?
- Which scenarios were used as the holdout?
- Which judges (model + rubric version + calibration vintage) scored it?
- What was the gate evidence (paired delta, CI, p-value, overfit gap)?
- Who/what triggered the campaign? (cron? failure-cluster threshold? manual?)
- Was a human reviewer in the loop?
- What was the rollback predicate? Did it fire?

The substrate has *partial* support — `RunRecord` carries `experimentId`, `seed`, `candidateId`, `splitTag`; `GateDecision` carries `evidence` (good!); `HeldOutGate` keeps the full numbers. But **there is no `PromptLineage` first-class object** that chains v47 → v46 → v45 with these fields as immutable links. Production teams that ship v50 can't easily answer "show me the chain that got us here".

`auto-pr.ts` (16KB) appears to handle PR-form promotion. PRs *are* a form of lineage (the commit DAG). But `autoOnPromote: 'config'` bypasses the commit DAG. No git history = no audit trail.

### 8. Substrate-evaluates-substrate — **1/10**

Nothing.

The mutator, judge, and gate are not themselves evaluated by the substrate. They are wired in by consumers and run forever without any drift / regression / calibration audit. The doc has a section called "What is NOT in v1.0" that proudly says:

> No new contracts beyond `Scenario` / `DispatchFn` / `JudgeConfig` (0.38).

This is the wrong framing for a self-improvement system. The right framing is: **the substrate's substrate must itself self-improve**. Specifically:

- **Judge calibration must re-run on a cadence.** `judge-calibration.ts` exists with κ, Pearson, ICC(2,1), MAE, bias probes — none of it is scheduled, gate-blocking, or reported.
- **Mutator quality must be tracked**. Mean improvement per generation, diversity per population, ratio of accepted vs rejected candidates. A mutator whose acceptance rate drops to 1% over 6 months is a dead mutator and the system should know.
- **Gate calibration must be audited**. False-promote rate (promoted prompt later rolled back) and false-reject rate (rejected prompt that would've helped) tracked over time. Without this, the gate's thresholds are voodoo.
- **Meta-evaluation across products**. With 5 products on the same substrate, the substrate should aggregate: "products with this mutator config converge in N cycles; products with this gate config promote K% per cycle; this judge family shows positional bias of 0.12". This is the highest-leverage signal in the entire design and it's nowhere in the doc.

Compare to Constitutional AI: the *constitution* is a versioned, auditable artifact. The *critic prompt* is a versioned, auditable artifact. The *training recipe* is a versioned, auditable artifact. All three are themselves evaluated and iterated.

### 9. Goodhart / specification gaming — **3/10**

Aggregating from the above: the design has weak protection against specification gaming, and the protections that exist (red-team battery, calibration helpers, contamination canaries, muffled-gate scanner) are off the critical path of `runCampaign`. A product team can configure a `runCampaign` with `autoOnPromote: 'config'` and have **zero** of these protections engaged.

Goodhart's law explicitly: "When a measure becomes a target, it ceases to be a good measure" (Goodhart 1975; Manheim & Garrabrant 2018 *Categorizing variants of Goodhart's law*). The four variants — regressional, extremal, causal, adversarial — all bite this design:

- **Regressional Goodhart**: judges have noise; selecting top-K candidates by judge score regresses to "candidates that exploit judge noise".
- **Extremal**: the further the optimizer pushes, the more out-of-distribution the candidate prompts get for the judge.
- **Causal**: judge scores may correlate with quality on the training distribution but not cause it on the production distribution.
- **Adversarial**: the mutator is literally an adversary against the judge.

The standard mitigations (KL penalty against baseline; ensemble disagreement; trust region; human-in-the-loop on outliers; out-of-distribution detection on candidate prompts) are absent from the design surface.

### 10. Comparison to published research — **4/10**

Where this sits on the actual self-improvement spectrum:

| Reference | What they do | Where v1.0 stands |
|---|---|---|
| **RLHF** (Christiano 2017; Ouyang 2022 InstructGPT) | Frozen reward model, KL penalty, separate validation, human preference data. | v1.0 = no KL penalty, no human preference loop, judges aren't frozen, no validation/holdout discipline enforced. **Below.** |
| **RLAIF** (Bai 2022 *Constitutional AI*; Lee 2023 *RLAIF*) | AI feedback for scale, but anchored to a versioned constitution; explicit separation of supervised + RL phases; explicit harm probes. | v1.0 has no constitution, no harm probe in the gate, no phase separation. **Below.** |
| **Self-Refine** (Madaan 2023) | LLM critiques its own output, iterates. Single-turn. | v1.0 is structurally similar at the per-turn level but adds population search. Comparable scope at single-shot; weaker overall. |
| **STaR / Self-Taught Reasoner** (Zelikman 2022) | Bootstrap CoT data from model itself, fine-tune. | v1.0 doesn't fine-tune; lives at prompt layer. Different scope. |
| **DSPy / MIPRO** (Khattab 2024) | Compiler-style prompt optimization with bootstrapped demos and multi-stage signature search. | v1.0's optimizer field is roughly *aspires to* DSPy but the contract is much thinner — no demos, no signatures, no compiler. **Below.** |
| **GEPA** (Agarwal 2024) | Reflective optimization with critique-as-signal, Pareto frontier. | v1.0 cites GEPA as a *plugin*, not a property the substrate guarantees. Strictly weaker. |
| **PromptBreeder** (Fernando 2023) | Evolutionary, explicit novelty/diversity ops, mutation-of-mutation. | v1.0 has populations but no diversity ops, no mutation-of-mutation. **Below.** |
| **Debate / Scalable Oversight** (Irving 2018; Khan 2024) | Two adversarial models + a (weaker) judge; correctness via debate. | v1.0 has no debate, no adversarial pairing of candidates against the judge. Absent. |
| **Process Reward Models** (Lightman 2023 *Let's Verify Step by Step*) | Reward per step, not per outcome. | v1.0 has `src/prm/` (good!) but `runCampaign` doesn't expose process-level scoring on the optimizer surface. Underused. |
| **OpenAI o1 / o3 RL** | RL on chain-of-thought against verifiable rewards. | Different regime (model training, not prompt opt). N/A directly, but the *discipline* (verifiable rewards, not LLM-judged rewards, for high-stakes signals) is precisely what this design lacks. |
| **DeepMind FunSearch / AlphaEvolve** (2023/2024) | Evolutionary code generation with *external verifier* (not LLM judge). | v1.0 has LLM judges as the only verifier. FunSearch's lesson — external verification or you'll hack the judge — is unheeded. |
| **Anthropic Sleeper Agents / Sycophancy** (Hubinger 2024; Sharma 2023) | Documented failure modes of RLHF — backdoors survive safety training; sycophancy is rewarded by LLM judges. | v1.0 has no defenses against either; no sycophancy probe in the gate, no backdoor detection. |

**Honest placement**: v1.0 is a **productization of GEPA/DSPy-style prompt optimization** with a thin held-out gate and an auto-deploy hook. It's not at the research frontier; it's not even at the published-best-practice frontier (DSPy MIPRO with multi-objective Pareto). It's roughly at the level of "prompt evolution scripts circa 2023, but well-engineered".

**This is not a criticism of the engineering** — the engineering is good. The criticism is the doc's framing ("we've built every primitive a self-improving agent product needs") materially overstates the maturity of the self-improvement story.

---

## What this would need to be Anthropic-research-grade

A v1.0 that I would defend in a research-meeting review:

1. **Typed splits, enforced at the API.** `LabeledScenarioStore.write({scenario, label, split: 'train'|'holdout'|'canary'|'quarantine', capturedAt})`. Reads of two splits in the same campaign require an explicit flag. Holdout reads are wrapped in `HoldoutAuditor`. Temporal split is the default (most-recent N% is holdout). Canary tokens checked on every write.
2. **Judge ensemble required for promotion.** Gate requires ≥2 judges from different model families, requires inter-judge agreement above κ ≥ 0.6 on a fresh calibration set, fails closed when agreement drops.
3. **First-class `Lineage` object.** Every promoted artifact has an immutable lineage record: parent hash, mutator (id+version+seed), training scenarios (content-addressed), holdout scenarios, judge versions, gate evidence, promotion timestamp, promoter (human or automation), rollback predicate. Stored in a content-addressed log.
4. **Drift detection layer.** Per-product, scheduled: PSI on input distribution, embedding shift on user content, judge re-calibration on golden set, holdout staleness counter. Gate refuses to run on stale calibration / stale holdout.
5. **Specification-gaming probe in the gate.** Every K generations, inject a `negative-control mutator` that emits known-bad candidates ("verbose", "overly-confident", "always-confident-citation"); gate must reject them. Failure pages an oncall.
6. **Diversity floor in optimizer contract.** Mutator interface requires returning N candidates with min pairwise embedding distance ≥ δ. Or: gate rejects populations where top-K candidates are all near-duplicates.
7. **Behavioral-diff floor in gate.** Promote only when (a) judge delta clears threshold AND (b) red-team pass rate ≥ baseline AND (c) refusal-rate-on-probe-set within ±ε of baseline AND (d) behavioral diff on probe set ≥ δ (no-op candidates can't promote).
8. **Shadow / canary deploy for `autoOnPromote: 'config'`.** Live promotion runs on T% of traffic for K hours with rollback predicate. Block promotion if anything regresses on user-side metrics (not judge-side).
9. **Meta-evaluation suite.** Substrate self-evaluates: mutator-acceptance-rate, false-promote-rate, judge-drift-rate, gate-rejection-distribution. Cross-product roll-up.
10. **Process-reward bridge.** `src/prm/` exists; expose it on `runCampaign.optimizer.signal: 'outcome' | 'process'`. Step-level signal is materially better for trajectory agents than outcome-only.
11. **KL-style trust region.** Optional but recommended: penalize candidates whose prompt distance from baseline (embedding-level) exceeds δ, unless the gate sees substantial gain. Prevents extremal-Goodhart drift.
12. **Constitution / spec artifact.** Versioned, human-authored, immutable. Every promoted prompt must demonstrate non-regression against constitution-encoded behaviors. This is the Constitutional-AI parallel — the loop optimizes against the constitution, not just judge scores.

---

## Specific concerns — train/test contamination

**Showstopper #1.** `LabeledScenarioStore` accumulates from both production and eval; both training and gate pull from the same store; `holdoutScenarios` in the design's example is unconstrained. The `HoldoutAuditor` primitive that already exists in the substrate (`src/contamination-guard.ts:154`) is not used by `runCampaign`. This is the single highest-leverage fix: **wire `HoldoutAuditor` and `checkCanaries` into the campaign primitive so that misuse becomes a typed error, not a hopeful comment in a README**.

Worst-case lifecycle: at t=0, every scenario gets `split: 'train'`. At t=1, a developer carves a holdout by `labeledStore.sample({count: N})` without enforcing disjointness. At t=2, the holdout is rerun against 30 generations. At t=3, the holdout-search gap converges to zero and the gate green-lights everything. The system is now an unbounded approval machine.

## Specific concerns — reward hacking

**Showstopper #2.** With LLM judges as the sole reward signal, with no judge diversity requirement, with no specification-gaming probe in the gate, with no behavioral-diff floor, with no red-team regression check in the gate, the most likely steady state at month 6 is:

- Judge scores higher than month 0.
- User-perceived quality lower than month 0 (verbose, sycophantic, hallucinated-citation prompts win the judge).
- Red-team pass rate degraded but undetected.
- Refusal rate either too high (over-cautious from the calibration drift) or too low (jailbreak-friendly from the optimization pressure).
- No automatic detection of any of the above.

Add at minimum: (a) red-team battery as a *required* gate condition, (b) sycophancy probe (e.g. user-asserts-incorrect-fact; agent should correct, not agree), (c) at least one process-reward signal (PRM exists in this repo).

---

## Recommendation

**Do not ship v1.0 in its current shape as drawn — particularly do not ship `autoOnPromote: 'config'`.** The engineering is good; the doc undersells the substrate's own safety primitives (`ContaminationGuard`, `HoldoutAuditor`, `judge-calibration`, `red-team`, `muffled-gate-scanner`) and oversells the self-improvement loop.

Two paths forward:

- **Conservative path (recommended)**: ship `runCampaign` with `autoOnPromote: 'pr' | 'none'` only. Keep `'config'` out of v1.0. Add the typed-split / canary-enforcement / holdout-auditor wiring to the campaign primitive in v1.1. Add judge-ensemble + red-team-in-gate + spec-gaming-probe in v1.2. Then unlock `'config'` behind a shadow-deploy + rollback layer in v1.3.

- **Frontier path**: redesign the loop as a Constitutional-AI-shaped artifact. Versioned constitution + critic + reviewer + holdout-rotation + ensemble-judge + lineage. This is 4–6 weeks of work, not 2. But it's the version that earns the "self-improving" label.

The "2-week ship" estimate in the doc is realistic for the engineering merge (collapse 10,500 LOC of wrappers). It is **not** realistic for fielding a credible self-improvement system. The doc should separate those two claims cleanly: "we are unifying the wrappers" (true, valuable, ship it) vs "we are shipping a self-improvement substrate" (not true at v1.0 quality bar; needs the work above).

---

## Bottom line for the team

The codebase is doing real work in the right places (HeldOutGate's paired bootstrap is paper-grade; the calibration module is paper-grade; the contamination canaries are paper-grade; PRM scaffolding is paper-grade). The v1.0 doc *connects fewer of these primitives to the closed loop than it should*. Fix the connections, add the missing invariants, and this becomes a defensible self-improvement story. As drawn, it's a well-engineered prompt-tuning runner with a dangerous "auto-update production" button.
