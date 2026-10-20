"""Own typed single-step repairs and recorded-trajectory validation."""

from __future__ import annotations

from typing import Annotated, Any, Literal

import pydantic

from agent_eval_rpc.dspy_rlm_output import (
    _extract_json_array,
    _prediction_field,
)

# The TB-Repair transport contract names its own task token the same way, so
# the instructions select the typed repair signature without a wire-protocol
# change. Mirrors DSPY_REPAIR_TASK_TOKEN in src/trace-repair/arm-dspy.ts.
_REPAIR_TASK_TOKEN = "tb-repair-typed-"


_REPAIR_SIGNATURE_VERSION = "tb-repair-typed-v1"


# Mirror of SCAFFOLD_INTERVENTION_BUDGET in src/trace-repair/action-budget.ts.
# The grader enforces the budget; stating it here keeps the typed field from
# capping an action below what the grader would have accepted, which would
# hand this arm a smaller action than the arms that answer over a completion.
_REPAIR_ACTION_MAX_BYTES = 4096


# One repair per row. The contract asks for the single step whose action would
# be replaced, so a program that proposes several has not answered it.
_MAX_REPAIRS = 1


_REPAIR_ANALYSIS_PROMPT = """
The recorded trajectory is already loaded into the REPL as the variable `trajectory`, a list of
{step_id, action, observation} objects in recorded order; read it with Python code instead of
re-fetching it. The task statement handed to the recorded agent is loaded as `taskStatement`.
Follow analyst_instructions for the repair task definition and the execution rules your action
must satisfy.
Use llm_query or llm_query_batched for focused semantic subjudgments over step content.
Do not claim that you inspected data you did not retrieve.
When done, SUBMIT(answer=..., repairs=[...]); repairs is [] when no single replacement action
could make the task's held-out suite pass.
""".strip()


class RepairProposal(pydantic.BaseModel):
    """One executable repair: the step to replace, and what to run instead."""

    model_config = pydantic.ConfigDict(extra="forbid")

    k: int = pydantic.Field(
        ge=1,
        description=(
            "The step_id whose action you replace. Must be a step_id present in "
            "the trajectory; there is no credit for naming one step and repairing "
            "elsewhere."
        ),
    )
    failure_claim: Annotated[
        str,
        pydantic.StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000),
    ] = pydantic.Field(
        description=(
            "What went wrong at step k. Recorded and never scored, so spend the "
            "effort on the action."
        ),
    )
    intervention_kind: Literal["shell", "edit"] = pydantic.Field(
        description=(
            "'edit' when the action authors file content with a heredoc, 'shell' "
            "otherwise. A mismatch between this and the action is rejected rather "
            "than corrected."
        ),
    )
    action: Annotated[
        str,
        # strip_whitespace so a whitespace-only action fails min_length here
        # instead of surviving to the grader, which trims before measuring; the
        # byte budget below is measured on the same stripped text the grader
        # measures.
        pydantic.StringConstraints(strip_whitespace=True, min_length=1),
    ] = pydantic.Field(
        description=(
            "The exact shell text executed in place of step k. Not a description, "
            "not a diff, not a plan. One top-level statement, at most "
            f"{_REPAIR_ACTION_MAX_BYTES} bytes, run in a fresh /bin/sh."
        ),
    )

    @pydantic.model_validator(mode="after")
    def _enforce_action_budget(self) -> RepairProposal:
        measured = len(self.action.encode("utf-8"))
        if measured > _REPAIR_ACTION_MAX_BYTES:
            raise ValueError(
                f"action is {measured} bytes, above the "
                f"{_REPAIR_ACTION_MAX_BYTES}-byte scaffold action budget"
            )
        return self


def _build_repair_signature(dspy: Any) -> Any:
    return dspy.Signature(
        {
            "question": (
                str,
                dspy.InputField(desc="The repair question to answer."),
            ),
            "analyst_instructions": (
                str,
                dspy.InputField(
                    desc=(
                        "The repair task definition and the rules the returned "
                        "action must satisfy to execute."
                    )
                ),
            ),
            "trajectory": (
                list[dict[str, Any]],
                dspy.InputField(
                    desc=(
                        "Every recorded step of the failed run, in order: "
                        "{step_id, action, observation}. `action` is the shell text "
                        "the agent ran; `observation` is what came back, or null."
                    )
                ),
            ),
            "taskStatement": (
                str,
                dspy.InputField(desc="The task statement handed to the recorded agent."),
            ),
            "answer": (
                str,
                dspy.OutputField(desc="A concise prose summary of the diagnosis."),
            ),
            "repairs": (
                list[RepairProposal],
                dspy.OutputField(
                    desc=(
                        f"At most {_MAX_REPAIRS} repair; [] when no single replacement "
                        "action could make the held-out suite pass. `k` must be a "
                        "step_id present in the trajectory."
                    )
                ),
            ),
        },
        _REPAIR_ANALYSIS_PROMPT,
    )


