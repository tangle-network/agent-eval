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
- **Graph:** a node exists before an edge or cell names it, and a cell's node already has an edge. On a node's first edge every parent was registered before the node and already has an edge, so the lineage is acyclic. A parent in another search appears only on a `derive` edge that matches `derivedFrom`.
- **Re-proposal:** identical content is a second edge into the existing node, counted as a re-proposal and never measured again. It may come from any node the search holds, including the node itself (a proposal that changed nothing) or a node registered after it (a revert). Such a parent is not lineage: it does not enter the node's `parents` or the parent's `children`, and ancestry follows an edge only through parents registered before the child.
- **Splits:** a task belongs to one split and one unit. With `heldOutUnits`, no test unit appears in train or selection. Stages match splits: `claim` cells run on test, `screen` and `rung` on selection.
- **Seal:** only the root (the first registered node) and nodes decided `finalist` run test cells. The root is never a finalist, at most 3 nodes are, and none is added once a claim cell exists.
- **Claim start:** once a node is decided `finalist`, the search only claims: no operation, node, edge or non-claim cell follows.
- **Parents:** a node decided `invalid` (by admission or by the divergence rule) never appears as a parent on a later edge.
- **Attempts:** attempts count from 1 without gaps. A `passed` or `failed` outcome is final; only a retryable `errored` outcome admits another attempt.
- **Budget:** at every `cell-allocated` and `operation-started` that holds a reservation, committed spend plus open reservations plus the unspent claim reserve plus the new reservation stays within `maxUsd`. A claim cell draws on the unspent claim reserve first, and a cell the reserve covers is admitted even when overspend elsewhere took committed spend past the cap. An event without a reservation is always admitted: the rule admits holds, and refusing to record work would leave a search that can never close. Spend above a reservation is recorded as overspend, never refused. An unknown cost counts as its proven floor.
- **Completion:** `search-closed` needs every allocated cell settled or cancelled, every started operation recorded, and every node with an edge and a terminal decision.
- **Claim:** the claim names every node decided `finalist`, estimates each against the root on test, and tests each at `1 - (1 - confidence) / k` for its k finalists. A `ship` claim needs a promoted finalist, held-out test units, a pinned judge, and every test unit scored by the root and the shipped finalist; any other claim keeps the root.

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

## The agent's view

`renderSearchSummary(state, { split, limit? })` turns a `SearchStateView` into compact text: the leading nodes against the root with their estimates, the most recently discarded nodes with the measurement that discarded them, and a log of recent proposals — as AIDE's journal summary does.
`agent-eval search show <ledger>` verifies a ledger and prints this for a terminal, on the search's own ranking split (`selection` when the search declares one, else `train`); there is no local HTML renderer.

```ts
import { renderSearchSummary, searchProposerView } from '@tangle-network/agent-eval/campaign'

renderSearchSummary(state, { split: 'train' })
// search s1 — vb/coder — maximize composite
//   12 nodes · 34 settled cells (2 open) · $1.42 known
//   status: open
//
// Leading nodes (vs root, train split):
//   node_… (advanced rung 2): Δ=+0.0821 [0.0340, 0.1290] dashed, sign p=0.0156 (8 units)
// ...
```

