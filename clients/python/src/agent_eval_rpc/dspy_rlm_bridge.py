"""Run an official DSPy RLM against trace tools owned by the Node process."""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import quote, urlparse

import httpx
import pydantic

from agent_eval_rpc.optimizer_bridge_common import atomic_write_json

_DEFAULT_MAX_INPUT_BYTES = 4 * 1024 * 1024
_SEVERITIES = frozenset({"critical", "high", "medium", "low", "info"})
_FINDING_KEYS = frozenset(
    {
        "severity",
        "claim",
        "subject",
        "confidence",
        "rationale",
        "recommended_action",
        "evidence",
    }
)
_REQUIRED_FINDING_KEYS = frozenset({"severity", "claim", "confidence", "evidence"})
_EVIDENCE_KEYS = frozenset({"uri", "excerpt"})
_TRACE_ANALYSIS_PROMPT = """
Investigate the supplied question using the enabled trace tools and Python for aggregation.
Follow analyst_instructions as task-specific policy.
Use llm_query or llm_query_batched when a focused model subquery is useful.
Do not claim that you inspected data you did not retrieve.

Return:
1. answer: a concise answer supported by the trace data.
2. findings_json: a JSON array, without Markdown fences. Each element must contain only:
   - severity: "critical", "high", "medium", "low", or "info"
   - claim: a non-empty string
   - subject: an optional non-empty string
   - confidence: a finite number from 0 through 1
   - rationale: an optional string
   - recommended_action: an optional string
   - evidence: a non-empty array of objects containing only uri and optional excerpt

Every evidence URI must identify exact trace or span IDs returned by an enabled tool.
For span evidence, use trace://<percent-encoded-trace-id>/span/<percent-encoded-span-id>.
Percent encoding leaves letters and digits unchanged. Never use base64.
Never invent, approximate, or silently normalize an identifier.
Return [] when no finding has citable evidence.
""".strip()

# The codetrace RLM transport contract is the only analyst prompt that names
# the subject grammar token; its presence in the instructions selects the
# typed task signature without a wire-protocol change.
_CODETRACE_TASK_TOKEN = "incorrect-steps-"
_CODETRACE_SIGNATURE_VERSION = "codetrace-typed-v1"
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
# Mirror of the TypeScript benchmark caps (MAX_INCORRECT_BLOCKS,
# MAX_INCORRECT_BLOCK_STEPS in benchmark-public-prompt.ts): a cap violation
# that crosses the boundary aborts the whole case there, so it is dropped here.
_MAX_INCORRECT_BLOCKS = 16
_MAX_INCORRECT_BLOCK_STEPS = 12
# Matches the runner-built excerpt recipe in benchmark-evidence-validation.ts:
# an exact prefix of the span's projected action content, at most 512 chars.
_EXCERPT_CHARACTERS = 512
# The downstream evidence gates reject an excerpt shorter than 12 characters
# unless the whole action is shorter, and reject any excerpt under 8; content
# below 8 chars cannot produce an acceptable quote at all.
_MINIMUM_QUOTABLE_CONTENT_CHARACTERS = 8
_VIEW_SPANS_PAGE_SIZE = 100
_MAX_PROBED_STEPS = 400
_STEP_SPAN_ID = re.compile(r"^step-([1-9][0-9]*)$")

_CODETRACE_ANALYSIS_PROMPT = """
The complete trajectory is already loaded into the REPL as the variables `trajectory` and `final_verification`; read them with Python code instead of re-fetching the trace.
Follow analyst_instructions for the incorrect-step task definition and block boundaries.
Where analyst_instructions describe transport — findings_json, finding subjects, evidence URIs, or excerpts — they are superseded: SUBMIT typed blocks and the caller builds every subject, URI, and excerpt from them.
Use llm_query or llm_query_batched for focused semantic subjudgments over span content.
Do not claim that you inspected data you did not retrieve.
When done, SUBMIT(answer=..., blocks=[...]); blocks is [] for a clean trajectory.
""".strip()


class IncorrectBlock(pydantic.BaseModel):
    """One contiguous block of incorrect assistant steps in the analyzed trajectory."""

    model_config = pydantic.ConfigDict(extra="forbid")

    first_step: int = pydantic.Field(
        ge=1,
        description=(
            "The step number that commits the mistake — not the step that planned it "
            "and not a later step that repeats it. Must be the n of an existing "
            "assistant span whose span_id is step-<n>."
        ),
    )
    last_step: int = pydantic.Field(
        ge=1,
        description=(
            "The final consecutive step still committing to or compounding the "
            "same mistake; extend through every such step and stop at the first "
            "step free of the error. >= first_step, and a block spans at most "
            f"{_MAX_INCORRECT_BLOCK_STEPS} steps."
        ),
    )
    consequence_step: int = pydantic.Field(
        ge=1,
        description=(
            "The step whose action or following observation shows the damage this "
            "block caused; >= first_step, and it may sit inside the block when the "
            "damage is already visible there. Must be an existing assistant step."
        ),
    )
    escape_status: Literal["escaped", "unescaped"] = pydantic.Field(
        description=(
            "'escaped' only when one single later step fully reversed the block and "
            "nothing afterwards revisits the same file, command, or hypothesis; "
            "'unescaped' in every other case, including whenever you are unsure."
        ),
    )
    severity: Literal["critical", "high", "medium", "low", "info"] = pydantic.Field(
        description="Severity of the damage this block caused.",
    )
    claim: Annotated[
        str,
        pydantic.StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000),
    ] = pydantic.Field(description="One sentence describing the block's failure.")
    confidence: float = pydantic.Field(
        ge=0,
        le=1,
        description="0.9+ exact evidence; 0.6-0.8 inferred pattern; <0.5 speculative.",
    )
    rationale: (
        Annotated[str, pydantic.StringConstraints(max_length=4_000)] | None
    ) = pydantic.Field(
        default=None,
        description="The concrete downstream evidence visible at the consequence step.",
    )

    @pydantic.model_validator(mode="after")
    def _enforce_block_shape(self) -> IncorrectBlock:
        if self.last_step < self.first_step:
            raise ValueError(
                f"last_step {self.last_step} precedes first_step {self.first_step}"
            )
        span = self.last_step - self.first_step + 1
        if span > _MAX_INCORRECT_BLOCK_STEPS:
            raise ValueError(
                f"block spans {span} steps; the maximum is {_MAX_INCORRECT_BLOCK_STEPS}"
            )
        if self.consequence_step < self.first_step:
            raise ValueError(
                f"consequence_step {self.consequence_step} precedes first_step {self.first_step}"
            )
        return self


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


@dataclass(frozen=True)
class _CodetraceEnvironment:
    trace_id: str
    # Full projected span list, in store order, handed to the REPL verbatim.
    spans: list[dict[str, Any]]
    # step number -> span, for existence and kind checks on model-claimed steps.
    step_spans: dict[int, dict[str, Any]]
    final_verification: list[dict[str, Any]]
    fetch_mode: str


@dataclass(frozen=True)
class _ToolCallback:
    url: str
    token: str
    timeout_seconds: float


_ACTIVE_TOOL_CALLBACK: ContextVar[_ToolCallback | None] = ContextVar(
    "dspy_rlm_tool_callback",
    default=None,
)


