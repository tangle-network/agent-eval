# Statistics: adoption decisions

This is the standing decision record for `src/statistics.ts` and the estimators layered on it.
It answers three questions: which statistic is trustworthy, where each number comes from, and what a caller is allowed to ask for at 3–10 repetitions per arm.
The API itself is documented in [`concepts.md`](../concepts.md); this file records *why* each statistic is kept, fixed, or refused.

## Verdict

Keep the statistics in-house, fix them here, and take no statistics package as a runtime dependency.

Of the 38 exported statistics, 17 were correct, 15 were defective, and 6 are correct mathematics applied in a regime where they mislead.
The defects concentrated in exactly the functions a promotion gate reads: the paired rank tests, the bootstrap interval, and the multiple-comparison boundary.
All 15 are repaired; the 6 regime limits are now declared in the result rather than left for a caller to infer.
The largest single defect is a standard-normal CDF that mixed the arguments of the Abramowitz–Stegun error-function approximation, giving up to `3.7189e-2` absolute CDF error at `x = 0.567` where a correct implementation is bounded by `7.5e-8`.
That one line made every affected p-value too small by 26–36 % relative, so the module's real type-I error rate was 6.53 % at a nominal 5 %.

The reason to stay in-house is not preference.
Every statistic a JavaScript library gets right is one this module already gets right, and every statistic this module gets wrong at 3–10 reps is one no JavaScript library gets right either.
A survey of 13 installed packages, tested by execution rather than documentation, found no npm package that computes an exact rank test under ties, Cliff's delta, or a paired bootstrap interval.

## How the numbers below were produced

Every measurement in this document was produced by executing the code, not by reading it.

The pristine baseline is `origin/main` blob `md5 15ca1ed9fbdd10215b5d0b682d99946c`, extracted with `git archive` and bundled with `esbuild` so that concurrent edits to the working tree could not move it.
The comparison build is the same bundle taken from the working tree.
References are `scipy 1.13.1` (`stats.norm`, `stats.t`, `stats.mannwhitneyu`, `stats.wilcoxon`, `stats.binomtest`, `stats.pearsonr`, `stats.spearmanr`) and, for the exact conditional null, an independent enumeration of every split of the observed data that agreed with scipy's permutation test to four decimals on 9 of 9 two-sample cases.
Monte Carlo figures are 4,000 trials per cell with a seeded generator unless stated otherwise.

Where a number in this document differs from one recorded elsewhere, the difference is almost always which build was measured.
The same call `mannWhitneyU([1,2,3],[4,5,6]).p` returns `0.03769147` on `origin/main` and `0.04953448` once the CDF is repaired; both are correctly reported values of different code.

## Decision key

- **keep-and-fix** — the statistic belongs in this package, the implementation is wrong or incomplete, and the fix is ours to write.
- **keep-with-CI-oracle** — the implementation is correct and stays as-is, pinned against a scipy-generated golden fixture so it cannot silently regress.
- **replace-with-library** — a maintained package does this better than we do.
- **delete** — the statistic should not be callable.

No statistic in this module is marked **replace-with-library**.
That is the survey's conclusion, not an oversight, and the argument is in [Dependency verdict](#dependency-verdict).

## Defective

These 15 produced a wrong number, hung, or fabricated a verdict.
All are repaired, each with a regression test that fails on the pristine blob and passes after.

