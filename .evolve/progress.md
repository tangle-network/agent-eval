# Progress

## 2026-07-27 - Belief-state research closed

PR #450 removed the experimental `belief-state` package after repository-wide analysis found no producers and no consumers.
The reusable off-policy estimators remain in `src/rl/off-policy.ts`.
The reusable calibration code remains in `src/meta-eval/calibration.ts`.
Do not resume the removed package until a real runtime decision producer and a measured consumer exist.

## Gen 6 — Empirical proof: CLOSED (honest negative + proven mechanism)

### Shipped + verified (branch pursue/empirical-proof, ~7 commits, suite green)
- Full-stack wiring: findings -> competing drivers through compareDrivers (+ deterministic prompt-capture test). The loop's missing connection, closed.
- GSM8K substrate-proof harness + dataset; AppWorld BENCH_SPLIT knob; v4-flash pricing.

### The empirical result (live, real backends, ~$3.50)
Ran the lift bench across 5 configs hunting a measurable held-out lift:
| config | baseline | lift | why |
|---|---|---|---|
| extraction | 0.625->1.0 | n/a (0 findings) | model ceilings |
| GSM8K v4-pro / v4-flash | 1.0 | — | model ceilings |
| AppWorld easy | ~0.89 | — | near-ceiling |
| AppWorld d2 (v4-flash) | ~0.91 | — | near-ceiling |
| AppWorld d3 (v4-pro, scaled gen2/pop2/n8) | 0.885 | **0.0% CI[-11.7,11.7]** | competent baseline + capability-bound residual |

**MECHANISM proven:** the loop runs end-to-end on a real public benchmark (AppWorld, objective TGC/SGC), drivers compete, the gate correctly HOLDS baseline when no candidate beats it, integrity=real. **LIFT not achieved:** capable models ceiling easy tasks; on AppWorld d3 the baseline prompt is already competent and the residual failures are capability-bound, not prompt-bound. memory-curation HURT (-4.7%, context bloat).

### The honest conclusion
Prompt-optimization lift needs THREE things at once: a weak/fixable baseline prompt + a model capable of benefiting + a task with headroom. Each available config violated one. The substrate is correct; a positive number requires CONSTRUCTING that triple, not finding it.

## Next (awaiting go-ahead — NOT auto-run, per the no-third-scale commitment)
The one config most likely to show real lift: a DELIBERATELY-WEAK AppWorld baseline prompt (strip the competent repl_agent instructions to a bare "solve the task") on difficulty 1-2 where v4-flash is NOT ceilinged — the standard GEPA/DSPy "optimize a weak starting prompt" setup. This directly targets the root cause (baseline too good) and is principled, not rigged.

Next: /pursue weak-baseline AppWorld lift config (explicit go-ahead) OR merge the verified substrate (pursue/empirical-proof) + close the ticket on the proven mechanism.

## 2026-06-05 — Belief-state Phase 0 corpus substrate

Implemented the first belief-state decision corpus path for local code-agent traces. The new `src/belief-state/code-agent-corpus.ts` joins Codex, Claude Code, OpenCode, Kimi Code, and Pi/PiGraph-shaped session events to `RunRecord`, emits decision points for failure recovery, tool selection, and graph completion, inventories target support, selects failure recovery first, and runs the experimental selective/calibration/OPE report.

Verified synthetic coverage for the five trace families. Missing behavior/target propensities correctly force OPE `unsupported` and overall `hold`; no counterfactual policy value is claimed without support.

Built package smoke on local private traces: 33 sessions joined to 33 `RunRecord`s and emitted 13,137 decision rows. Breakdown: Codex 2,172 decisions, Claude Code 10,198, Kimi Code 597, OpenCode 168, PiGraph 2. Failure recovery had support in Codex, Claude Code, Kimi Code, and OpenCode; all policy reports held because behavior/target propensities are missing.

Next: run real local corpus measurement and keep the stable belief-state API gate closed until the empirical support thresholds clear.

## 2026-08-01 - Recursive trace analyst evolve round closed

