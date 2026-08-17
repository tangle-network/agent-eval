# Complete search history

Optimization is not only the winning prompt, profile, or patch. A trustworthy optimizer must retain the complete search it performed: what it planned to try, what it actually tried, what failed to run, what was rejected, what it spent, and why it stopped.

Eval already has one canonical representation for this: `SearchLedger`. The history receipt in this package does **not** introduce another event log.

```text
SearchLedger JSONL               canonical facts and rich evidence
        │
        ├── hash chain           mutation and truncation detection
        ├── replay audit         planned denominator and unresolved work
        └── SearchHistoryReceipt compact, content-addressed table of contents
                    │
                    └── compareOptimizationMethods(...,
                          searchHistoryPolicy: 'require-complete')
```

## ELI5

Imagine several scientists competing to improve an agent. Previously, each scientist could hand back only their favorite answer. You could test the favorites, but you could not see the discarded ideas, broken experiments, missing measurements, or whether the scientist quietly stopped early.

`SearchLedger` is the sealed lab notebook. `SearchHistoryReceipt` is its tamper-evident table of contents. Strict comparison says: **no final exam until every scientist hands in a complete notebook**.

## One source of truth

Rich records stay in the ledger:

- the search plan;
- candidate slots and explicit closed slots;
- candidate identity and lineage;
- every task attempt and outcome;
- model, agent, benchmark, and source identity;
- surface firing/effect evidence;
- every model-backed or deterministic search operation;
- token and cost accounting, including explicit unknowns;
- selected and rejected decisions;
- the terminal result;
- content-addressed artifacts.

The receipt copies none of those records. It binds the ledger artifact, verified head, replay audit, event addresses, and a small identity inventory. Deleting the ledger destroys the evidence; the receipt cannot masquerade as a replacement.

## Creating a receipt

Create it only from a replay returned by the canonical ledger implementation:

```ts
import {
  createSearchHistoryReceipt,
  openSearchLedger,
} from '@tangle-network/agent-eval/campaign'

const ledger = await openSearchLedger({
  path: '/runs/gepa/search-ledger.jsonl',
  campaignId: 'gepa-run-42',
})
const replay = await ledger.replay()

const receipt = createSearchHistoryReceipt({
  producerId: 'gepa',
  runId: 'gepa-run-42',
  ledger: {
    role: 'search-ledger',
    uri: 'artifact://gepa-run-42/search-ledger.jsonl',
    sha256: ledgerArtifactDigest,
    byteLength: ledgerArtifactBytes,
  },
  replay,
})
```

The receipt is complete only when the replay has:

- a search plan;
- a terminal `search-completed` event;
- no unresolved candidate slots;
- no missing task outcomes;
- no missing planned operations;
- no pending candidate decisions;
- a terminal status (`selected` or `all-rejected`).

Known cost is a separate requirement. A complete notebook may honestly contain unknown accounting; the comparison cost contract still prevents that subtotal from being represented as total spend.

## Comparing methods

Existing callers need no change. Missing history is reported but does not alter scoring:

```ts
const comparison = await compareOptimizationMethods({
  methods,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  // ...existing settings
})

console.log(comparison.searchHistory)
```

Autonomous or publication-grade callers should fail closed:

```ts
const comparison = await compareOptimizationMethods({
  methods,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  searchHistoryPolicy: 'require-complete',
  // ...existing settings
})
```

Every method finishes optimization before the first untouched-test call. Under `require-complete`, a missing, malformed, producer-mismatched, interrupted, or denominator-incomplete receipt aborts at that boundary. The final test is never used to rescue or diagnose an incomplete search.

## What it proves

A verified receipt proves that its compact index is internally intact and binds one declared content-addressed ledger artifact, ledger head, audit, producer, and run identity. Matching it against the supplied replay proves the receipt describes that exact replay.

It does **not** prove:

- that the optimizer searched intelligently;
- that a candidate is correct or safe;
- that a selected candidate generalizes;
- that the ledger artifact is durably retained at its URI;
- that a declared external source is honest;
- that knowledge caused an improvement;
- that the result is novel.

Those claims require the ledger bytes, artifact verification, held-out evaluation, provenance checks, knowledge-use receipts, and causal experiments.

## Package ownership

- **Eval** owns search plans, attempts, outcomes, decisions, completeness audits, and method comparison.
- **Runtime** owns executing candidates, durable checkpoints, trace emission, and resume orchestration.
- **Knowledge** owns visibility, retrieval, and downstream-use receipts for knowledge pages.
- **Interface** owns portable agent/profile identities and canonical digests. It should not own Eval's search semantics.
- **SDKs** should provide adapters and ergonomic builders around these contracts, not fork their types.

This boundary is intentional: shared identity primitives can move downward; domain claims stay with the package capable of verifying them.

## Integration checklist

A method is ready for strict comparison when it:

1. plans the complete denominator before work begins;
2. appends every candidate, closed slot, attempt, operation, decision, and terminal event;
3. records unknown accounting as unknown rather than zero;
4. stores the canonical JSONL artifact durably;
5. replays and audits that artifact;
6. returns a `SearchHistoryReceipt` whose `producerId` exactly matches its method name.

The best developer experience is a method adapter that performs steps 2–6 automatically while leaving candidate-generation strategy entirely unconstrained.
