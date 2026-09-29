# Campaign coverage

Import `campaignCoverage` and `CampaignCoverage` from `@tangle-network/agent-eval/campaign`. This is the same implementation used by campaign evidence and optimization; product adapters must not copy a weaker coverage loop.

```ts
import { campaignCoverage } from '@tangle-network/agent-eval/campaign'

const coverage = campaignCoverage(campaign.cells, scenarios, reps, true)
if (!coverage.complete) {
  console.error(coverage.unscorableCells)
}
```

The intended scenarios and replicate count establish the denominator. The result identifies missing, duplicate, unexpected and incorrectly identified cells; absent artifacts; execution failures; failed or incomplete judge panels; and nonfinite scores. With `requireJudgeScore: true`, every intended cell needs a successful finite judgment.

Coverage is not quality, provenance, cost completeness, or permission to promote. A failed task with a captured artifact and a valid zero score may be fully measured. A missing measurement is not a zero. Product adapters remain responsible for their named judge, required score dimensions, paired seeds, authenticated outcomes, and complete observed costs.

When comparing arms from one campaign, preserve the original physical execution cell identity separately and project each arm to the intended task/replicate identities before checking coverage. Do not change the underlying retained campaign.

Verification uses the existing `src/campaign/coverage.test.ts`, repository typecheck/build, and packed-package checks. This export adds no evaluator, execution dependency, scheduler, or new statistics. Consumers need the published release containing this export; a source branch is not a registry release.