| Statistic | Status | Decision | Measured evidence | Regime caveat |
| --- | --- | --- | --- | --- |
| `normalCdf` | defective, **fixed** | keep-and-fix | `t = 1/(1+p·|x|)` used the unscaled argument while the exponential used `exp(-x²/2) = exp(-z²)` with `z = x/√2`; max abs CDF error `3.7189e-2` at `x = 0.567`. Repaired to evaluate both halves at `z = |x|/√2`; worst deviation from `scipy.stats.norm.cdf` now `4e-10` at `x = 1.6` and `3.4e-8` at `x = 0.565`, inside the A&S 7.1.26 bound of `7.5e-8`. | None once fixed. |
| `normalCdf` duplicate in `src/baseline.ts` | defective, **fixed** | keep-and-fix | A byte-identical second copy of the same defect reached production verdicts through `welchsTTest → studentTCdf`. Deleted with its duplicated `studentTCdf`/`incompleteBeta`/`lnGamma`; the shared math now lives in `src/math/normal.ts`, `src/math/student-t.ts` and `src/math/special-functions.ts`. A `df = 298` case moved from `p = 0.010887` to the true Student-t `0.015150`. | Now one implementation repo-wide: `grep 0.3275911` returns a single site. |
| `mcnemarPower` | defective, **fixed** | keep-and-fix | Reached the normal distribution through the broken forward CDF while its documented inverse `mcnemarRequiredN` reached it through `zQuantile`, so the two were not inverses. `mcnemarPower({p10:0.2, p01:0.1, nPairs:200})` returned `0.773437` against a true `0.736522`; it now returns `0.736522`. | Power was **overstated** above 0.5 and understated below it, so pre-registered N read off this function was too small. |
| `studentTCdf` `df > 100` branch | defective, **deleted** | delete | The branch short-circuited to `normalCdf`, which changed a two-sided `df = 102, t = 1.98` result from the true `0.050398` to `0.047703` and flipped a 5% decision. | Every finite degree of freedom now uses the regularized incomplete beta. |
| `studentTCdf` / `incompleteBeta` at `df ≤ 100` | defective, **fixed** | keep-and-fix | The continued fraction omits the mandatory symmetry branch (`x < (a+1)/(a+b+2)`, else `1 − I(1−x, b, a)`), so it is evaluated outside its convergence domain for small `|t|` and collapses as `x → 1`. `studentTCdf(0.005, 100)` returns `0.89152130` against a true `0.50198972`, an error of `0.3895`. Through `pairedTTest` at `df = 7`: `t = 0.001` reports `p = 0.15130173` against a true `0.99923002`, and `t = 1e-6` reports `p = 0.00015251`. There is a discontinuity at zero — `t = 1e-8` returns exactly `p = 1.0` because `x ≥ 1` short-circuits. | A perfectly null paired result reports `p < 0.05`. The materially wrong band is `|t| ≲ 0.02` at `df = 2–10`, widening to `|t| ≲ 0.058` near `df = 100`; outside it `pairedTTest` matched `scipy.stats.ttest_rel` to `≤ 1e-6` relative across 166 cases. |
| `interRaterReliability` | defective, **fixed** | keep-and-fix | The grouping loop iterates judge-major and opens a new item bucket whenever the last holds `judgeScores.length` entries, so each bucket collects consecutive scores from the *same* judge. It measures within-judge spread, not between-judge agreement, and is anti-correlated with the truth. Two identical judges scoring `[0,100]` return **`−0.500000`** where the true α is `+1.0`; two maximally disagreeing judges (`[0,0]` versus `[100,100]`) return **`+1.000000`** where the true α is `−0.5`. Perfect agreement on three items returns `−0.250000`, on four items `+0.650000`. | The result is also unstable in the item count, because bucket boundaries depend on how the item count divides by the judge count. Zero test coverage repo-wide; consumed by `src/pipelines/judge-agreement.ts:73`. |
| `mannWhitneyU` (NaN input) | defective, **fixed** | keep-and-fix | The tie-grouping loop advances via `while (j < len && combined[j].v === combined[i].v) j++` then `i = j`. `NaN === NaN` is false, so `j` never leaves `i` and the process spins forever. `mannWhitneyU([1,2,3,4,5,6],[NaN,2,3,4,5,6])` did not return within 8 s and blocked the event loop hard enough that a 4 s `setTimeout` never fired. | A single NaN score hangs a campaign rather than failing it. `ranks` is safe only because it uses `i = j + 1`. |
| `wilcoxonSignedRank` (NaN input) | defective, **fixed** | keep-and-fix | The same construct at the absolute-rank grouping loop, same hang. | Reachable from `held-out-gate.ts:278`, so a NaN in a holdout set hangs the gate. |
| `mannWhitneyU` (tie and continuity correction) | defective, **fixed** | keep-and-fix | The variance uses the no-ties formula `n₁n₂(n₁+n₂+1)/12` and there is no continuity correction. `[1,2,3]` versus `[4,5,6]` (zero ties) and `[0,0,0]` versus `[1,1,1]` (maximal ties) both return the byte-identical `p = 0.04953448`. scipy's tie-and-continuity-corrected asymptotic separates them at `0.080856` and `0.046854`. | Both omissions push p downward, so they compound the CDF defect rather than offsetting it. `u` is returned as `min(u1,u2)`, which discards the direction of the effect. |
| `wilcoxonSignedRank` (tie and continuity correction) | defective, **fixed** | keep-and-fix | The variance uses `n(n+1)(2n+1)/24` with no tie term `−(1/48)Σ(t³−t)` and no continuity correction, despite the function computing average ranks for ties. | Same compounding direction. The statistic convention also differs from scipy without being documented: this returns `W⁺`, scipy returns `min(W⁺, W⁻)`. |
| `wilcoxonSignedRank` (`n < 6` branch) | defective, **fixed** | **branch deleted** | Line 219 hard-returns `{w: 0, p: 1}` below six non-zero differences, with no exception, no flag, and nothing in the result to distinguish it from a measured null. A clean `+0.5` on all five of five pairs returns `p = 1` where the exact answer is `0.0625`. Because zero deltas are dropped first, ties silently push `n` under the threshold: ten pairs with five zero deltas also returned `p = 1`. | This is the single most consequential open defect at 3–10 reps, and it violates the package's own *no fallbacks, fail loud* rule. It is a false-negative generator precisely in the target regime. |
| `bonferroni` | defective, **fixed** | keep-and-fix | Adjusted values are correct (`min(1, p·k)` matched R `p.adjust` on 8 case sets), but the rejection boundary uses strict `<` where the rule is `p ≤ α/k`. With `p = [0.0125]×4` and `α = 0.05` it returns `significant = [false,false,false,false]`; `holm` on the identical input returns `[true,true,true,true]`. It also has no input validation, unlike `holm`: `bonferroni([-0.1, 0.2], 0.05)` returns `{adjusted: [-0.2, 0.4], significant: [true, false]}` — a negative p-value declared significant. | Two corrections in one module disagree at their shared boundary. |
| `benjaminiHochberg` | defective, **fixed** | keep-and-fix | q-values are correct (matched R `p.adjust('BH')` on 8 case sets including the 15-value worked example and ties), same two rule defects. `benjaminiHochberg([0.05, 0.05], 0.05)` returns `significant = [false, false]` where BH rejects iff `q ≤ α`. `benjaminiHochberg([-0.1, 0.2])` returns `qValues = [-0.2, 0.2], significant = [true, false]`. | Drives `rl/contamination.ts:162` and `summary-report.ts:159`. |
| `pairedTTest` (zero-variance branch) | defective, **fixed** | keep-and-fix | Line 199 returns `p = 0` when the standard error is zero. `pairedTTest([0, 0, 0.5], [0.5, 0.5, 1])` — a constant `+0.5` shift on three pairs — returns `{t: null, df: 2, p: 0}`. That is absolute certainty from three observations where the exact signed-rank floor at `n = 3` is `0.25`, and the object is internally inconsistent (`t` serialized as `null` alongside `p = 0`). | `pairedCohensDz` handles the identical condition correctly by returning `null` and documents why. The module should answer the degenerate case once, the same way, everywhere. |
| `cohensD` (degenerate branches) | defective, **fixed** | keep-and-fix | Returns a silent `0` twice: when either sample has fewer than two observations, and when the pooled standard deviation is zero. `cohensD([1,1,1],[2,2,2])` returns `0` — "no effect" for a maximal, zero-variance separation. | Third distinct answer to the same degenerate condition, after `pairedTTest`'s `p = 0` and `pairedCohensDz`'s `null`. Only `pairedCohensDz` is right. |
| `mulberry32` | defective, **fixed** | keep-and-fix | `let s = seed \| 0 \|\| 0x9e3779b9` collapses seed `0` to the golden-ratio constant. `mulberry32(0)` and `mulberry32(0x9e3779b9 \| 0)` both emit `[0.3588899802, 0.1059032613, 0.6752904793]`. | Seed `0` is a common default, so two runs a caller believes are independent replicates are the same run. |
| `makeRng` / bootstrap seeding | defective, **fixed** | keep-and-fix | `makeRng` returns raw `Math.random` when `opts.seed` is undefined. Two back-to-back `confidenceInterval` calls on identical input returned `lower = 0.30000000000000004` and `lower = 0.3`, `upper = 0.6749999999999999` and `upper = 0.6499999999999999`. Seeding works when supplied (`seed: 7` reproduced exactly). | This contradicts `mulberry32`'s own docstring, which states that a seed is required because unseeded randomness in gate verdicts is non-reproducible by construction. `src/contract/analyze-runs.ts:908` is the live call site that passes no seed; the gates in `held-out-gate.ts`, `promotion-policy.ts`, `statistical-heldout.ts`, `measured-comparison.ts` and `summary-report.ts` all thread one through. |

