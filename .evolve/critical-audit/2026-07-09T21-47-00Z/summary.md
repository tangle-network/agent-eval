# Critical audit: clustered paired binary inference

Score: 6/10.

Three medium correctness findings block using this unreleased API as the DeepSWE promotion decision.

## Fix plan

1. Align the sign-flip statistic with the task-weighted interval.
   Verification: reproduce the 40-repository unequal-size counterexample and require the p-value to test the reported `+0.20` effect.
2. Suppress cluster-bootstrap intervals below two independent repositories.
   Verification: one improving repository returns `bootstrap: null`.
3. Reject a bootstrap draw count too small to represent both requested tails.
   Verification: one draw at 95% confidence fails with minimum `40`.

REQUEST_CHANGES — the original API could certify significance for a different effect and could fabricate certainty from one repository or one draw.
