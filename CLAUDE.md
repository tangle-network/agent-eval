# agent-eval

This package owns evaluation data, scoring, experiment decisions, and release evidence.

## Read for the task

- For orientation, read [concepts.md](docs/concepts.md), [README.md](README.md), and the [charter](docs/charter.md).
- For maintenance, read the repository's [agent-eval skill](.claude/skills/agent-eval/SKILL.md).
  It defines the workflow and points to current source.
- For registered experiments, read [experiment.md](docs/experiment.md).
- For checks without an answer key, read [verification-strategies.md](docs/verification-strategies.md).
- For result vocabulary and certification, read [verdicts.md](docs/verdicts.md).
- For conversation-engine regressions, read [multishot-golden-records.md](docs/multishot-golden-records.md).
- For non-TypeScript consumers, read [wire-protocol.md](docs/wire-protocol.md) and the [Python client guide](clients/python/README.md).
- For fleet execution, debugging, or experiment integrity, read [building-doctrine.md](docs/building-doctrine.md).

Update the document closest to a change.
Keep API and command details in their current owning source rather than copying them here.
Use the package scripts for build, tests, type checks, and benchmark-identity updates.

## Dependency and evidence boundaries

`agent-interface` owns portable contracts.
This package owns evaluation concepts; `agent-runtime` and `agent-knowledge` consume them.
Do not import either consumer here or declare it as a runtime, development, or peer dependency.
Move portable contracts to `agent-interface` and evaluation concepts here.
Keep concepts coupled to running execution in `agent-runtime`, or accept execution through callbacks.

Use `src/ledger-core/canonical.ts` for ledger canonicalization and digests.
It delegates canonical JSON encoding to `agent-interface`.
Run `pnpm check:canonical-json` when changing stable serialization; preserve one encoder.

External-boundary calls return typed outcomes with explicit success or failure and diagnostic information.
Inspect `succeeded` before using `value`; fallback policies must be explicit.
Missing evidence must remain distinguishable from a measured zero or a successful empty result.

## Local conventions

TypeScript is strict, with single quotes, two-space indentation, and no semicolons.
Comments explain current behavior and reasons; change history belongs in commits and pull requests.
Do not add AI-attribution trailers to commits or artifacts.
