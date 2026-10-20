"""Run an official DSPy RLM against trace tools owned by the Node process."""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

# Preserve the original bridge import surface while each responsibility has one owner.
from agent_eval_rpc.dspy_rlm_codetrace import (  # noqa: F401
    _CODETRACE_ANALYSIS_PROMPT,
    _CODETRACE_SIGNATURE_VERSION,
    _CODETRACE_TASK_TOKEN,
    _EXCERPT_CHARACTERS,
    _MAX_INCORRECT_BLOCK_STEPS,
    _MAX_INCORRECT_BLOCKS,
    _MAX_PROBED_STEPS,
    _MINIMUM_QUOTABLE_CONTENT_CHARACTERS,
    _STEP_SPAN_ID,
    _VIEW_SPANS_PAGE_SIZE,
    IncorrectBlock,
    _block_environment_defect,
    _build_block_findings,
    _build_codetrace_signature,
    _CodetraceEnvironment,
    _coerce_typed_blocks,
    _fetch_codetrace_environment,
    _fetch_step_excerpts,
    _is_final_verification_span,
    _probe_codetrace_spans,
    _search_verification_spans,
    _trace_span_uri,
    _typed_prediction_to_findings,
    _view_spans_paged,
)
from agent_eval_rpc.dspy_rlm_output import (  # noqa: F401
    _CODE_FENCE,
    _CODETRACE_FINDINGS_REPAIR_PROMPT,
    _FIELD_HEADER,
    _FINDINGS_MARKER_FAMILY,
    _FINDINGS_REPAIR_PROMPT,
    _FINDINGS_REPAIR_SHAPE,
    _SAFE_FIELD_DEFAULTS,
    _accepted_rows,
    _control_adapter,
    _extract_json_array,
    _first_bracketed_array,
    _last_findings_array,
    _lm_history_length,
    _looks_like_finding,
    _marker_sections,
    _parse_findings_json,
    _parse_json_object,
    _prediction_field,
    _prediction_string,
    _recover_control_fields,
    _repair_findings_turn,
    _salvage_findings_json,
    _tolerant_adapter,
    decode_raw_finding_array_or_empty,
)
from agent_eval_rpc.dspy_rlm_repair import (  # noqa: F401
    _MAX_REPAIRS,
    _REPAIR_ACTION_MAX_BYTES,
    _REPAIR_ANALYSIS_PROMPT,
    _REPAIR_SIGNATURE_VERSION,
    _REPAIR_TASK_TOKEN,
    RepairProposal,
    _build_repair_signature,
    _coerce_typed_repairs,
    _typed_prediction_to_repairs,
    _validate_repair_trajectory,
)
from agent_eval_rpc.dspy_rlm_sandbox import (  # noqa: F401
    _PYODIDE_IMPORT_MAP,
    _PYODIDE_VERSION,
    _build_deno_command,
    _deno_cache_dir,
    _dspy_runner_path,
    _find_deno_executable,
    _probed_interpreter,
    _run_probed_interpreter,
    _sandbox_attestation,
)
from agent_eval_rpc.dspy_rlm_tools import (  # noqa: F401
    _ACTIVE_TOOL_CALLBACK,
    _TRACE_TOOL_ARGUMENTS,
    _TRACE_TOOL_FUNCTIONS,
    _TRACE_TOOL_REQUIRED_ARGUMENTS,
    _build_dspy_tools,
    _call_trace_tool,
    _tool_callback,
    _ToolCallback,
    _without_none,
    countTraces,
    getDatasetOverview,
    queryTraces,
    readSpanSource,
    searchSpan,
    searchTrace,
    viewSpans,
    viewTrace,
)
from agent_eval_rpc.dspy_rlm_validation import (  # noqa: F401
    _read_json,
    _reject_json_constant,
    _require_exact_keys,
    _require_finite_json,
    _require_http_url,
    _require_non_empty_string,
    _require_object,
    _require_positive_integer,
)
from agent_eval_rpc.finding_codec import RejectedFindingRow, describe_rejected_rows
from agent_eval_rpc.optimizer_bridge_common import atomic_write_json

