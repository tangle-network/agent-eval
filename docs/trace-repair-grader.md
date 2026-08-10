# The repair grader

`@tangle-network/agent-eval/trace-repair` grades one claim about a recorded failure by executing the repair it proposes.

An analyst reads a blinded trajectory prefix and answers with exactly one finding — a step `k`, what went wrong there, and one action to run instead — or with the literal `no-decisive-failure`.
The grader turns that answer into a measured difference.

Who produces the answer, and what has to be equal between two analysts before their difference means anything, is [the analyst arms](./trace-repair-analyst-arms.md).

## The headline

```
Delta-repair = P(tests pass | intervention) − P(tests pass | no-fix control)
```

Paired per row, then bootstrapped over rows.
Every admitted row stays in the denominator, including the rows an analyst declined and the answers the grader rejected.
Those rows contribute a paired difference of exactly zero, because with no intervention to run their arm is their control arm.

## The five tiers

| Tier | Question | Pays |
|---|---|---|
| t0 parsed | Is this one answer, inside the action budget? | — |
| t1 reproduced | Does the recorded state at `k` come back under replay? | **nothing** |
| t2 executes | Does the intervention run at `k`? | `executes` |
| t3 local flip | Does the held-out suite pass immediately after it? | `localFlip` |
| t4 repair flip | Does the suite pass after the pinned policy continues? | `repairRate` |

t0, t1 and t2 are nested gates.
t3 and t4 are two measurements of the same intervention, and neither contains the other: an intervention that fixes the task outright flips locally, and one that unblocks an agent with work still to do flips only after the continuation.

**t1 pays nothing, structurally.**
`RepairCredit` has three numeric terms and no reproduction term, so there is no field a reproduced step could pay into.
Naming the first step with a nonzero exit code earns exactly what naming a step that does not reproduce earns.

Reproduction is not "a nonzero exit came back".
Most admitted rows end on a clean exit, so the gate asks whether the recorded state at `k` reproduces, whatever that state was, including a returncode of zero.
A step that recorded no observation has nothing to reproduce; the gate passes vacuously, opens no container, and records `basis: 'no-recorded-observation'`.

## The action budget

The intervention is one action from the action space the scaffold had.

| Rule | Default | Why |
|---|---|---|
| One top-level statement | `maxStatements: 1` | A command list joined by `&&`, `\|\|` or a pipe is one statement. Two statements separated by a newline or `;` are two actions. |
| One authored file | `maxHeredocs: 1` | An `edit` writes file content inline through one heredoc. |
| 4 KB | `maxBytes: 4096` | The scaffold's per-action budget. |

Heredoc bodies, comments and compound blocks (`if`, `for`, `while`, `until`, `case`, `{ … }`) are inside a statement, never separators.
An action the scanner cannot resolve stays inside one oversized statement and is rejected on bytes, so an unparseable answer fails closed.

The declared kind must match the action: an answer that calls a file rewrite a shell command is rejected rather than silently corrected.

## Admission

Five checks, none of which reads a finding, a `k`, or a label.
Four are anchored at the recorded end state, so the same evidence admits a row whatever an analyst later blames; the fifth is about the task rather than the row.

| Check | Criterion |
|---|---|
| oracle determinism | the task's own suite returned one verdict per assertion on byte-identical state |
| prefix fidelity | at most 10 % of replayed steps diverge from their recorded returncode |
| end state fails | the held-out suite fails on the recorded end state |
| no-fix control | 3 of 3 continuations from the end state fail |
| no-op control | 3 of 3 continuations from the end state, after an action that changes nothing, fail |

The two controls only screen under a control that can act.
A control with a step budget of zero executes no command, so it grades the bytes the end-state check already read as failing, and a pass there is the task's grader disagreeing with itself.
`admitRow` refuses that pairing at the call rather than admitting every row through a check that cannot fire; see [trace-repair-admission.md](./trace-repair-admission.md).

`admitRow` is pure: a campaign runner executes the checks against real containers and hands it the measured evidence.
Splitting it that way keeps every admission re-derivable from the recorded numbers without re-running a container.

