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

## Lenses

A lens (`@tangle-network/agent-eval/search`, search-tree-design §12) is a pure function of a `SearchStateView`: it reads no other record type and does no I/O.
Each returns `{ data, signal }` — `data` is JSON a view or `agent-eval search show` renders, and `signal` is exactly one named, quantitative value a `SearchPolicy` can read, so what a person sees and what the climber uses come from the same computation.
No lens imputes a value below the design's honesty thresholds: an unknown cost or an unpaired sample stays excluded, reported as `insufficient` or `no measured children` rather than folded into a number.
Every sample a lens summarizes is staged by `estimateNode`'s own `searchEstimateMethod`: `none` below 2 (no mean; one observation is no estimate), `insufficient` below 6 (a mean, no interval), `descriptive` below 20 and `bootstrap` from 20, each interval naming its method and n.
Every order a lens reports, such as a cluster id, sorts by UTF-16 code unit, so a fixed ledger gives the same JSON on every host.

### All eight lenses, one page

`src/search/lenses/` holds eight lenses total; the table below is every one of them, the signal a `SearchPolicy` can read from it, and the one-line methodology it motivates (search-tree-design §12).
Five of the eight feed a shipped consumer today: four (`operatorYield`, `landscape`, `skillManifold`, `metaSearch`) into a `SearchPolicy` or allocator, one (`editCredit`) into agent-runtime SkillOpt rather than a `SearchPolicy`. `tree`, `front` and `taskMatrix` expose their signal to `agent-eval search show`, Intelligence, discovery lab and VerticalBench with no built-in policy consumer yet — the design names their intended use, and the Wiring column says which are still only that.

