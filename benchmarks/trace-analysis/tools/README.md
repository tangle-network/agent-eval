# trace-analysis tools

## compare-analyst-runs.mjs

Compares analyst-benchmark `result.json` files across labeled arms and verifies persisted artifacts against their own observations.
It imports the package's statistics from `dist/` (`summarizeAnalystBenchmarkRunner`, `compareAnalystRunners`, `clusteredPairedBinary`), so run `pnpm build` first.

### Compare arms

```bash
node benchmarks/trace-analysis/tools/compare-analyst-runs.mjs \
  --run direct=path/to/runA/result.json \
  --run rlm=dspy-rlm@path/to/runB/result.json \
  --baseline direct [--seed 0] [--resamples 2000] [--confidence 0.95] [--json]
```

- `--run LABEL=[RUNNER@]PATH[,[RUNNER@]PATH...]` tags one arm; `RUNNER@` picks the runner id inside the file (default: the file's sole non-`empty` runner).
- Per-arm output: micro precision/recall/F1 (pooled `summaries[].f1` semantics: recall = Σmatched/Σexpected, precision = Σsupported/Σpredicted findings on issue-bearing rows), macro F1 (mean per-case F1), failed/planned runs, and the raw pooled counts.
- Paired deltas reuse `compareAnalystRunners`: pairs on `caseId`+`repetition`, clusters on `observations[].clusterId`, cluster-level paired bootstrap CIs on all 18 metrics, with inference limitations printed per row.
- The completion line reuses `clusteredPairedBinary` (pass = run did not error): discordant counts, task-weighted risk difference, whole-cluster bootstrap CI, and a cluster sign-flip p-value.
- CIs are deterministic for a given `--seed` (default 0).

### Pool splits before computing micro (`--pool`)

```bash
node benchmarks/trace-analysis/tools/compare-analyst-runs.mjs --pool \
  --run rlm=dev/result.json,holdout/result.json \
  --run direct=devB/result.json,holdoutB/result.json
```

Observations from all of an arm's files are concatenated before any statistic, which is how pooled headline micro F1 over dev+holdout case-measurements is computed.
Pooled files must cover disjoint case sets; a repeated `caseId`+`repetition` inside one arm is an error, not a silent merge.

### Verify a persisted artifact against itself

```bash
node benchmarks/trace-analysis/tools/compare-analyst-runs.mjs \
  --verify-embedded benchmarks/trace-analysis/codetracebench-rlm-glm52-20260731/result.json
```

Recomputes the artifact's `summaries`, `comparisons`, and `codeTraceCalibration` from its own `observations` and prints MATCH/MISMATCH per field (exit 1 on any mismatch).
Comparison CIs use the artifact's recorded `provenance.runnerOrderSeed`, so `intervalLow`/`intervalHigh` reproduce exactly; `--seed` overrides it when checking a foreign artifact.