def getDatasetOverview(filters: dict[str, Any] | None = None) -> Any:
    """Return a bounded summary of the trace dataset."""

    return _call_trace_tool("getDatasetOverview", _without_none(filters=filters))


def queryTraces(
    limit: int,
    filters: dict[str, Any] | None = None,
    offset: int | None = None,
) -> Any:
    """Return one bounded page of trace summaries."""

    return _call_trace_tool(
        "queryTraces",
        _without_none(filters=filters, limit=limit, offset=offset),
    )


def countTraces(filters: dict[str, Any] | None = None) -> Any:
    """Count traces that match optional filters."""

    return _call_trace_tool("countTraces", _without_none(filters=filters))


def viewTrace(trace_id: str) -> Any:
    """Read a bounded projection of one trace."""

    return _call_trace_tool("viewTrace", {"trace_id": trace_id})


def viewSpans(trace_id: str, span_ids: list[str]) -> Any:
    """Read a bounded set of spans from one trace."""

    return _call_trace_tool("viewSpans", {"trace_id": trace_id, "span_ids": span_ids})


def searchTrace(
    trace_id: str,
    regex_pattern: str,
    max_matches: int = 50,
) -> Any:
    """Search one trace with a bounded regular expression query."""

    return _call_trace_tool(
        "searchTrace",
        {
            "trace_id": trace_id,
            "regex_pattern": regex_pattern,
            "max_matches": max_matches,
        },
    )


def searchSpan(
    trace_id: str,
    span_id: str,
    regex_pattern: str,
    max_matches: int = 50,
) -> Any:
    """Search one span with a bounded regular expression query."""

    return _call_trace_tool(
        "searchSpan",
        {
            "trace_id": trace_id,
            "span_id": span_id,
            "regex_pattern": regex_pattern,
            "max_matches": max_matches,
        },
    )


_TRACE_TOOL_FUNCTIONS: dict[str, Callable[..., Any]] = {
    function.__name__: function
    for function in (
        getDatasetOverview,
        queryTraces,
        countTraces,
        viewTrace,
        viewSpans,
        searchTrace,
        searchSpan,
    )
}
_TRACE_TOOL_ARGUMENTS = {
    "getDatasetOverview": frozenset({"filters"}),
    "queryTraces": frozenset({"filters", "limit", "offset"}),
    "countTraces": frozenset({"filters"}),
    "viewTrace": frozenset({"trace_id"}),
    "viewSpans": frozenset({"trace_id", "span_ids"}),
    "searchTrace": frozenset({"trace_id", "regex_pattern", "max_matches"}),
    "searchSpan": frozenset({"trace_id", "span_id", "regex_pattern", "max_matches"}),
}
_TRACE_TOOL_REQUIRED_ARGUMENTS = {
    "getDatasetOverview": frozenset(),
    "queryTraces": frozenset({"limit"}),
    "countTraces": frozenset(),
    "viewTrace": frozenset({"trace_id"}),
    "viewSpans": frozenset({"trace_id", "span_ids"}),
    "searchTrace": frozenset({"trace_id", "regex_pattern", "max_matches"}),
    "searchSpan": frozenset({"trace_id", "span_id", "regex_pattern", "max_matches"}),
}


def main() -> None:
    previous_umask = os.umask(0o077)
    try:
        _main()
    except BaseException as error:
        # The parent bounds captured stderr head+tail, which can truncate away
        # the exception type buried mid-traceback. The last line always names
        # the failure so every crash is classifiable from the retained tail.
        summary = " ".join(str(error).split())[:200]
        print(f"DSPY-BRIDGE-FAILURE: {type(error).__name__}: {summary}", file=sys.stderr)
        raise
    finally:
        os.umask(previous_umask)


def _main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-input-bytes", type=int, default=_DEFAULT_MAX_INPUT_BYTES)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    if args.max_input_bytes <= 0:
        raise ValueError("--max-input-bytes must be positive")
    input_value = _read_json(Path(args.input), args.max_input_bytes)
    operation = input_value.get("operation")
    if operation == "inspect":
        _require_exact_keys(input_value, {"operation"}, "inspect input")
        dspy = _load_dspy()
        with _probed_interpreter(dspy) as (_, deno_command):
            output = {"runtime": _runtime_identity(deno_command)}
    elif operation == "analyze":
        validated = _validate_analyze_input(input_value)
        output = _analyze(validated)
    else:
        raise ValueError("DSPy RLM bridge operation must be inspect or analyze")
    atomic_write_json(Path(args.output), output)


