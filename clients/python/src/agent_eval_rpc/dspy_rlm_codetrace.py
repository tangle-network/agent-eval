"""Own typed incorrect blocks and their exact trace evidence."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Annotated, Any, Literal
from urllib.parse import quote

import httpx
import pydantic

from agent_eval_rpc.dspy_rlm_output import (
    _extract_json_array,
    _prediction_field,
)
from agent_eval_rpc.dspy_rlm_tools import (
    getDatasetOverview,
    searchTrace,
    viewSpans,
    viewTrace,
)
from agent_eval_rpc.finding_codec import decode_raw_finding_array, describe_rejected_rows

# The codetrace RLM transport contract is the only analyst prompt that names
# the subject grammar token; its presence in the instructions selects the
# typed task signature without a wire-protocol change.
_CODETRACE_TASK_TOKEN = "incorrect-steps-"


_CODETRACE_SIGNATURE_VERSION = "codetrace-typed-v1"


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


_CODETRACE_ANALYSIS_PROMPT = (
    "\n"
    "The complete trajectory is already loaded into the REPL as the variables `t"
    "rajectory` and `final_verification`; read them with Python code instead of "
    "re-fetching the trace.\n"
    "Follow analyst_instructions for the incorrect-step task definition and bloc"
    "k boundaries.\n"
    "Where analyst_instructions describe transport — findings_json, finding subj"
    "ects, evidence URIs, or excerpts — they are superseded: SUBMIT typed blocks"
    " and the caller builds every subject, URI, and excerpt from them.\n"
    "Use llm_query or llm_query_batched for focused semantic subjudgments over s"
    "pan content.\n"
    "Do not claim that you inspected data you did not retrieve.\n"
    "When done, SUBMIT(answer=..., blocks=[...]); blocks is [] for a clean traje"
    "ctory.\n"
).strip()


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
    rationale: Annotated[str, pydantic.StringConstraints(max_length=4_000)] | None = pydantic.Field(
        default=None,
        description="The concrete downstream evidence visible at the consequence step.",
    )

    @pydantic.model_validator(mode="after")
    def _enforce_block_shape(self) -> IncorrectBlock:
        if self.last_step < self.first_step:
            raise ValueError(f"last_step {self.last_step} precedes first_step {self.first_step}")
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


@dataclass(frozen=True)
class _CodetraceEnvironment:
    trace_id: str
    # Full projected span list, in store order, handed to the REPL verbatim.
    spans: list[dict[str, Any]]
    # step number -> span, for existence and kind checks on model-claimed steps.
    step_spans: dict[int, dict[str, Any]]
    final_verification: list[dict[str, Any]]
    fetch_mode: str


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
            return f"{label} step-{step} is {span.get('kind')!r}, not an assistant LLM span"
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
        # Invariant check on code-built output, through the same codec the
        # model path uses: a violation is a bridge bug and must crash, not flow
        # downstream as model noise.
        accepted, rejected = decode_raw_finding_array([finding])
        if rejected:
            raise ValueError(
                f"typed SUBMIT block {index} built an invalid finding: "
                f"{describe_rejected_rows(rejected)}"
            )
        findings.extend(accepted)
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
