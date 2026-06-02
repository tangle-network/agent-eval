# Progress

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
