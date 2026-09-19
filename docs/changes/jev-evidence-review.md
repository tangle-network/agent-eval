# Unreleased: opt-in evidence reviews on native evaluations

`@tangle-network/agent-eval/jev` adds `prepareJevReview`, `assessJevReview` and
`jevReviewFindings`. Callers retain ownership of questions, hypotheses, evidence, severity,
thresholds and result policy. Review identity includes authored option order; request JSON is
not sorted before dispatch. Missing or partial negative evidence cannot become a clean review.

The optional `examples/jev-behavior-review.ts` recipe covers reward gaming, evaluator tampering,
policy/authorization/data-boundary breaches, injection-following, contradicted completion,
oversight bypass, matched-baseline anomalies and cross-run behavior. It composes the existing
`jevAnalyst`; the taxonomy is not installed in the generic evaluator and is not a calibrated
safety detector. See [behavioral reviews](../jev-behavior-review.md) for evidence and limits.

No dependency, transport, scheduler, package entrypoint, default model, production action or
spending policy changes. Existing evaluator, judge, analyst and protocol APIs remain unchanged.
Use existing deterministic control/reward checks and independent final assessment alongside
semantic reviews. Adversarial model quality and product/harness adoption remain tracked in
#772/#771 and the cross-repository roadmap #768.
