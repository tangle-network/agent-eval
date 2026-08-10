# TB-Repair admission

Admission decides which corpus rows enter a campaign.
It runs before any analyst reads a row, and it publishes the denominator it produced.

`Delta-repair = P(tests pass | intervention) - P(tests pass | no-fix control)` is an average over a set of rows.
An analyst that declines the rows it cannot solve shrinks that set and raises its own score.
So the set is fixed first, by checks no analyst can influence, and every row that leaves is counted with the reason it left.

Source: [`src/trace-repair/`](../src/trace-repair/).
The policy the controls run under is in [trace-repair-continuation.md](./trace-repair-continuation.md).

## The four conditions

A row is admitted only when all four hold.

| # | condition | what it removes |
| --- | --- | --- |
| 1 | the recorded prefix replays with divergence at or below 10% | rows whose recording does not reproduce, so no claim about step `k` can be executed |
| 2 | the task's held-out tests fail on the recorded end state | rows that did not actually fail |
| 3 | the no-fix control fails every rollout | rows the continuation policy rescues with no intervention at all |
| 4 | the no-op control fails every rollout | rows an inert action plus continuation rescues, which is a flaky task or a lucky policy |

Conditions 3 and 4 are the ones that keep `Delta-repair` honest.
Without them a row that any continuation would have passed counts as a repair, and the number measures the continuation policy rather than the analyst.

Divergence is `divergences / prefixExecuted`, and the threshold admits a row sitting exactly on it.
A replay that executed fewer steps than the recording holds is excluded as `prefix-replay-truncated` before that ratio is read, because a truncated run computes divergence over the steps it did reach and a short replay would look perfect.

## The population split

The corpus assay measured the final recorded return code of every admitted row.

| stratum | final return code | assay share | can one command repair it |
| --- | --- | --- | --- |
| `clean-exit` | `0` | 87.13% | yes — the agent stopped believing it was done and the tests disagree |
| `command-error` | `> 0` | 12.65% | yes |
| `signal-kill` | `< 0` | 0.22% | no — the command was killed at a timeout |

Rows are stratified before anything samples them, and every row carries its stratum, admitted or not.
`admitStrata` defaults to `clean-exit` and `command-error`; the excluded signal kills appear in the chain as `stratum-not-admitted` rather than disappearing.

`AdmissionReport.strata` holds admitted ids per stratum and there is no pooled list.
Sampling reads one stratum at a time; pooling an addressable population with an unaddressable one takes an explicit concatenation that a reader can see.

## The denominator chain

A benchmark whose denominator is not auditable is not a benchmark.
Every run emits the funnel as JSON and renders it as a table: the reason, the rows that reached that stage, the rows it removed, and the rows that survived.

| stage | exclusion reason | entering | excluded | remaining |
| --- | --- | --- | --- | --- |
| 1 | `no-recorded-commands` | 5 | 1 | 4 |
| 2 | `unparseable-final-returncode` | 4 | 0 | 4 |
| 3 | `stratum-not-admitted` | 4 | 1 | 3 |
| 4 | `prefix-replay-error` | 3 | 0 | 3 |
| 5 | `prefix-replay-empty` | 3 | 0 | 3 |
| 6 | `prefix-replay-truncated` | 3 | 0 | 3 |
| 7 | `prefix-divergence-above-threshold` | 3 | 1 | 2 |
| … | … | … | … | … |

`assertChainReconciles` runs on every build of the artifact and throws unless `input = admitted + sum(excluded)`, the last stage's `remaining` equals `admitted`, and the per-stratum inputs plus the unstratified rows cover the overall input.

The stage order is also the order of the checks, and it is cost-ordered.
Everything decidable from the recording runs before the first container, and the six control rollouts run last.
A stratum a campaign does not admit costs nothing at all.

## A boundary failure is never a verdict

Four exclusion reasons exist only because an external call failed: `prefix-replay-error`, `end-state-oracle-error`, `no-fix-control-error`, and `no-op-control-error`.

An errored control rollout is not counted as a failed one.
Counting it as a failure would admit a row nobody verified, which is the same corruption as a silent zero.
The row leaves with the error reason and the message from the boundary, and it stays visible in the chain.

## Analyst independence, in code

Two guards, both mechanical.

`assertAnalystIndependent(rows)` rejects any row carrying a key outside the closed list `rowId, taskName, recordedModel, recordedCommands, finalReturncode`.
The check is a closed key list rather than a list of known analyst field names, because the failure to catch is "some new analyst output leaked into the gate".

`assertDenominatorIntact({ report, strata, sampled, scored })` rejects the three ways a denominator moves after the fact:

- a sampled row that was never admitted,
- a scored row that was never sampled,
- a sampled row that was never scored.

The third is the one an analyst can cause alone.
A row it declines still needs an outcome — `no-decisive-failure` is an answer — so a missing outcome raises `denominator shrank by N row(s)` instead of quietly reducing `n`.

## Running it

```ts
import {
  admissionArtifact,
  definePinnedContinuationPolicy,
  renderAdmissionReport,
  runAdmission,
} from '@tangle-network/agent-eval/../src/trace-repair'

const policy = definePinnedContinuationPolicy({ model: 'pinned/model-id', seed: 20260808 })

const report = await runAdmission({
  rows, // corpus rows, recording fields only
  policy,
  replayer, // replays the prefix in the task's pinned image
  oracle, // runs the task's held-out tests on the recorded end state
  controls, // restores the state, applies the arm, continues, then grades
  config: { concurrency: 8 },
})

const artifact = admissionArtifact(report)
writeFileSync('admission.json', JSON.stringify(artifact, null, 2))
writeFileSync('ADMISSION.md', renderAdmissionReport(artifact, { rowLimit: 50 }))
```

The three boundaries are injected, and each carries an `id` that lands in the artifact.
A report produced against fakes names those fakes, so it cannot be read as one produced against real containers.

The no-op injection step is drawn from the policy seed, the row id, and the rollout index, so it is reproducible from the artifact.
Every rollout the controls return is checked against the arm, row, and index that was requested, and both arms are checked for a shared policy digest and paired seeds before a row is admitted.
