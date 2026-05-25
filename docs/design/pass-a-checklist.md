# Pass A — substrate 0.40 implementation checklist

Status: **green-lit, Phase 1 in progress**
Date: 2026-05-25
Spec: `docs/design/pass-a-substrate-0.40.md`
Review synthesis: `.evolve/reviews/2026-05-25-SYNTHESIS.md`

## Pre-work spikes (DONE)

**Spike 1 — Safety primitives wireable:**

| Module | Exports |
|---|---|
| `src/red-team.ts` | `redTeamDataset`, `scoreRedTeamOutput`, `redTeamReport`, `DEFAULT_RED_TEAM_CORPUS` |
| `src/rl/reward-hacking.ts` | `detectRewardHacking(input) → RewardHackingReport` |
| `src/canary.ts` | `runCanaries(runs, opts) → CanaryReport` |
| `src/holdout-auditor.ts` | exists, exports to confirm during impl |

Adapters needed (~150 LOC) to wrap these into the `Gate.decide()` contract.

**Spike 2 — duplication confirmed, with bonus:**

- 4 product `run-prompt-evolution.ts` files vary in function count: gtm 15 / creative 28 / legal 33 / tax 30
- legal + tax already import statistical primitives (`pairedBootstrap`, `wilcoxonSignedRank`, `pairedEvalueSequence`, `corpusInterRaterAgreementFromJudgeScores`) from `@tangle-network/agent-eval`
- **Bonus**: the stats layer EXISTS in the substrate; Pass A wires it into `runCampaign`. No new statistical code required. Day-1 diff work is 2 days (gather all features legal/tax use → expose via `runCampaign` opts).

---

## Phase 0 — sign-off (DONE)
- [x] Drew sign-off on Pass A scope
- [x] Spike 1: safety modules verified
- [x] Spike 2: duplication + stats-already-exist verified

## Phase 1 — substrate core (Week 1, 5 days)

- [ ] `src/campaign/types.ts` — Scenario, DispatchFn, JudgeConfig (re-export), CampaignResult schema
- [ ] `src/campaign/run-campaign.ts` — primitive orchestrator
- [ ] Seed propagation through all LLM calls (router + judges + dispatch ctx)
- [ ] Cell-level resumability cache (manifestHash + scenarioHash + profileHash)
- [ ] Bootstrap CIs (wire existing `pairedBootstrap`, configurable `reps`, default 5)
- [ ] `src/campaign/labeled-store/types.ts` + `fs-adapter.ts` — `LabeledScenarioStore` with provenance + temporal split
- [ ] Per-source rate limits in store
- [ ] ~30 tests (substrate)
- [ ] Internal smoke: seed=42 → identical CampaignResult.manifestHash on rerun

## Phase 2 — presets + safety wire-up (3 days)

- [ ] `src/campaign/presets/run-eval.ts` (~40 LOC)
- [ ] `src/campaign/presets/run-optimization.ts` (~50 LOC) — wraps `runMultiShotOptimization` as Mutator
- [ ] `src/campaign/presets/run-production-loop.ts` (~80 LOC)
- [ ] `src/campaign/auto-pr.ts` — `openAutoPr` helper
- [ ] `src/campaign/gates/default-production-gate.ts` — composes red-team + reward-hacking + canary + heldout-auditor
- [ ] Gate adapters (wrap existing modules into `Gate.decide` shape)
- [ ] Hard-refuse `tracing: 'off'` when `autoOnPromote !== 'none'`
- [ ] ~20 preset + gate tests
- [ ] Publish `agent-eval@0.40.0`

## Phase 3 — runtime side (2 days)

- [ ] `runProductionLoop` scheduler in `agent-runtime` (Shape A only)
- [ ] `handleChatTurn` default `TraceStore` wiring (default-on tracing)
- [ ] Tests
- [ ] Publish `agent-runtime@0.25.0`

## Phase 4 — consumer migrations (8 days, 4 if parallelized)

- [ ] **Day 1-2**: DIFF the 4 product `run-prompt-evolution.ts` files. Fold unique features (statistical, redteam, persona-discovery) into substrate. Validate `runCampaign` exposes all features each product uses today.
- [ ] gtm-agent migration + smoke (~150 LOC config)
- [ ] legal-agent migration + smoke (~180 LOC)
- [ ] tax-agent migration + smoke (~200 LOC)
- [ ] creative-agent migration + smoke (~150 LOC)
- [ ] agent-builder migration: `dispatch: kindRouter` for 6 kinds (~150 LOC)
- [ ] blueprint-agent: unvend `agent-eval`, bump to 0.40, migrate (~200 LOC)
- [ ] physim: `MultiLayerVerifier → JudgeConfig` adapter + 12-stage `SessionScript[]` (~300 LOC)
- [ ] agent-builder-sota-p1: audit if it's a fork or sibling; migrate or document

## Phase 5 — skills + docs (2 days)

- [ ] Update `agent-stack-adoption` skill: Pass A primitives, 3 named presets, `LabeledScenarioStore` discipline, default safety gate
- [ ] Update `agent-eval-adoption` skill: `CampaignResult` schema, seed/CI patterns
- [ ] Reinstall skills via `dotfiles/claude/install.sh`
- [ ] Update each product's `eval/` README
- [ ] `agent-eval@0.40` README: highlights + migration + breaking-changes
- [ ] `agent-runtime@0.25` README: tracing default-on note

## Phase 6 — quality gates (1 day)

- [ ] All existing tests green: 5 substrate repos + 7 consumer repos
- [ ] Determinism smoke: `runCampaign({ seed: 42 })` × 2 → identical `manifestHash`
- [ ] Resumability smoke: kill mid-campaign, restart → completed cells cached
- [ ] Provenance smoke: write to `LabeledScenarioStore` without provenance → rejected
- [ ] Temporal split smoke: capture test scenario after train → filtered from training pool
- [ ] Safety smoke: production loop default gate detects synthetic reward-hacking + red-team probe failures
- [ ] OTEL smoke: spans land in collector with full chain (judge → mutator → gate → openAutoPr)
- [ ] End-to-end: `runProductionLoop` opens real PR (Shape A)

## Phase 7 — release (1 day)

- [ ] Tag `agent-eval@0.40.0` + `agent-runtime@0.25.0`
- [ ] Close PR #91 with "Pass A landed" + link to implementation PRs
- [ ] Update Pass B doc with safety stack roadmap

## Total: 3-4 weeks honest

Confidence: **92%** (was 85% pre-spikes). Remaining 8% is process-discipline (scope creep into Pass B) + the unvend of blueprint-agent (could surface drift) + physim's MultiLayerVerifier adapter (unproven design).
