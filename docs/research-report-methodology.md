# researchReport — methodology

This document is the methodological brief for `researchReport` (exported from
`@tangle-network/agent-eval` and `@tangle-network/agent-eval/reporting`). It
exists so a launch reviewer, peer reviewer, or auditor can quickly verify that
the verdict embedded in any rendered report is defensible, reproducible, and
appropriate to the data.

The companion code is `src/summary-report.ts`. Each item below names the
corresponding function or option so the doc and the code don't drift.

## Inputs

- `runs: RunRecord[]` — every record carries `runId`, `candidateId`, `seed`,
  `experimentId`, `splitTag`, and an `outcome` with the configured score.
- `comparator: string` — the candidate id treated as the null reference. Must
  be selected before data inspection; `preregistrationHash` should pin this.
- `split: 'search' | 'holdout'` — defaults to `holdout`. Decisions on `search`
  are descriptive only; promotion calls require the holdout.
- `rope: { low, high }` — Region of Practical Equivalence on the paired delta,
  in score units. Must come from the domain owner — there is no
  statistically-defensible default.
- `minPairs` (soft floor, default 20) and `RESEARCH_REPORT_HARD_PAIR_FLOOR`
  (hard floor, 6). Below the soft floor, the verdict is `needs_more_data` and
  the report carries the MDE at the current N.
- `fdr` (default 0.05), `confidence` (default 0.95), `mdePower` (default 0.8),
  `mdeAlpha` (default = `fdr`).

## Pairing

Pairs are joined by `(experimentId, seed)` so the comparator and candidate
share scenario *and* seed. This is the same join `gainHistogram` uses; see
`pairScoresByKey` in `src/summary-report.ts`. Records on the wrong split or
with non-finite scores are dropped before pairing.

## Decision rule

In order — first match wins:

1. `comparator` itself → `hold` (baseline).
2. No comparator → `hold` if on the cost/quality Pareto frontier, else
   `needs_more_data`. The verdict is descriptive, not causal.
3. Held-out gate verdict ≠ `promote` → `reject`. The gate is *necessary but
   not sufficient*; even a `promote` gate must clear the paired test below.
4. Paired N < `RESEARCH_REPORT_HARD_PAIR_FLOOR` → `needs_more_data` with a
   "below hard floor" reason. Bootstrap CIs degenerate at this size.
5. ROPE configured AND paired-delta CI ⊂ ROPE → `equivalent`.
6. Paired-delta CI upper bound < 0 → `reject` (CI excludes a non-negative
   effect). Note: this uses **paired delta only** — not the marginal mean.
7. Paired N < `minPairs` (soft floor) → `needs_more_data` with the MDE at
   current N attached so the verdict is actionable.
8. BH-adjusted q ≤ `fdr` AND CI lower bound > 0 → `promote`. The BH q-value
   controls FDR across all candidates in the same sweep; the bootstrap CI
   provides an effect-size guarantee independent of the test.
9. Otherwise → `hold`.

## Statistical primitives used

| Quantity | Function | Source file |
|---|---|---|
| Marginal CI on score mean | `confidenceInterval` | `statistics.ts` |
| Cohen's d vs comparator | `cohensD` | `statistics.ts` |
| Wilcoxon signed-rank (paired) | `wilcoxonSignedRank` | `statistics.ts` |
| BH-FDR q-values | `benjaminiHochberg` | `power-analysis.ts` |
| Paired bootstrap CI on median delta | `pairedBootstrap` | `paired-stats.ts` |
| Bayesian-bootstrap-style Pr(Δ>0), Pr(Δ∈ROPE) | `bootstrapMeanSamples` | `summary-report.ts` (private) |
| Minimum detectable paired effect | `pairedMde` | `power-analysis.ts` |
| Run fingerprint | `hashJson(canonicalize(...))` | `pre-registration.ts` |

The Pr(Δ>0) and Pr(Δ∈ROPE) summaries use the bootstrap-prior duality of
[Rubin 1981]: under a non-informative Dirichlet prior, the bootstrap
distribution of a sample statistic is its posterior. We expose these as
posterior summaries on the **mean** delta and the bootstrap CI on the
**median** delta — the median is more robust to the heavy-tailed score
distributions seen in agent benchmarks; the mean lets us read off the
Bayesian-style probability of superiority in a single number.

