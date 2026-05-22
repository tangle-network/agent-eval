# HeldOutGate — promotion gate

The line between "the optimizer's best guess" and "what we ship." A
candidate promotes only if three independent gates clear:

1. **Productive runs** — enough paired observations to even measure.
2. **Paired Δ** — the bootstrap-CI lower bound on the median Δ exceeds
   the threshold (`> 0` by default — *significantly* better).
3. **Overfit gap** — the candidate's `(search − holdout)` gap is no
   worse than baseline's, catching the classic "wins the optimizer,
   loses on holdout" failure.

The example walks all three cases:

- a clean win that promotes,
- a coverage rejection (too few runs),
- the overfit pattern — search 0.95, holdout 0.55. The gate refuses
  to ship it.

```bash
pnpm tsx examples/held-out-gate/index.ts
```
