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

`scope.population` takes explicit unit ids only. A query form was proposed but never specified; resolve a query before writing the finding.

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

- `team-shape` (computed, `team`) reads a spawn journal through the supervisor-run readers plus an optional coordination log, builds command, governance and communication edges, and classifies the tree by ordered rules: single, partition, swarm, hive, flat star, fleet. The thresholds are `TEAM_SHAPE_THRESHOLDS`; recalibrate them against the 2026-10-20 class definitions before reading a fleet or swarm boundary as settled.
- `failure-modes` (judged, `agent`, `team` or `run`) asks fixed-choice questions through `systemOneAnalyst`: a MAST-adapted failure mode, delegation-brief completeness and steer handling. `createFailureModesAnalyst` refuses a rubric whose calibration κ is below `FAILURE_MODES_MIN_KAPPA`. Calibrate with `calibrateFailureModes` against `failureModeGoldFromAgentRx` rows plus a gold file read by `parseFailureModeGold`.
- `rollup` (computed) pools run findings per play with a lineage-clustered bootstrap, then lets `promote` decide what climbs. Each lifted finding gets the pooled interval over every run beneath it and its observation and cluster counts.