`ProposeContext.train` (a `SearchProposerView`) and `ProposeContext.summary` (this text, always rendered on `split: 'train'`) are how `runOptimization`'s proposal step hands a proposer the search so far.
`searchProposerView(state)` has no parameter that can select another split: its `scoredCells`/`unitScores` always read `'train'`, so a proposer built on it cannot reach the sealed selection or test split even by mistake.
`ProposeContext.parents` carries every parent the policy chose, primary first, with its artifact — `currentSurface` is `parents[0].artifact`; a `merge` proposal needs every parent, and the built-in `incumbent`/`crowdedFrontierParent` policies always choose one.

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
const { state, leader, reason, claim } = await runSearch({
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
  `incumbent({ patience })` is the hill climb: it expands the leader once every earlier child is screened.
  A node leads when it dodged no unit (no cell ran and ended unscored), scored every unit the leader scored, and beats the leader's mean on them.
  A node measured on fewer units than the leader, such as one an allocator has only screened, cannot take the lead on less evidence.
  `crowdedFrontierParent({ seed })` draws the parent from the Pareto frontier by a seeded crowded tournament and keeps the incumbent's leader rule.
- **Allocator:** `plan(state, nodeId, rung)` lists the cells a node needs through its rung; the kernel allocates the ones the ledger lacks.
  `advance(view)` names the nodes the evidence moves to a further rung, and `prune(view, keep)` names, at close, the nodes left waiting.
  The kernel records each `advanced` decision only once the cap admits its rung's cells, then allocates them.
  `uniform({ reps })` gives the root every train and selection task as `root` cells, and every other node every train task (`train`) and selection task (`screen`); it has one rung.
  `asha({ units, eta, trainUnits, reps })` is asynchronous successive halving over one permutation of the selection units, seeded by the search's seed.
  Rung k is the first `units × 2^k` units (default 6, 12, 24, ...), and the top rung is every unit.
  The root runs every unit first; a new node screens on rung 0 plus `trainUnits` (default 2) train units, which are the proposer's feedback and never rank.
  Every node at a rung runs the same units as its parent, the root and its siblings, so every contrast pairs.
  A node that finished rung k advances once it ranks in the top floor(n / eta) (default eta 3) of the n nodes that finished rung k, the root included, by mean over the rung's units.
  A node with an unscored unit ranks last and never advances.
  There is no barrier: a node outside the top waits, and at close it is decided `pruned` with its rank.
  These are rank decisions: they spend budget and claim nothing.
  Without a selection split, `asha` ranks the train split, as the policy does.

**Budget.**
Every reservation passes the ledger's admission rule: committed spend plus open reservations plus the unspent claim reserve plus the new hold stays within `maxUsd`.
A claim cell draws on the reserve held since the start, so overspend on earlier cells cannot stop the claim.
The kernel checks `state.budget.headroomUsd` first and prices an expansion as one proposal plus `childrenPerProposal` screens.
A hard lane holds its maximum; an estimate lane holds 1.5 times the p99 of its settled cells once 20 settled, else its prior.
Spend above a hold is recorded as overspend, never refused.
Expansion stops at `maxNodes`, `maxExpansions`, the deadline, after `patience` expansions without a new leader, when the cap cannot admit one more expansion or overspend took the search past it, or when the proposer stops.
Allocated cells still run; at the deadline the ones not yet started are cancelled.
A node that finishes a rung is ranked at once, so rungs keep opening after expansion stops, until the deadline or the claim.
At close the allocator prunes the nodes left waiting on a rung, except the policy's leader.
A search without a test split closes with no claim: the leader is decided `selected` when it has a scored cell, and every other undecided node `rejected` with its estimate against the leader.
A search with a test split closes with its claim (below).

**Divergence.**
When a node's cells finish, the kernel compares it with its primary parent.
If its train mean rose on the train units they share while its selection interval against the parent (6 or more units, not indeterminate) lies wholly on the worse side, the node is decided `invalid` with rule `divergence` and the interval as its basis.
Train is what the proposer reads, so a gain there that selection contradicts is the signature of fitting the feedback instead of the task.
An invalid node is never a parent and never a finalist.
The check reads the screen once; a node an allocator advanced is not judged again on its rung cells, after a restart either.

**Resume.**
The ledger is the only checkpoint.
Running the kernel again on an open ledger replays it and continues.
An operation that started without a result is recorded `failed` with an unknown cost and a floor of 0, and the next proposal runs under a new operation id.
A recorded proposal whose children were not all registered is finished from its stored output.
A cell the ledger shows unsettled is offered to `executor.adopt` before its first dispatch, so an attempt that finished before the restart is recorded once and not run again.
Aborting the `signal` pauses the search: in-flight cells are aborted, a scored result that still arrives is recorded, an attempt that ends in an error while the search stops stays unsettled (the error may be the interruption), and the ledger stays open.
One kernel runs a ledger file at a time on a host: a second one is refused by a pid lock beside the ledger, and a killed holder's lock is reclaimed.
A closed ledger returns its result; more work on a closed search is a new search.

An `asha` search ranks a node when it finishes a rung, so a restart that changes the order cells finish in can change a promotion.
Its resumed ledger holds only rank decisions that its own evidence supports.

`scripts/search-sim.ts` runs the real kernel, ledger, policies and claim over a seeded synthetic objective, proposer and executor.
`kill-resume` SIGKILLs it at random ledger positions and compares the resumed search with an uninterrupted one.
`claims --searches 200 --null` runs 200 searches in which no node differs from the root and reports how often the claim ships, with Wilson and Clopper-Pearson intervals; `--plant-gain X` plants a real gain to measure how often the claim finds it.
`compare --seeds 200` runs one search per seed under `uniform` and under `asha` and reports the cells each allocated, the node each kept, and the units each edge pairs on; `--pool-gap X` swaps the hill climb for a fixed pool with one planted best candidate.
Every simulated run re-derives each `advanced` and `pruned` decision from the ledger just before it.

## The claim

A search that declares a test split ends in its claim, made once, on test data no node was selected on.
`runSearch` refuses to start such a search without a selection split, a claim `minimumEffect`, and a pinned judge.
Under a cap it also refuses a `reservedClaimUsd` below `searchClaimReserveUsd({ testTasks, reps, cellUsd })`, the hold for the root and 3 finalists on every test task, or a cap that cannot also cover the root and one screening round.
Size the reserve at the hold the lane will take: an estimate lane holds 1.5 times the p99 of its settled cells once 20 settled.

When expansion stops, the kernel:

1. **Fixes the design.** `planSearchClaim` ranks the finalists: at most 3 non-root nodes, not invalid, that scored every selection unit and beat the root's mean on them, best selection mean first.
   Under `asha` these are nodes that finished the top rung.
   It fixes the estimator (binary when every unit is one task at one repeat and every pre-test score is 0 or one value, else continuous).
   It checks power: `pairedPromotionPower` simulates the claim's own `decidePairedPromotion` call at a true improvement of `minimumEffect`, with the search's pooled between-unit selection variance, on the test units, at the Bonferroni confidence.
   It keeps the largest k whose power reaches 0.8 and whose test cells the unspent claim reserve and headroom cover.
   The plan is stored as the `claim-plan` blob on the `claim` operation before any test cell exists.
2. **Seals the family.** Each planned finalist is decided `finalist` with its selection estimate against the root.
   From here the search only claims: no node advances to another rung.
3. **Runs the test together.** The root's and the finalists' test cells are allocated task by task and dispatched before anything else, so drift over a long search cannot bias the pairs. They run past the deadline, on the reserve held since the start.
4. **Decides.** `decideSearchClaim` tests each finalist against the root with `decidePairedPromotion` on per-unit test means at confidence `1 - 0.05 / k`, requiring every test unit.
   The promoted finalist with the largest improvement is `selected` and the claim is `ship`; otherwise the claim is `hold` and the root is kept.
   Every other open node is `rejected` with its selection estimate against the root.

When the power check fails (a continuous claim needs at least 20 test units to be decided at all) or the reserve cannot cover one finalist, the claim closes as `test-cannot-resolve` and spends nothing on test cells.
The claim records its rule (`SEARCH_CLAIM_RULE`, whose revision digests every parameter), the family-wise confidence, the power check, each finalist's test estimate and deciding interval, and its reason.
`verifySearchClaim(state)` makes the claim again from the closed ledger alone and compares it byte for byte: the power check, the finalists, each finalist's test estimate and interval, the selection, the decision and the reason.
It reads no blob, so a store that keeps digests only can run it.
The finalists are the nodes decided `finalist`, in decision order; whether the budget covered k finalists' test cells is read from the claim cells that ran.
It returns `verified`, `mismatch` with the differences, or `unknown` for a claim another rule revision made.
The projector checks the claim's structure (every finalist named, the Bonferroni confidence of each test, a ship's held-out units and pinned judge) but not its numbers, so a store keeps what `verifySearchClaim` derives, never the producer's claim as written.
`runSearch` runs it on every close and on every rerun of a closed ledger, throws on `mismatch`, and returns it as `SearchRunResult.claimVerification`.
A judge change is a changed `search-opened` header, which `SearchRecorder.open` refuses; it starts a derived search instead of mixing verdicts.

`compareOptimizationMethods` keeps its own held-out comparison for black-box methods such as GEPA, which return one winner and never see the test split.
A method's search ledger closes before the comparison starts, so the comparison cannot add claim cells to it.

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
- `src/campaign/search-summary.ts`: `renderSearchSummary` and `searchProposerView`.
- `src/campaign/search-ledger-recording.ts`: `SearchRecorder` and the surface helpers.
- `src/campaign/search-kernel.ts`: `runSearch`, the executor, proposer and codec ports, `searchPolicyView` and `searchDivergence`.
- `src/campaign/search-claim.ts`: `planSearchClaim`, `decideSearchClaim`, `verifySearchClaim` and `searchClaimReserveUsd`.
- `src/campaign/search-policy.ts`: `SearchPolicy`, `incumbent` and `crowdedFrontierParent`.
- `src/campaign/allocation.ts`: `SearchAllocator`, `uniform` and `asha`.
- `src/campaign/presets/run-optimization.ts`: `runOptimization` as a search on the kernel.
- `src/campaign/gepa-search-import.ts`: the GEPA population and evaluation importers.
- `src/campaign/search-history-receipt.ts`: receipts and admission.
- `src/ledger-core/`: hashing, locking, durable appends, chain verification, and the trusted-head pin.