## Correct mathematics, misleading regime

These 5 compute what they claim.
They mislead at 3–10 repetitions because the asymptotic assumption does not hold there, and no change to the implementation fixes that.

| Statistic | Status | Decision | Measured evidence | Regime caveat |
| --- | --- | --- | --- | --- |
| `mannWhitneyU` small-n | approximation limit, **exact path added** | keep-and-fix (add exact path) | The normal approximation was applied unconditionally, including `n = 1`, with no switchover threshold. At three per group the exact minimum attainable two-sided p is `0.100000`, yet complete separation returned `p = 0.04953448`. The default now selects exact computation from the dynamic program's actual state and work, so balanced 12+12 and imbalanced 1+24 designs are both exact. Above that limit, the automatic permutation seed is invariant to observation order and group order; the prior seed changed a two-sided result from `0.04960` to `0.04420` when the groups were swapped. | Repairing the CDF did not fix this; only an exact test does. Discreteness is the binding constraint, and tie-aware `pFloor` now reports it on every result. |
| `wilcoxonSignedRank` small-n | approximation limit, **exact path added** | keep-and-fix (add exact path) | Where the approximation ran it was anti-conservative at `n = 6–7` (minimum attainable `p = 0.0209` against an exact `0.0312` at `n = 6`) and conservative from `n ≥ 8`. The default is now exact by sign-flip enumeration at `n ≤ 20`. | The `n < 6` hard return is gone. `pFloor = 2^(1−n)` is reported on every result, so a design that cannot reach alpha says so. |
| `confidenceInterval` / `pairedBootstrap` | approximation limit, **floor declared** | keep-and-fix (add an n floor) | Percentile bootstrap, correctly constructed. The gate-relevant quantity is `P(low > 0)` under a true null against a nominal 2.5 %. Measured over 4,000 seeded trials on a continuous null: **13.53 % at `n = 3`**, 3.33 % at `n = 5`, 4.45 % at `n = 8`, 3.52 % at `n = 10`, 3.10 % at `n = 20` for the median statistic; 13.85 %, 7.95 %, 5.80 %, 4.90 %, 3.80 % for the mean statistic. On a five-value discrete grid resembling judge scores: 6.02 % at `n = 3` (median), 6.68 % (mean), still 3.43 % at `n = 10` (mean). | This is an intrinsic limit of bootstrapping three points, not an implementation error — scipy's BCa on the same `n = 3` data gives 16.0 %. The defect is the docstring, which states that `low > threshold` means the gain is real at the confidence level. At `n = 3` that claim is wrong by more than 5×. Consumed by `promotion-policy.ts:133`, `held-out-gate.ts:272`, `statistical-heldout.ts:174`, `measured-comparison.ts:995`, `analyze-runs.ts:908`. `pairedBootstrap` now returns `gateEligible`, false below `BOOTSTRAP_GATE_MIN_N = 20`. |
| `pairedRiskDifference` | approximation limit | keep-and-fix | The point estimate and the variance formula both matched the closed form exactly on 6 configurations, but the interval is Wald: empirical coverage against a nominal 95 % is 73.80 % at `n = 5`, 86.48 % at `n = 10`, 93.80 % at `n = 20`, 94.73 % at `n = 200`. With no discordant pairs the variance is exactly zero, so `pairedRiskDifference([0,0,0],[1,1,1])` returns `riskDifference = 1, lower = 1, upper = 1` — a zero-width 95 % interval asserting certainty from three observations, and ten concordant pairs return `[0, 0]`. | The module already ships `wilson` and its own comment block argues against exactly this Wald approach for proportions. A Wilson-style or Tango score interval is the standard fix. |
| `requiredSampleSize`, `requiredPairedSampleSize`, `pairedMde` | approximation limit, **documented** | keep-with-CI-oracle | All three match their stated normal-approximation formulas exactly against `scipy.stats.norm.ppf` closed forms, and are numerically unchanged by the CDF fix because they route through `zQuantile` rather than the forward CDF (`requiredSampleSize({effect: 0.5}) = 63` before and after). They use normal quantiles with no t correction, so they understate required n where n is small: `requiredPairedSampleSize({effect: 0.5})` returns **32** against an exact t-based **34**, and `{effect: 0.8}` returns **13** against **15**. | A 6–13 % shortfall, precisely in the range a caller consults to decide whether 3–10 reps suffice. Both docstrings now say "treat as a lower bound". |

## Correct

These 17 matched their references with zero mismatches and stay as they are, pinned against a golden fixture so they cannot regress silently.

