# Typed evaluation product adoption (0.184.0)

This release makes the already-merged `/evaluation` and `/jev` entrypoints available in a new,
immutable package version. The published 0.183.0 tarball does not contain those entrypoints;
changing main's files without publishing a new version does not upgrade a consumer.

`EvaluationAccount` is the minimal existing paid-call contract. Pass a campaign's `context.cost`
directly to any evaluator instead of creating another account or casting a cell meter to a full
ledger. Direct calls and judge/analyst adapters retain the existing account precedence.

The regression uses the real profile matrix, its artifact store and an independent outcome
label across two configurations. It checks selected actions and per-cell spend, not code shape, generated prose length,
or the number of findings. It is a deterministic injected-classifier check, not a live benchmark.

Release npm/Python 0.184.0 through the existing publish workflow, then regenerate consumer locks
against the published artifact. Platform/Intelligence adoption is a dependent change. Do not
republish 0.183.0, commit a locally built tarball, or claim candidate-package tests prove a registry
release or a production deployment.
