# agent-eval

This package owns evaluation data, scoring, experiment decisions, and release evidence.
This file is the map: what each path owns, and the one command that verifies it.
Behaviour and values live in the code; this file links to them and never copies them.

## Where things live

| Path | Owns | Verify |
| --- | --- | --- |
| `src/` | The package. Public entry modules are listed in [`scripts/build-entries.mjs`](scripts/build-entries.mjs), which `tsdown` builds; the root barrel is [`src/index.ts`](src/index.ts), which re-exports the grouped types in [`src/public-api/`](src/public-api). | `pnpm typecheck && pnpm build` |
| `src/<area>/` | One area per directory, named for the concept it implements. Find the area from the entry module that exports it. | `pnpm test` |
| `tests/` | The vitest suite. Add integration tests; never write unit or mock tests. | `pnpm test` |
| `examples/` | Runnable recipes. They import from `src/`; see [`tsconfig.examples.json`](tsconfig.examples.json). | `pnpm typecheck:examples` |
| `scripts/` | Build, check and experiment scripts. The `check:*` scripts in [`package.json`](package.json) guard individual invariants. | `pnpm typecheck:scripts`, then the `check:*` script for the invariant |
| `clients/python/` | The Python client for the wire protocol. | See [its README](clients/python/README.md) |
| `evidence/` | Measured results, indexed by [`evidence/INDEX.md`](evidence/INDEX.md). | `pnpm evidence:check` |
| `benchmarks/` | Committed benchmark runs and their tools. A run folder is a record of what happened, not library code. | None; see the run's README where it has one |
| `docs/` | Current design and usage docs. | Named paths and links resolve |
| `archive/` | Dated records superseded by later work. Read them for history only. | None |
| `CHANGELOG.md` | Release history. | None |

## Shared helpers

Each shared concern has one owner. Import it; do not re-implement it.

- Canonical JSON and digests: [`src/ledger-core/canonical.ts`](src/ledger-core/canonical.ts). It delegates encoding to `agent-interface`. Check with `pnpm check:canonical-json`.
- Seeded random draws: `makeRng` in [`src/statistics/internal.ts`](src/statistics/internal.ts).
- Statistics and estimators: [`src/statistics/`](src/statistics). Decisions: [statistics-decisions](docs/design/statistics-decisions.md).
- Numeric primitives: [`src/math/`](src/math).
- Model prices and cost: [`src/cost-ledger/pricing.ts`](src/cost-ledger/pricing.ts).
- Model-output JSON recovery: [`src/llm-client/json.ts`](src/llm-client/json.ts).
- Served-model and backend identity: [`src/integrity/`](src/integrity).
- Trace redaction: [`src/trace/redaction/`](src/trace/redaction), documented in [redaction.md](docs/redaction.md).

## Read for the task

- For orientation, read [concepts.md](docs/concepts.md), [README.md](README.md), and the [charter](docs/charter.md).
- For maintenance, read the repository's [agent-eval skill](.claude/skills/agent-eval/SKILL.md). It defines the workflow and points to current source.
- For gating a run on the path it took, read [trace-contracts.md](docs/trace-contracts.md). This package owns the one trajectory-contract checker; `traces check` in `/traces` calls it.
- For a finding's layer, population, promotion or the findings ledger, read [finding-layers.md](docs/finding-layers.md).
- For redacting or share-safety-checking a trace, read [redaction.md](docs/redaction.md). This package owns the one redaction core (`./traces` export); agent-runtime, traces and run-capsule import it instead of keeping their own patterns.
- For registered experiments, read [experiment.md](docs/experiment.md).
- For checks without an answer key, read [verification-strategies.md](docs/verification-strategies.md).
- For result vocabulary and certification, read [verdicts.md](docs/verdicts.md).
- For conversation-engine regressions, read [multishot-golden-records.md](docs/multishot-golden-records.md).
- For non-TypeScript consumers, read [wire-protocol.md](docs/wire-protocol.md) and the [Python client guide](clients/python/README.md).
- For fleet execution, debugging, or experiment integrity, read [building-doctrine.md](docs/building-doctrine.md).

Update the document closest to a change.
Keep API and command details in their current owning source rather than copying them here.
Use the package scripts for build, tests, type checks, and benchmark-identity updates.

## Source delivery

Work on a feature branch and run relevant checks while developing. Land authorized PRs into `main` with `gh pr merge <PR> --merge --match-head-commit <INTENDED_HEAD_SHA>` using the writer-authenticated CLI. Capture the intended head first; read back `mergedAt` and `mergeCommit` before reporting completion. No additional merge wrapper or host installation is required.

Before merge, run the local Beelink gate; repositories carry no PR or push CI. Versioning and publication remain separate operations. Release PRs and external contributions retain their qualification. Drafts, explicit holds, conflicts and native repository restrictions still apply; do not use administrator bypasses or fabricate test results. A skipped job is not a test pass.

Local Beelink gate (set `TOUCHED_INTEGRATION_TEST` to the affected integration file; the gate installs from the frozen pnpm lockfile): `beelink-gate auto https://github.com/tangle-network/agent-eval.git "$(git rev-parse HEAD)" -- sh -c 'pnpm typecheck && pnpm exec vitest run "$1"' _ "${TOUCHED_INTEGRATION_TEST:?set touched integration test path}"`.

Package preparation and npm/Python publication are separate authorized operations with their existing qualification and credential controls. Evaluation verdicts and experiment promotion below are product behavior, not Git merge gates; their validation remains mandatory.

## Dependency and evidence boundaries

`agent-interface` owns portable contracts.
This package owns evaluation concepts; `agent-runtime` and `agent-knowledge` consume them.
Do not import either consumer here or declare it as a runtime, development, or peer dependency.
Move portable contracts to `agent-interface` and evaluation concepts here.
Keep concepts coupled to running execution in `agent-runtime`, or accept execution through callbacks.

Run `pnpm check:canonical-json` when changing stable serialization; preserve one encoder.

External-boundary calls return typed outcomes with explicit success or failure and diagnostic information.
Inspect `succeeded` before using `value`; fallback policies must be explicit.
Missing evidence must remain distinguishable from a measured zero or a successful empty result.

## Local conventions

TypeScript is strict, with single quotes, two-space indentation, and no semicolons.
Comments explain current behavior and reasons; change history belongs in commits and pull requests.
Do not add AI-attribution trailers to commits or artifacts.
A name means one concept in this repo: when two modules export the same name for different things, rename one so the name says what it is.
