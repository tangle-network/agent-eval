"""Decode DSPy output and recover malformed control and findings fields."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

from agent_eval_rpc.dspy_rlm_validation import (
    _reject_json_constant,
    _require_non_empty_string,
)
from agent_eval_rpc.finding_codec import (
    RejectedFindingRow,
    canonical_findings_json,
    decode_raw_finding_array,
)


def _parse_findings_json(value: Any) -> tuple[list[dict[str, Any]], list[RejectedFindingRow]]:
    """Decode a submitted findings value through the shared wire codec.

    The codec is generated from the TypeScript schema, so a row accepted here
    is a row TypeScript accepts. A list or mapping is canonical-JSON encoded
    before it crosses the string boundary, because a Python repr is not JSON
    and parsing one used to yield zero rows and report success. A value that is
    not a findings array raises; only an explicitly empty array is an empty
    result.
    """
    if isinstance(value, (list, dict)):
        value = canonical_findings_json(value)
    return decode_raw_finding_array(value)


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
        rows, _ = decode_raw_finding_array_or_empty(stripped[markers[-1].end() :])
        if rows:
            return rows, "malformed-marker"
    rows = _accepted_rows(_last_findings_array(stripped))
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


_FINDINGS_REPAIR_SHAPE = (
    "Re-emit ONLY the strict findings_json JSON array for that answer: no prose,"
    " no Markdown fences, no field markers.\n"
    "Each element must contain only severity, claim, optional subject, confidenc"
    "e, optional rationale, optional recommended_action, and evidence (a non-emp"
    "ty array of objects with uri and optional excerpt).\n"
    "Use only identifiers and quotes already present in the answer; never invent"
    " evidence."
)


# The generic analysis contract: a finding is a citable claim of any kind.
# CodeTrace's "incorrect step" vocabulary belongs to the CodeTrace contract
# only -- asking a generic analysis for incorrect steps erased valid factual
# findings, because an answer with no incorrect step still has citable claims.
_FINDINGS_REPAIR_PROMPT = f"""Your previous trace-analysis answer is below.
{_FINDINGS_REPAIR_SHAPE}
Return [] only when the answer contains no citable claim.

ANSWER:
"""


_CODETRACE_FINDINGS_REPAIR_PROMPT = f"""Your previous trace-analysis answer is below.
{_FINDINGS_REPAIR_SHAPE}
Return [] if the answer reports no incorrect steps.

ANSWER:
"""


def decode_raw_finding_array_or_empty(
    value: Any,
) -> tuple[list[dict[str, Any]], list[RejectedFindingRow]]:
    """Decode salvaged text, treating "not a findings array" as nothing found.

    Salvage runs over arbitrary model prose that may hold no array at all, so a
    missing array here is the expected outcome, not a defect. Every row it does
    find is still validated by the codec.
    """
    try:
        return decode_raw_finding_array(value)
    except TypeError:
        return [], []


def _accepted_rows(value: Any) -> list[dict[str, Any]]:
    accepted, _ = decode_raw_finding_array_or_empty(value)
    return accepted


def _repair_findings_turn(
    lm: Any,
    answer_text: str,
    defects: str,
    prompt: str = _FINDINGS_REPAIR_PROMPT,
) -> tuple[list[dict[str, Any]], list[RejectedFindingRow], str | None]:
    # A repair failure must not void the already-completed investigation: the
    # error is returned for the runtime record instead of being raised, and the
    # findings stay empty. The exact row defects go INTO the turn, so the model
    # is told what to fix rather than asked to guess.
    instruction = f"{prompt}{answer_text}"
    if defects:
        instruction = f"{instruction}\n\nThe previous submission was refused:\n{defects}"
    try:
        completions = lm(messages=[{"role": "user", "content": instruction}])
    except Exception as error:  # noqa: BLE001 — recorded in runtime, never silent
        summary = " ".join(str(error).split())[:200]
        return [], [], f"{type(error).__name__}: {summary}"
    completion = completions[0] if isinstance(completions, list) and completions else completions
    if not isinstance(completion, str):
        return [], [], f"repair completion has unexpected type {type(completion).__name__}"
    accepted, rejected = decode_raw_finding_array_or_empty(completion)
    return accepted, rejected, None


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
# no-op REPL turn. `findings_json` has NO default: an absent findings field is
# a defect to report, and defaulting it to "[]" made a lost field
# indistinguishable from a model that found nothing citable.
_SAFE_FIELD_DEFAULTS = {
    "code": "",
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
        elif name in _SAFE_FIELD_DEFAULTS:
            recovered[name] = _SAFE_FIELD_DEFAULTS[name]
        # A field with no safe default -- findings_json -- is LEFT OUT. The
        # caller then reports it missing by name. Defaulting it to "[]" made an
        # unrecoverable field look like a model that found nothing citable.
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
