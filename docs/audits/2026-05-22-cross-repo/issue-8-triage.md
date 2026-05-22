## Why this matters

The 2026-05-22 cross-repo audit ([synthesis](https://github.com/tangle-network/agent-eval/blob/chore/cross-repo-eval-audit-2026q2/docs/audits/2026-05-22-cross-repo/SYNTHESIS.md)) measured substrate-surface adoption across all five consumers (tax / legal / creative / gtm / agent-builder). The headline: **~70% of agent-eval's public surface has zero consumer adoption.**

This is not "we forgot to wire it." Issue #75 + the consumer issues already address the wiring gap, and #76 (reporting suite) closes the closure-loop gap. The remaining unused surface is **speculative**: primitives we built for hypothetical future consumers that don't exist.

Keeping speculative exports in `index.ts` is a tax:
- Surface that future consumers waste time evaluating before realizing it's not for them
- Maintenance burden on every release (every change to a speculative export still ships in `dist/`)
- Signal-to-noise dilution: when 70% of the catalog is unused, the 30% that's load-bearing is harder to find
- Documentation drift (CHANGELOG entries, JSDoc tags, OpenAPI emission)

The audit also turned up six private `pearsonR` implementations scattered across `judge-calibration.ts` / `pipelines/judge-agreement.ts` / `rl/reward-hacking.ts` / `builder-eval/correlation.ts` / `meta-eval/correlation-study.ts` / `meta-eval/rubric-predictive-validity.ts` — same disease at a smaller scale: accreted internal surface that should be one shared helper.

**Fix**: every export gets a 30-day decision — find a real consumer use case, demote to `@experimental`, or delete.

## The triage process

**Acceptance criterion per export**: by 2026-06-22 every currently-unused public export carries one of three labels:

1. **`@adopted`** — at least one consumer (tax/legal/creative/gtm/agent-builder) has a tracked issue or PR adopting it within the window. The reporting-suite issue (#76) is sufficient for: `corpusInterRaterAgreementFromJudgeScores`, `failureClusterView`, `regressionView`, `judgeAgreementView`, `toolWasteView`, `stuckLoopView`, `budgetBreachView`, `detectRewardHacking`.

2. **`@experimental`** (JSDoc tag — already shipped on some exports; extend it) — primitive stays in the substrate but moved behind a subpath import (e.g. `@tangle-network/agent-eval/experimental`) so root-level consumers don't see it. Caller must explicitly opt in. Stability not guaranteed across minors.

3. **`deleted`** — code removed; CHANGELOG entry under "Removed" with rationale; one-line note in the migration guide pointing at the closest substrate alternative or "no consumer demand."

## Specific candidates (the audit identified)

### `@experimental` candidates (no current consumer; keep behind a flag)

- `PrmGrader`, `prmBestOfN`, `prmEnsembleBestOfN`, `StepRubric`, 5 builtin rubrics under `./prm` — process-reward-model surface. No consumer step-grades or trains a PRM. Strong technical surface but premature.
- `toDpoRows`, `toGrpoRows`, `toSftRows`, `toPrmRows` under `./rl` — training-data exporters. No consumer fine-tunes against this output today. Reasonable to keep `@experimental` because the use case will exist eventually.
- `calibrationCurves`, `correlationStudy` under `./meta-eval` — depend on `FileSystemOutcomeStore` which no consumer populates. Keep `@experimental`; unblock once outcome-store wiring lands in any consumer's production loop.
- `proposeAutomatedPullRequest` + its transports — already `@experimental` per the catalog. Verify the tag is honored at the export site.
- `runProductionLoop` — already `@experimental`. Same.
- Wire surface (`./wire`: `createApp`, `startServer`, OpenAPI emitter, Zod schemas, builtin rubrics) — no consumer runs the substrate as a service today. Keep but tag `@experimental`.

### `deleted` candidates (no current consumer + no plausible future)

- `resetLockedAppendersForTesting` — exported from root despite the name (catalog flagged this as likely-leak). Move to a `/testing` subpath import or delete entirely. Test-only.
- `createTraceAnalystAdapter` — already deprecated as of 0.29.0; one-minor grace period elapsed. Delete in 0.32 or 0.33.
- `createAntiSlopJudge` — substrate ships one slop-judge shape; the four verticals run text-keyword heuristics that don't match the substrate primitive. Either reshape the primitive to match consumer demand or delete and have consumers ship their own.
- `runBehavioralCanaries` — same story as `createAntiSlopJudge`. Consumers use ad-hoc canaries. Delete or reshape after consulting consumer surface.

### `@adopted` candidates (already absorbed by issues filed today)

- IRR primitives, pipelines views, `detectRewardHacking` — covered by reporting-suite issue #76
- The 8 patterns in issue #75 — covered by the absorption spec
- The legal `runDurableEval` lift — covered by issue #75 T06

### Internal-helper consolidation (sub-task)

6 private `pearsonR` implementations across the codebase. Lift to a single `src/math/pearson.ts` with one exported `pearson(xs, ys): number` plus internal use everywhere. Saves ~80 LOC, removes drift risk.

## Process

1. **Week 1 (by 2026-05-29)**: open one tracking comment per candidate above; assign owner.
2. **Week 2 (by 2026-06-05)**: consumer outreach for each candidate. Is anyone planning to adopt? Is the primitive shape right for what they'd want?
3. **Week 3 (by 2026-06-12)**: decisions land. Per candidate: `@adopted` / `@experimental` / `deleted`. PRs opened.
4. **Week 4 (by 2026-06-22)**: PRs merged. Substrate 0.33.0 ships with the curated surface.

## Completion checklist

- [ ] Tracking comments opened on this issue per candidate
- [ ] Consumer-outreach decisions captured per candidate
- [ ] `@experimental` JSDoc tags applied to surviving speculative primitives
- [ ] Deprecated primitives removed; CHANGELOG entry under "Removed"
- [ ] Six private `pearsonR` impls consolidated into `src/math/pearson.ts`
- [ ] `resetLockedAppendersForTesting` either moved to `/testing` subpath or deleted
- [ ] `createTraceAnalystAdapter` removed (one-minor deprecation window elapsed)
- [ ] `tests/consumer-contract.test.ts` updated to reflect the curated surface
- [ ] `package.json` `exports` map updated if subpaths change
- [ ] `dist/openapi.json` regenerates without speculative surfaces
- [ ] Migration guide: docs/migrations/0.33.0.md added with a one-line note per removed export

## Why this is the harder issue

Pruning is unglamorous. It produces no new capability. But every shipped library that ages well does this — Rust's `std::dbg!` audits, React's experimental-then-stable promotion path, even Go's stdlib has periodic "remove what nobody uses" passes. The accreting substrate is exactly the failure mode that makes consumers stop trusting a library's surface as a useful guide to what's load-bearing.

The audit found the substrate is well-curated where it's been curated: stability tags emit into `.d.ts`, the consumer-contract test pins five product agents' imports, root re-exports were intentionally narrowed in 0.24. This issue is one more deliberate curation pass.

## Coordination

- Pairs with **#76** (`evalReportingSuite`) — that issue **adopts** ~8 of the unused primitives via the suite. This issue triages everything else.
- Pairs with **#75** (substrate 0.32.0 absorption) — that issue **adds** 8 new primitives. This issue **prunes** unused ones. Both ship in the 0.32 → 0.33 window.
- Pairs with **[agent-builder#191](https://github.com/tangle-network/agent-builder/issues/191)** — the scaffold expansion. Once #75 + #76 + this triage land, the scaffold templates can render against a curated substrate without consumer agents seeing speculative surface they shouldn't depend on.

## Companion docs

- Cross-repo synthesis: https://github.com/tangle-network/agent-eval/blob/chore/cross-repo-eval-audit-2026q2/docs/audits/2026-05-22-cross-repo/SYNTHESIS.md
- Substrate catalog: https://github.com/tangle-network/agent-eval/blob/chore/cross-repo-eval-audit-2026q2/docs/audits/2026-05-22-cross-repo/agent-eval-catalog.md
