# Statistics: adoption decisions

`src/statistics/` owns estimators and intervals. Product callers own their decision rules.
The public API is `@tangle-network/agent-eval/statistics`; internal paths are unsupported.

## Evidence and dependencies

Keep statistics in-house with independent numerical oracles, rather than adding runtime dependencies.
`scripts/generate-statistics-oracle.py` generates `tests/fixtures/statistics-oracle.json`;
`tests/statistics-oracle.test.ts` checks the scipy and statsmodels reference values.
`tests/statistics-library-crosscheck.test.ts` checks untied exact null distributions against R through the development-only `lib-r-math.js`.
Historical audits and affected-version notices live in `CHANGELOG.md`.

## Small samples

Exact rank tests and sign tests own decisions where their attainable p-value permits one.
`mannWhitneyU` and `wilcoxonSignedRank` default to exact enumeration within their work limits,
then seeded Monte Carlo permutation. Explicit asymptotic requests within the exact-feasible
regime are refused. Read `method` and `pFloor` from the result; source owns the limits.

A percentile bootstrap below twenty independent clusters is descriptive spread, not a
promotion gate. `pairedBootstrap.gateEligible` exposes that restriction.
`pairedDeltaTest` uses the exact sign test for small samples and the bootstrap afterward.
`pairedPromotionPower` sizes the complete sealed decision by simulation; closed-form power
functions cannot account for its sufficiency gates, vetoes or repeated reads.

## Clustered observations and time drift

`clusterBootstrap` redraws whole clusters with replacement, preserving each stratum's cluster
count. A cluster spanning strata is invalid. Its statistic can be a mean, percentile, share
or ratio; degenerate resamples are omitted and no finite draws leaves NaN bounds. `clusterBootstrapMean` delegates to this engine.
The mean wrapper keeps its data-derived seed; its bounds now use the shared interpolated
quantiles, so previously recorded endpoints may differ. One cluster carries no between-cluster
information even if its interval collapses.

`placeboBand` receives one same-cell history and the exact before/after estimator used for
credit, including baseline winsorization and failure scoring. It selects the nearest sealed
number of clusters on each side of hourly boundaries, excluding windows crossing sealed
steps. At least 72 hours and 39 eligible boundaries are required; otherwise bounds remain
null with `status: 'uncalibrated'`. It reports K, n, boundaries and drift deltas, and inverts
empirical quantiles as `[delta - q975, delta - q025]`. 
`tests/cluster-recorded.integration.test.ts` exercises the public APIs on a numeric projection
of recorded create rows. Its long replay is explicitly constructed; short measured history
must remain uncalibrated. Product owners still validate cadence, cell membership, complete
reads, cluster identity and their selected statistic before claiming a calibrated result.

## Reproducibility

Use `makeRng` from `src/statistics/internal.ts` or the shared cluster bootstrap seed.
