---
name: agent-eval
description: Maintain agent-eval cases, judges, records, traces, campaigns, comparisons, and releases.
---

# Agent Eval

Use this only when changing `@tangle-network/agent-eval` itself.
For product adoption, use the public package README and adoption skill.
This file defines maintainer procedure; source and generated types define the API.

## Read First

1. Read `README.md` and `docs/concepts.md` for the public model.
2. Read the target subpath barrel and implementation.
3. Search the repository for an existing primitive, adapter, and regression test.
4. Check `package.json` exports before adding or changing an import path.
5. Read the nearest runnable example only when it exercises the same public path.
6. Read `docs/trace-analysis.md` before changing analyst kinds, engines, or benchmarks.

Useful starting points:

| Concern | Start |
|---|---|
| Stable product API | `src/contract/index.ts` |
| Candidate search and promotion | `src/campaign/index.ts` |
| Canonical run data | `src/run-record.ts` |
| Trace capture and replay | `src/trace/index.ts` |
| Trace analysis / recursive analyst engine | `src/analyst/index.ts` |
| Comparisons and reports | `src/reporting.ts` |
| Benchmark adapters | `src/benchmarks/index.ts` |
| Training-data exports | `src/rl/index.ts` |
| Recorded-trajectory replay and executed proofs | `src/trajectory-replay/index.ts` |
| Repair grading: five-tier funnel, action budget, Delta-repair | `src/trace-repair/index.ts` |

Treat source as authoritative when prose disagrees, then correct the nearest stale document in the same change.

## Package Boundaries

This package must not depend on `agent-runtime` or `agent-knowledge`, including type-only and development dependencies.
A concept belongs here when it makes sense without a running agent loop: cases, scores, run records, comparisons, statistics, promotion decisions, and trace analysis.
Execution profiles, worker control, streaming turns, and product storage transactions belong elsewhere.

Use the canonical `AgentProfile` from `@tangle-network/agent-interface`.
Do not create package-local profile or run-record shapes.

## Optimization Surface

Three public entry points improve or benchmark a surface. Route by intent.

| Intent | Call | Required pieces |
|---|---|---|
| Improve one surface against scenarios, with a release decision, in one call | `selfImprove({ method })` from `/contract` | agent dispatch, judge, scenarios, baseline surface, budget |
| Benchmark two or more optimizers at equal budget | `compareOptimizationMethods()` from `/campaign` | methods, dispatch, judges, train + selection + final cases, cost ceiling |
| Compose an official optimizer for either entry above | `gepaOptimizationMethod()` / `skillOptOptimizationMethod()` from `/campaign` | objective, `evaluationId`, recipe or trainer, execution owner (`optimizer.call` + `callRef`), optimizer-model budget |

`selfImprove()` is the agent entry: it gives the method disjoint train and selection partitions, re-scores the selected surface on a held-out split, and returns a `gateDecision`.
`compareOptimizationMethods()` is the measurement entry: it gives every method equal inputs and scores the selected surfaces on final cases no method received.
Neither entry ever passes final comparison cases to a method.
The execution owner is always caller code: `profileOptimizerModelCall` from `@tangle-network/agent-runtime/kernel`, or your own `ExternalOptimizerModelCall` (copy `examples/_shared/openai-compatible-owner.ts`).

The canonical doc is `docs/campaign-proposers.md`.
Runnable paths: `examples/self-improve-optimizer/` (selfImprove + official GEPA) and `examples/compare-optimization-methods/` (method comparison).

## Integrity Rules

- Missing backend use, output, trace evidence, usage, or required identity fails loudly.
- Record pinned model versions; bare moving aliases are not release evidence.
- Preserve unknown provider fields and redact secrets at ingestion boundaries.
- Use code for objective facts and model judges only for semantic facts.
- Deterministic failures cannot be overridden by a model score.
- Keep service and measurement failures distinct from agent failure.
- Compare candidates on paired cases under equivalent conditions.
- Keep candidate-generation cases separate from final decision cases.
- Report sample count, uncertainty, failures, cost, and latency with quality.
- Search and analysis produce detached candidates; they do not mutate live product state.

