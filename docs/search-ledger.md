# Search ledger

A selected prompt, profile, or patch is not a record of the search that produced it.
The search ledger is that record: a hash-chained event log of one search's nodes, edges, and cells, where every decision carries the evidence that justified it.
It is the search's only lineage record and its only resume checkpoint.

```text
search-ledger.jsonl          canonical JSONL, SHA-256 hash chain, trusted-head pin
  ├── blobs/<sha256>.json    surfaces, profiles, rationales, diffs, RunRecords
  ├── SearchState            the one projection: invariants and the read model
  └── SearchHistoryReceipt   bounded proof envelope for compareOptimizationMethods
```

## Terms

- **Node:** a content-addressed artifact, for example an AgentProfile or a prompt.
  `nodeId` is `searchNodeId(searchId, artifactDigest)`, so identical content in one search is one node.
- **Edge:** the proposal that derived a node from its parents.
  It records the operator, the proposer, the redacted rationale, and one parent-to-child diff per parent.
  `edgeId` is `searchEdgeId(searchId, childNodeId, proposalKey)`, where the proposal key names the proposal within the search, so a resumed search recognizes its own edges.
- **Cell:** one node on one task in one split at one repeat.
  `cellId` is `searchCellId(searchId, nodeId, taskId, split, rep)`.
  Each attempt at a cell has the run id `cellId:attempt`, the id its RunRecord carries.
- **Unit:** the claim's independent unit, usually the task's source.
  Repeats and sibling tasks of one unit average inside it before any statistic.
- **Splits:** `train` is the proposer's feedback, `selection` is private to the policy and allocator, and `test` is sealed for the claim.

## Events

| Event | Records |
|---|---|
| `search-opened` | Subject, process, artifact kind, objective with judge and claim, the three splits with their tasks and units, policy, budget, containment, derivation, identity. First and once. |
| `operation-started`, `operation-recorded` | A non-cell spend, such as one proposer call, with its reservation and then its outcome and accounting. |
| `node-registered` | A node, its artifact digest and declared surfaces. |
| `edge-recorded` | Parents (primary first), operator (`seed`, `draft`, `improve`, `debug`, `merge`, `derive`), attribution, proposer, selection rule, rationale, diffs, label. |
| `cell-allocated` | A planned cell with its stage (`root`, `train`, `screen`, `rung`, `claim`, `external`), lane, and reservation. |
| `cell-settled` | One attempt: outcome, accounting, time, placement, identity, surface evidence, trace reference, and optionally its RunRecord blob. |
| `cell-cancelled` | A cell that will not run: `pruned`, `budget`, `deadline`, or `aborted`. |
| `node-decided` | `advanced {rung}`, `pruned`, `invalid`, `finalist`, `selected`, or `rejected`, with its rule, reason, and the estimate it used. May repeat; the latest wins. |
| `search-closed` | The stop reason and the claim: power, finalists, the selected node, and `ship`, `hold`, or `test-cannot-resolve`. Last and once. |

Edge attribution says how the parents are known and is never inferred from timing or order:

- `explicit`: the proposer that created the child emitted the edge.
- `correlated`: an importer joined an optimizer's own parent record by content digest, for example GEPA's `parentIndices`.
- `unknown`: no parent record exists, and the edge names no parent.

## Invariants

`SearchState` applies every entry and refuses one that breaks an invariant.
The same code runs in the producer's journal, the kernel, and the Intelligence verifier.

- **Order:** `search-opened` comes first; nothing follows `search-closed`. More work on a closed search is a derived search.
- **Graph:** a node exists before an edge or cell names it, and a cell's node already has an edge. A parent registered before its child and already in the tree, so the graph is acyclic. A parent in another search appears only on a `derive` edge that matches `derivedFrom`.
- **Re-proposal:** identical content is a second edge into the existing node, counted as a re-proposal.
- **Splits:** a task belongs to one split and one unit. With `heldOutUnits`, no test unit appears in train or selection. Stages match splits: `claim` cells run on test, `screen` and `rung` on selection.
- **Seal:** only the root (the first registered node) and nodes decided `finalist` run test cells.
- **Attempts:** attempts count from 1 without gaps. A `passed` or `failed` outcome is final; only a retryable `errored` outcome admits another attempt.
- **Budget:** at every `cell-allocated` and `operation-started`, committed spend plus open reservations plus the unspent claim reserve plus the new reservation stays within `maxUsd`. Spend above a reservation is recorded as overspend, never refused. An unknown cost counts as its proven floor.
- **Completion:** `search-closed` needs every allocated cell settled or cancelled, every started operation recorded, and every node with an edge and a terminal decision. A `ship` claim needs a promoted finalist and held-out test units; any other claim keeps the root.

