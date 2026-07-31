"""Independent reference for Tango's (1998) score interval for the paired risk
difference, written from the score equation directly with scipy's root finder —
NOT a port of the TypeScript. Used to cross-check
`pairedRiskDifferenceScore` in src/statistics.ts.

Emits JSON on stdout: [{b, c, n, lower, upper}, ...]
"""
import json
import sys

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm


def constrained_loss_rate(b, c, n, delta):
    """MLE of q = P(treatment loses) subject to p10 - p01 = delta.

    Found by numerically maximising the profile log-likelihood
    L(q) = b*log(q+delta) + c*log(q) + e*log(1-2q-delta), rather than by the
    closed-form root, so an algebra error in the TypeScript cannot be mirrored
    here.
    """
    e = n - b - c
    lo = max(0.0, -delta) + 1e-12
    hi = (1.0 - delta) / 2.0 - 1e-12
    if hi <= lo:
        return max(lo, 0.0)

    def neg_ll(q):
        p10 = q + delta
        p01 = q
        conc = 1.0 - 2.0 * q - delta
        if p10 <= 0 or p01 <= 0 or conc <= 0:
            return np.inf
        return -(b * np.log(p10) + c * np.log(p01) + e * np.log(conc))

    grid = np.linspace(lo, hi, 20001)
    vals = np.array([neg_ll(q) for q in grid])
    return float(grid[int(np.argmin(vals))])


def score(b, c, n, delta):
    q = constrained_loss_rate(b, c, n, delta)
    var = n * (2.0 * q + delta * (1.0 - delta))
    num = b - c - n * delta
    if var <= 0:
        return np.inf if num > 0 else (-np.inf if num < 0 else 0.0)
    return num / np.sqrt(var)


def interval(b, c, n, confidence=0.95):
    z = norm.ppf(1 - (1 - confidence) / 2)
    rd = (b - c) / n
    eps = 1e-9
    lower = brentq(lambda d: score(b, c, n, d) - z, -1 + eps, rd - eps if rd > -1 + eps else rd,
                   xtol=1e-10) if score(b, c, n, -1 + eps) > z else -1.0
    upper = brentq(lambda d: score(b, c, n, d) + z, rd + eps if rd < 1 - eps else rd, 1 - eps,
                   xtol=1e-10) if score(b, c, n, 1 - eps) < -z else 1.0
    return lower, upper


CASES = [
    (0, 3, 76), (15, 5, 76), (0, 0, 76), (2, 0, 6), (0, 1, 10),
    (5, 2, 40), (1, 1, 20), (10, 0, 200), (0, 8, 200), (3, 3, 30),
]

out = []
for b, c, n in CASES:
    lo, hi = interval(b, c, n)
    out.append({"b": b, "c": c, "n": n, "lower": lo, "upper": hi})
json.dump(out, sys.stdout, indent=1)
print()
