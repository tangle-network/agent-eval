# TB-Repair admission

Admission decides which corpus rows enter a campaign.
It runs before any analyst reads a row, and it publishes the denominator it produced.

`Delta-repair = P(tests pass | intervention) - P(tests pass | no-fix control)` is an average over a set of rows.
An analyst that declines the rows it cannot solve shrinks that set and raises its own score.
So the set is fixed first, by checks no analyst can influence, and every row that leaves is counted with the reason it left.

Source: [`src/trace-repair/`](../src/trace-repair/).
The policy the controls run under is in [trace-repair-continuation.md](./trace-repair-continuation.md).

## The five conditions

A row is admitted only when all five hold.

| # | condition | what it removes |
| --- | --- | --- |
| 0 | the task's own suite returns one verdict on byte-identical state | tasks whose grader is not a function of the state, where every condition below is a draw |
| 1 | the recorded prefix replays with divergence at or below 10% | rows whose recording does not reproduce, so no claim about step `k` can be executed |
| 2 | the task's held-out tests fail on the recorded end state | rows that did not actually fail |
| 3 | the no-fix control fails every rollout | rows the continuation policy rescues with no intervention at all |
| 4 | the no-op control fails every rollout | rows an inert action plus continuation rescues, which is a flaky task or a lucky policy |

Condition 0 runs first and costs nothing at run time: it reads the task's certification, which was measured once by [`certify-task-oracle.sh`](../benchmarks/trace-repair/tools/README.md) and checked in as [`task-oracles.json`](../benchmarks/trace-repair/task-oracles.json).
Conditions 1 to 4 all read the same suite, so a suite that answers differently about identical bytes makes each of them a coin flip rather than a measurement.
A task with no certification is excluded as `task-oracle-uncertified`, which is a different fact from `task-oracle-nondeterministic`: one says the check has not run, the other says it ran and the task failed it.

Conditions 3 and 4 are the ones that keep `Delta-repair` honest.
Without them a row that any continuation would have passed counts as a repair, and the number measures the continuation policy rather than the analyst.

## The control has to be able to rescue

Conditions 3 and 4 ask whether a row is rescued by continuing from the recorded end state.
That question has an answer only under a control that can act.

A control rollout changes the graded state by executing commands, and it executes only what a model call asks for.
At a step budget of zero it executes nothing, so the container it grades holds the same bytes condition 2 already graded as failing.
A control pass under such a policy is not a rescue — it is the task's own grader answering differently about one state.
Condition 3 then cannot fire for the reason it exists, and every row walks through it.

So the control is a declared, hashed parameter rather than a default, and the criteria say which reading applies:

| `controlScreening` | requires | a control pass means |
| --- | --- | --- |
| `enforced` (default) | `stepBudget >= 1` | `no-fix-control-passed` — the row is repairable by continuing alone |
| `declared-inert` | `stepBudget == 0` | `control-passed-on-identical-state` — the task's grader disagreed with itself |

Either pairing the other way round raises `UncalibratedControlError` at the call, before a verdict is produced for any row.
A screening control that cannot act, and a control declared inert that can, are both configuration faults rather than properties of a row.

`defineControlPolicy` hashes the whole declaration — id, step budget, scaffold, model, command timeout — so a step budget cannot move under an unchanged label, and a policy that calls no model must record `model: null`.

Every admission decision carries an `AdmissionScreeningRecord`: the control policy and its digest, the screening mode, the task name, and the task's measured oracle flip rate.
It is on the rejected decisions too, so a reader of an artifact can tell which control screened a row without opening the runner's source.
`AdmissionRowVerdict` carries the same three fields for rows the executing pre-pass excluded before any control ran.

Divergence is `divergences / prefixExecuted`, and the threshold admits a row sitting exactly on it.
A replay that executed fewer steps than the recording holds is excluded as `prefix-replay-truncated` before that ratio is read, because a truncated run computes divergence over the steps it did reach and a short replay would look perfect.

## Reading the recording

Every condition above is asked of a recording, so a row is admitted or not by what a decoder can read out of it.
[`src/trajectory-replay/steps.ts`](../src/trajectory-replay/steps.ts) is that decoder, and it is the only one.

The published Terminal-Bench-2 dump holds **turns**, not steps.
A turn carries an observation in one of four recorded shapes, plus two absences — no observation at all, and a shape this grammar does not know.
Only the first shape carries an exit status.