A ledger written under another schema tag, such as the retired `tangle.search-ledger.v1` candidate-slot format, is refused with the tag named.
It is never translated.

## Reading the state

`ledger.state()` and every append return a `SearchStateView`.
Its `header`, `head`, `audit`, `completion`, and `closed` are plain values.
Its node, edge, cell, unit-score, and lineage reads go to the live indexes, so taking a view costs the same at any search size.
A view is valid until the ledger applies its next entry; a later read throws instead of mixing two ledger positions.

```ts
const state = await ledger.state()
state.audit.cells // { allocated, settled, cancelled, open }
state.scoredCells(nodeId, 'selection') // [{ cellId, unitId, attempt, score }]
state.unitScores(nodeId, 'selection') // [{ unitId, sum, count, mean }]
state.lineage(record.search) // { depth, ordinal, rep, containingRunId } for mintRolloutRows
```

A unit's mean sums its cells in cellId order, so it depends on the set of cells and not on the order they settled in.

## Estimates

`estimateNode(state, nodeId, { against, split })` is the one statistic of a node.
It averages each node's scored cells inside their units, pairs the units both nodes scored, and runs `pairedDeltaTest` on the per-unit deltas.
Unscored cells (errored, cancelled or in flight) are absent, never zero.

| Pairs | `method` | Reported |
|---|---|---|
| 0 or 1 | `none` | nothing; the view shows "unknown (1 unit)" |
| 2 to 5 | `insufficient` | `delta` only |
| 6 to 19 | `descriptive` | `delta`, the bootstrap `interval` as spread, and `exactSignP` |
| 20 or more | `bootstrap` | `delta` and the decision-grade `interval` |

The thresholds are the library's own: `minimumPairsForPairedDeltaTest(0.95)` and `BOOTSTRAP_GATE_MIN_N`.
`units` counts the units the node scored; `pairs` counts the units both nodes scored.
`delta` is node minus `against` in the metric's units, so an improvement on a `minimize` objective is negative.
`exactSignP` is one-sided toward improvement in the objective's direction.
When every paired delta is equal, the estimate is `indeterminate`: its interval would have zero width, so it carries neither an interval nor a p-value.

`cellSetDigest` digests the contrast and exactly the cells read: id, unit, attempt and score, in cellId order.
Its first 32 bits seed the bootstrap, and `estimator` is `SEARCH_ESTIMATOR`, whose revision digests every parameter of the computation.
Equal cells therefore give equal bits in any process and in any row order.
A verifier that reads cells from its own store calls `estimateNodeFromCells` with them; `searchCellSetDigest` tells it whether a node's cells changed.

```ts
const estimate = estimateNode(state, childId, { against: parentId, split: 'selection' })
await recorder.decideNode({ nodeId: childId, decision, basis: estimate, rule, reason })
```

`searchPosterior(state, { split })` gives every node a normal posterior on its improvement over the root, for sampling parents.
Its mean is the node's mean per-unit improvement over the root, oriented so that larger is better in either direction.
Its variance is the search's pooled between-unit variance of those improvements divided by the node's shared units, so a node measured on one unit has a wide posterior, not none.
The root sits at exactly 0, and the pooled variance stays null until some node shares 2 units with the root.
Posterior numbers steer spend and claim nothing; a claim comes from the sealed test split.

## Record a search

`SearchRecorder` writes each fact the moment it exists.
Ids are deterministic and every write checks the ledger's state first, so a resumed search continues its ledger instead of conflicting with its own history.
Rationales and labels are redacted with the `share` profile before they are hashed; surfaces are stored as they ran.

