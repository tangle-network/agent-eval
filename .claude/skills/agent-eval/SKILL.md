---
name: agent-eval
description: Maintain agent-eval cases, judges, records, traces, campaigns, comparisons, and releases.
---

# Agent Eval

Use this when changing `@tangle-network/agent-eval` itself; a product adopting the package reads the README.
`AGENTS.md` owns the path map, shared helpers, the gate and delivery. Source and generated types own the API. This file owns the maintainer procedure.

Scope a change to the whole defect or capability: every path and caller it touches, in one pull request, at whatever size that takes.
Reuse or replace the existing implementation and delete what the change makes dead; a second runner, result format or traversal for one concept is the defect.

## Read first

1. `docs/concepts.md` for the public model, then the target subpath barrel and its implementation.
2. The existing primitive, adapter and integration test for the behavior, found by search before anything is added.
3. `package.json` exports before adding or changing an import path.
4. `docs/trace-analysis.md` before changing analyst kinds, engines or benchmarks.

| Concern | Start |
|---|---|
| Stable product API | `src/contract/index.ts` |
| Candidate search, optimizers and promotion | `src/campaign/index.ts`, `docs/campaign-proposers.md` |
| Canonical run data | `src/run-record.ts` |
| Trace capture, containment order and replay | `src/trace/index.ts`, `src/trajectory.ts`, `docs/trajectory-replay.md` |
| Trace analysis and the recursive analyst engine | `src/analyst/index.ts` |
| Comparisons and reports | `src/reporting.ts` |
| Benchmark adapters | `src/benchmarks/index.ts` |
| Training-data exports and rollout lines | `src/rl/index.ts`, `src/rollout/`, `docs/rollout.md` |
| Recorded-trajectory replay and executed proofs | `src/trajectory-replay/index.ts` |
| Repair grading | `src/trace-repair/index.ts` |

When prose and source disagree, source wins; correct the stale document in the same change.

## Package boundaries

This package never depends on `agent-runtime` or `agent-knowledge`, type-only and development dependencies included.
A concept belongs here when it makes sense without a running agent loop: cases, scores, run records, comparisons, statistics, promotion decisions and trace analysis.
Execution profiles, worker control, streaming turns and product storage belong elsewhere; accept execution through a callback.
Use the canonical `AgentProfile` from `@tangle-network/agent-interface`; never a package-local profile or run-record shape.
No product's file names, naming conventions or verdict rules enter this package.

## Optimization

Route by intent; `docs/campaign-proposers.md` is the canonical doc.

| Intent | Call |
|---|---|
| Improve one surface against scenarios, with a release decision | `selfImprove({ method })` from `/contract` |
| Benchmark two or more optimizers at equal budget | `compareOptimizationMethods()` from `/campaign` |
| Wrap an official optimizer for either entry | `gepaOptimizationMethod()`, `skillOptOptimizationMethod()` from `/campaign` |
| Change one component of a multi-component surface while scoring the whole candidate | `scopedOptimizationMethod()` |
| Feed each method's selected candidate into the next | `sequentialOptimizationMethod()` |

`selfImprove()` gives the method disjoint train and selection partitions, re-scores the selected surface on a held-out split, and returns a `gateDecision`.
`compareOptimizationMethods()` gives every method equal inputs and scores the selected surfaces on final cases no method received.
Neither passes final cases to a method.
The model-call owner is caller code: `profileOptimizerModelCall` from `@tangle-network/agent-runtime/kernel`, or an `ExternalOptimizerModelCall` (copy `examples/_shared/openai-compatible-owner.ts`).
A graph of agents is a `components` surface; build multi-node optimization from the scoped and sequential methods, never a second optimizer loop.
Runnable paths: `examples/self-improve-optimizer/` and `examples/compare-optimization-methods/`.

## Integrity rules

- Missing backend use, output, trace evidence, usage or required identity fails loudly; unknown stays distinct from a measured zero.
- Record pinned model versions; a moving alias is not release evidence.
- Preserve unknown provider fields and redact secrets at ingestion.
- Code decides objective facts; a model judge decides only semantic facts and never overrides a deterministic failure.
- Service and measurement failure stay distinct from agent failure.
- Compare candidates on paired cases under equivalent conditions, with generation cases kept apart from final decision cases.
- Count independent units, not rows: cells that share a run, task or wake are one unit, and `heldOutGate` takes `independentUnitByScenarioId` to say so.
- Report sample count, uncertainty, failures, cost and latency with quality.
- Search and analysis produce detached candidates; they never mutate live product state.