Do not add silent fallbacks, parallel result formats, duplicate runners, or product-specific policy to the shared package.

## Change Patterns

### Public Primitive

Define the smallest reusable type and behavior in the owning module.
Export it from the narrowest public subpath.
Add focused behavior, error, serialization, and public-import tests.
Update the README or relevant concept doc and changelog when users must act on the change.

### Case Or Judge

Name the user behavior and independently observable success.
Prove a known good fixture passes and a realistic bad fixture fails.
Bound untrusted target output and keep scoring instructions unavailable to the target.
Record judge model, inputs, evidence, output, and errors.

### Campaign Or Promotion Rule

Retain every attempted slot, including service failures and rejected candidates.
Pair baseline and candidate by case and seed.
Test ties, missing pairs, zero variance, small samples, interrupted runs, and deterministic failures.
Never promote from development scores alone.

### Removing A Public Symbol

Derive the caller set mechanically. Never grep a hand-written list of repositories.
A repository missing from a list returns zero matches, which reads exactly like a repository that has no callers.

Select repositories by structure, so a naming convention cannot go stale:

```bash
# canonical checkout = .git is a DIRECTORY; a worktree clone's .git is a FILE
cd ~/code
for d in */; do d=${d%/}; [ -d "$d/.git" ] && echo "$d"; done
```

Grep each repository on its **default branch ref**, not its working tree.
A repository is usually sitting on unrelated in-flight work.

```bash
ref=$(git -C "$repo" symbolic-ref -q --short refs/remotes/origin/HEAD)
git -C "$repo" grep -n -w -I -- "$SYMBOL" "$ref" -- ':(exclude)*/node_modules/*'
```

Do not assume the default branch is `main`; resolve it per repository.
Use `git grep -w` so a lookalike identifier cannot match.

For published dependents, union the registry scope search with every non-private `package.json` name in those repositories — the search index is incomplete.
Download each package's `latest` tarball and grep the built `dist/` output, which is what a consumer resolves.

Read the `from` clause of every hit before calling it a caller.
A property key, a local definition of the same name, and a doc comment all look like calls to a grep.

Report every repository the sweep could not cover, such as one with no remote default branch.
Silence about a gap is the defect this procedure exists to prevent.

Record each caller's **pinned version**, then read what that pinned version's implementation did.
It is not always what `main` does, and a port copied from `main` into a repository pinned below it changes behavior silently.

Migrate every caller before the deletion lands, each in its own repository and its own pull request.

When verifying a migration in a consumer repository, run the tsconfig that covers the changed file.
A repository's `typecheck` script often excludes its `eval/` directory.

### Trace Or Intake Adapter

Preserve identity, timestamps, ordering, raw provenance, unknown fields, and error state.
Test redaction and incomplete capture.
Round-trip or replay from saved artifacts instead of making new model calls when possible.

## Verification

Run the focused tests while iterating.
Before completion run:

```bash
pnpm typecheck
pnpm build
pnpm verify:package
```

Run the full test suite for shared contracts, campaign logic, statistics, trace capture, or public exports.
Run example typechecking when examples or their imports change.
Report exact commands, result counts, and any check not run.

If `pnpm build` or `pnpm verify:package` reports an analyst-benchmark digest or source-manifest mismatch, run `pnpm analyst:pin`.
It rewrites `ANALYST_BENCHMARK_IMPLEMENTATION_FILES` from the import graph and both live digests from the sources, then re-run the check.
Never hand-edit those three values, and never touch `ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256` or `ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256`: they state facts about already-published evidence, and `pnpm analyst:pin` does not write them.

## Then consider

- `eval-engineering` when the change needs a new production-derived case.
- `eval-agent` when adding or calibrating a model judge.
- `harden` when changing redaction, credentials, wire input, or release authority.
- `verify` before publishing.
