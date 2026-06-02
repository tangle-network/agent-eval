# Pursuit: Empirical proof of the self-improvement substrate
Generation: 6
Status: auditing

## Goal
Produce a REAL, statistically-significant held-out lift on a HARD task (not a
ceiling-prone toy), with the FULL stack active — multiple drivers competing on
the Evidence-Bus, the EYES→HANDS findings wire live, gated by a PromotionPolicy —
published as a defensible artifact (task, model, backend integrity, per-driver
baseline→winner, paired-bootstrap liftCi, head-to-head pairwise, findings-fed vs
blind delta, n, $cost). The honest close of the plateau the last three evolve
rounds hit: mechanism proven, but no real lift on a task with headroom.

## Metric → product-value claim (REQUIRED before moving on)
- **held-out lift CI (per driver, paired bootstrap)** — "If the substrate moves a
  held-out number with CI.low > 0 on a task that does NOT ceiling, the
  self-improvement loop demonstrably makes a deployed agent better. This is the
  C→A unlock — the difference between 'the loop is wired' (proven) and 'the loop
  improves agents' (unproven until now). It is the entire product value: a
  customer's agent measurably improves per cycle." Not a proxy: the lift IS the
  product outcome.
- **findings-fed − findings-blind delta** — "If feeding the analyst's diagnosis
  beats blind on a task with cross-cutting structure, the EYES→HANDS wire earns
  its keep where the extraction ceiling couldn't show it. User-visible: the loop
  converges faster by acting on diagnosed root causes." Honest-negative allowed:
  a flat delta on a fair hard task is a real result, reported as such.

## Success criteria (defined BEFORE running — anti-p-hack)
- At least one driver: held-out lift CI.low > 0 (real significant lift) on the
  chosen hard task, real backend (integrity=real, not stub/ceiling).
- The run exercises ALL of: ≥2 competing drivers, findings wire, a PromotionPolicy
  gate emitting a ship/hold/need_more_work decision.
- Artifact committed with the full field set above.
- NO corpus tuned to manufacture the result; the task is chosen for genuine
  headroom + cross-cutting structure, fixed before the run.

## System Audit (empirical-proof-audit workflow, 7 agents, verified)
- **5 tasks exist.** extraction (deterministic, CEILINGS on strong models — 0 findings, done), AppWorld (cross-cutting findings, real env on disk), marketing (LLM judge, subjective), GSM8K (deterministic numeric, HARD/no-ceiling on weak baseline, per-problem failures so findings carry little), SWE-bench (extreme, heavy Docker setup).
- **The e2e gap (verified against source):** `runImprovementLoop` + `runOptimization` ALREADY consume `findings`/`analyzeGeneration` (run-optimization.ts:57-74,157,243; RunImprovementLoopOptions extends RunOptimizationOptions, forwards `{...opts}`). The ONLY missing wire is `OptimizerEntryConfig` (compare-drivers.ts:231-255) not carrying them + `gepaEntry` (289-305) not forwarding them. Two surgical additive edits; downstream is wired.
- **Model (verified live, corrected the audit):** `/models` lists `deepseek-v4-flash`/`deepseek-v4-pro`. `deepseek-chat` is an unlisted alias that STILL works (live test = "ok"), so prior runs were real. Use the explicit listed id **`deepseek-v4-pro`** for a reproducible artifact. Rate-limit-free.
- **AppWorld present** at `/tmp/halo-repo/demo/appworld` (733 tasks); needs `APPWORLD_ROOT`; ~6-8h → background follow-on.
- **GSM8K dataset** stageable (dspy loader at ~/code/dspy + hf datasets available).

## Diagnosis
No real lift captured because: (a) the only fast deterministic task (extraction) CEILINGS on a capable model, killing headroom + producing 0 findings; (b) no full-stack entrypoint fed findings to competing drivers; (c) the hard findings-benefiting task (AppWorld) was wrongly believed env-blocked. All three are fixable now.

## Generation 6 Design
### Thesis
The substrate is mechanism-complete but UNPROVEN. Gen 6 proves it: a real,
integrity-gated, statistically-significant held-out lift on a HARD non-ceiling
task (GSM8K) with multiple drivers competing on the Evidence-Bus — then confirms
the findings-wire's *value* on a cross-cutting task (AppWorld-d3) where per-trial
evidence is insufficient. Honest split: GSM8K proves driver-lift+clean-CI;
AppWorld proves findings-fed > blind (or an honest negative).

### Changes (ordered)
1. **Wiring (architectural):** thread `findings`/`analyzeGeneration`/`report`
   through `OptimizerEntryConfig` + `gepaEntry` (compare-drivers.ts). Document
   `skillOptEntry` as findings-BLIND (no measurement lie). + doc fix
   `deepseek-chat`→`deepseek-v4-pro` in the canonical runner.
2. **Measurement:** GSM8K `compareDrivers` runner (new) + stage the dataset.
3. **Proof artifact:** `proof.json` (task/model/backendIntegrity/per-driver
   liftCi/pairwise/findingsAblation/cost/provenance/stats).
4. **Findings-value confirm (follow-on, background):** AppWorld-d3
   findings-fed-vs-blind runner.
5. **Test:** unit-assert `analyzeGeneration` reaches a stub driver's propose()
   ctx through compareDrivers (deterministic, no LLM).

