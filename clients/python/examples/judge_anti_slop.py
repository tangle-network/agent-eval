"""Score content against the built-in `anti-slop` rubric.

Run this with the HTTP server up (`agent-eval serve --port 5005`) or with the
`agent-eval` CLI on PATH (subprocess fallback). The example pytest below
verifies the *shape* of the response — not the score, which depends on the
judge LLM.

    # one-shot script
    pip install agent-eval-rpc
    AGENT_EVAL_URL=http://127.0.0.1:5005 python examples/judge_anti_slop.py

    # tested invariants
    pytest examples/judge_anti_slop.py
"""

from __future__ import annotations

import pytest

from agent_eval_rpc import Client, RubricNotFoundError, ValidationError


def main() -> None:
    client = Client()  # auto-detects HTTP, falls back to subprocess

    result = client.judge(
        content="We just launched zero-copy IO between agents and their workdir.",
        rubric_name="anti-slop",
    )

    print(f"composite={result.composite:.3f}")
    print(f"dimensions={result.dimensions}")
    print(f"failure_modes={result.failure_modes}")
    print(f"wins={result.wins}")
    print(f"rationale={result.rationale[:200]}...")


# ── tests ───────────────────────────────────────────────────────────────────
# Treat the example as a pytest-runnable contract: shape, types, error paths.


def test_judge_returns_composite_in_range():
    """Composite score is always in [0, 1] regardless of content."""
    client = Client()
    result = client.judge(
        content="Generic marketing tone. Lots of synergies. Innovative solutions.",
        rubric_name="anti-slop",
    )
    assert 0.0 <= result.composite <= 1.0
    assert isinstance(result.dimensions, dict)
    assert all(0.0 <= v <= 1.0 for v in result.dimensions.values())


def test_judge_rejects_missing_rubric():
    """A bogus `rubric_name` raises `RubricNotFoundError`, not a generic error."""
    client = Client()
    with pytest.raises(RubricNotFoundError):
        client.judge(content="anything", rubric_name="this-rubric-does-not-exist")


def test_judge_rejects_empty_call():
    """Calling `judge` with neither `rubric_name` nor `rubric` is a validation error."""
    client = Client()
    with pytest.raises(ValidationError):
        client.judge(content="anything")


if __name__ == "__main__":
    main()
