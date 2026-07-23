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

Useful starting points:

| Concern | Start |
|---|---|
| Stable product API | `src/contract/index.ts` |
| Candidate search and promotion | `src/campaign/index.ts` |
| Canonical run data | `src/run-record.ts` |
| Trace capture and replay | `src/trace/index.ts` |
| Comparisons and reports | `src/reporting.ts` |
| Benchmark adapters | `src/benchmarks/index.ts` |
| Training-data exports | `src/rl/index.ts` |

Treat source as authoritative when prose disagrees, then correct the nearest stale document in the same change.

## Package Boundaries

This package must not depend on `agent-runtime` or `agent-knowledge`, including type-only and development dependencies.
A concept belongs here when it makes sense without a running agent loop: cases, scores, run records, comparisons, statistics, promotion decisions, and trace analysis.
Execution profiles, worker control, streaming turns, and product storage transactions belong elsewhere.

Use the canonical `AgentProfile` from `@tangle-network/agent-interface`.
Do not create package-local profile or run-record shapes.

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

## Then consider

- `eval-engineering` when the change needs a new production-derived case.
- `eval-agent` when adding or calibrating a model judge.
- `harden` when changing redaction, credentials, wire input, or release authority.
- `verify` before publishing.
