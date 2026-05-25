# Phase 4 — consumer migration tracking

Migrate the product repos off their duplicated eval / prompt-evolution
orchestration onto the published substrate (`@tangle-network/agent-eval@^0.40.3`
+ `@tangle-network/agent-runtime@^0.25.0`). Integration contract:
[`primitives-integration-spec.md`](./primitives-integration-spec.md).

**Strategy:** prove **gtm end-to-end first** (the canonical consumer), then fan
the proven migration pattern to the rest via parallel subagents, each briefed
with the gtm reference diff + the spec's forbidden-anti-patterns list. Each
migration is its own reviewable, rollback-able PR.

## Status board

| Repo | Deletable orchestration (LOC est.) | Dispatch seam | Status | PR |
|---|---|---|---|---|
| gtm-agent | ~2,420 | `runChatThroughRuntime` | **IN PROGRESS** | — |
| legal-agent | tbd | tbd | queued | — |
| tax-agent | tbd | tbd | queued | — |
| creative-agent | tbd | tbd | queued | — |
| agent-builder | tbd | tbd | queued | — |
| blueprint-agent | tbd | tbd | queued (Drew dispatching via spec) | — |
| physim | tbd (MultiLayerVerifier adapter) | tbd | queued | — |

## Per-repo migration checklist

For each repo, in order:

- [ ] **Survey** — inventory eval + prompt-evolution wrappers (file:line + LOC).
      Identify the dispatch seam, scenarios, judges, mutation strategy.
- [ ] **Bump deps** — `@tangle-network/agent-eval` → `^0.40.0`,
      `@tangle-network/agent-runtime` → `^0.25.0`; `pnpm update`; baseline
      typecheck green.
- [ ] **Rewire seams** — `dispatch`/`dispatchWithSurface`, `judges`,
      `scenarios` extracted from the existing wrappers (KEEP domain logic).
- [ ] **Replace orchestration** — swap the local generation/population/scorecard
      loop for `runImprovementLoop` (or `runCampaign` for eval-only). DELETE the
      wrapper body.
- [ ] **Gate** — compose domain gates with `defaultProductionGate`.
- [ ] **Dataset** — wire `FsLabeledScenarioStore` with correct `captureSource`.
- [ ] **Tests** — port wrapper contract tests to assert the substrate wiring;
      keep judge/scenario tests. Suite green.
- [ ] **Prove** — one real eval/improve run end-to-end; confirm scorecard +
      (if applicable) a PR opens on a shipping gate.
- [ ] **Anti-pattern sweep** — no silent fallbacks, no reimplemented loop, no
      train/holdout conflation, tracing on, dispatch named.
- [ ] **PR** — open, independent-review, merge.

## gtm-agent — migration map (from survey)

- **Branch base:** off the repo's working branch (`feat/gtm-rich-chat-actions`)
  or main — confirm before starting.
- **Dispatch seam:** `runChatThroughRuntime(ctx)`
  (`src/lib/.server/agent-runtime/chat.ts`) — prompt variant + scenario → real
  agent run → artifact + events + token usage.
- **Scenarios:** `src/lib/.server/production-loop/scenarios.ts` (3 holdout) +
  `eval/business-owner/personas.json` (canonical personas).
- **Judges:** `src/lib/.server/production-loop/judges.ts` (`runEnsembleJudge`,
  3-model ensemble) + canonical 12-dimension judges in `eval/canonical.ts`.
- **Delete (~2,420 LOC orchestration):** the generation/population/reps loop in
  `src/lib/.server/production-loop/index.ts` (~450), the checkpoint loop in
  `eval/canonical.ts` (~600), `eval/run-prompt-evolution.ts` wrapper (~800),
  `eval/analyst-loop.ts` wrapper (~300), `eval/optimization-campaign.ts` (~170),
  `scripts/evals/run-optimization-campaign.ts` (~100 scaffold).
- **Rewire:** `buildHoldoutRunner` → `dispatchWithSurface`; `buildScorer` →
  `judges`; `buildMutator` → `evolutionaryDriver({ mutator })`;
  `runProductionLoop` → `runImprovementLoop`.
- **Keep:** judges, scenarios, persona data + reactive driver, deterministic
  anti-slop/brief checks, GitHub PR wiring, feedback/trace ingestion.
- **Net:** ~1,400–1,600 LOC reduction.
