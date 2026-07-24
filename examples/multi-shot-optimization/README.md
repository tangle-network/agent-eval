# Improve A Surface With A Custom Candidate Generator

This offline example runs a caller-owned `SurfaceProposer` through `runImprovementLoop()`.
It measures candidates on training cases and evaluates the selected candidate on a separate holdout set.

## Run

```sh
pnpm exec tsx examples/multi-shot-optimization/index.ts
```

No API key is required.
The agent echoes the candidate surface and the judge checks for one required directive.

## What It Shows

- `SurfaceProposer` can be deterministic, model-backed, or delegated to another runtime.
- Candidate generation sees training history but not holdout results.
- The selected candidate is measured against the baseline on separate cases.
- The exact selected change is available as `promotedDiff`.

The expected decision is `ship` because the candidate scores `1` and the baseline scores `0` on every holdout case.
This proves the wiring, not the quality of a production evaluation.

Replace `dispatchWithSurface` with your agent call, replace the judge with a calibrated check, and replace the proposer with your product-specific candidate logic.
Use [`compareOptimizationMethods()`](../../docs/campaign-proposers.md) when the search procedure itself comes from GEPA, SkillOpt, or another complete optimizer.