Goal: recursive DSPy-RLM analyst beats one-shot on CodeTraceBench scored micro F1.
Outcome: dev-split lift real (+8.9pp, 0.3644→0.4536), holdout transfer failed (−4.0pp micro, +5.8pp macro on 32 disjoint cases); accuracy claim NOT promoted.
Correctness infrastructure promoted on its own proofs: Arm M recoveries (64e724d), Arm S typed environment engine (eca36d6), fail-loud product path (traces#64, agent-eval#508, supervisor-lab#48 all merged).

Best branch: `evolve/analyst-stack` @ 44438de in worktree agent-eval-arm-vote-20260731.
Instrument kept: disjoint 32-case holdout (/dev/shm/ctb-holdout-labels.json sha 53af5ffe…) + scratchpad compare_arms.py (paired cluster bootstrap).

Next constraint (diagnosed, unfunded): wide-cascade under-extension — holdout gold has 9-wide blocks; the stack emits narrow typed blocks (clap-4248: gold 23-31, stack (32,33) both reps, baseline (23,30)=0.87).
Fix direction: extend-while-chain-holds boundary doctrine + width-aware falsification; re-certify with ≥3 reps (2-rep CI ±0.15-0.28 cannot certify ±4pp deltas); then stronger controller (Claude via router); 69 more compatible upstream cases to widen the instrument.

Dead ends (do not re-fund): consensus voting under any aggregator (oracle-pick 0.396 ≈ single-run 0.393 at 3× cost); suppression-style prompt caution (P1 0.218); investigation depth as an accuracy lever.

## 2026-08-01 - Analyst stack SHIPPED (PR #514 merged)

All 9 commits on main: M recoveries, S typed environment engine, V dormant consensus flag, P2+W+W2 rubric-aligned prompt.
Shipped claim (pooled, 64 labeled cases, 2 reps): 0.3757 vs shipped-baseline 0.340 micro (+3.5pp), macro up on both splits, 1 failed run vs 2.
Regime structure disclosed in PR: +8.2pp on wide-cascade gold, −1.5pp on narrow gold vs baseline.
holdout-2 (cascade-skewed, 188 gold steps, sealed, /dev/shm/ctb-holdout2-*) remains UNSPENT — reserve for certifying the next width-adaptivity arm.
Side-quests all merged: traces#64, agent-eval#508, supervisor-lab#48, agent-runtime#657/#659/#662/#664, agent-knowledge#105.

## 2026-08-01 - Multi-pursue round: GEPA prompt certified as stock; W rejected; replay-verify shipped

Four parallel tracks off main 856b3a6, all with executed proofs; two sealed splits burned once under a pre-registered protocol.

Outcome: **GEPA-optimized prompt PROMOTED and shipped as the stock analyst prompt** — pooled-sealed micro 0.4809 vs incumbent 0.4285 (+5.2pp over 138 fresh observations, 0 failed runs, precision +9.7pp on cascade gold).
The hand-designed width-adaptive arm (W) was REJECTED by its own pre-registered gate (0.4047 pooled; its dev/h1 edge did not transfer — the second consecutive transfer failure for hand-tuned doctrine edits, now a pattern).
Convergence note: GEPA independently rediscovered W's split/boundary discipline and sharpened it (never bridge correct steps; drop "acts-on" from extension).

Also shipped: traces#69 execution-replay verification (36/36 prefix replay, counterfactual proof on zstd-1733, 26.6s); agent-eval#516 comparison harness (373/373 bit-match vs published artifacts); agent-eval#515 docs truth alignment; split3 built (37 rows = the entire remaining compatible pool, unbiased by construction).

Protocol lessons (measured): parallel measurement runs are FATAL (96/96 uniform wipeout from contention; serial probe immediately healthy) — strictly serial chains only; builder agents skip lint (repeat of finding #3) — full battery after any merge.

Open problems, ranked: (1) thin-gold narrow regime — every config collapses to 0.17-0.18 micro on split3; (2) both sealed splits now SPENT — OpenHands/Terminus2 importers (742 rows) are the instrument unlock; (3) GEPA round 2 from the new stock baseline (train on more scenarios, micro-aligned metric via per-case TP/FP/FN counts); (4) replay-verify → gold-labeled error steps + analyst-finding-to-fix-command wire.