_DEFAULT_MAX_INPUT_BYTES = 4 * 1024 * 1024


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
        if not isinstance(task_inputs, dict) or not isinstance(task_inputs.get("trajectory"), list):
            raise ValueError(
                "the repair task requires taskInputs.trajectory, the recorded steps the "
                "program reads; the analyst never fetches them from a trace store"
            )
        _validate_repair_trajectory(task_inputs["trajectory"])
        statement = task_inputs.get("taskStatement", "")
        if not isinstance(statement, str):
            raise ValueError(
                f"taskInputs.taskStatement must be a string, got {type(statement).__name__}"
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

        def interpreter_factory() -> Any:
            return interpreter

        interpreter_factory.execution_instructions = getattr(
            dspy.PythonInterpreter, "execution_instructions", ""
        )
        program = dspy.RLM(
            _build_signature_for(dspy, task_kind),
            max_iters=limits["maxIterations"],
            max_llm_calls=limits["maxLlmCalls"],
            max_output_chars=limits["maxOutputChars"],
            tools=tools,
            sub_lm=lm,
            # This program runs once: hand DSPy the same per-analysis sandbox
            # that passed the startup probe. The outer context also cleans up
            # if construction fails before DSPy takes ownership.
            interpreter_factory=interpreter_factory,
        )

        history_before = _lm_history_length(lm)
        callback = input_value["toolCallback"]
        with _tool_callback(callback["url"], callback["token"], callback["timeoutMs"] / 1_000):
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
    findings_parse_error: str | None = None
    format_repair_used = False
    repair_error: str | None = None
    rejected_rows: list[RejectedFindingRow] = []
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
        # The submitted value, NOT a string forced through str(): a list or
        # mapping is canonical-JSON encoded by the codec, and any other type
        # raises rather than becoming an empty result.
        raw_findings_json = _prediction_field(prediction, "findings_json")
        if isinstance(raw_findings_json, str):
            raw_findings_json = raw_findings_json.strip()
        try:
            findings, rejected_rows = _parse_findings_json(raw_findings_json)
        except TypeError as error:
            # A malformed string is model output that the existing salvage and
            # repair paths can recover. Other types are contract defects and
            # must still stop the run.
            if not isinstance(raw_findings_json, str):
                raise
            findings = []
            findings_parse_error = " ".join(str(error).split())[:300]
        # The recovered-answer placeholder is adapter output, not model text, so
        # it never feeds salvage and never earns a repair turn.
        answer_text = "" if answer == _SAFE_FIELD_DEFAULTS["answer"] else answer
        if not findings:
            salvage_sources = [
                source
                for source in (raw_findings_json, answer_text)
                if isinstance(source, str) and source
            ]
            for source_text in salvage_sources:
                salvaged = _salvage_findings_json(source_text)
                if salvaged:
                    findings, findings_salvage = salvaged
                    rejected_rows = []
                    break
        if not findings and findings_salvage is None and answer_text:
            # EXACTLY one repair turn on the same LM handle, carrying the exact
            # row defects. A valid submission never reaches here. The call is
            # visible in modelCalls (counted below) and flagged in the runtime
            # record.
            format_repair_used = True
            repair_defects = describe_rejected_rows(rejected_rows)
            if findings_parse_error is not None:
                repair_defects = "\n".join(
                    part
                    for part in (
                        f"findings_json: {findings_parse_error}",
                        repair_defects,
                    )
                    if part
                )
            findings, repaired_rejections, repair_error = _repair_findings_turn(
                lm,
                answer_text,
                repair_defects,
            )
            if findings:
                rejected_rows = repaired_rejections
            elif repair_error is None and not rejected_rows and repaired_rejections:
                rejected_rows = repaired_rejections
        if rejected_rows:
            runtime = {
                **runtime,
                "rejectedFindings": [row.to_dict() for row in rejected_rows],
            }
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
            **(
                {"findings_parse_error": findings_parse_error}
                if findings_parse_error is not None
                else {}
            ),
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


if __name__ == "__main__":
    main()