| observation shape | what it means | carries an exit status |
| --- | --- | --- |
| `<returncode>N</returncode><output>…</output>` | a command ran | yes |
| `The last command <command>…</command> timed out and has been killed.` | the environment killed the command at its bound | no — the outcome is `killed` |
| `Please always provide EXACTLY ONE action in triple backticks, found N actions.` | the scaffold rejected the turn | no — nothing ran |
| `$3a` | the dump dropped the string | no — and nothing recovers it |

Three rules follow, and each one costs rows when it is missing.

**A command keeps the observation of its own turn.**
Collecting commands and observations into two lists and zipping them looks right and is not.
A rejected turn carries an observation and usually no command, so from the first rejected turn onward every observation is read against a different command than the one that produced it.
1,654 turns in the certified population are rejected turns, and they shift 643 of 2,727 rows.

**A rejected turn is never a step, even when the dump kept a command for it.**
The scaffold rejects a turn holding several bash blocks and runs none of them, while the dump keeps one block in the command field.
494 turns carry that pair.
Replaying the field would execute a command the recorded run did not, which is a worse corpus than a smaller one.

A rejected turn is recognised by its observation, so a rejected turn whose observation the dump elided reads as an executed command.
Nothing in the dump separates the two, and the defence is per row rather than per turn: the unknown-returncode ratio bounds how much of a row may be unreadable, and a row with no elided observation cannot hold the case at all.

**A trailing step that echoes the sentinel and nothing else is the end of the transcript, not a gap in it.**
The scaffold records an observation only when it hands one back to the model, and `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` ends the run.
2,312 of 2,727 rows end that way.
Reading that turn as the trajectory's last step reports no exit status for 85% of the corpus.
Echoing the sentinel changes no state, so the recorded end state is the state the step before it left, and that step's exit is the row's final return code.

The test is the whole action, never a substring.
131 of those 2,312 runs end on a command that writes files or edits them and then echoes the sentinel.
Dropping such a step would remove the run's last state change from the replay; keeping it leaves its exit unknown, which is what the row reports.

The elision marker is a **hexadecimal** counter over the row's strings in serialization order.
A decimal-only pattern (`^\$\d+$`) reads `$3a` as command text: 19,266 of 107,989 recorded commands are elided, and the decimal pattern sees 11,651 of them.

The counter is a position, not a key.
Across all 2,292 rows that hold a marker, the markers are strictly ascending and never repeat, and the first is always `$32` or `$33`.
A shell command that happened to look like a marker would repeat one or arrive out of order; none does, so the pattern has no false positive in this corpus and no marker maps back to text.
An elided command is unrecoverable and the row holding it is rejected.

## What the decoder recovers, and what it refuses

Measured over the 2,578 rows the earlier decoder rejected at the replayable stage, on the 46 certified tasks.

| class | rows | share | recovery |
| --- | --- | --- | --- |
| commands elided by the dump | 1,327 | 51.5% | refused — no dictionary maps the marker back |
| run ended on the submit sentinel | 581 | 22.5% | exact — the last executed command's own returncode |
| ended on the sentinel AND shifted by a rejected turn | 308 | 11.9% | exact |
| no executed command after decoding | 119 | 4.6% | refused — the run held only rejected turns or the sentinel |
| last executed command recorded no observation | 94 | 3.6% | refused — it echoed the sentinel after doing work, or its own text was elided |
| final observation elided by the dump | 85 | 3.3% | refused |
| shifted by a rejected turn | 47 | 1.8% | exact |
| last command killed at its timeout | 14 | 0.5% | read exactly as `killed`, then excluded as `signal-kill` |
| observation shape the grammar cannot read | 2 | 0.1% | refused |
| phantom command from a rejected turn | 1 | 0.0% | exact |

937 rows are recovered exactly — 36.3% of the 2,578 — and every refused class stays refused.
The 14 killed rows read their outcome exactly too, and are excluded at the stratum stage rather than counted here.

The population is one scaffold: `mini-swe-agent`.
No class is another scaffold's transcript format, because no other scaffold's rows enter this funnel.
`terminus-2`, `openhands`, `codex` and `claude-code` are pinned for later and are 0% of these 2,578.

The correction runs in both directions.
Six of the 142 rows the earlier decoder admitted carry a command the dump elided with a marker its pattern did not match, and one of those six is in the sealed 16.
Replaying it would have run the literal string `$3a` as a shell command.

## The measured funnel

Certified tasks, `mini-swe-agent`, recorded reward 0.
The other gates are unchanged: the end-state screen, the image-digest pin, and the oracle-determinism refusal all keep their thresholds.

The funnel opens at 2,601 rather than the 2,727 rows the dump holds for these tasks.
126 rows executed no command at all — every turn was rejected, or the run's only command was the sentinel — so they carry no prefix to replay.
[`tb-corpus-decode.json`](../benchmarks/trace-repair/tb-corpus-decode.json) records that count with the shard list and the duckdb version that produced it.

