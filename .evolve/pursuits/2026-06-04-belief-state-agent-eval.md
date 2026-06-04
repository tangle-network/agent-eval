# Pursuit: Belief-state work in agent-eval

Status: planned

## Goal

Turn belief-state agents from a broad MDP taxonomy into a trace-grounded research program inside `agent-eval`: selective action gates, OPE/replay, memory policy evaluation, surface attribution, calibration, and held-out promotion criteria.

## Current Decision

Start in `agent-eval`, but only as evaluation substrate. Do not put runtime memory, workflow execution, subagent lifecycle, or graph storage here.

Primary tracker: `docs/research/belief-state-agent-eval-roadmap.md`.

## Completion Gates

- [ ] Decision-point corpus exists and joins to `RunRecord`.
- [ ] Selective prediction beats baseline utility on holdout or records an honest negative.
- [ ] OPE support diagnostics pass before any counterfactual policy claim.
- [ ] Memory policy evaluation handles poisoning, staleness, and context bloat.
- [ ] Surface attribution distinguishes causal evidence from correlation.
- [ ] No stable belief-state API ships before replay/calibration proof.

## Next Action

Build the Phase 0 decision inventory and extraction experiment against existing traces. Pick one decision kind with enough data before promoting any stable public API.
