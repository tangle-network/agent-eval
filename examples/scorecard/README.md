# Eval scorecard

The `(persona × profile) → score timeline` your feature PR needs to see —
*"did this change regress persona P on profile F, even while the
aggregate improved?"* No single eval run can answer that. The
scorecard does.

What the example shows:

- **`AgentProfile` + `agentProfileHash`** — the canonical
  `@tangle-network/agent-interface` profile plus the eval hash used as the
  scorecard's unit of variation. `name` is excluded from identity.
- **`recordRunsToScorecard`** — append-only JSONL log, idempotent.
  Concurrent campaign runs cannot clobber.
- **`loadScorecard` + `diffScorecard`** — per-cell verdict using
  Cohen's d + Welch's t-test, so `regressed` / `improved` are
  significant moves, not noise.
- **A CI guard** — `diff.cells.filter(c => c.verdict === 'regressed')`
  is the one-liner a build check uses to block a merge.

```bash
pnpm tsx examples/scorecard/index.ts
```
