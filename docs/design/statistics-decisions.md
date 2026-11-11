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

`clusteredPairedContrast` tests a mean paired difference whose pairs share clusters. Its
interval is a leave-one-cluster-out jackknife with a t quantile on G-1 degrees of freedom; its
test of zero is a cluster sign-flip randomization (`clusterSignFlipTest`), whose level is exact
under a symmetric null. On clustered binary pairs at alpha 0.05/7 the t interval alone rejected
too often (0.0076 at 0.00714, 12,000 seeded cohorts), the sign-flip test did not (0.00475).
`clusteredBinaryMde` is the planning formula with the design effect 1 + (m-1)·ICC;
`simulateClusteredBinaryContrast` measures the test's false-positive rate, and its own
detectable effect when no effect is planted.

`placeboBand` takes same-cell history, a sealed cluster count and the exact credit estimator,
including winsorization and failure scoring. Hourly windows exclude sealed steps; fewer than
72 hours or 39 eligible boundaries yields `uncalibrated` with null bounds. It returns K, n,
boundaries and deltas; bounds invert as `[delta - q975, delta - q025]`.
The [recorded contract](../../tests/cluster-recorded.integration.test.ts) labels constructed replay; callers validate cadence, cell, coverage, clusters and estimator.

`independentRiskDifference(beforeSuccesses, beforeN, afterSuccesses, afterN, confidence)`
combines the existing Wilson limits with Newcombe's method 10 (no continuity correction).
It returns after-minus-before `delta`, `lower`, `upper`, confidence and both counted arms;
either empty arm gives a null delta and full difference support. This interval assumes
independent binomial observations; repeated attempts do not become independent trials.
Reference: [Newcombe (1998), method 10 and Table II](https://doi.org/10.1002/(SICI)1097-0258(19980430)17:8%3C873::AID-SIM779%3E3.0.CO;2-I).