| Statistic | Decision | Measured evidence |
| --- | --- | --- |
| `pairedTTest` (normal range) | keep-with-CI-oracle | Across 166 cases the t statistic matched `scipy.stats.ttest_rel` to `≤ 1.5e-15` and p to `≤ 1e-6` relative in all but 4. Type-I under a true null over 20,000 replicates: 5.20 % at `n = 3`, 4.74 % at `n = 4`, 4.97 % at `n = 6`, 5.17 % at `n = 8`, 5.03 % at `n = 10` — correctly calibrated at this package's actual sample sizes. |
| `mcnemar` | keep-with-CI-oracle | Exact two-sided binomial on discordant pairs; matched `scipy.stats.binomtest` two-sided to `< 1e-9` on all 13 `(b,c)` configurations including `(0,0)`, `(10,0)`, `(100,70)`. A `b = 1, c = 5` case returns `pValue = 0.21875`. Log-space accumulation via `lnGamma` keeps it stable at large counts. |
| `pairedSignTest` | keep-with-CI-oracle | Exact one-sided binomial; matched `scipy.stats.binomtest(..., alternative='greater')` to `< 1e-12` on all 9 cases. `pairedSignTest([0.5,0.5,0.5], 'greater')` returns `0.125`. Ties are excluded from the denominator and still reported; `alternative` must be passed explicitly and an invalid value throws, which prevents post-hoc direction selection. |
| `wilson` | keep-with-CI-oracle | Matched the closed form to `< 1e-8` on all 13 `(successes, n)` pairs including `0/1`, `10/10`, `1/1000`, `0/0`. Correctly asymmetric at the boundaries: `wilson(0, 10)` returns `[0, 0.27753280]`. |
| `passAtK` | keep-with-CI-oracle | Chen et al. 2021 unbiased estimator, exhaustively verified for every `(n, c, k)` with `n = 1..6` against exact integer `math.comb`: zero mismatches. Stable at scale (`n=1000, c=3, k=100` agreed to `1.11e-16`). `passAtK(10, 3, 5) = 0.9166666667`. |
| `corpusInterRaterAgreement` | keep-with-CI-oracle | The ICC(2,1) it surfaces matched a hand-derived two-way random-effects ANOVA reference to `< 1e-9` on 5 matrices, including the inverted case at `−1.959459`. This is a genuinely different and correct computation from `interRaterReliability`: it pivots to a proper items × judges matrix and delegates to `continuousAgreement`. Its fail-loud contract behaves — empty input, fewer than two judges, fewer than two common items, duplicate records, and absent dimensions all throw `ValidationError`. |
| `eProcess` | keep-with-CI-oracle | Betting test-martingale. Empirical type-I over 4,000 sequences of 200 observations at `α = 0.05`: 2.40 % at the null boundary, 0.00 % in the null interior, 1.33 % on continuous uniform — all inside Ville's bound. Power at `E[x] = 0.7` is 99.775 %. The predictability invariant holds: the first update leaves wealth at exactly 1. Restart reconstruction: `state()` carries the running sums (`sumX`, `varSum`) next to wealth and n, and `eProcess({ resume })` rebuilds the process from that snapshot; a process interrupted at any n and resumed from a JSON round-trip of its state reproduces the uninterrupted wealth sequence and decision exactly (`sequential-eprocess.test.ts`, interruptions at n = 0, 1, 7, 30, 119 and at the crossing), and `sequentialPairedGate({ resume })` does the same for the gate's observe-stream. A snapshot recorded under other parameters, or one whose fields cannot all be true at once, is refused. |
| `holm` | keep-with-CI-oracle | Matched `statsmodels.multipletests` to `1e-9` on a 6-value reference vector, and uses `≤` at the boundary, which is the correct rule. It also validates both `alpha` and the p range, which `bonferroni` does not. |
| `zQuantile` | keep-with-CI-oracle | Acklam inverse-normal, structurally independent of `normalCdf`. This independence is why the sample-size functions were untouched by the CDF defect, and why `mcnemarPower`'s failure to invert `mcnemarRequiredN` was a valid detector of it. |
| `mcnemarRequiredN` | keep-with-CI-oracle | Matched the Lachin closed form exactly on all 4 parameter sets: `234`, `77`, `155`, `Infinity`. Unchanged by the CDF fix. Round-trip against the repaired `mcnemarPower` now holds across 16 configurations: power at `requiredN` meets the target with overshoot `≤ 0.0049`, and power at `requiredN − 1` is below target in all 16. |
| `ranks` | keep-with-CI-oracle | Correct average-rank-with-ties. `ranks([3,1,1,2])` returns `[4, 1.5, 1.5, 3]`, matching `scipy.stats.rankdata`. Safe against NaN input because it advances with `i = j + 1`. |
| `pearsonR` | keep-with-CI-oracle | Matched `scipy.stats.pearsonr` to 8 decimals (`0.99061012` on an 8-point case). |
| `spearmanR` | keep-with-CI-oracle | Matched `scipy.stats.spearmanr` to 8 decimals (`0.99402980` on the same case). |
| `cliffsDelta` | keep-with-CI-oracle | Matched a hand-computed `(#gt − #lt)/(n₁n₂)` reference exactly (`0.312500`). Note the orientation is *after over before*, the opposite sign to the textbook `δ` written over `(a, b)`; the docstring states this and the parameter names `(before, after)` carry it. |
| `pairedCohensDz` | keep-with-CI-oracle | Matched `mean(d)/sd(d)` exactly (`2.184070`). It is the only function in the module that handles the zero-variance degenerate case correctly, returning `null` with a docstring explaining that the standardized effect is undefined rather than an arbitrarily large finite number. Treat it as the reference behaviour the other degenerate branches should adopt. |
| `weightedMean`, `partialCredit`, `weightedComposite`, `interpretCliffs`, `normalizeScores` | keep-with-CI-oracle | Arithmetic and thresholding, verified by direct evaluation (`weightedMean` of `[{1,w2},{4,w1}]` is `2.000000`; `partialCredit(3,4)` is `0.750000`). |
| `welchsTTest`, `compareToBaseline` (`src/baseline.ts`) | keep-with-CI-oracle, **covered** | Correct, and previously unguarded: no test file imported either, which is the structural reason a duplicated broken CDF survived here. It is exported publicly and it gates improved / regressed / stable verdicts. Now pinned against `scipy.stats.ttest_ind(equal_var=False)` in the oracle fixture and exercised through `compareToBaseline` in `tests/statistics.test.ts`. |

## Public surface change

