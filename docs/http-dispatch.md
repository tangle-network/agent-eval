# Distributed dispatch: execution, retries and receipts

`httpDispatch()` and `runDispatchServer()` are the existing `/adapters/http` transport. They do not own a second scheduler, an execution database, or an exactly-once protocol. Keep durable execution ownership in the worker's existing Run/retained-dispatch mechanism.

## Migration

`httpDispatch()` now makes **one attempt by default** (`retries: 0`, previously 2). A disconnected response or HTTP 500 does not establish that a worker did nothing. Applications that explicitly enable retries must bind request identity and external effects to a durable worker-side deduplication contract first. Existing explicit `retries` configuration remains supported.

Caller cancellation, terminal HTTP refusals, malformed success bodies, missing artifacts and receipt-import failures do not redispatch work. An error response carrying paid receipts is also terminal: import the already-settled spend, then report the failure. Request bytes and run/cell identities stay unchanged across explicitly enabled transport attempts. Backoff is cancellable.

The worker's optional `contextFactory` must supply a real `CampaignCostMeter` for paid work. A missing meter refuses `runPaidCall` before its execute callback. Deterministic work remains usable without a cost factory. Work performed outside the meter is not thereby free; the host must require and reconcile the appropriate evidence.

## Accounting boundary

Workers authorize and cap spend **before execution**. The client imports receipts after the operation; that cannot retroactively enforce a coordinator ceiling. Successful responses, failures and deliverable cancellation responses carry the same available settled receipts. Unknown cost stays unknown.

If the client disconnects before receiving a result, reconcile the worker's authoritative ledger. Do not reset an allowance or repeat the operation to reconstruct a lost receipt. This adapter does not implement that reconciliation or authorize an outer workflow to retry.

## Verification

The maintained `src/adapters/http.test.ts` uses real loopback Node HTTP, the actual client/server, real filesystem effects, and the native cost ledger. Five regressions distinguish the old behavior from the corrected boundary: terminal authorization, failure after a file effect, charged failure, charged cancellation and failed coordinator receipt import. The two existing connection/cancellation cases remain.

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run src/adapters/http.test.ts
pnpm typecheck
pnpm build
pnpm verify:package
```

Ledger amounts in the transport cases are synthetic; no provider call is needed to prove this boundary. Passing them is not a model-quality, task-success, live deployment, isolation, or customer-savings claim.

For a real application comparison, use the existing campaign/experiment APIs over complete application jobs. Preserve assigned failures, immutable checker and policy identities, full cost evidence, fresh final tasks and existing controlled publication. A transport check and a customer-benefit experiment answer different questions.
