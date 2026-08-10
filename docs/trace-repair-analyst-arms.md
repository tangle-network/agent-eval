# The repair analyst arms

The [repair grader](./trace-repair-grader.md) executes an answer.
This page is about who produces the answer, and about what has to be equal between them before a difference between two arms means anything.

An **arm** is one way of executing the repair question: a single chat completion, an agent harness, a DSPy program.
The question, the reply grammar, the action budget and the bounded repair turn belong to the comparison and not to the arm.

## Nothing is certified on this task

No arm here runs a certified prompt, and each one says so in its own declaration.

The one GEPA-certified analyst artifact this repository holds — `oht2-coverage-instructions.txt` — was earned on the CodeTraceBench incorrect-step task.
That contract asks for blocks of recorded steps that were wrong, carrying `first_step`, `last_step`, `consequence_step` and `escape_status`.
The repair contract asks a different question: one step `k`, and one executable action of the same type and budget the recorded scaffold itself took, which must make the task's held-out suite pass.
The certified text cannot answer that, and re-authoring it for the repair contract would void the certification, because the benchmark it was earned on has been retired.

So every arm is authored fresh for the repair task, and every arm is uncertified.
`repairArmAsymmetries` refuses a set where some arms carry a certification and others do not: an optimisation applies to every arm or to none.

## What is equal by construction

| Property | Where it is enforced |
|---|---|
| One question, one task policy | `repair-prompt.ts` holds them; each arm composes its prompt from those shared constants and declares its own reply grammar as `promptContract` |
| One action budget (4096 bytes, one top-level statement, one heredoc) | `askRepairArm` measures it; `gradeRepairRow` refuses a violation |
| One bounded repair turn on a malformed reply | declared per arm as `repairTurns`; `repairArmAsymmetries` refuses a set that disagrees |
| No arm sees a grading field | `RepairArmRequest` carries only a `BlindedTrajectoryPrefix`; the admitted row is not in the type, so a grading field is unreachable rather than merely unread |
| A row an arm could not answer is a typed failure | `RepairArmReply` has no shape for a silent null |
| A k the recording does not hold is a declined reply | both arms drop the row with its reason; the same model mistake lands in the same funnel cell on every execution path |

The budget is **recorded** at answer time and **enforced** at grade time.
One authority refuses; measuring early is what lets a report say what an arm spent its bytes on without paying for a rollout to find out.

Prompt identity is recorded at two grains.
`repairQuestionSha256` digests what every arm shares: the question, the task policy, the budget the caps are read from.
Each answer additionally stamps `repairArmPromptSha256`, which folds in the arm's own declared contract text — so the chat arms, which ask the identical composed question, share one digest, and the DSPy arm, whose typed SUBMIT grammar is a materially different question, stamps another.
A contract change, including a `DSPY_REPAIR_SIGNATURE` version bump, changes the per-arm digest.

## What is allowed to differ, and is recorded

`repairArmAsymmetries` renders the differences beside the result rather than leaving a reader to infer them from two runners' source.

| Arm | Executes | Affordances |
|---|---|---|
| `bare-framing` | one chat completion, no harness | inline trajectory |
| `prime` | the prime agent harness through a bridge | inline trajectory, agent loop |
| `dspy-rlm` | a DSPy RLM program with a typed repair signature | inline trajectory, code interpreter, agent loop |

The DSPy arm reads the trajectory with code inside its own environment; the completion arms read it as prompt text.
That is a real advantage and it is declared, not hidden.

## The DSPy arm

`createDspyRepairArm` binds the DSPy RLM engine to the repair contract.
The engine is the incumbent one, unchanged. What is new is a typed signature authored for this task:

```
question, analyst_instructions, trajectory, taskStatement  →  answer, repairs: list[RepairProposal]
```

`RepairProposal` is a pydantic model in `dspy_rlm_bridge.py`: `k`, `failure_claim`, `intervention_kind`, `action`.
Its action cap mirrors the scaffold budget the grader enforces, so the typed field cannot refuse an action the grader would have accepted.
The instructions name the task token `tb-repair-typed-`, which is how the bridge selects this signature; the same mechanism selects the CodeTraceBench signature.

The trajectory arrives as `taskInputs` on the engine request and is bound as a variable in the program's environment.
It is not fetched from a trace store: a Terminal-Bench trajectory is not in one, and a bridge that silently answered without it would be answering about material the caller never delivered — so a repair analysis with no `taskInputs.trajectory` stops the run.

Typed rows return under `runtime.repair`, not under `findings`.
The engine-neutral finding schema caps `recommended_action` at 2000 characters while the scaffold action budget is 4096 bytes, so routing a repair through it would hand this arm a smaller action than every other arm gets — an affordance asymmetry hidden inside a schema.
The measured comparison run makes that concrete: chat-completion answers ran to 2705, 3413, 3987 and 4733 bytes.

## Omni is still blocked, for a different reason than before

GEPA's Omni recipe was deferred on 2026-08-03 because no selection metric existed that a candidate could not game.
The repair grader discharges that: the metric is whether the held-out suite passes after the proposed action executes, which no prose can satisfy.

It stays blocked, on two grounds that the grader does not touch.

**It is an optimiser, not an arm.**
Running it produces certified instruction text for one arm.
The comparison rule above — an optimisation applies to every arm or to none — is now enforced in code, so an Omni-tuned arm beside three untuned ones is a set `repairArmAsymmetries` refuses.

**There is no leakage-free split to train on.**
The corpus records 48 rows from exactly four Terminal-Bench-2 tasks, and admission passes 43: `sanitize-git-repo` 16, `count-dataset-tokens` 12, `password-recovery` 11, `largest-eigenval` 4.
The 20 pre-registered measurement rows draw from all four.
The binding constraint on the existing result is the four task clusters, not the 20 rows, so any training split shares clusters with the measurement set at exactly the level that binds.

The usable set is smaller still.
`largest-eigenval` grades speedup with a wall-clock assertion and its suite is certified nondeterministic — 8 of its 27 assertion units flip on byte-identical state, worst-unit flip rate 0.375 — so the oracle-determinism gate refuses every one of its rows, and 16 of the 20 pre-registered rows survive, in three clusters.
All five `password-recovery` rows among those 16 score zero on the oracle-fix ceiling arm because the reference solution is bash and the scaffold runs dash, which makes their ceiling unmeasured rather than zero.
That leaves 11 measurement rows in two clusters with a measured ceiling.

Omni unblocks when the corpus carries enough independent task clusters to hold out a measurement set that shares none with the training split — not when the grader improves.

## Wiring

```ts
import {
  askRepairArm,
  createCompletionRepairArm,
  createDspyRepairArm,
  repairArmAsymmetries,
  repairArmResponse,
  gradeRepairRow,
} from '@tangle-network/agent-eval/trace-repair'

const arms = [bareFraming, prime, dspy]
// Refuses unequal budgets, unequal repair turns, or a partly certified set.
const asymmetries = repairArmAsymmetries(arms)

for (const arm of arms) {
  const answer = await askRepairArm({ arm, row })
  const response = repairArmResponse(answer)
  if (response === null) continue // the arm failed; the row still counts in the denominator
  const result = await gradeRepairRow({ row, response, sessions, oracle, continuation })
}
```

Publish `asymmetries` with the result.
A comparison that reports a difference without reporting what still differs between the arms is not reporting the difference it measured.