`normalCdf` and `studentTCdf` were private on `origin/main` and are now exported with explicit accuracy contracts.
`baseline.ts` owns the single Welch implementation, and `contract/analyze-runs.ts` consumes that result instead of carrying another normal-approximation copy.
That is the right trade: one implementation with one accuracy contract beats three copies of which two were wrong.
It also means both functions are now public API and owe callers a stated accuracy bound.
`normalCdf` is documented at `7.5e-8` absolute.
`studentTCdf` is exact to the incomplete beta's own precision at every finite degree of freedom and matches `scipy.stats.t.cdf` to `1e-9` across the pinned oracle cases; the residual floor near `t = 0` is float64 cancellation in `x = df/(df + t²)`, not the approximation.

## Dependency verdict

**Take no statistics package as a runtime dependency.**
**Use scipy as a CI oracle.**
**Implement the exact small-n rank tests here, because nothing else does.**

### What we must implement ourselves

Four things the survey found no correct implementation of in npm, at any package, under ties:

| Needed | Library that does it correctly |
| --- | --- |
| Exact two-sample rank test under ties | none |
| Exact paired signed-rank test under ties | none |
| Cliff's delta | no package exists in npm at all |
| Paired bootstrap confidence interval | none |

Those four rows are the entire bottleneck, and they are the reason this decision is not close.
`lib-r-math.js` comes closest — it is the only source of the exact two-sample rank-sum null distribution in JavaScript, and it reproduces every exact floor we care about (`pwilcox(0, 3, 3) = 0.100000`, `psignrank` at `n = 5` gives `0.062500`, at `n = 8` gives `0.007813`) at a cost of 2 packages and 1.2 MB.
But its signature is `(q, m, n)` with no tie vector, so ties are structurally unrepresentable, exactly as in R where `wilcox.test` warns and falls back.
It ships distributions, not tests, so the test wrapper, the tie conditioning, and the effect sizes remain ours regardless.

The cost of writing them ourselves is small and was measured, not estimated.
Enumerating every split of the observed data takes 0.1 ms at 3 versus 3 (20 splits), **3.7 ms at 10 versus 10** (184,756 splits), and 33 ms at 12 versus 12 (2,704,156 splits).
Paired sign-flip enumeration is `2ⁿ`: 1,024 at `n = 10`, about 1 M at `n = 20`.
The entire stated 3–10 repetition regime runs exact in under 4 ms.
This is roughly 150 lines, not a research project.

### What we must not take as a runtime dependency

The libraries that are correct are correct at things this module already gets right.

`@stdlib/stats-padjust` matches `statsmodels.multipletests` to `1e-9` on `holm`, `bh`, and `bonferroni`, and so does this module's own `holm`, `benjaminiHochberg`, and `bonferroni` on the same frozen reference vectors.
It was removed even as a development dependency because it bought zero additional coverage for 190 locked packages.
`@stdlib/stats-ranks` and `jstat.rank` both do average-rank-with-ties correctly, and so does `ranks` here.
`@sipemu/anofox-statistics`'s count-based exact tests are correct (`fisherExact([[3,0],[0,3]]) = 0.09999999999999992`, `binomTest(3,3,0.5) = 0.25000000000000006`, `mcnemarExact = 0.21875000000000008`), and so are `mcnemar` and `pairedSignTest` here.

Meanwhile the libraries that cover the missing statistics are wrong in this regime, sometimes worse than the incumbent:

- `@stdlib/stats-kruskal-test` matches `scipy.kruskal` to `1e-9` but is anti-conservative against the exact conditional truth in 7 of 8 cases: `p = 0.0495` against an exact `0.1000` at 3 versus 3, and `p = 0.4945` against an exact `1.0000` on a binary grid — off by `0.5055`. It returns a silent `NaN` on all-tied input rather than throwing. Measured cost: 286 packages, 11,997,061 bytes, 4,033 files.
- `@sipemu/anofox-statistics`'s `mannWhitneyU` returns `p_value = 0` for two **identical** samples, verified on four inputs including `x = y = [0.5,0.5,0.5]`, where the truth is `p = 1.0`. Its documented `exact` flag is a silent no-op under ties: all five tied cases returned byte-identical p for `exact: true` and `exact: false`.
- `@stdlib/stats-wilcoxon` has a genuine exact path but silently switches to the normal approximation when the differences contain ties, with nothing in the result to signal it — the `method` string is identical either way. Holding the statistic constant at `W = 15, n = 5`, untied input returns the exact `0.062500` and tied input returns `0.053337`, a p-value below the exact floor and therefore one that cannot exist at `n = 5`.
- `simple-statistics`'s `wilcoxonRankSum` returns the wrong rank sum on 5 of 9 regime cases; every case with two or more tie groups is corrupted. The tie accumulator is reset only in the single-element branch, so a multi-element group's average spans from the previous group's start. Upstream PR #809 carries a fix and a regression test, opened 2026-07-08, still open with no maintainer response.
- `mann-whitney-utest` and `@tainakanchu/mann-whitney-utest` (byte-identical source) compare a U statistic against a z-score in their significance decision, so the comparison is dimensionally meaningless. Complete separation at 3 versus 3 reports `significant = true` where no result at that size can reach `α = 0.05`.
- `jstat` (last published 2022-11-21) has no Mann-Whitney, no Wilcoxon, no Kruskal, no p-adjust. `science.js` (last published 2015-08-20) has zero hypothesis tests.

Dependency weight is a real cost, not a stylistic one.
This package's entire runtime dependency set is 7 packages.
Adding 190–286 for statistics we already compute correctly would be inherited by every consumer of `@tangle-network/agent-eval`.

### What scipy is for

scipy is the CI oracle and never ships.