An admitted row carries a phantom brand that only `admitRow` can produce.
`blindTrajectory` and `gradeRepairRow` both require one, so there is no signature anywhere that shows an unadmitted row to an analyst or grades an answer about one.

## What defeats the degenerate answers

`DEGENERATE_STRATEGIES` names each one in code, with the mechanism that removes its reward and where that mechanism lives.
A gate refuses the answer before a rollout is spent; a measurement lets it run and measures it at its control.

| Strategy | Defeated by |
|---|---|
| point at any nonzero-exit step | gate — reproduction pays nothing |
| propose the recorded command again | gate — compared against the recorded action at `k` |
| propose a no-op | gate for the literal ones, measurement for a semantic one |
| submit instead of repair | gate — the sentinel is rejected |
| touch the test suite | gate — the oracle injects the suite from outside and verifies the bytes it reads back |
| buy a bigger action | gate — statements, heredocs and bytes |
| decline every hard row | measurement — a declined row keeps its cell and its place in the denominator |
| repair somewhere other than `k` | measurement — the intervention runs at the named `k` only |

The suite is the load-bearing one.
`injectedTestOracle` purges the suite root, uploads the held-out suite from outside the session, reads the bytes back from inside and hashes them, and refuses to grade when the read-back digest is not the uploaded digest.
A container that silently drops the upload raises `TestSuiteTamperedError` rather than returning a result.

Ordering carries the same weight as the upload.
A repair rollout replays the prefix, runs the intervention, hands the container to the continuation policy, and only then calls the oracle.
The continuing agent therefore works in a container where the suite does not exist yet, and cannot read the thing that will grade it.

Every arm is graded against the suite the row was admitted against.
A grade produced from a different suite digest raises rather than being compared, because two arms that answered different questions are not a difference.

## Wiring

Three injected ports, one job each.

```ts
import {
  admitRow,
  blindTrajectory,
  deltaRepair,
  gradeRepairRow,
  injectedTestOracle,
  parseAnalystResponse,
  renderDeltaRepairReport,
} from '@tangle-network/agent-eval/trace-repair'

const outcome = admitRow(evidence)
if (!outcome.admitted) return

const prompt = blindTrajectory(outcome.row)
const answer = parseAnalystResponse(await analyst(prompt))
if (!answer.succeeded) return

const graded = await gradeRepairRow({
  row: outcome.row,
  response: answer.value,
  sessions,       // a fresh container at the trajectory's own image
  oracle,         // injectedTestOracle({ files, command, purge })
  continuation,   // the pinned policy, run forward from a prepared session
})

const report = deltaRepair(rows)
console.log(renderDeltaRepairReport(report))
```

The image must be the published one the trajectory was recorded against.
A locally rebuilt image drifts from the recording through unpinned apt and pip installs, and every number measured on it is about a different environment.

## Honest limits

The arms are matched on policy, budget and suite, and not on position.
The no-fix control continues from the recorded end state; the intervention arm continues from `k` and has to redo the work the recording did after `k` inside the same step budget.
That asymmetry biases against the intervention, and it travels with the number as the `control-position-asymmetry` threat.

Every admitted row has a control rate of zero by admission, so Delta-repair equals the intervention rate on an admitted corpus.
The estimate is conditional on that admission and says nothing about rows the control can already repair.

Under `controlScreening: 'declared-inert'` that zero is weaker still: the control made no model call, so a control rate of zero restates the end-state check instead of measuring what continuing alone can repair.
Rows screened that way carry the `control-cannot-rescue` threat into the report, so the caveat travels with the number.

Oracle determinism is certified per task, not per row, and it is certified at the two states certification can construct: the published image and that image after the reference solution ran.
Those are anchors, and a suite can be steady at an anchor while flipping near its threshold.
Per-assertion counting is what makes the anchor informative — a suite whose per-parameter timing assertions flip shows it there even when the whole-suite reward does not — but the certification is still a measurement at two states and not a proof about every state a campaign will grade.

A command-level repair cannot address a run the harness killed at a timeout.
Split that class out before sampling; the grader measures actions, not wall clock.

The interval carries `gateEligible`, which is false below the pair count where a percentile bootstrap holds its nominal error rate.
Below it the interval is descriptive spread and a promotion must not turn on it.
