#!/usr/bin/env python3
"""Regenerate the scipy golden fixture that pins `src/statistics.ts`.

scipy is a CI oracle. It is never a runtime dependency of this package and
never ships; it exists so that a hand-rolled approximation cannot drift into
being plausible on inspection and wrong by 3.7e-2, which is exactly the class
of defect this fixture was built to catch.

Usage:
    python3 scripts/generate-statistics-oracle.py

Writes tests/fixtures/statistics-oracle.json. Rerun and commit the diff when a
case is added; a changed value on an UNCHANGED case is a regression, not a
fixture that needs updating.

Requires scipy and statsmodels. Pinned reference versions are recorded in the
fixture header; a different version is allowed but must be recorded.
"""

from __future__ import annotations

import json
import math
import pathlib
import sys

import numpy as np
import scipy
import statsmodels
from scipy import stats
from statsmodels.stats.multitest import multipletests

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "statistics-oracle.json"

# Bound of the Abramowitz & Stegun 7.1.26 rational approximation to erf, as it
# propagates: |erf error| <= 1.5e-7, so |Phi error| <= 7.5e-8 and a two-sided
# tail 2*(1 - Phi) is good to 1.5e-7.
PHI_TOL = 7.5e-8
TAIL_TOL = 1.5e-7
# Acklam's inverse-normal has relative error < 1.15e-9, so anything routed
# through zQuantile (wilson, pairedMde, the paired risk difference) inherits
# roughly 1e-9 absolute. This is the module's stated accuracy, not slack.
Z_TOL = 1e-8
# Everything else is closed-form or exact-integer arithmetic in double.
EXACT_TOL = 1e-12


def case(fn: str, args: list, expect, tolerance: float, note: str = "") -> dict:
    entry = {"fn": fn, "args": args, "expect": expect, "tolerance": tolerance}
    if note:
        entry["note"] = note
    return entry


def normal_cdf_cases() -> list[dict]:
    xs = [-4, -2.5758293035489004, -1.959963984540054, -1, -0.567, 0, 0.5, 0.565,
          1.2815515655446004, 1.6, 1.6448536269514722, 1.959963984540054,
          2.5758293035489004, 3.2905267314919255, 3.890591886413094, 5]
    return [case("normalCdf", [x], float(stats.norm.cdf(x)), PHI_TOL) for x in xs]


def student_t_cases() -> list[dict]:
    # df <= 100 exercises the incomplete beta including its symmetric branch;
    # df > 100 is deliberately the normal approximation and is pinned against
    # scipy.stats.norm rather than scipy.stats.t.
    pairs = [(0.005, 100), (0.001, 7), (1e-6, 7), (0.02, 3), (0.058, 100),
             (0.5, 2), (1.0, 5), (1.96, 60), (2.0, 7), (-2.0, 7), (3.5, 12),
             (10.0, 5), (0.0, 5), (2.5, 100), (-1.3, 40)]
    out = [case("studentTCdf", [t, df], float(stats.t.cdf(t, df)), 1e-9,
                "float64 cancellation in x = df/(df+t^2) floors this near t = 0")
           for t, df in pairs]
    for t, df in [(2.442903, 298), (1.5, 500)]:
        out.append(case("studentTCdf", [t, df], float(stats.norm.cdf(t)), PHI_TOL,
                        "df > 100 is the normal approximation by design"))
    return out


def paired_t_cases() -> list[dict]:
    designs = [
        ([0.4, 0.5, 0.6, 0.7, 0.8, 0.5, 0.6, 0.7], [0.6, 0.7, 0.8, 0.9, 1.0, 0.7, 0.8, 0.9]),
        ([0.5, 0.6, 0.4, 0.7, 0.5, 0.6], [0.6, 0.5, 0.5, 0.6, 0.5, 0.55]),
        ([1, 2, 3], [1.5, 2.4, 2.9]),
        ([0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.5, 0.5],
         [0.2, 0.85, 0.35, 0.7, 0.45, 0.75, 0.4, 0.68, 0.55, 0.6]),
    ]
    out = []
    for before, after in designs:
        r = stats.ttest_rel(after, before)
        out.append(case("pairedTTest", [before, after],
                        {"t": float(r.statistic), "df": float(len(before) - 1),
                         "p": float(r.pvalue)}, EXACT_TOL))
    return out


