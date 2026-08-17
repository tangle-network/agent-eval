# Complete optimization history

A winning surface is not a search history.

`compareOptimizationMethods()` can now retain a content-addressed receipt for each method's complete search ledger. The ledger remains the sole detailed record. The receipt is a compact, immutable index that binds the ledger bytes, hash-chain head, event inventory, entity inventory, terminal state, accounting audit, and every unresolved denominator.

## ELI5

Think of an optimizer as a scientist trying many ideas.

Without complete history, the final report says only:

> Idea 17 won.

With complete history, the report also points to a sealed flight recorder containing:

- every planned candidate slot;
- every candidate actually registered;
- every slot closed without a candidate and why;
- every task attempt and outcome;
- every model-backed or deterministic search operation;
- every selection or rejection;
- every cost and token accounting gap;
- the terminal search decision.

The final test still acts as a separate referee. Search history does not expose final-test cases to the optimizer.

## One API

History is an additive field on the existing optimization contract. There is no second comparison function and no second search-history format.

```ts
import {
  compareOptimizationMethods,
  createOptimizationHistoryReceipt,
  openSearchLedger,
} from '@tangle-network/agent-eval/campaign'

const method = {
  name: 'my-optimizer',
  async optimize(input) {
    const ledger = await openSearchLedger({
      path: `${input.runDir}/search-ledger.jsonl`,
      campaignId: 'my-optimizer-run',
    })

    // Append search-planned, candidate-registered, task-attempted,
    // search-operation-recorded, candidate-decided, and search-completed
    // events while the optimizer runs.

    const replay = await ledger.replay()
    const history = createOptimizationHistoryReceipt({
      methodName: 'my-optimizer',
      runId: 'my-optimizer-run',
      ledger: {
        role: 'search-ledger',
        uri: `artifact://${input.runDir}/search-ledger.jsonl`,
        sha256: ledgerArtifactDigest,
        byteLength: ledgerArtifactBytes,
      },
      replay,
    })

    return {
      winnerSurface,
      cost,
      history,
    }
  },
}

const comparison = await compareOptimizationMethods({
  methods: [method],
  baselineSurface,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges,
  runDir,
  historyPolicy: 'require-complete',
})

console.log(comparison.optimizationHistory)
console.log(comparison.best.history?.receiptDigest)
```

## Migration policy

The default is `historyPolicy: 'allow-missing'`.

Existing methods continue to run unchanged. The comparison reports each method as `complete`, `incomplete`, or `missing`. This makes adoption visible without breaking every optimizer at once.

Use `historyPolicy: 'require-complete'` for claims that depend on the whole search process. Eval then refuses before the first untouched-final-test dispatch unless every method supplies a valid, terminal, denominator-complete receipt.

```ts
comparison.optimizationHistory = {
  policy: 'allow-missing',
  allComplete: false,
  methods: [
    {
      methodName: 'legacy-optimizer',
      status: 'missing',
      reasons: ['history receipt is missing'],
    },
  ],
}
```

## What the receipt proves

A verified receipt proves that one exact content-addressed search-ledger artifact is indexed by one exact receipt and that the supplied audit and event inventory have not changed.

`assertOptimizationHistoryMatchesReplay()` additionally proves that the receipt still describes a supplied verified ledger replay.

A complete receipt proves that the planned search denominator reached a terminal state: candidate slots, task outcomes, operations, and decisions have no unresolved gaps.

## What it does not prove

The receipt does not prove that:

- the winner is good;
- the optimizer searched intelligently;
- a reported score is correct;
- the selected surface generalizes;
- a knowledge page caused the result;
- the result is novel.

Those are separate claims. Final-test comparison, verifier evidence, knowledge-use receipts, novelty/reuse adjudication, and causal experiments remain separate on purpose.

## Ownership

- **Eval** owns the search ledger, history receipt, completeness policy, final-test comparison, and causal adjudication.
- **Runtime** owns execution, checkpointing, trace emission, and propagation of Eval's receipt.
- **Knowledge** owns page visibility, retrieval, and downstream-use receipts.
- **Interface** owns portable agent-profile and content identities, not domain-specific ledgers.
- **SDKs** should provide ergonomic builders, adapters, examples, and re-exports without becoming a second contract owner.

## Design constraints

1. One rich history: the existing hash-chained search ledger.
2. One comparison API: `compareOptimizationMethods()`.
3. Receipts index artifacts; they do not copy their detailed records.
4. Missing evidence stays missing. It is never converted to zero, success, or rejection.
5. Requiring complete history happens before untouched-final-test scoring.
6. Default behavior remains source-compatible for existing methods.
