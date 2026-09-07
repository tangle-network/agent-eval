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

First-party optimizers do this for you. Application code should not hand-author receipt JSON.

## Record a search from the loop

`runOptimization()` and `selfImprove()` accept `searchLedger` and return the receipt on `searchHistory`:

```ts
import { openSearchLedger, runOptimization } from '@tangle-network/agent-eval/campaign'

const result = await runOptimization({
  // ...scenarios, dispatchWithSurface, judges, proposer, populationSize, maxGenerations, runDir
  searchLedger: {
    ledger: openSearchLedger({ path: `${runDir}/search-ledger.jsonl`, campaignId: runId }),
    identity: {
      agent: { uri: 'git+https://github.com/acme/agent.git', revision: agentCommit },
      proposer: { kind: 'deterministic', source: { uri: proposerUri, revision: proposerCommit } },
      search: { uri: searchUri, revision: searchCommit },
      model: { provider: 'openai', snapshot: 'gpt-5.4@2026-06-01' },
    },
  },
})
```

The loop emits the plan, one candidate-generation operation per generation, one registration per candidate with the exact parent it mutated, one task attempt per designed cell, one decision per candidate, and the terminal event.

`identity` carries what the ledger requires and a campaign cannot infer: immutable revisions for the agent, proposer, and search implementations, plus the model the agent runs. A measured value wins wherever execution reported one; a cell that ran a moving model alias is refused rather than recorded as an immutable identity.

`gepaOptimizationMethod({ searchLedger: { identity } })` records GEPA's own candidate population into the same ledger, so a comparison under `require-complete` accepts it.

## Extend a plan for a rolling search

A search whose length is not known when it starts appends `search-plan-extended` with the extra candidate slots and operations.
The first plan event stays first, the effective plan is the merge, and the generation invariant continues across rounds: a candidate whose parent is a round-one candidate is generation 2, not a restarted 0.

The planned task denominator does not extend. Extending it would reopen candidates that already closed their tasks.

A search still uses one ledger. A parent from an earlier ledger enters as a generation-0 `candidate-registered` whose surface artifact references the prior ledger, because a cross-file parent cannot be replayed and verified from these bytes.

## Complete means the planned denominator is closed

A receipt is complete only when canonical replay reports:

- a search plan;
- a terminal `search-completed` event;
- no unresolved candidate slots;
- no missing planned task outcomes;
- no missing planned operations;
- no pending candidate decisions;
- a terminal status of `selected` or `all-rejected`.

A first-party recorder appends the terminal event only when replay already accounts for the whole planned denominator. An interrupted run, or a candidate that left a designed cell unscored, stays `in-progress` and reports the exact gap.

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

`selfImprove({ method })` accepts the same `searchHistoryPolicy` and `searchHistoryVerification` options.
Both workflows use the same method preparation, result validation, cost reconciliation, and history admission.
`selfImprove` returns `searchHistoryCoverage`; comparison returns coverage for every method.
The default remains `allow-missing` with receipt verification.

### Verify referenced history before final assessment

Set `searchHistoryVerification: 'ledger'` to require the referenced bytes, even with `allow-missing`.
Combine it with `require-complete` to require both verified bytes and complete history.

```ts
const comparison = await compareOptimizationMethods({
  // ...methods, partitions, dispatch, judges, runDir
  searchHistoryPolicy: 'require-complete',
  searchHistoryVerification: 'ledger',
  storage,
})
```

Eval reads the receipt URI through `storage.read`.
A `file:` URI becomes a local path; other URIs remain opaque storage keys.
A custom `CampaignStorage` can resolve retained artifacts without another ledger implementation.
Missing bytes, length or digest mismatches, invalid chains, and replay discrepancies refuse final dispatch.
A verified coverage row carries `ledgerVerified: true`.
Receipt-only coverage does not make that claim.

Existing search recorders compute `ledger.sha256` with `hashCanonical` over the complete JSONL string.
It hashes that string's canonical JSON encoding, rather than the raw UTF-8 file.
Verification preserves this existing identity scheme.
`byteLength` measures the UTF-8 JSONL bytes.

Every method finishes optimization before the first untouched-final-test dispatch. Under `require-complete`, missing, malformed, producer-mismatched, interrupted, or denominator-incomplete evidence aborts at that boundary.

## Verification boundary

`verifySearchHistoryReceipt()` verifies the bounded envelope and its canonical digest.

`assertSearchHistoryMatchesReplay()` additionally proves that the envelope was derived from the supplied canonical replay.

`verifySearchHistoryArtifact(receipt, storage)` resolves bytes and runs both checks through the canonical journal codec.
The two receipt-only functions do not fetch or retain the ledger artifact. A skeptical consumer must resolve `receipt.ledger`, verify its digest and byte length, replay it with `SearchLedger`, and then call `assertSearchHistoryMatchesReplay()`.

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

## Bind final measurements to execution evidence

Both complete-method workflows accept optional `evidence: CampaignEvidenceContext`.
It requires the caller's pursuit, evaluator, environment, authority, and attestation provenance.
Eval does not infer independent authority or certify those external declarations.

Each measured baseline and winner receives the existing `EvidenceReceipt` format.
Eval derives candidate, input-set, output, and result digests from the executed surface and complete campaign.
A missing or deferred final measurement cannot produce a receipt.
Receipts describe measurements; they do not override the release gate or replace the method's selected winner.

`createCampaignEvidenceReceipt` on `/experiment` provides the same binding for other complete campaign consumers.
Changing an output changes its output digest; changing a judge result changes its measurement digest.
The final receipt retains caller authority, including `candidate-self-report`, without upgrading it.
