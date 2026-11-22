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
`clusteredBinaryMde` solves its planning variance equation as a quadratic with the design
effect 1 + (m-1)·ICC. No finite positive attainable solution gives null MDE and `detectable:false`.
`simulateClusteredBinaryContrast` measures false-positive rate and power for a supplied effect.
Without one, it searches within attainable success rates using common seeded draws and refuses
an unbracketed target. The selected endpoint meets the empirical search threshold; neither global
minimality nor true population power is certified. Its separate reporting cohort and standard
errors retain Monte Carlo uncertainty, including a reported power below the requested target.
Paired deltas must be finite; invalid evidence is refused before a p-value is computed.
If any required cluster deletion makes the statistic undefined, the jackknife keeps the
full-sample estimate but returns null bounds. It never discards that cluster and reports
artificially narrow uncertainty.

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

## Association across many measures

`clusteredAssociation` tests whether a score predicts an outcome when rows share independent units:
AUC for a 0/1 outcome (null 0.5, through `rocAuc`) and Spearman for a continuous one (null 0, through `spearmanR`).
Its standard error is the standard deviation of the statistic over `clusterBootstrap` resamples of whole units,
and its p-value is a Wald test on Student-t with `units - 1` degrees of freedom, two-sided or `greater`.
The percentile interval from the same resamples is reported beside it.

Why a Wald test on the whole-unit standard error, not a bootstrap tail count:
a study that corrects across hundreds of measures needs p-values below `level / m`, and a bootstrap tail
count cannot go below `1 / resamples`. A row resample would understate the standard error whenever rows of
one unit share what makes that unit differ; the planted test in `tests/meta-eval/measure-validity.test.ts`
(24 units, a unit-level rank correlation near 0.25 and none in the population) admits under row resampling
and not under unit resampling. When every defined resample gives the same value, the standard error is zero
and the p-value falls back to `1 / (definedResamples + 1)` on the tested side of the null, or 1.

`scope: 'within-unit'` compares rows only inside each unit: AUC per unit weighted by its positive-negative
pairs, which is the Mann-Whitney count restricted to same-unit pairs, or Spearman per unit weighted by its row
pairs, with a score constant inside a unit counted as no association there. Units are summarized once and the
summaries are resampled, so a unit drawn twice stays two units. A pooled statistic can be carried entirely by
differences between units, such as larger repositories failing more; the within-unit statistic cannot.

`measureValidityStudy` fixes each measure's direction before the cut, so its tests are one-sided in that
direction and Benjamini-Hochberg runs on those p-values. A two-sided test would admit a measure whose direction
reversed. The one-sided test has a known weakness: when the same units appear on both sides of the cut, a
coincidence among those units can choose the direction and then confirm it, raising the pooled error rate up to
twice the level. The within-unit test is immune to that, because unit-level coincidences cancel inside a unit,
and `predicts` requires it wherever it can be estimated; a pooled-only pass is labelled `predicts-pooled-only`.
Movement agreement is the AUC of a movement's sign for the better outcome, which equals balanced accuracy and
stays 0.5 under no relation whatever the outcome's base rate; it is tested one-sided as its own family.