| Lens | `search show` flag | Signal | Motivates | Wiring |
|---|---|---|---|---|
| `tree` | `--tree` | `tree.nodeCount` | the base page every other lens sits beside | none (base view) |
| `operatorYield` | `--operator-yield` | `operatorYield.weights` | operator choice as a bandit | **wired** — `incumbentWithOperatorBandit` draws its expansion operator from this once an operator has 6 measured outcomes |
| `front` | `--front` | `front.membership` | multi-objective selection: which nodes earn their cost, on score vs. known spend | not wired — a view signal today (Intelligence's frontier, cost-per-solved reporting) |
| `taskMatrix` | `--task-matrix` | `taskMatrix.specialistGain` | ship a portfolio and route by task family; conditional skills | not wired — no `SearchPolicy` reads it yet (recorded open issue on PR #866) |
| `editCredit` | `--edit-credit` | `reusableHunks` | extract reusable edits as inline skills; stop re-proposing dead ones | **wired to SkillOpt, not a `SearchPolicy`** — `data.skillCandidates` feeds agent-runtime `improve({ surface: 'skills' })` directly (PR #868) |
| `landscape` | `--landscape` | `plateau` | draft fresh from the root when the climb has plateaued | **wired, opt-in** — `draftOnPlateau(base)` wraps any policy (e.g. `draftOnPlateau(aide())`); off by default, no quality gain detected in simulation yet (PR #869) |
| `skillManifold` | `--skill-manifold` | `nextUnit` | adaptive testing: measure the cell that best separates the leaders next | **wired, opt-in** — `asha({ extend: nextUnitExtension(skillCalibration(lens)) })`; off by default, saved ~9 of ~600 cells per search with no quality loss in simulation (PR #869) |
| `metaSearch` | `--meta` | `metaSearch.bestPolicyConfiguration` | tune the climber itself: an outer search whose cells are inner searches, ranked by held-out lift per known dollar | **wired** — `runNestedSearch` scores each outer cell with this signal (PR #867) |

Every lens is a pure function of `SearchStateView` — no clock, no `Math.random`, no record type but the ledger's own (`editCredit` also reads content blobs, and the caller verifies them against their digest).
`agent-eval search show <ledger>` takes any combination of the first seven flags in one call; `--meta` takes one or more ledger paths in place of a single lens flag, because a meta-search score compares searches, not nodes within one.

**Verified on a real ledger** (`scripts/import-vb-climb.ts` import of `climb-gen1-20260924T151217Z`, a real VerticalBench GEPA climb — 2 nodes, 4 settled cells, every cell's cost unknown because the GEPA callback path meters per batch, not per cell):

```
$ agent-eval search show search-ledger.jsonl --tree --operator-yield --front --task-matrix --edit-credit --landscape --skill-manifold

tree: 2 nodes, 2 edges
seed → node_8b6e8e11c5a430aa900f210c8e5162d7 (rejected) $0.00 known + at least $0.00 over 2 unknown-cost cells
improve → node_9d74773e7ecfd982307a8285845e7fad (selected) $0.00 known + at least $0.00 over 2 unknown-cost cells

operator yield (selection split, gain per known $ of proposal + screen):
  improve: 1 proposals → 1 node (selected=1); yield: no measured children; 1 excluded
  seed: 1 proposals → 1 node (rejected=1); yield: no measured children; 1 excluded

front (selection split, axes: score, costPerCellUsd): 0 of 2 node(s) on the frontier, 2 excluded (one-unit 2)

task matrix (selection split, maximize): 2 node(s) × 1 unit(s), 1 node cluster(s), 1 unit cluster(s)
  cluster base-pay-usdc-checkout.selection.1 [...]: specialist gain insufficient (1 of 6 units)

edit credit — 10 genes from 1 of 1 lineage edges, 1 measurable steps (selection split, maximize)
  signal reusableHunks = null (insufficient: no gene has 6 selection units on clean steps (10 genes, 1 measurable steps))

Landscape (selection split, ...): placed 2 of 2 nodes by landmark MDS on 2 landmarks
  plateau: insufficient: 0 of 6 accepted nodes (screened, no dodged unit, 6 or more units shared with the root)

Skill manifold (selection split, loadings fitted here)
  intrinsic dimension: insufficient (0 nodes and 0 units qualify; a manifold needs 3 nodes and 6 units)

$ agent-eval search show climb-141516Z/search-ledger.jsonl climb-151217Z/search-ledger.jsonl --meta

meta-search: 2 searches (0 contained, 0 derived) in 1 objective, 2 configurations
metaSearch.bestPolicyConfiguration: unknown — no configuration of vb/coder · score (maximize) has a known lift per dollar: 2 unscored searches and 0 with only a spend floor
```

Every signal reports honestly rather than guessing: at 2 nodes and 1 shared unit, this real climb is below every lens's `insufficient`/`none` threshold, so `operatorYield`, `front`, `taskMatrix`, `editCredit`, `landscape` and `skillManifold` all say so instead of printing a number.
The two `--wired` behaviors above (`incumbentWithOperatorBandit`, `draftOnPlateau`, `nextUnitExtension`) fall back to their base policy's own behavior on exactly this "insufficient" case — the same code path a synthetic ledger with real signal values exercises, proved in each lens's own PR.


| Lens | Reports | Signal |
|---|---|---|
| `tree(state)` | a tidy tree of nodes and edges — the base view every other lens sits beside; a node with unknown-cost cells shows its known spend, its proven floor and how many cells are unknown, never a total | `tree.nodeCount` (drives no policy) |
| `operatorYield(state, { split? })` | each edge operator's proposals, re-proposals, outcome counts and yield: a node's gain over the root from `searchPosterior` (`estimateNode`'s tree-wide contrast) divided by the known cost of producing and screening it — its even share of the proposal operation's cost over that operation's child edges, plus its cells allocated before its first decision (the first rung and the train feedback); cells of later rungs and the claim are the allocator's and the claim's choice, so they are not charged to the operator; a node counts once, under the operator of the edge that registered it, and a re-proposal adds a proposal but no outcome or sample; a node is excluded from yield when it was decided invalid, shares fewer than 2 units with the root, or its proposal or a screen cell has an unknown, unrecorded or zero cost | `operatorYield.weights`: an operator's yield mean once it has 6 or more yield-eligible nodes (`MIN_OUTCOMES_FOR_WEIGHT`), else `null` |
| `front(state, { split?, axes? })` | the Pareto frontier over per-unit mean score and known cost per attempted cell on the split (reusing `paretoFrontier`), with room for caller-declared extra axes; a node's total spend depends on how far the allocator measured it, so it is shown but is not an axis; a node decided invalid, scored on fewer than 2 units, with an unknown-cost cell on the split, or with a non-finite extra axis is excluded from every frontier pass, with the reason | `front.membership`: 1 for a node on the frontier, 0 otherwise (including an excluded node) |
| `taskMatrix(state, { split? })` | nodes and units, each single-linkage clustered on the root-mean-square difference over their shared scores, cutoff at the data's own median pairwise distance | `taskMatrix.specialistGain`: per unit cluster, the best node's mean minus the mean of node means, in the objective's direction, among nodes not decided invalid that scored every unit of the cluster; `null` with the reason, and omitted from the signal, below 2 such nodes or 6 units |

`agent-eval search show <ledger> [--tree] [--operator-yield] [--front] [--task-matrix]` prints each lens's text form below the search summary, so an agent reading the CLI sees the same numbers Intelligence, discovery lab, VerticalBench and agent-runtime `improve()` would render from the same JSON.

`incumbentWithOperatorBandit({ seed, fixedWeights? })` (`/campaign`) is the one built-in policy that reads a lens signal: a hill climb, like `incumbent`, whose expansion operator is a weighted draw over `operatorYield`'s weights.
An operator without 6 measured outcomes yet draws on `fixedWeights` (uniform by default) instead of being starved until every operator clears the gate; a measured operator's weight is `fixedWeights[operator] + yield`, floored just above zero, because yield (dollars) and the fixed prior (an arbitrary share) are not on the same scale and a small positive yield should not draw less than an untested operator's default prior.

## Edit credit: which edits earned their score

`editCredit(state, { readArtifact })` (`@tangle-network/agent-eval/search`) treats the edits of a search as genes and follows them down its lineage.
It diffs each lineage parent and child line by line, with whitespace normalized, and cuts every changed run into paragraphs.
An added paragraph is an `insert` gene and a removed paragraph is a `delete` gene.
A gene's id hashes its kind, its location in the artifact and its normalized lines, so the same edit has the same id wherever a proposer makes it.
The lens computes these ids; the ledger records no hunk ids.
A node carries a gene when its content holds the paragraph (or, for a delete, lacks it), so carrying follows merges, re-proposals and reverts.
`readArtifact` returns a node's parsed artifact, and the caller verifies its bytes against the reference's digest.
A node whose artifact is unreadable, or a code surface whose patch is not in the ledger, has unknown content, and its steps yield no genes.

Credit pairs, on each clean lineage step, the side that carries the gene against the side that lacks it, on the units both scored.
A step is clean for a gene when every change on it belongs to one edit that introduced the gene, so a merge that also brings in other edits credits none of them.
Per unit, both sides average over the gene's clean steps, and `pairedDeltaTest` decides on the per-unit contrasts, staged like `NodeEstimate.method`: `none` below 2 units, `insufficient` below 6, `descriptive` below 20, `bootstrap` from 20.
The verdict is `pairedDeltaTest`'s own decision in each direction: `reusable`, `harmful`, `unresolved`, or `insufficient` below 6 units.
Genes with the same clean steps are linked: they have one credit, and they count as one edit.
Credit is not adjusted for the number of edits, because it steers what to reuse and test next and claims nothing.
`data.chance.expectedReusable` states how many reusable edits the verdict would call if no edit had an effect, so read the count against it.
A policy chooses a parent for its scores, so a parent is high by chance on the units it was chosen on.
On a step where the child gained a gene, that parent is the lacking side, and credit is biased toward `harmful`; where the child lost the gene, credit is biased toward `reusable`.
With no true effect, the generator below measured `harmful` on 4.3 % of measured edits under `uniform` (103 of 2,396, 40 searches) and 1.3 % under `asha` (31 of 2,412), and `reusable` on 0.8 % and 1.0 %.
Only the sealed test split is free of this bias, so a reusable edit still needs a held-out test before it ships.

Interactions compare a gene's step contrasts where another gene is present on both ends against where it is absent on both ends, in both directions.
The pairs with 6 or more units are tested with an exact two-sided sign test and flagged after a Holm correction; a flag is a reason for a factorial test, not a claim.
A flag says that a gene's credit depends on its context; the named partner can be a gene that travels with the true partner.

The signal `reusableHunks` counts the reusable edits, and `signal.top` names the first gene of each, best first; it is null until some gene has 6 units on clean steps.
`data.skillCandidates` turns each reusable insert edit into an inline skill resource with the `improve()` options that select it, for agent-runtime's SkillOpt (`surface: 'skills'`).
`agent-eval search show <ledger> --edit-credit [--json]` prints the lens, reading artifacts from the blobs the ledger names.
`scripts/synthetic-search-ledger.ts` writes a seeded search with planted edit effects through the real kernel and scores the lens against the planted truth.

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

`gepaOptimizationMethod({ searchLedger: { identity } })` records GEPA's search when it finishes, and `skillOptOptimizationMethod({ searchLedger: { identity } })` records SkillOpt's.
`importGepaPopulation` turns the population into nodes and `correlated` edges and reports collapsed duplicates.
`importExternalEvaluations` turns every callback evaluation into an `external` cell; a candidate GEPA evaluated but kept out of its population gets an `unknown` edge and is decided `pruned`.
SkillOpt reports no parents, so every candidate it evaluated gets an `unknown` edge; its choice is `selected` and the others are `rejected`.
A composed GEPA recipe reports no population either, so its candidates are recorded the same way; every GEPA recipe writes a ledger.

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
  An executor that measures a cell with a one-cell `runCampaign` maps the campaign cell with `campaignCellSearchResult(cell, { execution, lane })`, as `runOptimization` does.
- **Proposer:** `propose({ parents, operator, leader })` returns children with a label, a rationale and optional typed `attribution`, plus the operation's accounting.
  Its output is stored as a `proposal` blob on `operation-recorded` before any child is registered.
- **Codec:** `node(recorder, artifact)` content-addresses an artifact, `diff` stores the parent-to-child diff, and `load` reads a node's artifact back.
- **Policy:** `expand(view)` returns parents and an operator, or null to wait; `leader(view)` names the node the search keeps.
  The view holds the policy split (selection, or train when a search has none) and no test cell: per-unit scores, paired estimates, every node's lineage, status and defect count (`nodes()`), and each node's posterior on its improvement over the root (`posterior`, from `searchPosterior`, computed once per ledger state).
  The kernel refuses an expansion without a parent or with a parent whose screen has not finished; an invalid node is never screened, so it is never a parent.
  Every built-in policy keeps the same leader: a node leads when it dodged no unit (no cell ran and ended unscored), scored every unit the leader scored, and beats the leader's mean on them.
  A node measured on fewer units than the leader, such as one an allocator has only screened, cannot take the lead on less evidence.
  A leader with no scored unit, such as a root whose every cell ended unscored, holds no evidence, and the first node that dodged no unit takes the lead from it.
  `incumbent({ patience, minImprovement })` is the hill climb: it expands the leader once every earlier child is screened.
  With `minImprovement`, a node takes the lead only when its mean beats the leader's by more than that margin, in the metric's units.
  `crowdedFrontierParent({ seed })` draws the parent from the Pareto frontier by a seeded crowded tournament.
  `aide({ drafts, debugProbability, maxDebugDepth, stallAfter })` (defaults 5, 0.5, 3, 4) is AIDE's policy with three changes for noisy scores.
  It drafts whole alternatives from the root until `drafts` nodes were drafted.
  Then, with probability `debugProbability`, it debugs a buggy leaf whose chain holds fewer than `maxDebugDepth` debug edges; a node is buggy when at least half of its final cells outside the test split `failed`, and an `errored` cell never makes it buggy.
  Otherwise it improves a parent drawn by Thompson sampling from every screened node that is not buggy: the root at 0, every other node from a normal with its mean improvement over the root and the pooled between-unit variance divided by its shared units.
  Until some node shares 2 units with the root the variance is unknown and the draw is uniform.
  When the drawn parent's lineage (the nodes under its nearest draft, or under the root) has had `stallAfter` improve children in a row that did not raise its best posterior mean, the improve forks from the node with the best posterior mean instead.
  A fork's children restart the run of the lineage they join, so a stalled lineage that holds the global best forks once, not on every later expansion.
  `beam({ width })` expands the top `width` nodes by posterior mean, the member with the fewest children first; a member is the root, a node an allocator advanced, or a node that scored every unit the root scored.
  Each edge records the rule and evidence that chose its parent (`aide:draft`, `aide:debug`, `aide:thompson`, `aide:uniform-draw`, `aide:stall-fork`, `beam(width=k)`).
  Pair `incumbent` and `crowdedFrontierParent` with `uniform`, and `aide` and `beam` with `asha`: a hill climb expands only the leader, and under `asha` the root keeps the lead until a child finishes the top rung, while a posterior stays honest about a node measured only on the first rung.
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

A node an allocator advanced stays a possible parent while its rung cells run, after a restart too.
An `asha` search ranks a node when it finishes a rung, and `aide` and `beam` expand while other screens run.
A restart that changes the order cells finish in can therefore change a promotion or a parent.
The resumed ledger holds only decisions that its own evidence supports.
A hill climb under `uniform` waits for every screen, so its resumed search equals the uninterrupted one.

`scripts/search-sim.ts` runs the real kernel, ledger, policies and claim over a seeded synthetic objective, proposer and executor.
`kill-resume` SIGKILLs it at random ledger positions and compares the resumed search with an uninterrupted one.
`claims --searches 200 --null` runs 200 searches in which no node differs from the root and reports how often the claim ships, with Wilson and Clopper-Pearson intervals; `--plant-gain X` plants a real gain to measure how often the claim finds it.
`compare --seeds 200 --arms incumbent+uniform,aide+asha` runs one search per seed under each `policy+allocation` arm and reports the cells each allocated, the node each kept, how often it kept the planted node and how often it kept a node at least half the planted gain above the root (each with a Wilson interval), and the units each edge pairs on; every later arm is paired with the first by seed, with an exact sign test.
`--max-cells N` caps the cells a search allocates, so arms compare at equal cells.
`--pool-gap X` swaps the hill climb for a fixed pool with one planted best candidate; `--deep-gain X` plants a gain at depth `--deep-depth` (default 3) of one lineage, behind neutral path nodes (or a gradient with `--deep-ramp`), with every other edit a loss.
`--defect-rate X` makes a share of children fail every cell as a defect, which `aide` debugs.
Every simulated run re-derives each `advanced` and `pruned` decision from the ledger just before it.
It also rebuilds the policy's view from the ledger just before each proposal started and checks that the policy returns the recorded parents, operator and selection evidence.

## Geometry lenses: `landscape` and `skillManifold`

A lens is a pure function of a `SearchStateView` from `@tangle-network/agent-eval/search`.
It returns `data` for a view and one `signal` that a policy or an allocator reads, so a person and the climber read the same number.
A geometry lens signal states its `method`, its sample `n`, and, when its value is null, the reason in `insufficient`.
A lens never imputes a score or a cost.

`landscape(state, embed?, options?)` places every node in two dimensions by landmark classical multidimensional scaling of a distance between profiles.
The default distance, `lineageEdits()`, counts the improve, debug and merge edges between two nodes.
A draft is written afresh, so the lineage distance leaves a draft's lineage unplaced; `surfaceTextEdits(read)` places it by line edits between the surface texts.
`vectorEmbedding(name, vector)` takes a caller's vectors, for example a model embedding of each profile.
A node's score is its improvement over the root on shared units, with the standard error that `searchPosterior` gives it.
The surface is ordinary kriging with each node's own noise; a grid cell is null where the nodes leave more than half the prior variance unexplained.
No surface is drawn unless distance predicts score: the fitted length scale must raise the log-likelihood by 1 or more over independent node scores.
Basins are peaks of the node scores on the 6-nearest-neighbour graph that stand above their saddle by z standard errors.
z is the Bonferroni normal quantile at 5% over the graph's local maxima, so a flat landscape of noisy nodes counts one basin at least 95% of the time.
The surface and the basins need 6 nodes that share 2 or more units with the root.
The signal `plateau` is the rise of the best improvement over the root across the last 6 accepted nodes, divided by that node's standard error.
An accepted node is screened, dodged no unit, and shares 6 or more units with the root.
`draftOnPlateau(base, { window, below })` wraps any policy: on every `window`-th expansion, when `plateau` is below `below` (default 1), it drafts from the root; otherwise `base` expands.
A draft pays off only when `base` expands drafts that trail its leader, as `aide` does; `incumbent` expands only its leader.
The trigger adds drafts to `aide`'s own; it does not replace them.
In `scripts/search-sim.ts plateau` (30 seeds, 24 expansions, root lineage capped at 0.62), `draftOnPlateau(aide({ drafts: 0 }))` kept 0.198 less true quality than `aide()` (95% paired bootstrap [−0.230, −0.163]; 25 of 30 seeds worse).
With the cap removed, the difference was not detectable (−0.012 [−0.049, +0.026]).

`skillManifold(state, k?, options?)` factors the node × unit matrix of per-unit means as `b_u + P_i · Q_u` on standardized scores.
Alternating ridge least squares reads only observed cells; a missing cell is masked, never filled.
Five-fold cross-validation over held-out cells picks the intrinsic dimension by the one-standard-error rule.
With fewer than 6 nodes and 6 units the dimension is insufficient, and `k: 'auto'` fits one descriptive axis.
The signal `nextUnit` names the unit whose next cell removes the largest expected share of the variance of the leaders' contrasts.
It needs 2 leaders with 6 or more modelled units and a cross-validated cell noise.
`skillCalibration(lens)` keeps the unit loadings of a fit whose cross-validation found an axis.
`asha({ extend: nextUnitExtension(calibration) })` fills each rung it opens with the units that best separate the leaders, read from the ledger at the decision that opened the rung.
The extension is off by default.

`agent-eval search show <ledger> --landscape --skill-manifold` prints both lenses as text; `--landscape` reads surface texts from `blobs/` beside the ledger and checks each digest.
`scripts/search-sim.ts plateau` compares `incumbent` with `draftOnPlateau(incumbent)` by seed, and `scripts/search-sim.ts adaptive` compares `asha` with the extension.

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

## A search of searches: `metaSearch` and nested searches

`metaSearch(searches, { objective? })` (`@tangle-network/agent-eval/search`) treats each search as one node.
Its genome is the configuration its ledger records: expansion policy, allocator, budget, proposer and the proposer's model.
A policy parameter equal to the search's own seed reads `seed=<search>`, so one configuration run on different seeds is one genome.
Its score is `metaSearchScore(state)`: the claim's held-out lift per known dollar of the whole search.
The lift is `estimateNode` of the shipped node, or on `hold` of the first finalist the claim fixed before test, against the root on the test split.
A search that is open, has no claim, cannot resolve its test, held with no finalist tested, pairs fewer than 2 test units, or has a claim its ledger contradicts is unscored with that reason, never 0.
A search with an unknown-cost cell has only a floor, so its lift per dollar is a bound that enters no estimate.

Searches form a forest by derivation (`derivedFrom`) and containment (`containment`).
Configurations group searches of one genome within one objective.
A configuration's estimate is the mean over its scored searches with a percentile bootstrap interval, staged like `NodeEstimate.method` by the number of searches; one scored search carries its own paired interval over its test units.
Every configuration reports how many of its searches were scored.
The signal `metaSearch.bestPolicyConfiguration` names the configuration with the largest estimate within one objective, with its interval, method, n and coverage; it is a point ranking, not a test.
`agent-eval search show <ledger> [<ledger> ...] --meta [--objective <key>] [--json]` prints the lens as text, or as JSON with `--json`.

`runNestedSearch` runs an outer search whose cells are inner searches, on the same kernel.
An outer node is a configuration (`runtime-config`), an outer task is a problem, and each outer cell runs one inner search of its node's configuration on its task's problem.
The inner search records the outer cell attempt as its `containment`, and its id is a digest of that attempt, so a rerun resumes the inner ledger instead of starting again.
The outer cell scores `metaSearchScore` of the closed inner search, costs what the inner search spent, and binds the inner head hash.
An inner search without a known lift per dollar settles its cell `errored` and not retryable, so its configuration cannot lead on missing evidence.
The outer search's judge is `META_SEARCH_SCORE_SOURCE`, and with a test split it claims once, on held-out problems, whether a configuration beats the root configuration.
`scripts/search-meta-sim.ts` runs one over simulator configurations with no model spend.

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
- `src/search/lenses/edit-credit.ts`: `editCredit` and `editCreditText`.
- `src/campaign/search-ledger-recording.ts`: `SearchRecorder` and the surface helpers.
- `src/campaign/search-kernel.ts`: `runSearch`, the executor, proposer and codec ports, `searchPolicyView` and `searchDivergence`.
- `src/campaign/search-claim.ts`: `planSearchClaim`, `decideSearchClaim`, `verifySearchClaim` and `searchClaimReserveUsd`.
- `src/search/lenses/landscape.ts`, `plateau.ts` and `skill-manifold.ts`: the geometry lenses, the plateau score and the unit extension.
- `src/campaign/search-policy.ts`: `SearchPolicy`, `incumbent`, `incumbentWithOperatorBandit`, `crowdedFrontierParent`, `aide` and `beam`.
- `src/campaign/allocation.ts`: `SearchAllocator`, `uniform` and `asha`.
- `src/campaign/presets/run-optimization.ts`: `runOptimization` as a search on the kernel.
- `src/campaign/gepa-search-import.ts`: the GEPA population and evaluation importers.
- `src/campaign/search-history-receipt.ts`: receipts and admission.
- `src/search/lenses/meta-search.ts`: `metaSearch`, `metaSearchScore`, `searchPolicyGenome` and `renderMetaSearchText`.
- `src/search/nested-search.ts`: `runNestedSearch`, `nestedSearchId` and `searchConfigCodec`.
- `src/ledger-core/`: hashing, locking, durable appends, chain verification, and the trusted-head pin.
