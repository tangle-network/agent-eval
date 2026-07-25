# HeldOutGate: promotion gate

The line between "the optimizer's best guess" and "what we ship."
A candidate promotes only when the required evidence exists and four required checks pass.
When a cost ceiling is configured, a fifth check applies:

1. **Complete split scores**: candidate and baseline both have search and holdout results.
2. **Productive runs**: enough paired observations to measure.
3. **Paired Δ**: the bootstrap-CI lower bound on the median Δ exceeds
   the threshold (`> 0` by default: *significantly* better).
4. **Overfit gap**: the candidate's `(search − holdout)` gap is no
   worse than baseline's, catching the classic "wins the optimizer,
   loses on holdout" failure.
5. **Cost, when configured**: candidate cost evidence is complete and
   its median cost per task does not exceed `costPerTaskCeiling`.

Candidate and baseline rows pair only on the same `(experimentId, scenarioId, seed)` identity.
Missing or duplicate identities fail loudly, and unmatched rows are reported in the decision evidence instead of being paired by input order.

The example walks through three decisions:

- a clean win that promotes,
- a coverage rejection (too few runs),
- the overfit pattern: search 0.95, holdout 0.55. The gate refuses
  to ship it.

```bash
pnpm tsx examples/held-out-gate/index.ts
```
