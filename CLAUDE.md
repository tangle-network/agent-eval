# agent-eval

This package owns evaluation data, scoring, experiment decisions, and release evidence.

## Source delivery

Work on a feature branch and run relevant checks while developing. Land authorized PRs into `main` with `gh pr merge <PR> --merge --match-head-commit <INTENDED_HEAD_SHA>` using the writer-authenticated CLI. Capture the intended head first; read back `mergedAt` and `mergeCommit` before reporting completion. No additional merge wrapper or host installation is required.

Ordinary internal source PRs do not wait for CI, local signoff, version bumps or publication. Release PRs and external contributions retain verification. Drafts, explicit holds, conflicts and native repository restrictions still apply; do not use administrator bypasses or fabricate test results. A skipped job is not a test pass.

Package preparation and npm/Python publication are separate authorized operations with their existing qualification and credential controls. Evaluation verdicts and experiment promotion below are product behavior, not Git merge gates; their validation remains mandatory.

## Read for the task

- For orientation, read [concepts.md](docs/concepts.md), [README.md](README.md), and the [charter](docs/charter.md).
- For maintenance, read the repository's [agent-eval skill](.claude/skills/agent-eval/SKILL.md).
  It defines the workflow and points to current source.
- For gating a run on the path it took, read [trace-contracts.md](docs/trace-contracts.md).
  This package owns the one trajectory-contract checker; `traces check` in `/traces` calls it.
- For a finding's layer, population, promotion or the findings ledger, read [finding-layers.md](docs/finding-layers.md).
- For redacting or share-safety-checking a trace, read [redaction.md](docs/redaction.md).
  This package owns the one redaction core (`./traces` export); agent-runtime, traces and run-capsule import it instead of keeping their own patterns.
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