def welch_cases() -> list[dict]:
    designs = [
        ([0.4, 0.5, 0.6, 0.55, 0.45, 0.5], [0.7, 0.8, 0.75, 0.72, 0.78, 0.74]),
        ([1, 2, 3, 4, 5], [2, 3, 4, 5, 6]),
        ([10, 12, 14, 16], [11, 11, 15, 15]),
        ([100, 101, 102, 103, 100, 101], [140, 141, 142, 143, 140, 141]),
    ]
    out = []
    for a, b in designs:
        # The module reports (mean(b) - mean(a)) / se, so b is the first arg.
        r = stats.ttest_ind(b, a, equal_var=False)
        out.append(case("welchsTTest", [a, b],
                        {"t": float(r.statistic), "df": float(r.df), "p": float(r.pvalue)},
                        EXACT_TOL))
    return out


def mann_whitney_cases() -> list[dict]:
    """Untied designs only.

    scipy's method='exact' ignores ties (it warns and uses the untied null), so
    a tied design has no scipy reference. The module conditions on the observed
    tie pattern, which is the correct exact test and is pinned in
    tests/statistics.test.ts against brute-force enumeration instead.
    """
    designs = [([1, 2, 3], [4, 5, 6]), ([1, 2, 3, 4, 5], [10, 11, 12, 13, 14]),
               ([1, 3, 5, 7], [2, 4, 6, 8]), ([1, 2], [3, 4]),
               (list(range(1, 13)), list(range(13, 25))),
               ([0.1, 0.4, 0.9, 1.4, 2.2], [0.2, 0.5, 1.1, 1.5, 3.0])]
    out = []
    for a, b in designs:
        exact = stats.mannwhitneyu(a, b, alternative="two-sided", method="exact")
        out.append(case("mannWhitneyU.exact", [a, b],
                        {"u": float(min(exact.statistic, len(a) * len(b) - exact.statistic)),
                         "p": float(exact.pvalue)}, EXACT_TOL))
    big_a = list(range(1, 15))
    big_b = list(range(8, 22))
    asym = stats.mannwhitneyu(big_a, big_b, alternative="two-sided",
                              method="asymptotic", use_continuity=True)
    out.append(case("mannWhitneyU.asymptotic", [big_a, big_b], {"p": float(asym.pvalue)},
                    TAIL_TOL, "tie-corrected variance plus continuity correction"))
    return out


def wilcoxon_cases() -> list[dict]:
    """Untied |differences| only, for the same reason as the two-sample test."""
    designs = [([0, 0, 0, 0, 0], [0.5, 0.9, 1.4, 2.0, 2.7]),
               ([0, 0, 0], [0.5, 0.9, 1.4]),
               ([1, 2, 3, 4, 5, 6], [2.5, 1.4, 4.7, 3.1, 6.9, 5.2]),
               (list(range(1, 11)), [2.1, 3.2, 4.3, 5.4, 6.5, 7.6, 8.7, 9.8, 10.9, 12.1])]
    out = []
    for before, after in designs:
        d = np.asarray(after, dtype=float) - np.asarray(before, dtype=float)
        r = stats.wilcoxon(d, alternative="two-sided", method="exact", zero_method="wilcox")
        w_plus = float(sum(rank for rank, delta in zip(stats.rankdata(np.abs(d)), d) if delta > 0))
        out.append(case("wilcoxonSignedRank.exact", [before, after],
                        {"w": w_plus, "p": float(r.pvalue)}, EXACT_TOL))
    return out


def sign_and_mcnemar_cases() -> list[dict]:
    out = []
    for diffs in [[0.5, 0.5, 0.5], [1, -1, 1, 1, -1, 1, 1], [0, 0, 0],
                  [0.2, 0.3, 0, -0.1, 0.4, 0.5, 0.1, 0]]:
        n = sum(1 for d in diffs if d != 0)
        pos = sum(1 for d in diffs if d > 0)
        neg = sum(1 for d in diffs if d < 0)
        for alt, successes in (("greater", pos), ("less", neg)):
            p = 1.0 if successes <= 0 else float(
                stats.binomtest(successes, n, 0.5, alternative="greater").pvalue)
            out.append(case("pairedSignTest", [diffs, alt], {"pValue": p}, EXACT_TOL))
    for b, c in [(0, 0), (1, 5), (10, 0), (100, 70), (3, 3), (7, 2)]:
        nd = b + c
        p = 1.0 if nd == 0 else float(min(1.0, 2 * stats.binom.cdf(min(b, c), nd, 0.5)))
        control = [1] * c + [0] * b
        treatment = [0] * c + [1] * b
        out.append(case("mcnemar", [control, treatment], {"b": b, "c": c, "pValue": p}, EXACT_TOL))
    return out