## MDE

The minimum detectable paired effect at N pairs, two-sided α, and power β:

$$d_\text{min} = \frac{z_{1-\alpha/2} + z_\beta}{\sqrt{n}}$$

reported on the standardised scale, then multiplied by the observed paired-
delta SD to get the MDE in score units. Consumers reading a `needs_more_data`
verdict can use the MDE to budget the next round of runs:

- Observed paired SD = 0.10 score units, paired N = 20, α = 0.05, β = 0.8 →
  d_min ≈ 0.63 standardised → MDE ≈ 0.063 score units. If the smallest
  effect that would change a launch decision is below this, run more pairs.

## Provenance

Every report carries:

- `runFingerprint`: SHA-256 over the canonicalised list of
  `(runId, candidateId, splitTag)` triples (sorted by runId), plus the
  comparator id and split. Same `(runs, comparator, split)` produces the same
  fingerprint regardless of input order.
- `preregistrationHash`: the caller passes the hash of a signed
  `HypothesisManifest` (see `pre-registration.ts`). The fingerprint and the
  preregistration hash together let a reader verify both *what data the
  report saw* and *what protocol it was supposed to run.*

Reports without a `preregistrationHash` carry a "post-hoc" warning in the
risks list and the executive summary. Treat them as descriptive only.

## Alternatives considered

- **Paired t-test instead of Wilcoxon + bootstrap.** Rejected: agent score
  distributions are heavy-tailed (judges saturate near 0 and 1) and the t
  approximation breaks down with the small N typical of holdouts.
- **Unpaired Mann–Whitney.** Rejected: matched scenarios make pairing free,
  and unpaired tests throw away the variance reduction. Use the paired test
  by default.
- **Sequential / always-valid inference (e-values, mSPRT, alpha-spending).**
  Out of scope for a single-look report. If users iterate, wrap this report
  in an alpha-spending schedule, or commit to one preregistered look.
- **Hierarchical Bayesian shrinkage across many candidates.** Future work.
  The current ranking is on raw paired statistics and over-credits the top
  candidate when many are tested.
- **Calibration / coverage simulation on the bootstrap CI.** Future work; we
  rely on the asymptotic guarantee plus the hard pair floor to keep coverage
  reasonable.

## When NOT to apply

- Paired N below the hard floor (6) on any candidate.
- Comparator chosen by inspecting the data (post-hoc selection inflates
  false-discovery rates beyond the BH guarantee).
- Mid-run distribution shift: judge model swap, rubric change, infrastructure
  outage. Pair exchangeability is violated and the bootstrap is not valid.
- Scenarios drawn non-randomly from a stream the candidate can influence
  (data-leak across runs). The pairing is no longer ignorable.
- Highly skewed cost distributions: the Pareto frontier still works but the
  marginal CI on cost may be misleading.

## Citations

- Benjamini, Y. & Hochberg, Y. (1995). Controlling the false discovery rate:
  a practical and powerful approach to multiple testing. *JRSS B*,
  57(1), 289–300.
- Wilcoxon, F. (1945). Individual comparisons by ranking methods.
  *Biometrics Bulletin*, 1(6), 80–83.
- Efron, B. (1979). Bootstrap methods: another look at the jackknife.
  *Annals of Statistics*, 7(1), 1–26.
- Rubin, D. B. (1981). The Bayesian bootstrap.
  *Annals of Statistics*, 9(1), 130–134.
- Kruschke, J. K. (2018). Rejecting or accepting parameter values in
  Bayesian estimation. *Advances in Methods and Practices in
  Psychological Science*, 1(2), 270–280. (ROPE.)
- Howard, S. R., Ramdas, A., McAuliffe, J., Sekhon, J. (2021).
  Time-uniform, nonparametric, nonasymptotic confidence sequences.
  *Annals of Statistics*, 49(2), 1055–1080. (Background reading on
  always-valid inference for sequential extensions.)
