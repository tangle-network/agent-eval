# Unreleased: audit a frozen probability policy

Added `auditProbabilityPolicy`, `ProbabilityPolicyAuditInput` and
`ProbabilityPolicyAuditReport` to `@tangle-network/agent-eval/meta-eval`.
Existing `auditEvaluator` behavior and report hashes are unchanged. No dependency,
model call, scheduler or automatic promotion is added.

Use this when a product turns a probability into accept, reject or escalation.
The caller supplies both thresholds and independently labeled observations. The
helper maps the observations, then uses the existing `auditEvaluator` statistics,
independent-unit counting, development-exposure exclusion and authority checks.

```ts
import { readFile } from 'node:fs/promises'
import { auditProbabilityPolicy } from '@tangle-network/agent-eval/meta-eval'

const path = process.argv[2]
if (!path) throw new Error('Supply the frozen audit JSON path')
const report = auditProbabilityPolicy(JSON.parse(await readFile(path, 'utf8')))
console.log(JSON.stringify(report, null, 2))
```

The input has the existing evaluator audit fields: `evaluatorDigest`, `population`,
`samplingFrame`, `authority`, `policy` and `observations`. Add explicit `thresholds`
with `rejectAtOrBelow` and `acceptAtOrAbove`. Every observation carries `id`,
`independentUnitId`, `evidenceRef`, independently checked `expected` (`accept` or
`reject`), `exposure` (`fresh` or `development`), and `acceptProbability` instead
of `observed`.

`acceptProbability` is P(the event the caller defines as acceptable), in [0,1], or
null for missing output. For Jev, a caller can use a suitable Noul or a named Choice
probability. Do not substitute Jev's distribution-confidence statistic or an
arbitrarily scaled numeric grade. Other providers work without pretending to be Jev.

Probabilities at or above `acceptAtOrAbove` map to accept. Those at or below
`rejectAtOrBelow` map to reject. The open interval between them and null map to
unknown. Thresholds must be finite, in [0,1], and strictly separated. Nothing
chooses thresholds or inserts a default cutoff for the application.

## Read the result correctly

The result retains the existing admit/reject/inconclusive verdict, error bounds,
coverage, exclusions, authority and mapped observations. Unknown judgments remain
in the conservative error bounds, never measured successes. The helper does not
quietly discard escalated or unavailable cases to improve apparent accuracy.
`coverage.eligibleCases - coverage.unknownCases` is the number of decided eligible
cases; the full denominator remains `eligibleCases`.

`probabilityPolicy` retains the original classifier digest, thresholds and exact
probabilities keyed by observation id. `evaluatorDigest` identifies the composed
classifier-plus-threshold program. `inputDigest` binds the complete validated
probability-audit input (sorted by observation id), including probability changes
that do not change the selected action. `reportDigest` covers the complete report.

The original evaluator digest must identify the actual frozen classifier, question
and evidence-rendering definition. An arbitrary string or a model alias is not
an independently verified program identity. Hashes establish identity, not truth.

## Keep selection and final assessment separate

Tune thresholds on development data, freeze them, then use fresh independent cases
for the final audit. A development-exposed source excludes its fresh-looking
variants too. Duplicate observation ids and identical declared author/auditor
identities are refused. Distinct declared names do not prove real-world independence;
the execution owner must enforce it and supply evidence.

The output audits this fixed binary decision policy. It does not prove probability
calibration, downstream workflow correctness, cost savings, causal repair quality
or external-action authorization. Use existing calibration/comparison utilities
and actual task outcomes for those claims. A small or entirely missing dataset is
inconclusive rather than perfect evidence. Real datasets, task slices, cost/latency
comparisons and deployed validation remain tracked in issue #771 under roadmap #768.

## Checks

`pnpm exec vitest run tests/probability-policy-audit.test.ts tests/evaluator-admission.test.ts`

Regressions cover boundary decisions, missing data, invalid probabilities, overlapping
thresholds, digest identity, input immutability, independent-unit denominators,
development leakage, authority checks and unchanged underlying error bounds. These
are executable arithmetic/contract tests, not live Jev quality measurements.