Pin scipy-generated golden values as a JSON fixture under `tests/`, regenerated by a checked-in script, and assert every **keep-with-CI-oracle** statistic against it.
That is `scripts/generate-statistics-oracle.py` → `tests/fixtures/statistics-oracle.json`, asserted by `tests/statistics-oracle.test.ts`: 154 cases across 22 statistics, each carrying its own tolerance (`7.5e-8` where A&S bounds it, `1e-8` where Acklam's inverse normal does, `1e-12` elsewhere).
scipy 1.13.1 was the reference for every number in this document and it catches exactly the class of defect found here: a hand-rolled approximation that is plausible on inspection and wrong by `3.7e-2`.
`lib-r-math.js` is a **devDependency only**, cross-checking the untied exact null distributions in `tests/statistics-library-crosscheck.test.ts`.
The three correction functions are independently covered by the statsmodels-generated fixture.
Neither reference implementation is imported by `src/`.
`fast-check` is already a devDependency, so the invariants that no fixture can express — a p-value never below the attainable floor, monotonicity of p in the statistic, an exact and an asymptotic path agreeing as `n` grows — belong there.

## Exact versus asymptotic policy

The governing fact is combinatorial, not numerical.
At 3 versus 3 there are only 20 possible splits, so the attainable two-sided p-grid is `{0.1, 0.2, …}` and `0.05` is unreachable.
`[1,2,3]` versus `[4,5,6]` and `[0,0,0]` versus `[1,1,1]` both have an exact `p = 0.1000`, while scipy's tie-corrected asymptotic gives `0.080856` and `0.046854` — **adding the tie correction makes the answer worse.**
No better approximation reaches the right answer here; only an exact test does.

### Switchover thresholds

| Test | Exact by enumeration | Seeded Monte Carlo permutation | Asymptotic |
| --- | --- | --- | --- |
| Two-sample rank (`mannWhitneyU`) | dynamic program up to 8,192 cells and 250,000 transitions; includes 12 v 12 and 1 v 24 | above that, default 100,000 permutations | never the default; only on explicit request above the exact work limits |
| Paired signed-rank (`wilcoxonSignedRank`) | `n ≤ 20` — `2²⁰ = 1,048,576` sign flips | above that, default 100,000 sign flips | same |
| Paired sign test (`pairedSignTest`) | always exact — binomial, already correct | — | never |
| McNemar (`mcnemar`) | always exact — binomial, already correct | — | never |
| Paired mean difference (`pairedTTest`) | — | — | valid from `n ≥ 3`, now that the `incompleteBeta` symmetry branch is in place |
| Bootstrap interval (`confidenceInterval`, `pairedBootstrap`) | — | — | **not a valid gate below `n = 20`** |

The bootstrap row is the strongest recommendation here and the one most likely to be resisted.
Measured `P(low > 0)` under a true null against a nominal 2.5 % never reaches nominal in the tested range: 13.53 % at `n = 3`, 3.52 % at `n = 10`, 3.10 % at `n = 20` for the median statistic, and 13.85 % / 4.90 % / 3.80 % for the mean.
Below `n = 20` the bootstrap interval should be reported as descriptive spread and must not be the leg a promotion turns on; the exact sign test or exact signed-rank should carry the decision instead.

### What to do when the caller asks for a misleading number

Refuse, loudly, in the package's own idiom.

Every rank test takes `method: 'exact' | 'asymptotic' | 'auto'`, defaulting to `'auto'`.
`'auto'` selects exact whenever the design is inside the enumeration threshold, Monte Carlo permutation above it, and asymptotic never.
An explicit `method: 'asymptotic'` inside the exact-feasible range **throws a `ValidationError`** naming the smallest attainable p at that design and the exact work limits.
An explicit `method: 'exact'` ABOVE the threshold throws too, rather than enumerating a distribution whose cost is unbounded.

This is a refusal, not a warning, and the reason is the package's own doctrine.
A warning on `stderr` does not reach the JSON a gate reads, does not reach a CI log a human skims, and does not survive serialization into a run record.
An anti-conservative p that a gate silently believes is exactly the class of silent fallback that *no fallbacks, fail loud* exists to prevent, and the `wilcoxonSignedRank` `n < 6` branch was the proof: it returned `p = 1` for real effects from v0.1.0 to 0.133.0 and nothing downstream could tell.

The cost of the refusal is real and is stated here rather than discovered later: an explicit-asymptotic caller at 3 v 3 who was reading `0.0495` now gets an exception, and the same design read through the default now reports `0.1000`.
A historical verdict that turned on the difference was never valid.

Two supporting requirements make the refusal usable rather than merely obstructive.

Every rank-test result carries `method` and `pFloor` — the method actually used and the smallest attainable p at that design — so a downstream gate can see the discreteness rather than infer it.
This is the field `@stdlib/stats-wilcoxon` omits, which is why its silent exact-to-approximate switch is undetectable by a caller.
`pairedBootstrap` carries the same signal as `gateEligible`.

Still to do: every gate that consumes a rank test should state its minimum n at construction and fail its own precondition check when the data is smaller, rather than accepting whatever the test returns.
A gate that cannot reach its alpha at the n it was handed should report *underpowered*, which is a true statement about the experiment, not *not significant*, which is a false statement about the effect.
`pFloor` and `gateEligible` make that check expressible.
Promotion paths now use `pairedDeltaTest`: an exact one-sided sign test carries decisions from 6 through 19 pairs, and the bootstrap interval carries them from 20 onward.

## Consumer notice

Every published version from **0.1.0 (2026-04-20)** through **0.133.0 (2026-07-27)** reported p-values that are too small from the functions listed below.
The defect entered at the initial commit (`7d5032b`, `src/statistics.ts:747`) and was present in every release since.

The normal CDF itself was corrected in 0.133.1; every other row below was still open at that release.

### Which functions, and by how much

| Function | Path to the defect | Direction | Measured |
| --- | --- | --- | --- |
| `mannWhitneyU` | `normalCdf`, then the asymptotic path itself | p too small | `[1,2,3]` v `[4,5,6]`: reported `0.03769147`. Repairing the CDF alone gives `0.04953448` (1.31×); the shipped exact answer is `0.10000000` (2.65×), and `0.05` is unreachable at 3 v 3 in the first place. `[1..5]` v `[10..14]`: reported `0.00671001`, shipped exact `0.00793651` (1.18×). |
| `wilcoxonSignedRank` | `normalCdf`, then the asymptotic path itself | p too small, or fabricated as 1 | `n = 8` constant shift: reported `0.00873623`, CDF-repaired `0.01171872`, shipped exact `0.00781250`. Below six non-zero differences the old code returned `p = 1` regardless of the data: a clean 5-of-5 shift reported `1.0` where the exact answer is `0.0625`. |
| `pairedTTest` at `df > 100` | deleted `studentTCdf` normal shortcut | p too small | A `df = 298` case: reported `0.010887`, correct Student-t `0.015150`. |
| `welchsTTest`, `compareToBaseline` | duplicate `normalCdf` in `baseline.ts` | p too small | Same `df = 298` case, same shift. This drives the improved / regressed / stable verdict at `baseline.ts:97`. |
| `mcnemarPower` | `normalCdf` | power **overstated** above 0.5, understated below | `{p10: 0.2, p01: 0.1, nPairs: 200}`: reported `0.773437`, correct `0.736522`. At `n = 80`: `0.9368` against `0.9197`. At `n = 20`: `0.3294` against a correct `0.3627`. |
| `pairedTTest` at `df ≤ 100`, small `\|t\|` | `incompleteBeta` — **fixed** | p wildly too small near `t = 0` | `df = 7, t = 0.001`: reported `0.15130173`, correct `0.99923002`. `df = 100, t = 1e-6`: reported `0.00004411`, correct ≈ `1.0`. |
| `interRaterReliability` | grouping loop — **fixed** | sign inverted | Identical judges return `−0.500000`; maximally disagreeing judges return `+1.000000`. |

`requiredSampleSize`, `requiredPairedSampleSize`, `pairedMde`, `mcnemarRequiredN`, `mcnemar`, `pairedSignTest`, `wilson`, `passAtK`, `corpusInterRaterAgreement`, `eProcess`, `holm`, `ranks`, `pearsonR`, `spearmanR`, `cliffsDelta`, and `pairedCohensDz` are **unaffected** — verified numerically identical before and after (`requiredSampleSize({effect: 0.5}) = 63`, `mcnemarRequiredN({p10: 0.2, p01: 0.1}) = 234` both ways).

### How to re-check a decision you already made

The defect is monotone in `|z|`, so the affected band is exact and narrow.

The broken code crossed `p = 0.05` at `|z| = 1.843031` instead of the correct `1.959964`, and at that true critical value it reported `p = 0.038053`.
Therefore:

- **Any recorded p in `[0.038053, 0.050000)` from an affected function crossed a 5 % gate that it should not have crossed.**
- At `α = 0.01` the band is `[0.007443, 0.010000)`.
- At `α = 0.10` the band is `[0.077398, 0.100000)`.
- A recorded p below `0.038053` was significant at 5 % either way; a recorded p at or above `0.05` was not significant either way. Neither needs re-checking.

The practical size of the error: the module's real type-I error rate was **6.53 % at a nominal 5 %** and **1.34 % at a nominal 1 %**, confirmed by 20,000 null replicates at `n = 8` per group where `mannWhitneyU` rejected at 6.47 % as shipped against 4.86 % with the same U and z fed a correct CDF.

Three further cautions for anyone auditing an old verdict.

A promotion that turned on a `pairedBootstrap` `low > 0` check at fewer than 10 pairs was never valid at the stated confidence, independent of this defect — the measured false-positive rate is 13.53 % at `n = 3` against a nominal 2.5 %.

A `wilcoxonSignedRank` leg that reported `p = 1` on fewer than six non-zero differences measured nothing.
It is not evidence of no effect, and re-running it on this release returns a real exact p.
Note that exact ties are dropped before ranking, so ten pairs with five tied deltas also fell into that branch.

Any bootstrap interval recorded from a release at or before 0.133.0 through `analyze-runs.ts` is not reproducible: that call site passed no seed and `makeRng` fell back to `Math.random`.
Re-running it against the old release will not give the same interval. From this release the seed is derived from the data when the caller supplies none, so it is reproducible either way — but an interval recorded earlier cannot be reconstructed.

Mirror this section into `CHANGELOG.md` at the release that carries the fix, with the affected version range and the re-check bands, so a consumer who never reads this file still gets the notice.

## Random-source audit

Every `Math.random` reference in `src/`, what it feeds, and whether a reported number depends on it.
The rule this audit enforces: **no result-bearing draw may come from an unseeded source.**
A result-bearing draw is one whose value reaches a reported statistic, an interval, a gate verdict, or an allocation a caller acts on.

The canonical seeded generator is `mulberry32` in `src/statistics/random.ts`, reached through `makeRng(seed, ...series)` in `src/statistics/internal.ts`.
`makeRng` derives the seed from the observations when the caller supplies none, so an unseeded call is still reproducible: same input, same interval.
That is why the option stays optional — a required seed would push the caller into inventing one, and an invented seed is not more honest than a derived one.

### Result-bearing draws — all seeded

| Site | Formula | Consumer | Seed source |
| --- | --- | --- | --- |
| `statistics/internal.ts` `makeRng` | mulberry32 | every resampling path in `src/statistics` | caller seed, else FNV-1a over the IEEE-754 bytes of the observations |
| `statistics/descriptive.ts` `confidenceInterval` | percentile bootstrap | reported interval | `makeRng(opts.seed, scores)` |
| `statistics/paired-tests.ts` `pairedBootstrap` | paired percentile bootstrap | promotion intervals | `makeRng(opts.seed, deltas)` |
| `statistics/rank-tests.ts` `mannWhitneyU`, `wilcoxonSignedRank` | permutation null | exact rank-test p | `makeRng(opts.seed, …)`, order-independent for the symmetric two-sample case |
| `promotion-gate.ts` | bootstrap over the two arms | ship / hold verdict | `options.seed`, else `hashSeed(baseline, candidate)` |
| `held-out-gate.ts` | delegates to `pairedBootstrap` | held-out gate verdict | caller seed, else the paired observations |
| `summary-report.ts` `bayesianBootstrapMeanSamples` | Dirichlet-weight bootstrap | reported posterior and gain histogram | `makeRng(seed, deltas)` |
| `meta-eval/rubric-predictive-validity.ts` `bootstrapCi` | percentile bootstrap of Pearson r | rubric verdict (`load_bearing` / `informative`) | `makeRng(input.seed, xs, ys)` |
| `meta-eval/correlation-study.ts` `bootstrapPearsonCi` | percentile bootstrap of Pearson r | reported correlation CI | `makeRng(options.seed, xs, ys)` |
| `rl/active-curriculum.ts` `thompsonCurriculum` | Beta posterior sampling | sample-budget allocation | `makeRng(opts.seed, scores)` |
| `rl/adaptation-eval.ts` `compareAdaptationCurves` | bootstrap of per-k mean deltas | per-k CI and AUC delta | `makeRng(opts.seed, a-means, b-means)` |
| `campaign/gates/sequential.ts` | seeded Fisher-Yates over paired deltas | exchangeability guard before the e-process | `shuffleSeed`, default 1337, data-independent by construction |

### Draws that reach no result

These stay on `Math.random`. Each produces an identifier or a retry delay; no reported number reads them, and seeding them would make two concurrent runs collide on the same identifier.

| Site | Formula | What it feeds |
| --- | --- | --- |
| `llm-client.ts:1050` | `Date.now().toString(36)` + random suffix | per-call identifier in the ledger tag |
| `trace/emitter.ts:350` | same | span identifier |
| `builder-eval/builder-session.ts:255` | same | builder session identifier |
| `campaign/worktree/index.ts:697` | same, 4-character suffix | worktree branch name |
| `matrix/runner.ts:67` | 8 hex characters | matrix run identifier |
| `adapters/http.ts:152,162` | `2^attempt * 200 + random * 200` | retry backoff jitter |
| `hosted/client.ts:128,138` | same | retry backoff jitter |

### What changed in this pass

Five byte-identical private copies of mulberry32 existed alongside the canonical one, in `meta-eval/rubric-predictive-validity.ts`, `rl/active-curriculum.ts`, `rl/adaptation-eval.ts`, `summary-report.ts`, and `promotion-gate.ts`.
Four of them fell back to `Math.random` when the caller passed no seed, so four reported statistics were silently non-reproducible.
`meta-eval/correlation-study.ts` called `Math.random` directly inside its bootstrap and had no seed option at all.
All six now route through `makeRng`, and `correlationStudy` gained the `seed` option its sibling already had.
`Math.random` references in `src/` fell from 19 to 10, and none of the remaining ten is result-bearing.

## Test and documentation classification

The audit in #411 counted assertions that prove nothing, module mocks, and conditional skips. The disposition:

**No-throw assertions.** 66 `expect(...).not.toThrow()` sites across 36 files. They split in two:

- *A guard's accept case.* `assertLlmRoute`, `assertNoHiddenLeak`, `assertCapabilityHeadroom`, `assertMultishotShotResult`, `assertMatchedMethodLimits`, `assertGateReport`, `assertAnalystBenchmarkObservation`, `assertDeterministicOracle`, `assertDenominatorIntact`, and `assertJsonValue` return nothing. For these the no-throw IS the assertion: it pins the false-positive boundary of a fail-closed gate, and a gate that refuses a legal input is as broken as one that admits an illegal one. Each sits next to a `toThrow` sibling that proves the refusal. Kept.
- *A value-returning call.* `validateRunRecord` and friends return the validated value, so the no-throw discarded the only thing worth checking. Converted to assert the returned value.

**Module mocks.** 5 sites, each now carrying a one-line justification in its file header: four wrap a `node:` builtin to reproduce a race or an absent native binding that a real filesystem cannot be timed into (`trace/store.test.ts`, `analyst/benchmark-verification-artifacts.test.ts`, `analyst/benchmark-command-public-data.test.ts`, `rollout/readers/opencode-sqlite-lazy.test.ts`); one replaces the provider call in the wire handler test, which is about request validation and error mapping (`tests/wire/handlers.test.ts`).

**Conditional skips.** 6 sites, all environment-gated, none silent:

| Site | Gate | Why |
| --- | --- | --- |
| `command-runner.test.ts:148` | `process.platform === 'win32' \|\| getuid() === 0` | POSIX permission bits do not constrain root or Windows |
| `ledger-core/trusted-head.test.ts:473` | same, as `runIf` | the same permission assumption |
| `analyst/benchmark-command-public-data.test.ts:72` | `process.platform === 'win32'` | POSIX path semantics |
| `analyst/kinds/skill-usage.test.ts:198` | `SKILL_USAGE_REAL` | needs a real skill corpus on disk |
| `tests/campaign/gepa-official-integration.test.ts:22` | `AGENT_EVAL_TEST_PYTHON` | needs the official GEPA python environment; CI sets it |
| `tests/campaign/skillopt-official-integration.test.ts:22` | `AGENT_EVAL_TEST_PYTHON` | needs the official SkillOpt python environment; CI sets it |

The two python-gated files run in CI, which installs the environment; the platform gates never skip on CI's Linux runner.

## Runnable-fence sweep

A one-time pass, not a build gate. The 73 Markdown files under `docs/`, `examples/`, the two READMEs, `CLAUDE.md`, and the maintainer skill hold 66 fences marked `ts`.
Each was extracted to a file and compiled with the examples compiler options, with `@tangle-network/agent-eval` and every subpath mapped to `src/`, so the check reads the surface this repository ships rather than the version installed in `node_modules`.
Reading the installed copy is the trap: it reports every export added since the last release as missing, which is how a fence check produces false alarms and gets switched off.

Result:

- **3 fences were not TypeScript** and are now marked `text`: an object fragment in `campaign-proposers.md`, a call elided as `{ ... }` in `feedback-trajectories.md`, and a method sketch in `examples/benchmarks/README.md`.
- **2 fences imported a path that cannot resolve** — `@tangle-network/agent-eval/../src/trace-repair` in `trace-repair-admission.md` and `trace-repair-continuation.md` — now `@tangle-network/agent-eval/trace-repair`.
- **0 of the remaining 63 name an export that does not exist.** Every symbol a fence imports is on the current surface.
- The remaining compiler complaints are inherent to an excerpt: a name declared in the prose around it, a shorthand property, top-level `await` outside a module. Three fences import a deliberate placeholder (`your-text-optimizer`, `./my-engine`).

There is no fence checker in `scripts/` and no CI job. Compiling illustrative snippets fails builds for prose edits, and the failure mode it catches — a doc naming a symbol that no longer exists — is what the export census and review already cover. Repeat this pass by hand after a large surface change.