### Review gate
auth/crypto/TLS/trust-boundary? No. billing? No. NEW external endpoint? No (existing callLlm). lifecycle? No. concurrency/shared mutable state? No. → **Review gate: passed (all-no).** The real adversarial surface is EMPIRICAL INTEGRITY (ceiling / stub / p-hacking / noise), handled by: assertRealBackend (no stub), CI.low>0 not point estimate, fixed seed + deterministic split + published holdoutScenarioIds, pre-registered train/holdout N, no post-hoc scenario dropping, honest-negative allowed.

### Build Status
| # | Change | Status | Files | Tests |
|---|--------|--------|-------|-------|
| 1 | thread findings/analyzeGeneration/report → OptimizerEntryConfig + gepaEntry | done | compare-drivers.ts | 1 (prompt-capture) |
| 1b | skillOptEntry documented findings-blind + doc fix deepseek-v4-pro | done | compare-drivers.ts, canonical | — |
| 2 | GSM8K compareDrivers runner + dataset staging | done | gsm8k/compare-drivers.ts | smoke |
| 3 | proof.json artifact shape | done | gsm8k/compare-drivers.ts | — |
| 4 | AppWorld findings-fed-vs-blind confirm | in flight (smoke running) | run-bench.ts (reuse) | — |

### Results / EVALUATE
- **Full-stack wiring SHIPPED + verified.** findings now flow to the competing drivers through compareDrivers (the gap the audit found); deterministic test captures the finding in the reflection prompt. Full suite 1749 pass / 2 skip. Committed 4109cc4 → PR branch pursue/empirical-proof.
- **The crystallized finding (verified live):** capable instruction-tuned models CEILING single-shot deterministic benchmarks. deepseek-v4-pro AND deepseek-v4-flash both score baseline **1.0** on GSM8K even with a deliberately weak no-CoT prompt — like extraction (0.625→1.0, 0 findings). Prompt-optimization headroom on these tasks is ~zero. **Substrate lift is only measurable where the model's failures are PROMPT-FIXABLE — i.e. a hard multi-turn AGENTIC task with tool use (AppWorld), not single-shot QA.** This also explains why findings matter there and not on extraction/GSM8K.
- **AppWorld feasibility VERIFIED (corrected my earlier "env-blocked"):** appworld 0.2.0.dev0 in /tmp/halo-repo/demo/appworld/.venv, 733 tasks + load_task_ids('dev')=57, halo at ~/.local/bin/halo, repl_agent.py uses chat.completions (deepseek-compatible), deepseek-v4-pro priced. A minimal deepseek-direct (rate-limit-free) run executes — smoke launched (gepa-reflection/gepa-pareto/memory-curation, train=1 holdout=3).

### Verdict: ADVANCE (partial) — wiring + harness + finding shipped; the lift NUMBER rides on the AppWorld run (in flight), which is the only non-ceiling substrate. GSM8K runner is correct infra that documents the ceiling honestly (kept, not deleted — it's the smoke + a weaker-model proof if AppWorld stalls).

### Seeds for Gen 7
- Capture the AppWorld held-out lift CI (the real proof) + findings-fed-vs-blind on d3.
- If AppWorld stalls (rate limits / wall-time), a weaker open model on a HARDER reasoning corpus (MATH) is the deterministic-judge fallback with headroom.

### AppWorld d3 result (live, real backend)
Ran the lift bench in the confirmed movable regime (BENCH_SPLIT=train, difficulty=3).
- 1-gen (n=6): baseline 0.794, gepa lift **0.0% CI[0,0]**.
- scaled (gen=2/pop=2/reps=2, n=8): baseline 0.885, gepa-pareto **0.0% CI[-11.7,11.7]**, gepa-reflection **0.0% CI[0,0]**, memory-curation **-4.7%**. Significant lift: NONE. integrity=real, ~$3.50 total.

### Final Verdict: HONEST NEGATIVE + PROVEN MECHANISM (ticket closed)
- **Proven:** the self-improvement loop runs end-to-end on a real public benchmark (AppWorld, objective TGC/SGC); competing drivers propose; the gate correctly HOLDS baseline when no candidate beats it; backend integrity=real. The substrate is correct.
- **Not achieved:** a positive held-out lift. Across 5 configs no driver cleared CI.low>0. Root cause: capable models ceiling easy/deterministic tasks; on AppWorld d3 the baseline prompt is already competent and the residual failures are capability-bound, not prompt-bound. memory-curation HURT (context bloat).
- **The synthesis:** prompt-opt lift needs (weak/fixable baseline prompt) ∧ (capable-enough model) ∧ (headroom task) simultaneously. Each config violated one. A positive number requires CONSTRUCTING that triple — the next experiment, not a third scale of this one.
- **Banked (real value, independent of the number):** full-stack wiring (findings→competing drivers, the loop's missing link) + deterministic test + GSM8K harness + AppWorld BENCH_SPLIT knob + v4-flash pricing + the rigorous multi-config "where lift exists" finding.

### Seeds for Gen 7 (awaiting explicit go-ahead — NOT auto-run)
- Weak-baseline AppWorld config: strip the competent repl_agent prompt to bare "solve the task" on difficulty 1-2 (v4-flash not ceilinged) — the standard GEPA/DSPy weak-start setup; directly targets the "baseline too good" root cause.
- OR merge the verified substrate (pursue/empirical-proof) and close on the proven mechanism.

Status: CLOSED — honest negative + proven mechanism