def proportion_cases() -> list[dict]:
    out = []
    for successes, n in [(0, 10), (1, 1000), (10, 10), (0, 1), (7, 12), (50, 100)]:
        z = float(stats.norm.ppf(0.975))
        p = successes / n
        denom = 1 + z * z / n
        centre = (p + z * z / (2 * n)) / denom
        half = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom
        out.append(case("wilson", [successes, n],
                        {"estimate": p, "lower": max(0.0, centre - half),
                         "upper": min(1.0, centre + half)}, Z_TOL))
    for n, c, k in [(10, 3, 5), (6, 2, 3), (1, 1, 1), (5, 0, 2), (1000, 3, 100), (4, 4, 2)]:
        expect = 1.0 if n - c < k else 1.0 - math.comb(n - c, k) / math.comb(n, k)
        out.append(case("passAtK", [n, c, k], expect, EXACT_TOL))
    return out


def correlation_cases() -> list[dict]:
    designs = [([1, 2, 3, 4, 5, 6, 7, 8], [1.1, 2.3, 2.9, 4.4, 5.1, 5.8, 7.4, 8.1]),
               ([1, 2, 2, 4], [1, 2, 2, 4]),
               ([1, 2, 3, 4], [40, 30, 20, 10]),
               ([3, 1, 4, 1, 5, 9, 2, 6], [2, 7, 1, 8, 2, 8, 1, 8])]
    out = []
    for a, b in designs:
        out.append(case("pearsonR", [a, b], float(stats.pearsonr(a, b).statistic), EXACT_TOL))
        out.append(case("spearmanR", [a, b], float(stats.spearmanr(a, b).statistic), EXACT_TOL))
    for xs in [[3, 1, 1, 2], [5, 5, 5], [1, 2, 3, 4], [2.5, 2.5, 1.0, 9.0, 2.5]]:
        out.append(case("ranks", [xs], [float(v) for v in stats.rankdata(xs)], EXACT_TOL))
    return out


def multiple_comparison_cases() -> list[dict]:
    families = [[0.01, 0.04, 0.05], [0.0125, 0.0125, 0.0125, 0.0125],
                [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212,
                 0.216, 0.222, 0.251, 0.269, 0.275, 0.34],
                [0.05, 0.05], [0.2, 0.2, 0.2, 0.2, 0.2], [0.001, 0.5, 0.5, 0.5]]
    out = []
    for ps in families:
        for alpha in (0.05, 0.1):
            bonf_rej, bonf_adj, _, _ = multipletests(ps, alpha=alpha, method="bonferroni")
            holm_rej, holm_adj, _, _ = multipletests(ps, alpha=alpha, method="holm")
            bh_rej, bh_q, _, _ = multipletests(ps, alpha=alpha, method="fdr_bh")
            out.append(case("bonferroni", [ps, alpha],
                            {"adjusted": [float(v) for v in bonf_adj],
                             "significant": [bool(v) for v in bonf_rej]}, EXACT_TOL))
            out.append(case("holm", [ps, alpha],
                            {"adjusted": [float(v) for v in holm_adj],
                             "significant": [bool(v) for v in holm_rej]}, EXACT_TOL))
            out.append(case("benjaminiHochberg", [ps, alpha],
                            {"qValues": [float(v) for v in bh_q],
                             "significant": [bool(v) for v in bh_rej]}, EXACT_TOL))
    return out


