# Complete optimization search history

A selected prompt, profile, or patch is not a record of the search that produced it. A trustworthy optimizer must account for what it planned, tried, failed to run, rejected, and left unresolved before its winner is evaluated on untouched final cases.

Eval already has one rich source of truth for that process: `SearchLedger`. This feature does not add another event log.

```text
SearchLedger JSONL                 canonical facts and rich evidence
        │
        ├── hash chain             mutation and truncation detection
        ├── replay audit           planned denominator and unresolved work
        └── SearchHistoryReceipt   bounded proof envelope
                    │
                    └── compareOptimizationMethods({
                          searchHistoryPolicy: 'require-complete'
                        })
```

## ELI5

`SearchLedger` is the sealed laboratory notebook. `SearchHistoryReceipt` is the small signed cover sheet saying which notebook, which run, and whether the notebook accounts for the whole planned experiment.

The cover sheet does not copy every page. To inspect a candidate, failed attempt, missing task id, decision, or accounting gap, open the notebook.

## What the receipt contains

The receipt is bounded by the contract rather than by search length. It carries:

- the producer and concrete run identity;
- a content-addressed reference to the canonical ledger bytes;
- the digest of the exact replay audit;
- counts and terminal state needed to classify completeness;
- short, count-based incompleteness reasons;
- its own RFC 8785 SHA-256 digest.

It does not carry event arrays, candidate inventories, attempt records, decisions, or lists of every missing id. Those remain in `SearchLedgerReplay`.

## Create a receipt

Create receipts only from the result returned by `SearchLedger.replay()`:

```ts
import {
  createSearchHistoryReceipt,
  openSearchLedger,
} from '@tangle-network/agent-eval/campaign'

const searchLedger = openSearchLedger({
  path: '/runs/gepa/search-ledger.jsonl',
  campaignId: 'gepa-run-42',
})

const replay = await searchLedger.replay()
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

First-party optimizer adapters should do this automatically. Application code should not hand-author receipt JSON.

## Complete means the planned denominator is closed

A receipt is complete only when canonical replay reports:

- a search plan;
- a terminal `search-completed` event;
- no unresolved candidate slots;
- no missing planned task outcomes;
- no missing planned operations;
- no pending candidate decisions;
- a terminal status of `selected` or `all-rejected`.

Cost completeness remains a separate contract. Unknown spend stays unknown; it is never converted into zero merely because search history is complete.

## Compare methods without exposing final cases

Existing callers remain compatible. Missing history is reported:

```ts
const comparison = await compareOptimizationMethods({
  methods,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  // existing options
})

console.log(comparison.searchHistory)
```

Autonomous or publication-grade callers fail closed:

```ts
const comparison = await compareOptimizationMethods({
  methods,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  searchHistoryPolicy: 'require-complete',
  // existing options
})
```

Every method finishes optimization before the first untouched-final-test dispatch. Under `require-complete`, missing, malformed, producer-mismatched, interrupted, or denominator-incomplete evidence aborts at that boundary.

## Verification boundary

`verifySearchHistoryReceipt()` verifies the bounded envelope and its canonical digest.

`assertSearchHistoryMatchesReplay()` additionally proves that the envelope was derived from the supplied canonical replay.

Neither function fetches or retains the ledger artifact. A skeptical consumer must resolve `receipt.ledger`, verify its digest and byte length, replay it with `SearchLedger`, and then call `assertSearchHistoryMatchesReplay()`.

The receipt does not prove that:

- the optimizer searched intelligently;
- a candidate is correct, safe, or novel;
- the winner generalizes;
- an external source identity is honest;
- knowledge caused an improvement;
- the artifact URI will remain available.

Those claims require held-out evaluation, artifact retention, provenance verification, knowledge-use evidence, and causal experiments.

## Ownership

- **Eval** owns search evidence, completeness, held-out comparison, statistics, and release decisions.
- **Runtime** owns execution, checkpoints, cancellation, and resume orchestration while referencing Eval evidence.
- **Knowledge** owns what information was visible, retrieved, and selected for use.
- **Interface** owns portable profiles, diffs, identities, and digest primitives.
- **SDKs** should automate these owner contracts, not copy their types or introduce another optimizer loop.
