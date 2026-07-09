# Critical re-audit: clustered paired binary inference

Score: 8/10.

All three medium findings are resolved.

The task-weighted interval and sign-flip test now answer the same question.
One repository reports no cluster interval.
Too few bootstrap draws fail before sampling.
The 40-repository counterexample, one-repository case, one-draw case, exact enumeration, Monte Carlo determinism, whole-cluster bootstrap, unpaired rows, and Holm adjustment are covered by executable tests.

Residual requirement: consumers must reject unpaired rows before promotion, because the utility exposes them and intentionally computes complete-case statistics.

APPROVE — no correctness blocker remains in the unreleased API.
