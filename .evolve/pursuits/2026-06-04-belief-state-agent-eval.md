# Pursuit: Belief-state work in agent-eval

Status: active - Phase 0 infrastructure implemented, empirical corpus gate still open

## Goal

Turn belief-state agents from a broad MDP taxonomy into a trace-grounded research program inside `agent-eval`: selective action gates, OPE/replay, memory policy evaluation, surface attribution, calibration, and held-out promotion criteria.

## Current Decision

Start in `agent-eval`, but only as evaluation substrate. Do not put runtime memory, workflow execution, subagent lifecycle, or graph storage here.

Primary tracker: `docs/research/belief-state-agent-eval-roadmap.md`.

## Completion Gates

- [x] Decision-point corpus extractor exists and joins local code-agent traces to `RunRecord`.
- [x] Research evidence packet separates corpus/selective/calibration/OPE/paper-readiness status.
- [ ] Selective prediction beats baseline utility on holdout or records an honest negative.
- [x] OPE support diagnostics hold the report when behavior/target propensities are absent.
- [ ] Memory policy evaluation handles poisoning, staleness, and context bloat.
- [ ] Surface attribution distinguishes causal evidence from correlation.
- [ ] No stable belief-state API ships before replay/calibration proof.

## Next Action

Run the Phase 0 corpus measurement over real local traces and emit a `BeliefDecisionResearchEvidencePacket`. The first dogfood target is failure recovery after failed tool/patch actions; promotion still requires >= 200 labeled decision points, split metadata, integrity checks, a recorded baseline policy, and a packet status of `supported` for the intended paper claim scope.

## 2026-06-05 Implementation Status

Added the experimental code-agent corpus path:

- `src/belief-state/code-agent-corpus.ts` extracts decision points from Codex, Claude Code, OpenCode, Kimi Code, and Pi/PiGraph-shaped traces.
- `src/belief-state/research-evidence.ts` turns a corpus evaluation into paper-facing claim statuses: corpus support, selective-policy evidence, calibration evidence, OPE support, and paper-readiness.
- It inventories decision targets, selects failure recovery first when support is adequate, runs selective policy evaluation plus calibration, and routes missing propensities into OPE support diagnostics.
- It intentionally does not invent behavior probabilities, target probabilities, split metadata, or runtime memory state.
- `src/belief-state/code-agent-corpus.test.ts` covers the five local trace families and verifies that missing OPE support forces `hold`, not a counterfactual value claim.
- `src/belief-state/research-evidence.test.ts` verifies that a corpus can support selective/calibration evidence while remaining blocked for counterfactual paper claims when OPE support is missing.

Local smoke after build: 33 local sessions joined to 33 `RunRecord`s and produced 13,137 decision rows across Codex, Claude Code, Kimi Code, OpenCode, and PiGraph-shaped traces. Failure recovery was selected for Codex, Claude Code, Kimi Code, and OpenCode. Every evaluated source correctly held because OPE behavior/target propensities are missing.
