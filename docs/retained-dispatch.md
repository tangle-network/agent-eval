# Retained external dispatch

`createRetainedDispatch` from `@tangle-network/agent-eval/campaign` wraps an external dispatch. `runEval` remains the scheduler and measurement owner. Separate named allowances reserve development and audit calls; they are counts, not monetary receipts.

The owning durable Run binds authority, execution revision and receipt-decoder revision in `scope`. Record that a scope has started outside its local directory, then use `requireExisting: true` when recovering that scope. Complete directory loss must not be mistaken for a new allowance.

An immutable `dispatch-scope.json` precedes the append-only dispatch history. A missing, empty, torn or changed history is refused. A live instance also rechecks history before replay. Explicit measured failures can be retained; an external throw or an unretained side effect remains `outcome_unknown` and keeps its reservation. The existing retained-result reconciliation handles a result written before its settlement event.

Receipt parsing must preserve the canonical stored value. A different decoder cannot transform old evidence while keeping the original digest. This check is not proof that the external receipt is true; the caller still owns its provenance and authorization.

## Upgrading existing runs

Existing v1 directories without a scope anchor deliberately stop for reconciliation. Do not delete them, change their directory, or clear the owning Run's started marker to retry. Drain existing runs with their pinned implementation, or have the authority owner reconcile their original history and evidence before migration. This release does not synthesize an anchor from potentially incomplete historical data.

A partially initialized scope also stops rather than assuming nothing ran. The durable owner can distinguish an initialization failure from an issued external dispatch using its own record.

This mechanism does not certify arbitrary storage rollback or corruption, globally exactly-once remote effects, financial settlement, or semantic correctness. An independent durable Run/fence and proper storage retention remain necessary.

## Executed checks

```sh
pnpm exec tsx scripts/prove-retained-dispatch.ts
pnpm exec tsx scripts/prove-retained-dispatch-integrity.ts
```

The first maintained proof exercises contention, SIGKILL, failed dispatches, retained-result reconciliation and audit reservations. The second adds independent-process journal-loss, empty-history, whole-directory-loss, stale-live-instance and changed-decoder checks. Both perform real filesystem and child-process operations, with no provider calls.
