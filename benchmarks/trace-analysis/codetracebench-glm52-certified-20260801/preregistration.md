# Pre-registration — sealed-split certification, 2026-08-01

Written BEFORE any model run against a sealed split. Sealed instruments: holdout-2 (labels sha 2db46579…, 32 rows, cascade-skewed by construction) and split3 (labels sha d0347ec7…, 37 rows, entire remaining compatible pool, thin-gold ≈1.6 steps/case, unbiased by construction).

## Arms (3)

| Arm | Vehicle | Config |
| --- | --- | --- |
| incumbent | /dev/shm/ae-mp-tg dist (origin/main 856b3a6 + instructions-file threading; stock path byte-identical to main, digest 5811b534…) | stock prompt, stock bridge |
| W | /dev/shm/ae-mp-tw dist + its venv (branch mp/track-w-width-adaptive @ 9c04e8e) | width-adaptive TS prompt + bridge typed-path edits |
| G-winner | /dev/shm/ae-mp-tg dist + --instructions-file /dev/shm/mp-tg-gepa/winner-instructions.txt (sha d3829fb8…) | GEPA-optimized instructions, stock bridge |

W's arm intentionally carries its Python-bridge edits — that is W's shipped configuration; the digest fields record each arm's identity.

## Protocol

- 6 runs, strictly serial (parallel measurement runs proven contention-fatal this session: h1 96/96 wipeout).
- 2 repetitions, seed 0, concurrency 6, glm-5.2 via z.ai direct, max-output-tokens 8192, per-run --max-cost-usd 30.
- Splits run: holdout-2 (limit 32) and split3 (limit 37) per arm.
- Scoring: benchmarks/trace-analysis/tools/compare-analyst-runs.mjs (validated 373/373 vs published artifacts): per-split paired arm-vs-incumbent deltas with cluster bootstrap, plus pooled-sealed (h2+split3) micro/macro per arm.

## Decision rules (fixed now)

1. Promote W over incumbent iff pooled-sealed micro(W) ≥ micro(incumbent) AND neither split's paired f1 delta CI has lower bound < −0.10 (no regime catastrophe).
2. If W ties incumbent on pooled-sealed micro (paired CI spans 0): W is still promotable on regime balance iff split3 (narrow) paired delta ≥ 0 while holdout-2 (wide) delta ≥ −0.02 — the design goal is removing the incumbent's narrow-regime tax without paying a wide-regime one.
3. Promote G-winner only if it beats BOTH incumbent and W on pooled-sealed micro.
4. No post-hoc metric substitution: micro F1 is the headline; macro is reported, never the promotion criterion.
5. Failed-run counts reported per arm; a >10% failure rate on any run invalidates that run (rerun once serially before drawing conclusions).

## Spend

~$42 expected (6 runs ≈ $7/run at 2 reps). Ledger updated in experiments.jsonl after readout.
