# Retained external dispatch

`createRetainedDispatch` from `@tangle-network/agent-eval/campaign` wraps an external dispatch. `runEval` remains the scheduler and measurement owner. Separate named allowances reserve development and audit calls; they are counts, not monetary receipts.

The owning durable Run binds authority, execution revision and receipt-decoder revision in `scope`. Record that a scope has started outside its local directory, then use `requireExisting: true` when recovering that scope. Complete directory loss must not be mistaken for a new allowance.

An immutable `dispatch-scope.json` binds the run scope and named limits.
Every history event is committed in two durable steps through the existing compare-and-append contract.
The event is appended to `dispatches.jsonl`, then `dispatch-anchor.jsonl` records the committed byte length and cumulative digest.
The digest covers the history header, which binds the anchor to the scope and limits.
An event takes effect only after its anchor entry is durable.
An external dispatch therefore cannot run before its `started` event is anchored.
Settlement cannot be replayed before its event is anchored.

On open and before every replay, history must match its durable high-water mark exactly.
Truncation below the anchor, including to a valid header-only journal, stops for reconciliation.
History that diverges from the anchor or extends beyond it also stops for reconciliation.
Committed allowances are not reset, no allowance is reissued, and no dispatch is repeated.
An unanchored suffix is never trusted or synthesized.
A crash between the journal and anchor appends also stops for reconciliation.
Missing, empty, torn, or changed history is refused.
History without its anchor is half-initialized or tampered, and no such state is cleared automatically.
A live instance also rechecks the anchored history before replay.

Concurrent processes use compare-and-append for each file.
A writer that loses the journal append race refreshes and retries against committed state.
A reader that lands inside another writer's two-step commit window fails closed.
Retry after the writer completes by constructing a new instance.
If the writer stopped before anchoring its event, reconcile the incomplete state before resuming.
Explicit measured failures can be retained.
An external throw or an unretained side effect remains `outcome_unknown` and keeps its reservation.
The existing retained-result reconciliation handles a result written before its settlement event.

Receipt parsing must preserve the canonical stored value. A different decoder cannot transform old evidence while keeping the original digest. This check is not proof that the external receipt is true; the caller still owns its provenance and authorization.

## Upgrading existing runs

Existing v1 directories without a scope anchor deliberately stop for reconciliation.
Directories with a scope anchor but no `dispatch-anchor.jsonl` also stop.
That state may be half-initialized, interrupted between the history and anchor appends, or tampered.
This release never synthesizes an anchor from potentially incomplete state.
Do not delete them, change their directory, or clear the owning Run's started marker to retry.
Drain existing runs with their pinned implementation, or have the authority owner reconcile their original history and evidence before migration.

A partially initialized scope also stops rather than assuming nothing ran. The durable owner can distinguish an initialization failure from an issued external dispatch using its own record.

This mechanism does not certify arbitrary storage rollback or corruption, globally exactly-once remote effects, financial settlement, or semantic correctness. An independent durable Run/fence and proper storage retention remain necessary.

## Executed checks

```sh
pnpm exec tsx scripts/prove-retained-dispatch.ts
pnpm exec tsx scripts/prove-retained-dispatch-integrity.ts
```

The first maintained proof exercises contention, SIGKILL, failed dispatches, retained-result reconciliation and audit reservations. The second adds independent-process journal-loss, empty-history, header-only-truncation, whole-directory-loss, stale-live-instance and changed-decoder checks. Both perform real filesystem and child-process operations, with no provider calls.
