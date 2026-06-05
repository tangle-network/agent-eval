# Pursuit: Belief-state work in agent-eval

Status: active - Phase 0 infrastructure implemented, empirical corpus gate still open

## Goal

Turn belief-state agents from a broad MDP taxonomy into a trace-grounded research program inside `agent-eval`: selective action gates, OPE/replay, memory policy evaluation, surface attribution, calibration, and held-out promotion criteria.

## Current Decision

Start in `agent-eval`, but only as evaluation substrate. Do not put runtime memory, workflow execution, subagent lifecycle, or graph storage here.

Primary tracker: `docs/research/belief-state-agent-eval-roadmap.md`.

## Completion Gates

- [x] Decision-point corpus extractor exists and joins local code-agent traces to `RunRecord`.
- [x] Research evidence gate separates selective claim support from counterfactual claim support.
- [x] Runtime decision hooks can feed outcome-blind shadow probes without making `agent-eval` depend on runtime.
- [x] Stable experimental taxonomy exists for decision kinds, evidence quality, criteria, and reason codes.
- [ ] Selective prediction beats baseline utility on holdout or records an honest negative.
- [x] OPE support diagnostics hold the report when behavior/target propensities are absent.
- [ ] Memory policy evaluation handles poisoning, staleness, and context bloat.
- [ ] Surface attribution distinguishes causal evidence from correlation.
- [ ] No stable belief-state API ships before replay/calibration proof.

## Next Action

Run the next Phase 0 measurement from producer-backed runtime decision hooks, then join observed actions/outcomes into completed `BeliefDecisionPoint` rows and emit a `BeliefDecisionResearchEvidencePacket`. The first dogfood target is failure recovery after failed tool/patch actions; promotion still requires >= 200 labeled decision points, split metadata, integrity checks, a recorded baseline policy, and a packet status of `supported` for the intended claim scope.

## 2026-06-05 Implementation Status

Added the experimental code-agent corpus path:

- `src/belief-state/code-agent-corpus.ts` extracts decision points from Codex, Claude Code, OpenCode, Kimi Code, and Pi/PiGraph-shaped traces.
- `src/belief-state/research-evidence.ts` is intentionally small: corpus/selective/calibration gates are required for selective claims; OPE is additionally required for counterfactual claims.
- It inventories decision targets, selects failure recovery first when support is adequate, runs selective policy evaluation plus calibration, and routes missing propensities into OPE support diagnostics.
- It intentionally does not invent behavior probabilities, target probabilities, split metadata, or runtime memory state.
- `src/belief-state/code-agent-corpus.test.ts` covers the five local trace families and verifies that missing OPE support forces `hold`, not a counterfactual value claim.
- `src/belief-state/research-evidence.test.ts` verifies that a corpus can support selective/calibration evidence while remaining blocked for counterfactual paper claims when OPE support is missing.

Local smoke after build: 33 local sessions joined to 33 `RunRecord`s and produced 13,137 decision rows across Codex, Claude Code, Kimi Code, OpenCode, and PiGraph-shaped traces. Failure recovery was selected for Codex, Claude Code, Kimi Code, and OpenCode. Every evaluated source correctly held because OPE behavior/target propensities are missing.

Runtime bridge added after the agent-runtime hook merge:

- `src/belief-state/runtime-hooks.ts` accepts runtime-shaped decision hooks structurally, with no runtime import.
- Pre-action runtime decision hooks convert to `BeliefShadowProbeInput` so forked probes can ask what action the agent would take without leaking the observed action.
- Full `BeliefDecisionPoint` conversion requires an explicit `chosenAction`; the adapter diagnoses missing observed actions instead of fabricating rows.
- Unsupported runtime decision kinds are diagnosed unless the caller supplies an explicit belief decision kind override.

Taxonomy added for the long-term outcome:

- `src/belief-state/types.ts` exports stable decision kinds, evidence sources, evidence quality labels, evaluation criteria, and reason codes.
- The criteria are intentionally narrow: capture integrity, decision completeness, evidence quality, outcome quality, calibration, accepted-region risk, policy value, OPE support, memory health, surface attribution, generalization, and promotion.
- Runtime-specific sources such as `tool_result` remain adapter metadata unless promoted to the core evidence-source set by evidence.