def _validate_repair_trajectory(trajectory: list[Any]) -> None:
    """Refuse a malformed trajectory before the program runs.

    A silently skipped entry would empty the recorded step-id set and drop
    every proposal as "not a recorded step_id" — an error that names the
    symptom and hides the malformed input that caused it.
    """
    for index, entry in enumerate(trajectory):
        if not isinstance(entry, dict):
            raise ValueError(
                f"taskInputs.trajectory[{index}] must be an object, got {type(entry).__name__}"
            )
        step_id = entry.get("step_id")
        # bool is an int subclass; True aliasing to step_id=1 must not pass.
        if not isinstance(step_id, int) or isinstance(step_id, bool):
            raise ValueError(
                f"taskInputs.trajectory[{index}].step_id must be an integer, got {step_id!r}"
            )
        if not isinstance(entry.get("action"), str):
            raise ValueError(
                f"taskInputs.trajectory[{index}].action must be a string, got "
                f"{type(entry.get('action')).__name__}"
            )
        observation = entry.get("observation")
        if observation is not None and not isinstance(observation, str):
            raise ValueError(
                f"taskInputs.trajectory[{index}].observation must be a string or "
                f"null, got {type(observation).__name__}"
            )


def _typed_prediction_to_repairs(
    prediction: Any,
    trajectory: list[Any],
) -> dict[str, Any]:
    """Read the typed `repairs` field into the wire shape the grader consumes.

    Every row is validated against the recorded step ids. A row naming a step
    the recording does not hold is dropped with its reason rather than clamped:
    an analyst that names a step outside the trajectory has localized nothing.
    A `repairs` value that stays unreadable after the bounded structured
    re-read travels as `failure` beside the answer instead of aborting the
    analysis the model already paid for.
    """
    raw_repairs = _prediction_field(prediction, "repairs")
    proposals, repair, dropped, reported, failure = _coerce_typed_repairs(raw_repairs)
    step_ids = {
        entry["step_id"]
        for entry in trajectory
        if isinstance(entry, dict)
        and isinstance(entry.get("step_id"), int)
        and not isinstance(entry.get("step_id"), bool)
    }
    rows: list[dict[str, Any]] = []
    for index, proposal in enumerate(proposals):
        if len(rows) >= _MAX_REPAIRS:
            dropped.append({"index": index, "reason": f"exceeds the {_MAX_REPAIRS}-repair cap"})
            continue
        if proposal.k not in step_ids:
            dropped.append(
                {
                    "index": index,
                    "reason": f"k {proposal.k} is not a recorded step_id",
                }
            )
            continue
        rows.append(
            {
                "k": proposal.k,
                "failure_claim": proposal.failure_claim,
                "intervention": {
                    "kind": proposal.intervention_kind,
                    "action": proposal.action,
                },
            }
        )
    return {
        "signature": _REPAIR_SIGNATURE_VERSION,
        "reported": reported,
        "kept": len(rows),
        "dropped": dropped,
        "repair": repair,
        "rows": rows,
        "failure": failure,
    }


def _coerce_typed_repairs(
    raw_repairs: Any,
) -> tuple[list[RepairProposal], str | None, list[dict[str, Any]], int, str | None]:
    repair: str | None = None
    if isinstance(raw_repairs, str):
        stripped = raw_repairs.strip()
        if not stripped:
            # The tolerant adapter's recovered default for a missing field. The
            # model wrote no typed repairs at all — prose only — so there is
            # nothing to re-read: a typed failure that keeps the prose answer,
            # not a decline the model never submitted and not an aborted run.
            return (
                [],
                None,
                [],
                0,
                "the model returned no typed repairs field; a decline is SUBMIT "
                "repairs=[], not prose",
            )
        # The max-iterations extract fallback under a marker-tolerant adapter can
        # hand the typed field back as text. EXACTLY one bounded structured-repair
        # attempt runs here — the same single retry the chat-completion arms get
        # for a malformed reply. A value that stays unreadable is a typed failure
        # beside the answer, because the investigation produced one and a silent
        # [] would erase it.
        parsed = _extract_json_array(stripped)
        if parsed is None:
            return (
                [],
                "unparseable-repairs-string",
                [],
                0,
                "DSPy RLM typed repairs output is not a JSON array after the bounded "
                f"structured re-read: {' '.join(stripped.split())[:200]!r}",
            )
        repair = "parsed-repairs-from-string"
        raw_repairs = parsed
    if not isinstance(raw_repairs, list):
        raise RuntimeError(
            f"DSPy RLM typed repairs output must be an array, got {type(raw_repairs).__name__}"
        )
    proposals: list[RepairProposal] = []
    dropped: list[dict[str, Any]] = []
    for index, entry in enumerate(raw_repairs):
        if isinstance(entry, RepairProposal):
            proposals.append(entry)
            continue
        try:
            proposals.append(RepairProposal.model_validate(entry))
        except pydantic.ValidationError as error:
            dropped.append({"index": index, "reason": " ".join(str(error).split())[:300]})
    return proposals, repair, dropped, len(raw_repairs), None
