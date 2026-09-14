# Evaluation integrity example

Run an offline candidate search, audit its deterministic checker, and export the comparison report.
The example imports only public package entrypoints and makes zero paid calls.

From the repository root:

```sh
pnpm build
pnpm exec tsx examples/evaluation-integrity/index.ts
```

The search evaluates two arithmetic behaviors and selects the one that adds correctly.
Forty source tasks have two variants each.
The final comparison keeps source families separate from candidate selection.
The script checks the selected surface, observed lift, gate decision, cost, and durable exposure record.

Outputs appear under `.agent-eval/evaluation-integrity-example/`:

- `audit-controls.json` contains the executed good and bad controls.
- `report.json` contains evaluator error bounds and the actual final comparison.
- `final-evidence.jsonl` and its `.head` file retain reservation and exposure.

The final-evidence guard refuses a second measurement with the same reserved source units.
For disposable integration checks, pass a scratch output directory as the first argument.
Production decisions need a persistent shared ledger and fresh source evidence.

The fixture verifies public API composition.
It does not measure model-backed improvement or establish independent audit authority.
See [evaluation integrity](../../docs/evaluation-integrity.md) for methodology and the controls appropriate to each claim.