def power_cases() -> list[dict]:
    out = []
    for effect, alpha, power in [(0.5, 0.05, 0.8), (0.8, 0.05, 0.9), (0.2, 0.01, 0.8)]:
        za = float(stats.norm.ppf(1 - alpha / 2))
        zb = float(stats.norm.ppf(power))
        out.append(case("requiredSampleSize", [effect, alpha, power],
                        math.ceil(2 * ((za + zb) / effect) ** 2), EXACT_TOL))
        out.append(case("requiredPairedSampleSize", [effect, alpha, power],
                        math.ceil(((za + zb) / effect) ** 2), EXACT_TOL,
                        "normal quantiles with no t correction: a LOWER bound"))
    for n_paired, alpha, power in [(10, 0.05, 0.8), (32, 0.05, 0.8), (100, 0.01, 0.9)]:
        za = float(stats.norm.ppf(1 - alpha / 2))
        zb = float(stats.norm.ppf(power))
        out.append(case("pairedMde", [n_paired, alpha, power],
                        (za + zb) / math.sqrt(n_paired), Z_TOL))
    for p10, p01, alpha, power in [(0.2, 0.1, 0.05, 0.8), (0.25, 0.05, 0.05, 0.8),
                                   (0.3, 0.1, 0.05, 0.9), (0.15, 0.05, 0.01, 0.8)]:
        delta = p10 - p01
        p_disc = p10 + p01
        za = float(stats.norm.ppf(1 - alpha / 2))
        zb = float(stats.norm.ppf(power))
        n = (za * math.sqrt(p_disc) + zb * math.sqrt(max(0.0, p_disc - delta ** 2))) ** 2 / delta ** 2
        out.append(case("mcnemarRequiredN", [p10, p01, alpha, power], math.ceil(n), EXACT_TOL))
    for p10, p01, n_pairs, alpha in [(0.2, 0.1, 200, 0.05), (0.2, 0.1, 80, 0.05),
                                     (0.2, 0.1, 20, 0.05), (0.25, 0.05, 60, 0.05)]:
        delta = p10 - p01
        p_disc = p10 + p01
        za = float(stats.norm.ppf(1 - alpha / 2))
        z_beta = (math.sqrt(n_pairs) * abs(delta) - za * math.sqrt(p_disc)) / math.sqrt(
            max(1e-12, p_disc - delta ** 2))
        out.append(case("mcnemarPower", [p10, p01, n_pairs, alpha],
                        float(stats.norm.cdf(z_beta)), PHI_TOL))
    return out


def effect_size_cases() -> list[dict]:
    designs = [([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]),
               ([0.4, 0.5, 0.6, 0.5, 0.4, 0.6], [0.5, 0.6, 0.7, 0.6, 0.5, 0.7]),
               ([10, 11, 12, 13, 14], [1, 2, 3, 4, 5])]
    out = []
    for a, b in designs:
        va, vb = float(np.var(a, ddof=1)), float(np.var(b, ddof=1))
        pooled = math.sqrt(((len(a) - 1) * va + (len(b) - 1) * vb) / (len(a) + len(b) - 2))
        out.append(case("cohensD", [a, b], (float(np.mean(b)) - float(np.mean(a))) / pooled,
                        EXACT_TOL))
        gt = sum(1 for x in b for y in a if x > y)
        lt = sum(1 for x in b for y in a if x < y)
        out.append(case("cliffsDelta", [a, b], (gt - lt) / (len(a) * len(b)), EXACT_TOL))
    for before, after in [([0.1, 0.4, 0.3, 0.8], [0.3, 0.5, 0.7, 0.9]),
                          ([1, 2, 3, 4, 5], [1.2, 2.5, 2.8, 4.6, 5.1])]:
        d = np.asarray(after, dtype=float) - np.asarray(before, dtype=float)
        out.append(case("pairedCohensDz", [before, after],
                        float(np.mean(d) / np.std(d, ddof=1)), EXACT_TOL))
    for control, treatment in [([0, 0, 1, 1, 0, 1, 0, 0], [1, 0, 1, 1, 1, 1, 0, 1]),
                               ([1, 1, 1, 0], [0, 1, 1, 1])]:
        n = len(control)
        b = sum(1 for cc, tt in zip(control, treatment) if tt == 1 and cc == 0)
        c = sum(1 for cc, tt in zip(control, treatment) if tt == 0 and cc == 1)
        rd = (b - c) / n
        variance = (b + c - (b - c) ** 2 / n) / (n * n)
        z = float(stats.norm.ppf(0.975))
        half = z * math.sqrt(max(0.0, variance))
        out.append(case("pairedRiskDifference", [control, treatment],
                        {"riskDifference": rd, "lower": max(-1.0, rd - half),
                         "upper": min(1.0, rd + half)}, Z_TOL,
                        "Wald interval: undercovers below n = 20, see docs/design/statistics-decisions.md"))
    return out


def main() -> int:
    cases: list[dict] = []
    cases += normal_cdf_cases()
    cases += student_t_cases()
    cases += paired_t_cases()
    cases += welch_cases()
    cases += mann_whitney_cases()
    cases += wilcoxon_cases()
    cases += sign_and_mcnemar_cases()
    cases += proportion_cases()
    cases += correlation_cases()
    cases += multiple_comparison_cases()
    cases += power_cases()
    cases += effect_size_cases()

    payload = {
        "generator": "scripts/generate-statistics-oracle.py",
        "reference": {
            "scipy": scipy.__version__,
            "numpy": np.__version__,
            "statsmodels": statsmodels.__version__,
            "python": sys.version.split()[0],
        },
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    print(f"wrote {len(cases)} cases to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