Trace order:

- `Trajectory.steps` is containment order, never time order. Code that needs what had happened by a step reads `trajectoryTimingBoundary`, not a slice of `steps`.
- Every captured span appears once. A span whose parent is missing stays, and `Trajectory.missingParents` and the minted line's `provenance.gap` say so.
- `src/trace/containment-order.ts` is the one span-tree traversal; order through it.

Search ledger and optimizer evidence:

- A ledger cell is the campaign cell that measured it. Record it through `campaignCellSearchResult`, from the cell or its `CampaignCellMeasurement`, so dimensions, tokens, cost, model, duration and attempt arrive whole, in process or through an observation log.
- A request answered from an earlier measurement adds no cell; it is counted as reused.
- Native and external optimizers see the same evidence: `campaignEvidence` with the caller's `describeArtifact`, bounded by `excerptEvidence`, which keeps the head and the tail. Never clip to the head; the failure is at the end.

Training pairs:

- A process-reward pair is two actions taken in the same recorded context. Pair on the context digest, never on span name or position, and never across tasks.
- A row without the identity that proves a shared context is refused, not exported.

## Change patterns

**Public primitive.** Define the reusable type and behavior in the owning module and export it from the narrowest public subpath. Regenerate `docs/public-api.md` with `pnpm api:census`. Update the nearest concept doc, and the changelog when users must act.

**Case or judge.** Name the user behavior and an independently observable success. Prove a known good fixture passes and a realistic bad fixture fails. Bound untrusted target output and keep scoring instructions away from the target. Record judge model, inputs, evidence, output and errors.

**Campaign or promotion rule.** Retain every attempted slot, service failures and rejected candidates included. Pair baseline and candidate by case and seed. Cover ties, missing pairs, zero variance, small samples, interrupted runs and deterministic failures. Never promote from development scores alone.

**Trace or intake adapter.** Preserve identity, timestamps, parent links, raw provenance, unknown fields and error state. Cover redaction and incomplete capture. Replay from saved artifacts instead of making new model calls.

**Removing or changing a public symbol.** Derive the caller set mechanically; a repository missing from a hand-written list returns zero matches, which reads exactly like no callers.

- Start from `scripts/public-api-consumers.json`, then sweep every canonical checkout (`.git` is a directory; a worktree's is a file).
- Grep each repository on its default branch ref, resolved per repository, never its working tree:

```bash
ref=$(git -C "$repo" symbolic-ref -q --short refs/remotes/origin/HEAD)
git -C "$repo" grep -n -w -I -- "$SYMBOL" "$ref" -- ':(exclude)*/node_modules/*'
```

- For published dependents, union the registry scope search with every non-private `package.json` name in those repositories, download each `latest` tarball and grep its `dist/`.
- Read the `from` clause of every hit: a property key, a local definition of the same name and a doc comment all match.
- Report every repository the sweep could not cover.
- Record each caller's pinned version and read what that version did; it is not always what `main` does.
- Migrate every caller, each in its own repository's pull request, and verify with the tsconfig that covers the changed file: a `typecheck` script often excludes `eval/`.

## Verification

Tests are integration tests through the public entry; never unit or mock tests.
Write the failing case first and keep its gate id.
Nothing installs, builds or runs a suite on a workstation: every check runs through the gate `AGENTS.md` names, on a pushed commit.

| Change | Gate command |
|---|---|
| Any | `pnpm typecheck` and the touched integration test |
| Shared contracts, campaign logic, statistics, trace capture or public exports | add `pnpm build && pnpm test && pnpm verify:package` |
| Stable serialization | add `pnpm check:canonical-json` |
| Examples or their imports | add `pnpm typecheck:examples` |

Report the gate id, exit code, result counts and any check not run.

If the build or `pnpm verify:package` reports an analyst-benchmark digest or source-manifest mismatch, run `pnpm analyst:pin` and re-run the check.
It rewrites `ANALYST_BENCHMARK_IMPLEMENTATION_FILES` from the import graph and both live digests from the sources.
Never hand-edit those values, and never touch `ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256` or `ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256`: they state facts about already-published evidence.

## Then consider

- `eval-engineering` when the change needs a production-derived case or a judge to add or calibrate.
- `harden` when changing redaction, credentials, wire input or release authority.
- `verify` before publishing.