def _analyze(input_value: dict[str, Any]) -> dict[str, Any]:
    dspy = _load_dspy()
    model_proxy = input_value["modelProxy"]
    control_adapter = input_value.get("controlAdapter", "chat")
    limits = input_value["limits"]
    task_kind = _task_kind(input_value["instructions"])
    typed_task = task_kind == "codetrace"
    repair_task = task_kind == "repair"
    typed_diagnostics: dict[str, Any] | None = None
    typed_findings: list[dict[str, Any]] | None = None
    repair_diagnostics: dict[str, Any] | None = None
    task_inputs = input_value.get("taskInputs")
    if repair_task:
        if not isinstance(task_inputs, dict) or not isinstance(
            task_inputs.get("trajectory"), list
        ):
            raise ValueError(
                "the repair task requires taskInputs.trajectory, the recorded steps the "
                "program reads; the analyst never fetches them from a trace store"
            )
        _validate_repair_trajectory(task_inputs["trajectory"])
        statement = task_inputs.get("taskStatement", "")
        if not isinstance(statement, str):
            raise ValueError(
                "taskInputs.taskStatement must be a string, got "
                f"{type(statement).__name__}"
            )
    with _probed_interpreter(dspy) as (interpreter, deno_command):
        runtime = _runtime_identity(deno_command)
        lm = dspy.LM(
            f"openai/{model_proxy['model']}",
            api_base=model_proxy["baseUrl"],
            api_key=model_proxy["apiKey"],
            cache=False,
            num_retries=0,
            max_tokens=model_proxy["maxOutputTokens"],
            # The controller writes code, not extended reasoning; a reasoning
            # model left to think spends its whole completion budget thinking
            # and returns empty text, so the control turn parses to nothing.
            # Disabling thinking makes it emit the action directly. Providers
            # that do not recognise the field ignore it.
            extra_body={"thinking": {"type": "disabled"}},
        )
        tools = _build_dspy_tools(dspy, input_value["toolSpecs"])
        program = dspy.RLM(
            _build_signature_for(dspy, task_kind),
            max_iterations=limits["maxIterations"],
            max_llm_calls=limits["maxLlmCalls"],
            max_output_chars=limits["maxOutputChars"],
            tools=tools,
            sub_lm=lm,
            interpreter=interpreter,
        )

        history_before = _lm_history_length(lm)
        callback = input_value["toolCallback"]
        with _tool_callback(
            callback["url"], callback["token"], callback["timeoutMs"] / 1_000
        ):
            # Environment materialization and excerpt reads use the same
            # authenticated tool callback as model-driven tool calls, so they
            # count against the Node-side tool budget and never bypass it.
            environment = _fetch_codetrace_environment() if typed_task else None
            # A capable model that writes prose and a fenced code block instead
            # of DSPy's field markers fails the default adapter outright. The
            # two-step adapter prompts without markers and extracts the fields
            # with a second call, which is what upstream recommends for models
            # that do not emit structured output natively.
            with dspy.context(lm=lm, adapter=_control_adapter(dspy, lm, control_adapter)):
                if environment is not None:
                    prediction = program(
                        question=input_value["question"],
                        analyst_instructions=input_value["instructions"],
                        trajectory=environment.spans,
                        final_verification=environment.final_verification,
                    )
                elif repair_task:
                    prediction = program(
                        question=input_value["question"],
                        analyst_instructions=input_value["instructions"],
                        trajectory=task_inputs["trajectory"],
                        taskStatement=task_inputs.get("taskStatement", ""),
                    )
                else:
                    prediction = program(
                        question=input_value["question"],
                        analyst_instructions=input_value["instructions"],
                    )
            if environment is not None:
                typed_findings, typed_diagnostics = _typed_prediction_to_findings(
                    prediction,
                    environment,
                )
            elif repair_task:
                repair_diagnostics = _typed_prediction_to_repairs(
                    prediction,
                    task_inputs["trajectory"],
                )
    answer = _prediction_string(prediction, "answer")
    findings_salvage: str | None = None
    format_repair_used = False
    repair_error: str | None = None
    if typed_findings is not None:
        # The typed SUBMIT path emits no findings_json marker to salvage and no
        # prose to repair; its only recovery is the bounded typed repair inside
        # _typed_prediction_to_findings, recorded under runtime.typedBlocks.
        findings = typed_findings
        runtime = {**runtime, "typedBlocks": typed_diagnostics}
    elif repair_diagnostics is not None:
        # A repair is not a finding: the engine-neutral finding schema caps
        # recommended_action at 2000 characters, below the scaffold's own action
        # budget, so a repair routed through it would be a smaller answer than
        # the one the contract asks for. The typed rows travel whole under
        # runtime.repair and `findings` stays empty rather than carrying a lossy
        # copy that a reader could mistake for the answer.
        findings = []
        runtime = {**runtime, "repair": repair_diagnostics}
    else:
        raw_findings_json = _prediction_string(prediction, "findings_json")
        findings = _parse_findings_json(raw_findings_json)
        # The recovered-answer placeholder is adapter output, not model text, so
        # it never feeds salvage and never earns a repair turn.
        answer_text = "" if answer == _SAFE_FIELD_DEFAULTS["answer"] else answer
        if not findings:
            for source_text in (raw_findings_json, answer_text):
                salvaged = _salvage_findings_json(source_text) if source_text else None
                if salvaged:
                    findings, findings_salvage = salvaged
                    break
        if not findings and findings_salvage is None and answer_text:
            # EXACTLY one repair turn on the same LM handle: the model re-emits
            # the strict array from its own answer. The call is visible in
            # modelCalls (counted below) and flagged in the runtime record.
            format_repair_used = True
            findings, repair_error = _repair_findings_turn(lm, answer_text)
    model_calls = _lm_history_length(lm) - history_before
    if model_calls < 0:
        raise RuntimeError("DSPy LM history shrank during trace analysis")

    trajectory = _prediction_field(prediction, "trajectory")
    if not isinstance(trajectory, list):
        raise ValueError("DSPy RLM prediction trajectory must be an array")
    _require_finite_json(trajectory, "DSPy RLM prediction trajectory")

    return {
        "answer": answer,
        "findings": findings,
        "trajectory": trajectory,
        "modelCalls": model_calls,
        "runtime": {
            **runtime,
            "findings_salvage": findings_salvage,
            "format_repair_used": format_repair_used,
            **({"format_repair_error": repair_error} if repair_error is not None else {}),
        },
    }


def _uses_codetrace_contract(instructions: str) -> bool:
    return _CODETRACE_TASK_TOKEN in instructions


def _task_kind(instructions: str) -> str:
    """Which signature the instructions ask for.

    A set of instructions that names both tokens describes two output contracts
    at once, which no single signature can satisfy, so it stops the run rather
    than silently answering one of them.
    """
    codetrace = _uses_codetrace_contract(instructions)
    repair = _REPAIR_TASK_TOKEN in instructions
    if codetrace and repair:
        raise ValueError(
            "analyst instructions name both the codetrace and the repair task token; "
            "one analysis answers one output contract"
        )
    if repair:
        return "repair"
    if codetrace:
        return "codetrace"
    return "generic"