| stage | entering | excluded | remaining |
| --- | --- | --- | --- |
| `certified-deterministic-oracle` | 2,601 | 0 | 2,601 |
| `replayable-commands-and-final-returncode` | 2,601 | 1,522 | 1,079 |
| `unknown-returncode-ratio-at-most-25pct` | 1,079 | 121 | 958 |
| `recorded-commands-at-most-25` | 958 | 166 | 792 |
| `image-present-locally-at-pinned-digest` | 792 | 403 | 389 |
| `one-row-per-recorded-trial` | 389 | 83 | 306 |

`one-row-per-recorded-trial` is a stage the earlier funnel did not have.
885 `mini-swe-agent` trials appear in the dump twice, under an empty and a populated trial id, and the two copies are the same recorded run.
A cluster holding both reads one trajectory as two independent rows.

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
| 4 | `task-oracle-uncertified` | 3 | 0 | 3 |
| 5 | `task-oracle-nondeterministic` | 3 | 0 | 3 |
| 6 | `prefix-replay-error` | 3 | 0 | 3 |
| 7 | `prefix-replay-empty` | 3 | 0 | 3 |
| 8 | `prefix-replay-truncated` | 3 | 0 | 3 |
| 9 | `prefix-divergence-above-threshold` | 3 | 1 | 2 |
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

## What this changes about numbers already produced

Runs made before the control was declared and the task oracles were certified are not rewritten here.
What they measured is stated instead, so a reader can price them.

Two facts are measured, not inferred.

`largest-eigenval` is graded in part by a wall-clock assertion (`assert dt < ref_dt`, `tests/test_outputs.py:111`), the only one across the four tasks the milestones sampled.
Certification re-graded each task's published image 16 times with nothing written between the runs — 8 on the untouched image and 8 after the reference solution, half of each under CPU contention — at the same image digests the milestones ran against.

| task | replicates | units that flipped | worst per-unit flip | verdict |
| --- | --- | --- | --- | --- |
| `password-recovery` | 16 | 0 | 0 % | `CERTIFIED` |
| `sanitize-git-repo` | 16 | 0 | 0 % | `CERTIFIED` |
| `count-dataset-tokens` | 16 | 0 | 0 % | `CERTIFIED` |
| `largest-eigenval` | 16 | 8 | 37.5 % | `NONDETERMINISTIC_ORACLE` |

All eight flipped units are `test_speedup[size]` parameters on the untouched image, where `/app/eigen.py` holds the reference implementation the assertion compares against.
`test_speedup[10]`, `[3]` and `[6]` each returned 5 passes and 3 fails over 8 gradings of identical bytes.
The whole-suite reward never moved on that state — 0 of 8 — which is why the conjunction has to be counted term by term to see any of this.
An earlier run of the same certification put the worst unit at 50 %; a flip rate that is itself unstable is what a coin flip looks like.

No row from `largest-eigenval` can be admitted while that certification stands.

Both milestone runs screened their controls with a policy pinned to zero model calls, so conditions 3 and 4 could never fire for the reason they exist.
Every control pass those runs recorded fell on `largest-eigenval`: 3 of 3 across 68 row-evaluations, and 0 of 61 on the three tasks whose graders certify stable.
One row, `largest-eigenval__4GTN8MQ`, was excluded by milestone 1 on a control pass of 1/3 and admitted by milestone 2 on a control pass of 0/3 — the same row and the same control, with opposite verdicts.

The consequence differs by run.

| run | rows | rows from the timing-graded task | what moves |
| --- | --- | --- | --- |
| milestone 1 | 20 evaluated, 17 admitted | 2 evaluated, **0 admitted** | the two exclusions were labelled `no-fix-control-passed`, which claimed the row was repairable by continuing alone; nothing continued. The headline is computed on 17 rows that contain none of them |
| milestone 2 | 48 evaluated, 43 admitted | 5 evaluated, **4 admitted** | four admitted rows come from a task whose grader is not a function of the state; its admitted set is contaminated and its numbers are conditional on that |

Milestone 1's headline separation survives excluding the timing-graded task, because it never included it: oracle-fix `+0.353` over 17 rows and inert-probe `0.000` over the same 17 rows are unchanged when `largest-eigenval` is dropped.
What does not survive is the reason recorded for its two exclusions, and any reading of that run as evidence that the no-fix control screened anything.

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
  taskOracles: parseTaskOracleRegistry(JSON.parse(readFileSync(taskOraclesPath, 'utf8'))),
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
