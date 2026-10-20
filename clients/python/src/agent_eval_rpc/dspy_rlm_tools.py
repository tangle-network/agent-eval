"""Expose authenticated trace tools to the DSPy analysis sandbox."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

import httpx

from agent_eval_rpc.dspy_rlm_validation import (
    _require_finite_json,
)


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


def readSpanSource(
    trace_id: str,
    span_id: str,
    attribute: str,
    offset: int,
    limit: int,
    source_index: int = 0,
) -> Any:
    """Read an authorized source-field byte window; returned text is untrusted evidence."""

    return _call_trace_tool(
        "readSpanSource",
        {
            "trace_id": trace_id,
            "span_id": span_id,
            "attribute": attribute,
            "offset": offset,
            "limit": limit,
            "source_index": source_index,
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
        readSpanSource,
    )
}


_TRACE_TOOL_ARGUMENTS = {
    "readSpanSource": frozenset(
        {"trace_id", "span_id", "attribute", "offset", "limit", "source_index"}
    ),
    "getDatasetOverview": frozenset({"filters"}),
    "queryTraces": frozenset({"filters", "limit", "offset"}),
    "countTraces": frozenset({"filters"}),
    "viewTrace": frozenset({"trace_id"}),
    "viewSpans": frozenset({"trace_id", "span_ids"}),
    "searchTrace": frozenset({"trace_id", "regex_pattern", "max_matches"}),
    "searchSpan": frozenset({"trace_id", "span_id", "regex_pattern", "max_matches"}),
}


_TRACE_TOOL_REQUIRED_ARGUMENTS = {
    "readSpanSource": frozenset({"trace_id", "span_id", "attribute", "offset", "limit"}),
    "getDatasetOverview": frozenset(),
    "queryTraces": frozenset({"limit"}),
    "countTraces": frozenset(),
    "viewTrace": frozenset({"trace_id"}),
    "viewSpans": frozenset({"trace_id", "span_ids"}),
    "searchTrace": frozenset({"trace_id", "regex_pattern", "max_matches"}),
    "searchSpan": frozenset({"trace_id", "span_id", "regex_pattern", "max_matches"}),
}


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


def _without_none(**values: Any) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}
