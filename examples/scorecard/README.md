# Eval scorecard

The `(persona × profile) → score timeline` your feature PR needs to see —
*"did this change regress persona P on profile F, even while the
aggregate improved?"* No single eval run can answer that. The
scorecard does.

What the example shows:

- **`AgentProfile` + `agentProfileHash`** — the harness's unit of
  variation. Model lives *inside* the profile, so "same model,
  different skills" is two profiles. `id` is excluded from identity;
  skill/tool order does not matter.
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