def _build_signature_for(dspy: Any, task_kind: str) -> Any:
    if task_kind == "codetrace":
        return _build_codetrace_signature(dspy)
    if task_kind == "repair":
        return _build_repair_signature(dspy)
    return _build_signature(dspy)


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
                f"taskInputs.trajectory[{index}] must be an object, got "
                f"{type(entry).__name__}"
            )
        step_id = entry.get("step_id")
        # bool is an int subclass; True aliasing to step_id=1 must not pass.
        if not isinstance(step_id, int) or isinstance(step_id, bool):
            raise ValueError(
                f"taskInputs.trajectory[{index}].step_id must be an integer, got "
                f"{step_id!r}"
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
            dropped.append(
                {"index": index, "reason": f"exceeds the {_MAX_REPAIRS}-repair cap"}
            )
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


def _build_signature(dspy: Any) -> Any:
    return dspy.Signature(
        {
            "question": (
                str,
                dspy.InputField(desc="The trace-analysis question to answer."),
            ),
            "analyst_instructions": (
                str,
                dspy.InputField(desc="Task-specific investigation and reporting instructions."),
            ),
            "answer": (
                str,
                dspy.OutputField(desc="A concise, evidence-supported answer."),
            ),
            "findings_json": (
                str,
                dspy.OutputField(
                    desc="A strict JSON array of cited findings matching the required schema."
                ),
            ),
        },
        _TRACE_ANALYSIS_PROMPT,
    )


def _build_codetrace_signature(dspy: Any) -> Any:
    return dspy.Signature(
        {
            "question": (
                str,
                dspy.InputField(desc="The trace-analysis question to answer."),
            ),
            "analyst_instructions": (
                str,
                dspy.InputField(
                    desc=(
                        "Task-specific investigation policy. Its transport rules "
                        "(findings_json, subjects, URIs, excerpts) are superseded "
                        "by the typed blocks output."
                    )
                ),
            ),
            "trajectory": (
                list[dict[str, Any]],
                dspy.InputField(
                    desc=(
                        "Every span of the analyzed trajectory, in trace order: "
                        "{span_id, name, kind, status, status_message, attributes}. "
                        "Assistant actions are kind='LLM' spans with span_id='step-<n>'; "
                        "attributes.content carries the action. Long attribute values "
                        "may be truncated; use viewSpans for the untruncated span."
                    )
                ),
            ),
            "final_verification": (
                list[dict[str, Any]],
                dspy.InputField(
                    desc=(
                        "Spans of the trajectory's final verification. Evidence about "
                        "the final state only, never a rule for whether earlier steps "
                        "were incorrect. Empty when verification is unavailable."
                    )
                ),
            ),
            "answer": (
                str,
                dspy.OutputField(desc="A concise prose summary of the investigation."),
            ),
            "blocks": (
                list[IncorrectBlock],
                dspy.OutputField(
                    desc=(
                        "Every contiguous incorrect block found; [] for a clean "
                        f"trajectory. At most {_MAX_INCORRECT_BLOCKS} blocks. Every "
                        "step number must be the n of an existing assistant step-<n> span."
                    )
                ),
            ),
        },
        _CODETRACE_ANALYSIS_PROMPT,
    )


def _fetch_codetrace_environment() -> _CodetraceEnvironment:
    overview = getDatasetOverview()
    if not isinstance(overview, dict):
        raise RuntimeError("codetrace analysis dataset overview must be an object")
    total = overview.get("total_traces")
    if total != 1:
        raise RuntimeError(
            f"codetrace typed analysis requires exactly one trace, dataset has {total!r}"
        )
    sample = overview.get("sample_trace_ids")
    if not isinstance(sample, list) or not sample or not isinstance(sample[0], str):
        raise RuntimeError("codetrace analysis dataset overview names no trace id")
    trace_id = sample[0]

    view = viewTrace(trace_id)
    fetch_mode = "view-trace"
    spans: list[dict[str, Any]]
    if isinstance(view, dict) and isinstance(view.get("spans"), list):
        spans = [span for span in view["spans"] if isinstance(span, dict)]
    else:
        # The whole-trace projection exceeded the store's response budget, so
        # the assistant steps are probed by their deterministic step-<n> ids
        # and verification spans are located by content search.
        fetch_mode = "span-probe"
        spans = _probe_codetrace_spans(trace_id)

    step_spans: dict[int, dict[str, Any]] = {}
    final_verification: list[dict[str, Any]] = []
    for span in spans:
        span_id = span.get("span_id")
        if isinstance(span_id, str):
            match = _STEP_SPAN_ID.match(span_id)
            if match:
                step_spans.setdefault(int(match.group(1)), span)
        if _is_final_verification_span(span):
            final_verification.append(span)

    return _CodetraceEnvironment(
        trace_id=trace_id,
        spans=spans,
        step_spans=step_spans,
        final_verification=final_verification,
        fetch_mode=fetch_mode,
    )


def _is_final_verification_span(span: dict[str, Any]) -> bool:
    span_id = span.get("span_id")
    if isinstance(span_id, str) and span_id.startswith("benchmark-verification"):
        return True
    attributes = span.get("attributes")
    if isinstance(attributes, dict):
        role = attributes.get("benchmark.evidence.role")
        if isinstance(role, str) and role.startswith("final-verification"):
            return True
    return False


def _probe_codetrace_spans(trace_id: str) -> list[dict[str, Any]]:
    spans: list[dict[str, Any]] = []
    start = 1
    while start <= _MAX_PROBED_STEPS:
        page_ids = [f"step-{n}" for n in range(start, start + _VIEW_SPANS_PAGE_SIZE)]
        found, missing = _view_spans_paged(trace_id, page_ids)
        spans.extend(found)
        if len(missing) == len(page_ids):
            break
        start += _VIEW_SPANS_PAGE_SIZE
    spans.extend(_search_verification_spans(trace_id))
    if not spans:
        raise RuntimeError(
            f"codetrace typed analysis found no step-<n> spans in trace '{trace_id}'"
        )
    return spans


def _search_verification_spans(trace_id: str) -> list[dict[str, Any]]:
    # Verification span ids are content-addressed, so an oversized trace needs
    # a search to name them. A trajectory without verification is a valid task
    # state the prompt already covers, so absence is data, not an error.
    try:
        result = searchTrace(trace_id, "final-verification", 50)
    except (RuntimeError, ValueError, httpx.HTTPError):
        return []
    if not isinstance(result, dict) or not isinstance(result.get("hits"), list):
        return []
    span_ids = {
        hit["span_id"]
        for hit in result["hits"]
        if isinstance(hit, dict) and isinstance(hit.get("span_id"), str)
    }
    if not span_ids:
        return []
    found, _missing = _view_spans_paged(trace_id, sorted(span_ids))
    return found


def _view_spans_paged(
    trace_id: str,
    span_ids: list[str],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Read spans by id, re-requesting ids omitted for the response byte budget."""

    spans: list[dict[str, Any]] = []
    seen: set[str] = set()
    missing: list[str] = []
    unique = list(dict.fromkeys(span_ids))
    for offset in range(0, len(unique), _VIEW_SPANS_PAGE_SIZE):
        pending = unique[offset : offset + _VIEW_SPANS_PAGE_SIZE]
        while pending:
            result = viewSpans(trace_id, pending)
            if not isinstance(result, dict) or not isinstance(result.get("spans"), list):
                raise RuntimeError("viewSpans returned an invalid result for codetrace analysis")
            for span in result["spans"]:
                if isinstance(span, dict) and isinstance(span.get("span_id"), str):
                    if span["span_id"] not in seen:
                        seen.add(span["span_id"])
                        spans.append(span)
            for span_id in result.get("missing_span_ids", []):
                if isinstance(span_id, str):
                    missing.append(span_id)
            omitted = [
                span_id
                for span_id in result.get("omitted_span_ids", [])
                if isinstance(span_id, str) and span_id not in seen
            ]
            if omitted and len(omitted) >= len(pending):
                raise RuntimeError(
                    f"trace '{trace_id}' cannot project spans within the store budget: "
                    + ", ".join(omitted)
                )
            pending = omitted
    return spans, missing


def _typed_prediction_to_findings(
    prediction: Any,
    environment: _CodetraceEnvironment,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    raw_blocks = _prediction_field(prediction, "blocks")
    blocks, repair, dropped, reported = _coerce_typed_blocks(raw_blocks)

    kept: list[IncorrectBlock] = []
    for index, block in enumerate(blocks):
        if len(kept) >= _MAX_INCORRECT_BLOCKS:
            dropped.append(
                {
                    "index": index,
                    "reason": f"exceeds the {_MAX_INCORRECT_BLOCKS}-block cap",
                }
            )
            continue
        reason = _block_environment_defect(block, environment)
        if reason is not None:
            dropped.append({"index": index, "reason": reason})
            continue
        kept.append(block)

    findings = _build_block_findings(kept, environment, dropped)
    diagnostics = {
        "signature": _CODETRACE_SIGNATURE_VERSION,
        "reported": reported,
        "kept": len(findings),
        "dropped": dropped,
        "repair": repair,
        "environment": {
            "traceId": environment.trace_id,
            "fetch": environment.fetch_mode,
            "spanCount": len(environment.spans),
            "stepCount": len(environment.step_spans),
            "verificationSpanCount": len(environment.final_verification),
        },
    }
    return findings, diagnostics


def _coerce_typed_blocks(
    raw_blocks: Any,
) -> tuple[list[IncorrectBlock], str | None, list[dict[str, Any]], int]:
    repair: str | None = None
    if isinstance(raw_blocks, str):
        # The max-iterations extract fallback under a marker-tolerant adapter
        # can hand the typed field back as text. One bounded structured-repair
        # attempt runs here; an unparseable value fails loudly because the
        # investigation's answer text exists — a silent [] would erase it.
        parsed = _extract_json_array(raw_blocks)
        if parsed is None:
            raise RuntimeError(
                "DSPy RLM typed blocks output is not a JSON array after one repair "
                f"attempt: {' '.join(raw_blocks.split())[:200]!r}"
            )
        repair = "parsed-blocks-from-string"
        raw_blocks = parsed
    if not isinstance(raw_blocks, list):
        raise RuntimeError(
            f"DSPy RLM typed blocks output must be an array, got {type(raw_blocks).__name__}"
        )
    blocks: list[IncorrectBlock] = []
    dropped: list[dict[str, Any]] = []
    for index, entry in enumerate(raw_blocks):
        if isinstance(entry, IncorrectBlock):
            blocks.append(entry)
            continue
        try:
            blocks.append(IncorrectBlock.model_validate(entry))
        except pydantic.ValidationError as error:
            dropped.append(
                {
                    "index": index,
                    "reason": " ".join(str(error).split())[:300],
                }
            )
    return blocks, repair, dropped, len(raw_blocks)


def _block_environment_defect(
    block: IncorrectBlock,
    environment: _CodetraceEnvironment,
) -> str | None:
    for label, step in (
        ("first_step", block.first_step),
        ("last_step", block.last_step),
        ("consequence_step", block.consequence_step),
    ):
        span = environment.step_spans.get(step)
        if span is None:
            return f"{label} step-{step} does not exist in the trajectory"
        if span.get("kind") != "LLM":
            return (
                f"{label} step-{step} is {span.get('kind')!r}, not an assistant LLM span"
            )
    return None


def _build_block_findings(
    blocks: list[IncorrectBlock],
    environment: _CodetraceEnvironment,
    dropped: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    cited_steps = sorted({step for block in blocks for step in (block.first_step, block.last_step)})
    excerpts = _fetch_step_excerpts(environment.trace_id, cited_steps)

    findings: list[dict[str, Any]] = []
    for index, block in enumerate(blocks):
        evidence: list[dict[str, Any]] = []
        defect: str | None = None
        for step in dict.fromkeys((block.first_step, block.last_step)):
            excerpt = excerpts.get(step)
            if excerpt is None:
                defect = f"step-{step} carries no quotable action content"
                break
            evidence.append(
                {
                    "uri": _trace_span_uri(environment.trace_id, step),
                    "excerpt": excerpt,
                }
            )
        if defect is not None:
            dropped.append({"index": index, "reason": defect})
            continue
        finding = {
            "severity": block.severity,
            "claim": block.claim,
            "subject": (
                f"incorrect-steps-{block.first_step}-{block.last_step}"
                f"-{block.escape_status}-consequence-{block.consequence_step}"
            ),
            "confidence": block.confidence,
            "evidence": evidence,
        }
        if block.rationale is not None and block.rationale.strip():
            finding["rationale"] = block.rationale
        # Invariant check on code-built output: a violation is a bridge bug and
        # must crash, not flow downstream as model noise.
        findings.append(_validate_finding(finding, index))
    return findings


def _fetch_step_excerpts(trace_id: str, steps: list[int]) -> dict[int, str]:
    # Excerpts must be exact substrings of the span content the TypeScript
    # evidence gates re-read through the same store projection, so they are
    # sliced from a fresh viewSpans read, never from the discovery-grade
    # (more aggressively truncated) whole-trace projection.
    if not steps:
        return {}
    spans, _missing = _view_spans_paged(trace_id, [f"step-{step}" for step in steps])
    excerpts: dict[int, str] = {}
    for span in spans:
        match = _STEP_SPAN_ID.match(span.get("span_id", ""))
        if not match:
            continue
        attributes = span.get("attributes")
        content = attributes.get("content") if isinstance(attributes, dict) else None
        if not isinstance(content, str):
            continue
        quotable = content.strip()
        if len(quotable) < _MINIMUM_QUOTABLE_CONTENT_CHARACTERS:
            continue
        excerpts[int(match.group(1))] = quotable[:_EXCERPT_CHARACTERS]
    return excerpts


def _trace_span_uri(trace_id: str, step: int) -> str:
    return f"trace://{quote(trace_id, safe='')}/span/step-{step}"


def _build_dspy_tools(dspy: Any, tool_specs: list[dict[str, Any]]) -> list[Any]:
    tools = []
    for spec in tool_specs:
        properties = spec["parameters"]["properties"]
        tools.append(
            dspy.Tool(
                _TRACE_TOOL_FUNCTIONS[spec["name"]],
                name=spec["name"],
                desc=spec["description"],
                args=properties,
            )
        )
    return tools


@contextmanager
def _probed_interpreter(dspy: Any) -> Any:
    with tempfile.TemporaryDirectory(prefix="agent-eval-dspy-rlm-") as import_map_dir:
        import_map_path = Path(import_map_dir) / "import-map.json"
        import_map_path.write_text(json.dumps(_PYODIDE_IMPORT_MAP), encoding="utf-8")
        deno_command = _build_deno_command(dspy, import_map_path)
        yield from _run_probed_interpreter(dspy, deno_command)


def _run_probed_interpreter(dspy: Any, deno_command: list[str]) -> Any:
    interpreter = dspy.PythonInterpreter(deno_command=deno_command)
    try:
        try:
            probe_output = interpreter.execute("print(1+1)")
        except Exception as error:
            raise RuntimeError(
                "DSPy RLM sandbox startup probe failed before any model call"
            ) from error
        if not isinstance(probe_output, str) or probe_output.strip() != "2":
            raise RuntimeError(
                "DSPy RLM sandbox startup probe returned "
                f"{probe_output!r}, expected '2', before any model call"
            )
        yield interpreter, deno_command
    finally:
        interpreter.shutdown()


# DSPy's runner.js imports npm:pyodide without a version, and --no-config means
# no lockfile: a cold cache would execute whatever npm dist-tags.latest points
# at. The import map pins the interpreter the sandbox runs; transitive npm
# ranges below this root are the residual unpinned surface.
_PYODIDE_VERSION = "314.0.3"
_PYODIDE_IMPORT_MAP = {
    "imports": {"npm:pyodide/pyodide.js": f"npm:pyodide@{_PYODIDE_VERSION}/pyodide.js"}
}


def _build_deno_command(dspy: Any, import_map_path: Path) -> list[str]:
    deno_executable = _find_deno_executable()
    runner_path = _dspy_runner_path(dspy)
    deno_cache_dir = _deno_cache_dir(deno_executable)
    for label, path in (("DSPy runner", runner_path), ("Deno cache", deno_cache_dir)):
        if "," in str(path):
            raise RuntimeError(f"{label} path cannot contain a comma: {path}")
    return [
        str(deno_executable),
        "run",
        "--no-config",
        f"--import-map={import_map_path}",
        "--node-modules-dir=none",
        f"--allow-read={runner_path},{deno_cache_dir}",
        str(runner_path),
    ]


def _find_deno_executable() -> Path:
    executable_name = "deno.exe" if os.name == "nt" else "deno"
    beside_python = Path(sys.executable).parent / executable_name
    if beside_python.is_file() and os.access(beside_python, os.X_OK):
        return beside_python.resolve()

    from_path = shutil.which(executable_name)
    if from_path is not None:
        return Path(from_path).resolve()

    try:
        from deno import find_deno_bin

        packaged = Path(find_deno_bin())
    except (FileNotFoundError, ImportError) as error:
        raise RuntimeError(
            "DSPy RLM requires the deno==2.7.14 executable beside the Python interpreter"
        ) from error
    if not packaged.is_file() or not os.access(packaged, os.X_OK):
        raise RuntimeError(f"DSPy RLM Deno executable is not executable: {packaged}")
    return packaged.resolve()


def _dspy_runner_path(dspy: Any) -> Path:
    runner_path = Path(inspect.getfile(dspy.PythonInterpreter)).with_name("runner.js")
    if not runner_path.is_file():
        raise RuntimeError(f"DSPy PythonInterpreter runner is unavailable: {runner_path}")
    return runner_path.resolve()


def _deno_cache_dir(deno_executable: Path) -> Path:
    configured = os.environ.get("DENO_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    try:
        completed = subprocess.run(
            [str(deno_executable), "info", "--json", "--no-config"],
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("DSPy RLM could not inspect the Deno cache directory") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or f"exit code {completed.returncode}"
        raise RuntimeError(f"DSPy RLM could not inspect the Deno cache directory: {detail}")
    try:
        info = json.loads(completed.stdout, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("Deno info returned invalid JSON") from error
    deno_dir = info.get("denoDir") if isinstance(info, dict) else None
    if not isinstance(deno_dir, str) or not deno_dir.strip():
        raise RuntimeError("Deno info did not report denoDir")
    return Path(deno_dir).expanduser().resolve()


@contextmanager
def _tool_callback(url: str, token: str, timeout_seconds: float) -> Any:
    reset_token = _ACTIVE_TOOL_CALLBACK.set(
        _ToolCallback(url=url, token=token, timeout_seconds=timeout_seconds)
    )
    try:
        yield
    finally:
        _ACTIVE_TOOL_CALLBACK.reset(reset_token)


def _call_trace_tool(name: str, args: dict[str, Any]) -> Any:
    callback = _ACTIVE_TOOL_CALLBACK.get()
    if callback is None:
        raise RuntimeError(f"{name} called outside an active DSPy RLM analysis")
    response = httpx.post(
        callback.url,
        headers={"Authorization": f"Bearer {callback.token}"},
        json={"name": name, "args": args},
        timeout=callback.timeout_seconds,
    )
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as error:
        raise ValueError(f"trace tool callback returned invalid JSON for {name}") from error
    if not isinstance(payload, dict) or set(payload) != {"result"}:
        raise ValueError(f"trace tool callback returned an invalid envelope for {name}")
    result = payload["result"]
    _require_finite_json(result, f"trace tool callback result for {name}")
    return result


def _validate_analyze_input(value: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(
        value,
        {
            "operation",
            "question",
            "instructions",
            "modelProxy",
            "toolCallback",
            "limits",
            "toolSpecs",
            "controlAdapter",
        },
        "analyze input",
        optional={"taskInputs"},
    )
    if "taskInputs" in value:
        task_inputs = _require_object(value["taskInputs"], "taskInputs")
        _require_finite_json(task_inputs, "taskInputs")
    if value["controlAdapter"] not in ("chat", "two-step", "tolerant"):
        raise ValueError("analyze input controlAdapter must be 'chat', 'two-step', or 'tolerant'")
    if value["operation"] != "analyze":
        raise ValueError("analyze input operation must be analyze")
    _require_non_empty_string(value["question"], "question")
    _require_non_empty_string(value["instructions"], "instructions")

    model_proxy = _require_object(value["modelProxy"], "modelProxy")
    _require_exact_keys(
        model_proxy,
        {"baseUrl", "apiKey", "model", "maxOutputTokens"},
        "modelProxy",
    )
    _require_http_url(model_proxy["baseUrl"], "modelProxy.baseUrl")
    _require_non_empty_string(model_proxy["apiKey"], "modelProxy.apiKey")
    _require_non_empty_string(model_proxy["model"], "modelProxy.model")
    _require_positive_integer(model_proxy["maxOutputTokens"], "modelProxy.maxOutputTokens")

    callback = _require_object(value["toolCallback"], "toolCallback")
    _require_exact_keys(callback, {"url", "token", "timeoutMs"}, "toolCallback")
    _require_http_url(callback["url"], "toolCallback.url")
    _require_non_empty_string(callback["token"], "toolCallback.token")
    _require_positive_integer(callback["timeoutMs"], "toolCallback.timeoutMs")

    limits = _require_object(value["limits"], "limits")
    _require_exact_keys(
        limits,
        {"maxIterations", "maxLlmCalls", "maxOutputChars"},
        "limits",
    )
    for key in ("maxIterations", "maxLlmCalls", "maxOutputChars"):
        _require_positive_integer(limits[key], f"limits.{key}")

    tool_specs = value["toolSpecs"]
    if not isinstance(tool_specs, list):
        raise ValueError("toolSpecs must be an array")
    seen: set[str] = set()
    for index, raw_spec in enumerate(tool_specs):
        spec = _require_object(raw_spec, f"toolSpecs[{index}]")
        _require_exact_keys(
            spec,
            {"name", "description", "parameters"},
            f"toolSpecs[{index}]",
        )
        name = _require_non_empty_string(spec["name"], f"toolSpecs[{index}].name")
        if name not in _TRACE_TOOL_FUNCTIONS:
            raise ValueError(f"toolSpecs[{index}].name is not a supported trace tool")
        if name in seen:
            raise ValueError(f"toolSpecs contains duplicate tool {name}")
        seen.add(name)
        _require_non_empty_string(
            spec["description"],
            f"toolSpecs[{index}].description",
        )
        parameters = _require_object(
            spec["parameters"],
            f"toolSpecs[{index}].parameters",
        )
        if parameters.get("type") != "object":
            raise ValueError(f"toolSpecs[{index}].parameters.type must be object")
        properties = parameters.get("properties")
        if not isinstance(properties, dict):
            raise ValueError(f"toolSpecs[{index}].parameters.properties must be an object")
        if set(properties) != _TRACE_TOOL_ARGUMENTS[name]:
            raise ValueError(f"toolSpecs[{index}].parameters.properties do not match {name}")
        required = parameters.get("required", [])
        if (
            not isinstance(required, list)
            or not all(isinstance(item, str) for item in required)
            or len(set(required)) != len(required)
        ):
            raise ValueError(f"toolSpecs[{index}].parameters.required must be unique strings")
        if set(required) != _TRACE_TOOL_REQUIRED_ARGUMENTS[name]:
            raise ValueError(f"toolSpecs[{index}].parameters.required do not match {name}")
        _require_finite_json(parameters, f"toolSpecs[{index}].parameters")
    return value


def _parse_findings_json(value: str) -> list[dict[str, Any]]:
    # findings_json is model output. A model that wraps the array in a fenced
    # block or leaves prose around it should not void a completed investigation,
    # so the array is extracted before parsing. A genuinely absent array means
    # "no citable finding", which is a valid empty result, not a crash. Each
    # surviving row is still validated strictly.
    return _validated_rows(_extract_json_array(value))


def _validated_rows(parsed: list[Any] | None) -> list[dict[str, Any]]:
    if parsed is None:
        return []
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(parsed):
        # One malformed finding row is dropped, not fatal: the TypeScript
        # boundary re-validates every surviving row, so nothing invalid reaches
        # the score, and a completed investigation keeps its usable findings.
        try:
            rows.append(_validate_finding(row, index))
        except ValueError:
            continue
    return rows


# The findings_json marker family with damaged brackets — a truncated final
# turn emits shapes like "[[ ## findings_json ## ]" followed by valid JSON.
_FINDINGS_MARKER_FAMILY = re.compile(r"\[{0,2} *## *findings_json *## *\]{0,2}")


def _salvage_findings_json(text: str) -> tuple[list[dict[str, Any]], str] | None:
    """Deterministically recover a findings array the strict parse missed.

    Tries, in order: JSON after the LAST findings_json marker (well-formed or
    bracket-damaged), then the LAST well-formed JSON array whose elements all
    look like findings (carry claim + evidence). Every recovered row still
    passes the strict per-row validation; nothing is invented. Returns None
    when no citable array exists — an empty result stays empty.
    """

    stripped = text.strip()
    if not stripped:
        return None
    markers = list(_FINDINGS_MARKER_FAMILY.finditer(stripped))
    if markers:
        rows = _validated_rows(_extract_json_array(stripped[markers[-1].end() :]))
        if rows:
            return rows, "malformed-marker"
    rows = _validated_rows(_last_findings_array(stripped))
    if rows:
        return rows, "trailing-json-array"
    return None


def _last_findings_array(text: str) -> list[Any] | None:
    decoder = json.JSONDecoder()
    search_end = len(text)
    while True:
        start = text.rfind("[", 0, search_end)
        if start == -1:
            return None
        search_end = start
        try:
            candidate, _ = decoder.raw_decode(text, start)
        except ValueError:
            continue
        if (
            isinstance(candidate, list)
            and candidate
            and all(_looks_like_finding(row) for row in candidate)
        ):
            return candidate


def _looks_like_finding(row: Any) -> bool:
    return isinstance(row, dict) and "claim" in row and "evidence" in row


_FINDINGS_REPAIR_PROMPT = """Your previous trace-analysis answer is below.
Re-emit ONLY the strict findings_json JSON array for that answer: no prose, no Markdown fences, no field markers.
Each element must contain only severity, claim, optional subject, confidence, optional rationale, optional recommended_action, and evidence (a non-empty array of objects with uri and optional excerpt).
Use only identifiers and quotes already present in the answer; never invent evidence.
Return [] if the answer reports no incorrect steps.

ANSWER:
"""


def _repair_findings_turn(lm: Any, answer_text: str) -> tuple[list[dict[str, Any]], str | None]:
    # A repair failure must not void the already-completed investigation: the
    # error is returned for the runtime record instead of being raised, and the
    # findings stay empty.
    try:
        completions = lm(
            messages=[{"role": "user", "content": f"{_FINDINGS_REPAIR_PROMPT}{answer_text}"}]
        )
    except Exception as error:  # noqa: BLE001 — recorded in runtime, never silent
        summary = " ".join(str(error).split())[:200]
        return [], f"{type(error).__name__}: {summary}"
    completion = completions[0] if isinstance(completions, list) and completions else completions
    if not isinstance(completion, str):
        return [], f"repair completion has unexpected type {type(completion).__name__}"
    return _validated_rows(_extract_json_array(completion)), None


def _extract_json_array(value: str) -> list[Any] | None:
    text = value.strip()
    fence = _CODE_FENCE.search(text)
    if fence:
        text = fence.group(1).strip()
    for candidate in (text, _first_bracketed_array(text)):
        if candidate is None:
            continue
        try:
            parsed = json.loads(candidate, parse_constant=_reject_json_constant)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, list):
            return parsed
    return None


def _first_bracketed_array(text: str) -> str | None:
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end <= start:
        return None
    return text[start : end + 1]


def _validate_finding(value: Any, index: int) -> dict[str, Any]:
    finding = _require_object(value, f"findings[{index}]")
    keys = set(finding)
    if not _REQUIRED_FINDING_KEYS <= keys or not keys <= _FINDING_KEYS:
        raise ValueError(f"findings[{index}] has missing or unknown fields")
    if finding["severity"] not in _SEVERITIES:
        raise ValueError(f"findings[{index}].severity is invalid")
    _require_bounded_string(finding["claim"], f"findings[{index}].claim", 2_000)
    if "subject" in finding:
        _require_bounded_string(finding["subject"], f"findings[{index}].subject", 400)
    confidence = finding["confidence"]
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not math.isfinite(confidence)
        or confidence < 0
        or confidence > 1
    ):
        raise ValueError(f"findings[{index}].confidence must be a finite number from 0 to 1")
    for key, maximum in (("rationale", 4_000), ("recommended_action", 2_000)):
        if key in finding:
            _require_optional_bounded_string(
                finding[key],
                f"findings[{index}].{key}",
                maximum,
            )
    evidence = finding["evidence"]
    if not isinstance(evidence, list) or not evidence:
        raise ValueError(f"findings[{index}].evidence must be a non-empty array")
    for evidence_index, raw_evidence in enumerate(evidence):
        item = _require_object(
            raw_evidence,
            f"findings[{index}].evidence[{evidence_index}]",
        )
        if set(item) not in ({"uri"}, _EVIDENCE_KEYS):
            raise ValueError(
                f"findings[{index}].evidence[{evidence_index}] has missing or unknown fields"
            )
        _require_bounded_string(
            item["uri"],
            f"findings[{index}].evidence[{evidence_index}].uri",
            2_000,
        )
        if "excerpt" in item:
            _require_optional_bounded_string(
                item["excerpt"],
                f"findings[{index}].evidence[{evidence_index}].excerpt",
                2_000,
            )
    return finding


def _runtime_identity(deno_command: list[str]) -> dict[str, Any]:
    # The sandbox record is derived from the command that actually ran, so a
    # permission or config regression shows up in every run record instead of
    # being masked by a constant. Scoped paths are machine-specific and are
    # recorded as counts, never as raw paths, to keep run records shareable.
    return {
        "engine": "dspy-rlm",
        "packages": {
            "agent-eval-rpc": _package_version("agent-eval-rpc"),
            "dspy": _package_version("dspy"),
            "deno": _package_version("deno"),
            "pyodide": _PYODIDE_VERSION,
        },
        "python": {
            "implementation": sys_implementation_name(),
            "version": platform.python_version(),
        },
        "bridge": {
            "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
        "sandbox": {
            # The startup probe already raised unless it returned exactly "2".
            "probeOutput": "2",
            "runtime": "deno-pyodide",
            **_sandbox_attestation(deno_command),
        },
    }


def _sandbox_attestation(deno_command: list[str]) -> dict[str, Any]:
    options = [part for part in deno_command[1:] if part.startswith("-")]
    permissions: dict[str, Any] = {}
    for part in options:
        if part in ("-A", "--allow-all"):
            permissions["allow-all"] = {"scoped": False}
            continue
        if part.startswith("--allow-"):
            name, _, value = part.partition("=")
            scope_entries = [entry for entry in value.split(",") if entry] if value else []
            permissions[name.removeprefix("--")] = (
                {"scoped": True, "paths": len(scope_entries)}
                if scope_entries
                else {"scoped": False}
            )
    node_modules_dir = next(
        (part.partition("=")[2] for part in options if part.startswith("--node-modules-dir")),
        "default",
    )
    return {
        "config": "none" if "--no-config" in options else "discovered",
        "nodeModulesDir": node_modules_dir or "default",
        "permissions": permissions,
    }


def sys_implementation_name() -> str:
    return platform.python_implementation().lower()


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError as error:
        raise RuntimeError(
            f"{name} is required for the DSPy RLM bridge; install agent-eval-rpc[dspy]"
        ) from error


def _load_dspy() -> Any:
    try:
        import dspy
    except ImportError as error:
        raise RuntimeError(
            "DSPy is required for this bridge; install agent-eval-rpc[dspy]"
        ) from error
    return dspy


def _control_adapter(dspy: Any, lm: Any, kind: str) -> Any:
    if kind == "chat":
        return dspy.ChatAdapter()
    if kind == "two-step":
        return dspy.TwoStepAdapter(lm)
    if kind == "tolerant":
        return _tolerant_adapter(dspy)
    raise ValueError(f"unsupported control adapter '{kind}'")


def _tolerant_adapter(dspy: Any) -> Any:
    """ChatAdapter that always yields the declared output fields.

    Strict marker parsing runs first, so a marker-following model is unchanged.
    When it fails, every declared field is recovered from natural output — a
    `[[ ## field ## ]]` section that is present, a matching JSON key, the fenced
    block for `code`, otherwise a per-field safe default — so no completion
    shape crashes the recursive loop. The defaults are chosen so recovery can
    never invent a finding: `code`/`findings_json` fall back to a no-op, and a
    missing answer is named as such rather than fabricated.
    """

    class TolerantControlAdapter(dspy.ChatAdapter):
        def __init__(self) -> None:
            # The strict fallback retries the whole call through JSONAdapter,
            # which doubles spend and hides the first error; recovery here is
            # deterministic, so that fallback stays off.
            super().__init__(use_json_adapter_fallback=False)

        def parse(self, signature: Any, completion: Any) -> dict[str, Any]:
            try:
                return super().parse(signature, completion)
            except Exception:
                # Recovery must never raise: a control turn always yields the
                # declared fields, so an empty or malformed completion becomes
                # a safe no-op turn instead of aborting a paid investigation.
                text = completion if isinstance(completion, str) else str(completion or "")
                return _recover_control_fields(text, list(signature.output_fields.keys()))

    return TolerantControlAdapter()


_CODE_FENCE = re.compile(r"```(?:[A-Za-z0-9_+-]*)\n(.*?)```", re.DOTALL)
_FIELD_HEADER = re.compile(r"\[\[ ## (\w+) ## \]\]")

# Missing a field must never fabricate an action or a finding. Empty code is a
# no-op REPL turn; an empty findings array is a valid "nothing citable" result.
_SAFE_FIELD_DEFAULTS = {
    "code": "",
    "findings_json": "[]",
    "answer": "(no answer was produced from the trace investigation)",
    "reasoning": "(no stated reasoning)",
}


def _recover_control_fields(completion: str, output_fields: list[str]) -> dict[str, Any]:
    text = completion.strip()
    parsed_json = _parse_json_object(text)
    sections = _marker_sections(text)
    blocks = [block.strip() for block in _CODE_FENCE.findall(text) if block.strip()]
    prose = _CODE_FENCE.sub(" ", _FIELD_HEADER.sub(" ", text)).strip()

    recovered: dict[str, Any] = {}
    for name in output_fields:
        if parsed_json is not None and name in parsed_json:
            recovered[name] = parsed_json[name]
        elif name in sections:
            recovered[name] = sections[name]
        elif name == "code" and blocks:
            recovered[name] = "\n\n".join(blocks)
        elif name in ("answer", "reasoning") and prose:
            recovered[name] = prose
        else:
            recovered[name] = _SAFE_FIELD_DEFAULTS.get(name, "")
    return recovered


def _marker_sections(text: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    current: str | None = None
    buffer: list[str] = []
    for line in text.splitlines():
        header = _FIELD_HEADER.match(line.strip())
        if header:
            if current is not None:
                sections[current] = "\n".join(buffer).strip()
            current = header.group(1)
            buffer = []
        elif current is not None:
            buffer.append(line)
    if current is not None:
        sections[current] = "\n".join(buffer).strip()
    return {name: value for name, value in sections.items() if value and name != "completed"}


def _parse_json_object(text: str) -> dict[str, Any] | None:
    candidate = text
    fence = _CODE_FENCE.search(text)
    if fence:
        candidate = fence.group(1)
    try:
        value = json.loads(candidate)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _lm_history_length(lm: Any) -> int:
    history = getattr(lm, "history", None)
    if not isinstance(history, list):
        raise RuntimeError("DSPy LM does not expose model-call history")
    return len(history)


def _prediction_field(prediction: Any, name: str) -> Any:
    if isinstance(prediction, Mapping) and name in prediction:
        return prediction[name]
    if hasattr(prediction, name):
        return getattr(prediction, name)
    raise ValueError(f"DSPy RLM prediction is missing {name}")


def _prediction_string(prediction: Any, name: str) -> str:
    value = _prediction_field(prediction, name)
    # Model output: surrounding whitespace is presentation, not a data-integrity
    # defect, and this runs after every model call is already paid for.
    if isinstance(value, str):
        value = value.strip()
    return _require_non_empty_string(value, f"DSPy RLM prediction {name}")


def _read_json(path: Path, max_input_bytes: int) -> dict[str, Any]:
    if path.stat().st_size > max_input_bytes:
        raise ValueError(f"DSPy RLM bridge input exceeds {max_input_bytes} bytes")
    raw = path.read_bytes()
    if len(raw) > max_input_bytes:
        raise ValueError(f"DSPy RLM bridge input exceeds {max_input_bytes} bytes")
    try:
        value = json.loads(raw, parse_constant=_reject_json_constant)
    except json.JSONDecodeError as error:
        raise ValueError("DSPy RLM bridge input must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("DSPy RLM bridge input must be a JSON object")
    return value


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"non-finite JSON constant {value} is not allowed")


def _require_exact_keys(
    value: Mapping[str, Any],
    expected: set[str],
    label: str,
    optional: set[str] | None = None,
) -> None:
    present = set(value)
    allowed = expected | (optional or set())
    if not expected <= present or not present <= allowed:
        detail = f"exactly {sorted(expected)}"
        if optional:
            detail = f"{detail} and may contain {sorted(optional)}"
        raise ValueError(f"{label} must contain {detail}")


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError(f"{label} must be a non-empty trimmed string")
    return value


def _require_bounded_string(value: Any, label: str, maximum: int) -> str:
    result = _require_non_empty_string(value, label)
    if len(result) > maximum:
        raise ValueError(f"{label} exceeds {maximum} characters")
    return result


def _require_optional_bounded_string(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    if len(value) > maximum:
        raise ValueError(f"{label} exceeds {maximum} characters")
    return value


def _require_positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _require_http_url(value: Any, label: str) -> str:
    result = _require_non_empty_string(value, label)
    parsed = urlparse(result)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{label} must not contain credentials")
    return result


def _require_finite_json(value: Any, label: str) -> None:
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be finite JSON") from error


def _without_none(**values: Any) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


if __name__ == "__main__":
    main()
