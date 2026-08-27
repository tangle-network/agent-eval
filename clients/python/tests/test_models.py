"""Schema mirror tests — defend against TS/Python drift.

Each test names the regression it would catch. The invariant: anything
the TypeScript JudgeRequest accepts/rejects, the Python JudgeRequest
must accept/reject the same way.
"""
from __future__ import annotations

import pytest

from agent_eval_rpc.models import JudgeRequest, Rubric, RubricDimension

MIN_RUBRIC = Rubric(
    name="r",
    description="d",
    systemPrompt="p",
    dimensions=[RubricDimension(id="a", description="b")],
)


def test_judge_request_accepts_rubric_name_alone() -> None:
    JudgeRequest(rubric_name="anti-slop", content="hello")


def test_judge_request_accepts_inline_rubric_alone() -> None:
    JudgeRequest(rubric=MIN_RUBRIC, content="hello")


def test_judge_request_rejects_both_rubric_name_and_rubric() -> None:
    """Regression: ambiguous selection — server must not have to choose."""
    with pytest.raises(ValueError, match="exactly one"):
        JudgeRequest(rubric_name="anti-slop", rubric=MIN_RUBRIC, content="hello")


def test_judge_request_rejects_neither_rubric_name_nor_rubric() -> None:
    """Regression: silently dispatching to default rubric hides bugs."""
    with pytest.raises(ValueError, match="exactly one"):
        JudgeRequest(content="hello")


def test_judge_request_rejects_empty_content() -> None:
    """Regression: empty content scored high because LLMs are agreeable."""
    with pytest.raises(ValueError):
        JudgeRequest(rubric_name="anti-slop", content="")


def test_rubric_dimension_defaults() -> None:
    d = RubricDimension(id="x", description="y")
    assert d.weight == 1.0
    assert d.min == 0.0
    assert d.max == 1.0


def test_rubric_round_trip_preserves_camelCase_aliases() -> None:
    """Wire format uses systemPrompt/failureModes; Python uses snake_case.
    Round-trip via .model_dump(by_alias=True) must preserve the wire shape."""
    r = Rubric(
        name="r",
        description="d",
        systemPrompt="p",
        dimensions=[RubricDimension(id="a", description="b")],
    )
    payload = r.model_dump(by_alias=True)
    assert "systemPrompt" in payload
    assert "failureModes" in payload
    Rubric.model_validate(payload)  # accepts its own output