```ts
import { openSearchLedger, SearchRecorder, surfaceNode } from '@tangle-network/agent-eval/campaign'

const ledger = openSearchLedger({ path: `${runDir}/search-ledger.jsonl`, searchId })
const recorder = await SearchRecorder.open({ ledger }, opening)
const root = await recorder.registerNode(surfaceNode(recorder, baseline))
await recorder.recordEdge({
  childNodeId: root.nodeId, parents: [], operator: 'seed', attribution: 'explicit',
  proposer: null, proposalKey: 'baseline', rationale: { unknown: 'the starting surface' }, diffs: [],
})
const cellId = await recorder.allocateCell({ nodeId: root.nodeId, taskId, split: 'selection', rep: 0, stage: 'root' })
await recorder.settleCell({ cellId, outcome, accounting, identity, runRecord })
```

`runOptimization` and `selfImprove` run on the kernel below and return the receipt on `searchHistory`.
The loop's scenarios are its proposer's feedback, so they are the train split; its promotions are budget decisions and it makes no claim.

`gepaOptimizationMethod({ searchLedger: { identity } })` records GEPA's search when it finishes.
`importGepaPopulation` turns the population into nodes and `correlated` edges and reports collapsed duplicates.
`importExternalEvaluations` turns every callback evaluation into an `external` cell; a candidate GEPA evaluated but kept out of its population gets an `unknown` edge and is decided `pruned`.

## Run a search: the kernel

`runSearch` is the one loop every optimizer runs on.
It separates three decisions: where to expand (a `SearchPolicy`), where to spend rollouts (a `SearchAllocator`), and what to claim (the claim step on the sealed test split).
There is no generation barrier.
A lane that frees up takes the next allocated cell: claim cells first, then rung and root cells, then screens, then train cells.
The policy proposes when no cell waits, fewer than twice the lanes' capacity run, and the cap admits one proposal and its expected screens.

```ts
import { incumbent, runSearch, SearchRecorder, uniform } from '@tangle-network/agent-eval/campaign'

const policy = incumbent({ patience: 3 })
const allocation = uniform({ reps: 1 })
const recorder = await SearchRecorder.open({ ledger }, {
  ...opening,
  policy: { expansion: policy.name, allocation: allocation.name, seed },
})
const { state, leader, reason } = await runSearch({
  recorder, root, codec, policy, allocation, proposer, executor, maxExpansions: 10,
})
```

The ports:

- **Executor:** `lanes()` declares pools of slots, each `hard` (it enforces `cellUsd` per cell) or `estimate` (it cannot); `place(cell)` picks a cell's lane; `run(work)` runs one attempt and returns its outcome, accounting and identity; `adopt(work)` returns an attempt an earlier process finished, or null.
  An environment fault is an `errored` outcome; a rejection stops the search.
- **Proposer:** `propose({ parents, operator, leader })` returns children with a label, a rationale and optional typed `attribution`, plus the operation's accounting.
  Its output is stored as a `proposal` blob on `operation-recorded` before any child is registered.
- **Codec:** `node(recorder, artifact)` content-addresses an artifact, `diff` stores the parent-to-child diff, and `load` reads a node's artifact back.
- **Policy:** `expand(view)` returns parents and an operator, or null to wait; `leader(view)` names the node the search keeps.
  The view holds the policy split (selection, or train when a search has none) and no test cell.
  `incumbent({ patience })` is the hill climb: it expands the leader once every earlier child is screened, and a node that scored every unit of its screen leads when it beats the leader on the units they share.
  `crowdedFrontierParent({ seed })` draws the parent from the Pareto frontier by a seeded crowded tournament and keeps the incumbent's leader rule.
- **Allocator:** `plan(state, nodeId)` lists the cells a node needs now; the kernel allocates the ones the ledger lacks.
  `uniform({ reps })` gives the root every train and selection task as `root` cells, and every other node every train task (`train`) and selection task (`screen`).

**Budget.**
Every reservation passes the ledger's admission rule: committed spend plus open reservations plus the unspent claim reserve plus the new hold stays within `maxUsd`.
The kernel checks `state.budget.headroomUsd` first and prices an expansion as one proposal plus `childrenPerProposal` screens.
A hard lane holds its maximum; an estimate lane holds 1.5 times the p99 of its settled cells once 20 settled, else its prior.
Spend above a hold is recorded as overspend, never refused.
Expansion stops at `maxNodes`, `maxExpansions`, the deadline, after `patience` expansions without a new leader, when the cap cannot admit one more expansion, or when the proposer stops.
Allocated cells still run; at the deadline the ones not yet started are cancelled.
At close the leader is decided `selected` when it has a scored cell, every other undecided node `rejected` with its estimate against the leader, and the search closes with no claim.

