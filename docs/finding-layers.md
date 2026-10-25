# Finding layers

Every analyst finding can say what it is about and what it was measured on.
A claim measured on 4 runs of one play stays a play-level result until independent evidence lifts it.

Source of truth: `src/analyst/finding-scope.ts`, `domain-taxonomy.ts`, `promote.ts`, `findings-ledger.ts`, `team-shape.ts`, `failure-modes.ts` and `rollup.ts`, all exported from `@tangle-network/agent-eval/analyst`.

## The ladder

| Layer | A claim about |
| --- | --- |
| `event`, `turn` | One step of one agent |
| `agent` | One agent across its work |
| `team` | How a supervision tree was organized |
| `run` | One run |
| `play` | Runs of one play |
| `problem` | Plays of one problem (discovery-lab's theatre) |
| `domain` | Problems under one domain node, at any depth |
| `lab` | Everything |
| `meta` | The instrument itself: a judge, a ruler, an analyst |

## Schema 1.1.0

AnalystFinding 1.1.0 adds `layer`, `scope`, `method`, `measure`, `confounders`, `valid_for`, `claim_id` and `evidence_units`.
All are optional on the type, and `makeFinding` writes 1.1.0 only when one is set, so existing writers and stored 1.0.0 findings are unchanged.
`parseAnalystFinding` reads both versions with one schema:

- A 1.0.0 finding may not carry 1.1.0 fields; it reads as layer and n `unknown`.
- A 1.1.0 finding needs `layer`, `scope` and `method`.
- With `evidence_units`, `scope.n` and `scope.population` must match the units, and no unit may sit above the finding's layer.

`readFindingScope` labels a finding `anecdote` when n < 2, `uncalibrated` when it was judged without calibration, `lineage-unknown` when a unit's lineage was not recorded, and `unscoped` for 1.0.0.

`scope.population` stores resolved unit ids, never a query: `n`, `evidence_units` and promotion's lineage check compare against those ids, and a query re-run later can select a different set. Select a population with `queryFindings` and store the ids it returned.

## Lineage

An evidence unit's `derived_from` names the unit it inherited state from, `null` records an independent start, and an absent field records lineage nobody captured.
Units are grouped by lineage root.
Unknown lineage shares one root, so it can never count as independent support.

## Taxonomy and promotion

`defineDomainTaxonomy` builds one versioned tree of domain nodes; `attachToTaxonomy` hangs a problem on one primary domain path plus tags, a play on a problem, and a run on a play.
Everything sits under the implicit `lab` root.

`promote(findings, taxonomy, { k })` is the only way a claim moves up:

1. A finding sits at the lowest common ancestor of its population. That node's layer must equal the finding's layer, so a lab-level claim measured on one play is refused, not lifted.
2. Siblings with the same `claim_id` are grouped under their parent.
3. Only children with `measure.interval` vote, on the same measure and unit, and their intervals must share a point.
4. Children whose units share a lineage root count once. At least `k` independent children (default 2) are required.
5. A lifted finding cites its children as `finding://<finding_id>`; the rest are returned as untested above.

Event, turn, agent, team and meta findings are never placed on the ladder.

## Ledger

`openFindingsLedger` stores findings in the ledger-core journal: canonical, hash-chained, fsynced, pinned to a trusted head, and validated by the finding schema on write and read.
`read()` returns the rows and their Merkle root.
`queryFindings` filters by layer, subject, analyst, run, claim and domain-path prefix.
`diffFindingsOverTime` runs `diffFindings` between consecutive runs in ledger order.
`FindingsStore` remains the unchained JSONL store for its existing consumers.

## Analysts

- `team-shape` (computed, `team`) reads a Runtime spawn journal and coordination log: `teamShapeInputFromSources` takes them from `readRuntimeSupervisorRun`, and the same parser reads the structure-only reductions `extract.py` writes. E (command) edges come from the id path (`R:s1:s0` is a child of `R:s1`), G (governance) edges from the journal holding each `settled` row plus each delivered steer's sender, and C (communication) edges from coordination rows naming a receiver, sent by `from`/`by` or else the log owner's digest. Classes, version 1, checked in order: single, governed swarm, fleet, partition, `hive depth N`, star with sub-leads, flat star (`root integrates`, `root does not integrate` or `integration unknown`, from the caller's optional `integrations`). The 50% and 20% thresholds are provisional and carried in `method.version`. Every class check is reported as yes, no or `not observable from this record`; an owner digest is not an agent id, so lateral C and steer governance are usually not observable, and the record never reads them as absent. The four recorded Magnetar runs under `tests/fixtures/team-shape`, with the lead's gold labels, are the acceptance fixtures.
- `failure-modes` (judged, `agent`, `team` or `run`) asks fixed-choice questions through `systemOneAnalyst`: a MAST-adapted failure mode, delegation-brief completeness and steer handling. `createFailureModesAnalyst` refuses a rubric whose recorded calibration κ is below the source-owned `FAILURE_MODES_MIN_KAPPA`. `loadFailureModeGold` reads public AgentRx annotations through `loadPublicBenchmarkRows` plus a caller's gold file; `calibrateFailureModes` scores the judge's labels against that gold. The full AgentRx dataset is external; [recorded boundary fixtures](../tests/fixtures/agentrx-actor-boundary/README.md) retain only the cases needed to check admission and historical receipt preservation.
- `rollup` (computed) pools run findings per play with a lineage-clustered bootstrap, then lets `promote` decide what climbs. Each lifted finding gets the pooled interval over every run beneath it and its observation and cluster counts.

### Failure-mode gold admission

[`loadFailureModeGold`](../src/analyst/failure-modes.ts) owns AgentRx's projection onto agent/team root-cause labels. It reads the annotated root failure, including its actor; it does not infer an assistant fault from a user's behavior. User-origin underspecification has no counterpart in the agent's `fail-to-ask-for-clarification` label. The source owns the recognized agent roles; unfamiliar or missing actors cannot silently become agents.

A successful load reports `eligibility`, `agentRxMapping`, eligible `gold`, and `unmapped` rows. The existing `unmapped` field retains each source id/category and adds its root failure id, step, actor, and a typed reason: `unsupported-root-actor`, `unknown-root-actor`, or `category-without-counterpart`. `agentRxMapping` records the mapping version and `agent-or-team-root-cause` target, or is null for caller-only gold. Consumers must carry that provenance and the actual exclusion reasons into a **new** calibration receipt, rather than treating every exclusion as an unmapped category.

An all-excluded, otherwise valid AgentRx file returns `eligibility: 'unknown'`, no gold labels, and the exclusion evidence. That is a parsed source without calibration evidence, not a successful empty calibration or a measured absence of failures. Invalid input still returns a failed outcome. Caller-supplied gold remains the caller's assertion and is not certified as independent by this loader.

Caller gold ids must be disjoint from **all** AgentRx source ids, including excluded rows. A caller cannot reintroduce an excluded source id as eligible gold; overlapping ids are invalid. Caller ids with surrounding whitespace are invalid, so whitespace cannot disguise an overlapping source id. Valid caller ids are preserved exactly. Caller-only gold and disjoint caller ids remain supported.

The category crosswalk does not establish semantic equivalence. In particular, AgentRx's `intent-plan-misalignment` includes an incorrect plan or action ordering while pursuing the requested goal, whereas the current `task-derailment` criterion requires drifting toward a different goal. Those categories are not interchangeable. Structural/actor eligibility is not independent validation of this projection. Preserve the source category and mapping identity, and establish independent target-label evidence before using a replacement mapping; do not retrospectively alter a frozen receipt or silently treat the crosswalk as a validated taxonomy.

Existing receipt rows, source hashes, labels and verdicts are historical evidence. Loading a new mapping never regrades, relabels or filters a stored receipt. A new mapping, selection policy, question or input representation requires a new calibration configuration with its rule fixed before judging.

### Calibration and runtime contract

The maintained [`FAILURE_MODES_QUESTIONS`](../src/analyst/failure-modes.ts) object is the one question/criteria owner. Its failure-mode question targets the agent/team root cause, distinguishes downstream symptoms and corrected mistakes, and forbids inventing absent outcome/error evidence. A changed question advances `FAILURE_MODES_VERSION` and requires calibration against the exact new questions and input representation; an older receipt cannot qualify the changed rubric. Keep that receipt visible as the historical measured result while reporting current compatibility and qualification separately. Missing or clipped evidence remains an explicit consumer coverage limitation, never proof of no failure. `createFailureModesAnalyst` currently sends all its questions; calibration of `failure_mode` alone does not qualify the other outputs.

| Output | Target and required evidence |
| --- | --- |
| `failure_mode` | The causal agent/team failure explaining the observed shortfall, rather than an arbitrary downstream symptom or a user-origin annotation. AgentRx gold targets the annotated root. Inputs need the applicable task/policy, observed actions and tool results, actor identity, and an independently established outcome where available. A user ambiguity alone does not establish an agent's failure to clarify. |
| `delegation_brief` | The actual delivered briefs and whether they include the goal, constraints, expected output and check; not an inferred brief from child creation. |
| `steer_handling` | The delivered correction and the agent's subsequent behavior; lack of a correction record is not proof that none arrived. |

Before the next calibration, the consuming owner must use this full shared question object on the same declared target and evidence representation as runtime, and report independent gold, paired counts and reliability **per output**. Unknown or missing required observations stay outside the judge's measured population with an explicit reason. `none`, `no-delegation` and `no-steer` are observed classifications, not substitutes for unavailable evidence. Merely requesting all questions does not create independent labels for them.

This is the required consumer migration, not a claim that it has shipped: Lab's existing calibration asks only `failure_mode` over public trajectories, while its runtime reads coordination/spawn logs and asks all outputs. Lab owns reconciling those inputs and recording the target, mapping version, selection/exclusions, questions, model/served identity and source hashes in its next receipt. An applicable task/policy may be supplied as observation context; expected benchmark actions/outputs, root annotations, category rationales and other gold must remain outside the judged state. No old receipt is promoted by this source correction.

## Treatment and recorded conditions

Optional `treatment` and `conditions` arrays on a 1.1.0 finding preserve run composition.
A treatment is a named bundle with an immutable definition digest, source references and
all applicable `TREATMENT_LAYERS` tags. These input tags are separate from `FindingLayer`,
which says how far a claim holds. Arms and findings may carry several bundles.

Each conditions snapshot names its measured population, observation time and evidence.
Runtime/Lab/model/provider versions, seat, host load, start time and operator steers are
explicit nullable readings. Null means unavailable; an empty observed steer list means
none were observed. A snapshot ID identifies an immutable record; rollup and promotion reject conflicting content for the same ID anywhere in their input, before grouping. Capture conditions from
execution evidence; do not ask a judge to invent them or infer formation from an assignment.
The public types are on `@tangle-network/agent-eval/analyst`.

The finding identity includes the treatment definitions and fixed environment conditions
when composition is supplied. The finding factory normalizes unordered composition arrays, so reordering bundles, layer tags or condition snapshots preserves both identity and ledger replay payload.
Absent legacy composition and explicitly empty arrays remain distinguishable. Existing
findings without composition retain their old identity and remain readable.

`rollupFindings` and `promote` use the same composition identity for grouping and output
IDs, including the underlying-run re-pooling after promotion. Different bundles, fixed
versions, seats or unplanned/unknown steering states do not silently pool. Varying load,
observation time and source references retain their population-linked provenance without
splitting an otherwise matching group. Matching recorded conditions do not establish
that every possible confounder was observed; experiment owners still enforce declared
factors and interleaving before execution.
