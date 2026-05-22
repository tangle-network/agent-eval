## Why this matters

The 2026-05-22 cross-repo audit ([docs](https://github.com/tangle-network/agent-eval/blob/chore/cross-repo-eval-audit-2026q2/docs/audits/2026-05-22-cross-repo/SYNTHESIS.md)) found that consumers use ~25% of the substrate surface. The audit fix (issues #75, [tangle-network/agent-builder#191](https://github.com/tangle-network/agent-builder/issues/191), [tax-agent#81](https://github.com/tangle-network/tax-agent/issues/81), [legal-agent#85](https://github.com/tangle-network/legal-agent/issues/85), [creative-agent#124](https://github.com/tangle-network/creative-agent/issues/124), [gtm-agent#136](https://github.com/tangle-network/gtm-agent/issues/136)) closes the **integration** gap — consumers wire what's already there.

This issue closes the **closure** gap. The higher-order runtime abstractions (`TraceEmitter`, `runEvalCampaign`, `AnalystRegistry`) capture data — they don't auto-invoke the statistical primitives. Each is a pure function the consumer has to call explicitly. So consumers stop at "we ran the campaign" and never run the analysis that would tell them whether their judge ensemble is real, whether they're seeing reward-hacking, or what their failure clusters look like.

**Fix**: ship one substrate primitive that runs the 5 closure-loop primitives in one call and emits a structured `analysis.json` artifact. Scaffold-template wires it into every new agent's canonical eval so the loop comes for free.

## In scope — 5 primitives, sharp

| Member | Source primitive | Why |
|---|---|---|
| `irr` | `corpusInterRaterAgreementFromJudgeScores(records, ensemble, dims)` | 3-judge ensembles across all 4 verticals are unmeasured for IRR. ZERO consumers run it today. |
| `cost` | `{ totalUsd, p50, p95, breaches: budgetBreachView(store, ceilingUsd) }` | Every consumer hard-codes `costUsd: 0`. Cost as an evaluation dim doesn't exist outside of agent-builder. |
| `pipelines` | `{ failures: failureClusterView(store), regressions: regressionView(store, baseline), judgeAgreement: judgeAgreementView(store), toolWaste: toolWasteView(store), stuckLoops: stuckLoopView(store) }` | 5 pure functions over `TraceStore`. ZERO consumer use. Every consumer would action on a failure-cluster dashboard if they realized it was free. |
| `rewardHacking` | `detectRewardHacking(records)` | Already wired in 3 of 4 verticals — formalize as a suite member with consistent output shape. |
| `predictiveValidity` | `rubricPredictiveValidity(records, outcomeStore)` — **gated** | Only fires when `outcomeStore` is non-null. Without persisted deployment outcomes the primitive can't run. Suite degrades cleanly to `null` for this member, never throws. |

## Signature

```ts
// src/reporting-suite.ts
export interface EvalReportingSuiteOpts {
  /** Judge ids in the ensemble. */
  ensemble: string[]
  /** Dimensions scored by every judge. */
  dims: string[]
  /** USD budget ceiling for budgetBreachView. Optional; defaults to skip. */
  budgetCeilingUsd?: number
  /** Baseline run id for regression diff. Optional; defaults to skip. */
  baselineRunId?: string
  /** Outcome store for predictiveValidity. Null skips that member cleanly. */
  outcomeStore?: OutcomeStore | null
}

export interface EvalReportingSuiteReport {
  runId: string
  generatedAt: string
  irr: { perDim: Record<string, { icc: number; kappaWeighted: number; bootstrapCi: [number, number]; n: number }>; pooled: { icc: number; kappaWeighted: number } } | null
  cost: { totalUsd: number; p50: number; p95: number; breaches: BudgetBreachView } | null
  pipelines: {
    failures: FailureClusterView
    regressions: RegressionView | null
    judgeAgreement: JudgeAgreementView
    toolWaste: ToolWasteView
    stuckLoops: StuckLoopView
  }
  rewardHacking: RewardHackingReport | null
  predictiveValidity: PredictiveValidityReport | null
}

export async function evalReportingSuite(
  records: RunRecord[],
  traceStore: TraceStore,
  opts: EvalReportingSuiteOpts,
): Promise<EvalReportingSuiteReport>
```

Each member is `null` when its input requirement isn't met (no IRR if `records[].outcome.judgeScores` is missing; no `predictiveValidity` if `outcomeStore` is omitted). **Fail-loud doctrine**: never silently zero a member — null means "not computable from these inputs," and the caller can see why.

## Output

`<runDir>/analysis.json` alongside `records.jsonl` / `scores.json`. Read by:
- agent-builder's `/app/admin/findings` UI to surface IRR + failure-cluster trends
- Consumer scaffold's `pnpm eval:report` script (rendered by agent-builder scaffold)
- CI gates (e.g. fail if `irr.pooled.icc < 0.5` — ensemble has collapsed to one opinion)

## Scaffold change (cross-repo)

Extends agent-builder#191 Half B (scaffold expansion). The rendered `canonical-eval.ts` template emits a `--report` flag that fires `evalReportingSuite` post-run. The rendered `eval-report.ts` script reads `analysis.json` and prints a human-readable summary. Every newly-scaffolded agent inherits the closure loop without thinking about it.

## Explicit non-goals (deferred to #8 — substrate triage)

These primitives exist in the substrate but **NOT** in the reporting suite. They go through #8's triage instead:

- PRM module (`PrmGrader`, `prmBestOfN`, `prmEnsembleBestOfN`) — no consumer step-grades or trains a process reward model
- Training-data exporters (`toDpoRows`, `toGrpoRows`, `toSftRows`, `toPrmRows`) — no consumer fine-tunes against this output
- `createAntiSlopJudge` — consumers run text-keyword anti-slop heuristics that don't match the substrate primitive's shape
- `calibrationCurves`, full `correlationStudy` — useful in theory, no consumer persists outcomes to feed them
- `runBehavioralCanaries` — consumers use ad-hoc canary tests; substrate primitive shape needs validation

These are NOT in the suite because firing them without a consumer use case adds noise to `analysis.json` that nobody actions on. Better outcome: triage them via #8 (keep behind `@experimental`, find a real use case, or delete).

## Completion checklist

- [ ] `src/reporting-suite.ts` created with `evalReportingSuite` + `EvalReportingSuiteOpts` + `EvalReportingSuiteReport` types
- [ ] Each suite member calls the existing substrate primitive (no reimplementation); when input prerequisites unmet returns `null` with no throw
- [ ] `tests/reporting-suite.test.ts` — every member has both happy-path and null-path coverage
- [ ] Integration test: run against a real `RunRecord[]` corpus, assert `analysis.json` shape; assert all members non-null with full inputs; assert specific members null with partial inputs (no outcomeStore → predictiveValidity null; no budgetCeilingUsd → cost.breaches null)
- [ ] Exported from `src/index.ts` (root) + capability-area "Run record + outcome shape"
- [ ] `tests/consumer-contract.test.ts` updated to pin the new exports
- [ ] CHANGELOG.md entry for 0.32.1 (or 0.32.0 if not yet released)
- [ ] agent-builder#191 scaffold task added: `templates/eval-report.ts` renders the `pnpm eval:report` consumer surface
- [ ] Documentation: docs/audits/2026-05-22-cross-repo/spec-reporting-suite.md added with the same 10-section spec shape

## Coordination

- **Ships in or after substrate 0.32.0** (after #75 absorbs the 8 universal patterns)
- **Unblocks** agent-builder#191 Half B's scaffold-template work to emit a default `pnpm eval:report` script
- **Depends on**: `RunRecord.outcome.judgeScores: JudgeScoresRecord` (0.31.0 — shipped) and the consumer specs migrating off the side-channel cast (in flight via the 4 consumer issues)
- **Closes the meta-loop with #8**: #7 ships the closure suite; #8 deletes / demotes the rest of the unused surface so the substrate is *curated*, not *accumulating*

## Companion docs

- Cross-repo synthesis: https://github.com/tangle-network/agent-eval/blob/chore/cross-repo-eval-audit-2026q2/docs/audits/2026-05-22-cross-repo/SYNTHESIS.md
- Substrate catalog: https://github.com/tangle-network/agent-eval/blob/chore/cross-repo-eval-audit-2026q2/docs/audits/2026-05-22-cross-repo/agent-eval-catalog.md