**Resume.**
The ledger is the only checkpoint.
Running the kernel again on an open ledger replays it and continues.
An operation that started without a result is recorded `failed` with an unknown cost and a floor of 0, and the next proposal runs under a new operation id.
A recorded proposal whose children were not all registered is finished from its stored output.
A cell the ledger shows unsettled is offered to `executor.adopt` before its first dispatch, so an attempt that finished before the restart is recorded once and not run again.
Aborting the `signal` pauses the search: in-flight cells are aborted, a scored result that still arrives is recorded, an attempt that ends in an error while the search stops stays unsettled (the error may be the interruption), and the ledger stays open.
One kernel runs a ledger file at a time on a host: a second one is refused by a pid lock beside the ledger, and a killed holder's lock is reclaimed.
A closed ledger returns its result; more work on a closed search is a new search.

`scripts/search-sim.ts` runs the real kernel, ledger and policies over a seeded synthetic objective, proposer and executor, and `kill-resume` SIGKILLs it at random ledger positions and compares the resumed search with an uninterrupted one.

## Ship a search

A hosted store (Intelligence, or the reference receiver in `examples/hosted-ingest-server/`) receives a search through the [hosted ingest wire](./hosted-ingest-spec.md).
The shipper reads the ledger file, uploads the blobs each entry names, and posts the entries from the store's head.
A restarted shipper, a lost response, or a store that lost data continues from the store's head; a store that holds a different chain for the same search stops it with `SearchShipConflictError`.

```ts
import { shipSearchLedger, startSearchShipper } from '@tangle-network/agent-eval/hosted'

const shipper = startSearchShipper({ tenant, ledger: { path: ledger.path, searchId }, runKind: 'optimization' })
// ...the search appends to its ledger; the shipper tails it...
const shipped = await shipper.stop() // { head, localLines, batches, blobs: { uploaded, missing, ... } }
```

`selfImprove({ hostedTenant, searchLedger })` does this for its own ledger.
`agent-eval search ship <ledger> --run-kind optimization|eval` finishes or resumes a ship from a terminal.

## Receipts and `require-complete`

`createSearchHistoryReceipt({ producerId, runId, ledger })` reads the ledger's bytes, replays them, and binds the byte digest, the audit digest, and a bounded summary.
A receipt is complete exactly when the ledger holds `search-closed`, which the completion invariant admits only when nothing is outstanding.

```ts
const comparison = await compareOptimizationMethods({
  // ...methods, partitions, dispatch, judges, runDir
  searchHistoryPolicy: 'require-complete',
  searchHistoryVerification: 'ledger',
  storage,
})
```

Under `require-complete`, a missing, malformed, producer-mismatched, or open search refuses the final comparison before its first test dispatch.
`searchHistoryVerification: 'ledger'` also resolves the receipt's URI through `storage.read`, checks the bytes' SHA-256 and length, and replays them.
`verifySearchHistoryReceipt` checks the envelope alone; `assertSearchHistoryMatchesState` checks it against a replayed state.

A receipt does not prove that the optimizer searched well, that a node is correct or safe, or that a winner generalizes.
Those claims need the sealed test split, the claim's power check, and held-out evaluation.

## Files

- `src/campaign/search-ledger-types.ts`: the event and audit types.
- `src/campaign/search-ledger.ts`: schemas, canonical ordering, the codec, and `FileSearchLedger`.
- `src/campaign/search-state.ts`: `SearchState`, the invariants and read model, and the id functions.
- `src/campaign/estimate-node.ts`: `estimateNode`, `estimateNodeFromCells` and `searchPosterior`.
- `src/campaign/search-ledger-recording.ts`: `SearchRecorder` and the surface helpers.
- `src/campaign/search-kernel.ts`: `runSearch`, the executor, proposer and codec ports, and `searchPolicyView`.
- `src/campaign/search-policy.ts`: `SearchPolicy`, `incumbent` and `crowdedFrontierParent`.
- `src/campaign/allocation.ts`: `SearchAllocator` and `uniform`.
- `src/campaign/presets/run-optimization.ts`: `runOptimization` as a search on the kernel.
- `src/campaign/gepa-search-import.ts`: the GEPA population and evaluation importers.
- `src/campaign/search-history-receipt.ts`: receipts and admission.
- `src/ledger-core/`: hashing, locking, durable appends, chain verification, and the trusted-head pin.
