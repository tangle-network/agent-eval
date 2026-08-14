# Gated stop against blind continuation

The study asks one question.
At one matched total token budget, does an agent that may stop only after an executable held-out check passes finish more rows than the same agent spending the identical budget on unconditional continuation?

The mechanism under test is budget allocation, not detection.
A row that clears the check early returns its unspent budget to a pool.
The pool pays for extra steps on rows that have not cleared.
Detection quality is not the claim: on this corpus the recorded done-signal fires on 51.69 % of failed runs and 31.14 % of successes, which is 62.5 % precision as a success predictor.

Design and runner: [`benchmarks/trace-repair/gated-stop-ab/design.json`](../benchmarks/trace-repair/gated-stop-ab/design.json) and [`scripts/tb-gated-stop-ab.ts`](../scripts/tb-gated-stop-ab.ts).
The registration primitives are described in [experiment.md](./experiment.md).

## The two arms

| arm | role | stop rule | graded at |
| --- | --- | --- | --- |
| `blind-continue` | control | spend the allotment unconditionally | best intermediate state |
| `gated-continue` | treatment | stop when the held-out check passes | best intermediate state |

Both arms replay the same recorded prefix, run the same scaffold, and are graded by the same injected suite after every step.
The check that gates the treatment arm is the check that scores both arms.

That symmetry forces a control the report must carry.
The gate is the outcome, so the treatment arm cannot lose a success it already reached, while the control arm can regress out of one.
The control arm is therefore graded twice, at its final state and at its best intermediate state, and both contrasts are reported.
When the two disagree, the harsher contrast is the headline.

## Choosing the draw

The admitted set is the ceiling, not the draw.
`settlingDraw` returns the smallest draw that clears the registered power target at the settling effect of 0.10.
Spending more rows than the design needs is as undisciplined as spending fewer.

The search runs at 15 000 trials and the registered gate runs at 3 000.
Near the floor the two estimates straddle the target, because the standard error at 3 000 trials is about 0.007 and adjacent draws differ by less.
A draw must clear the target under both before the search accepts it.

## The identity gate runs before the spend

`confirm` evaluates the registered `servedModel` gate before it grades a row.
The gate compares the pinned model id against the id the seat reports.
Its registered action on failure is `abort`.

A contrast measured on a substituted model belongs to an experiment nobody registered.
The gate therefore ends the run at zero spend and writes `confirm-refusal.json`, which records the pinned id, the served id, the rows graded, and the dollars spent.
A refusal is a verdict object, not prose beside one.

## Measured seat behaviour

These facts were measured against the z.ai coding seat and they bound what the study can claim.

| fact | measurement | n |
| --- | --- | --- |
| `glm-5.2`, `glm-5.1` and `glm-5` are all answered by `glm-5.3` | served id differs from requested id | 3 ids |
| `glm-4.7` and `glm-4.6` are answered by themselves | served id equals requested id | 2 ids |
| `glm-5.3` is not deterministic at temperature 0 | 19 of 20 replies distinct | 20 |
| `glm-4.7` is not deterministic at temperature 0 | 8 of 20 replies distinct | 20 |
| the scaffold's first turn draws more than one action block | 6 of 20 replies, both models | 20 per model |
| the same rate inside a run, behind a replayed prefix | 4 of 24 steps | 24 |

Temperature 0 does not give a repeated continuation on this provider.
A paired design that assumes it must treat run-to-run variation as a threat to validity and report it.

## Label quality on `qemu-startup`

One row, `qemu-startup__PnXK6EH::ord0`, is recorded at reward 0 and passes its own held-out suite on the replayed end state.
The end-state screen measures exactly that condition, so the registered funnel excludes the row at the `recorded-end-state-fails-its-own-suite` stage.
The row is absent from the draw.

The disagreement rate is 1 of 18 screened rows on `qemu-startup`, against 0 of 285 on every other task.
The concentration is the finding, not the single row.
`qemu-startup` rows still enter the study, because the screen tests each row against the condition that would disqualify it and the remaining rows pass that test.
A task whose labels disagree with its own oracle at 5.6 % cannot carry a study on its own, and this design does not ask it to: it contributes 8 of 151 rows inside a task-clustered bootstrap that resamples whole tasks.
