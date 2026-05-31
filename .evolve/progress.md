# Evolve — tax agent prod-readiness via the unified matrix

## Where we are (2026-05-31)
The eval is UNIFIED + LIVE: tax agent as a `runLoop` multi-shot cell inside
`runProfileMatrix`, scored by the upstream TaxReturnEvaluator. PR #137
(drewstone-authored, tangletools-approved). Proven: 2 real shots, judge scored
0.316 by_line, standard RunRecord + byScenario rollup.

## Baseline (real, this session, hard QBI case)
| config | by_line | tools |
|---|---|---|
| single-shot bare model | 0.316 | 0 |
| single-shot product-mode (standalone) | 0.684 | 3 |
| matrix multi-shot (n=2, temp 0) | 0.316 | ? (identical shots) |

## Diagnosis — ROI-ranked gaps (matrix 0.316 → target ≥0.684)
1. **Shot diversity (cheap, high ROI):** n=2 shots were IDENTICAL (temp 0) → best-of-N degenerate. Set sampling temperature (~0.7) in loopDispatch sampling_args → diverse shots → fanout picks best. Expect lift toward the product ceiling.
2. **Tool-use realization (high ROI):** standalone product-mode hit 0.684 with 3 tool calls; the matrix run scored 0.316 — confirm tool_calls>0 in the matrix path (same productPrompt + bash:allow). If tools aren't firing in-matrix, fix the profile/prompt wiring.
3. **Cost/token forwarding (correctness):** `extractLlmCallEvent` (agent-runtime) doesn't parse the sandbox 0.4.0 `done` event → integrity 'warn', cost=0. Fix in agent-runtime so the matrix records real cost/tokens (needed for the corpus + the integrity gate). Generic — belongs in loopDispatch's cost path.

## Next experiment (designed, not yet run)
matrix.ts on the hard QBI case: --shots 3, sampling temperature 0.7, confirm tool_calls>0, 3 reps. Success: median by_line ≥ 0.60 (toward the 0.684 ceiling) with tool_calls>0, d>0.5 vs the 0.316 temp-0 baseline. Held-out: the other Schedule-C cases. ~3 sandboxed runs/cell → budget + greenlight before spending.

## Guardrails
tax-agent is heavily concurrent (6+ worktrees) — isolated-worktree only, never the shared main checkout. See [[reference_pr_authorship_convention]].
