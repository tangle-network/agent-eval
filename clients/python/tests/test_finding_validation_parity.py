from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from agent_eval_rpc import dspy_rlm_bridge
from agent_eval_rpc.finding_subject import is_valid_finding_subject

_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "finding-validation-parity.json").read_text()
)


@pytest.mark.parametrize("subject", _FIXTURE["validSubjects"])
def test_python_accepts_canonical_subjects(subject: str) -> None:
    assert is_valid_finding_subject(subject)


@pytest.mark.parametrize("subject", _FIXTURE["invalidSubjects"])
def test_python_rejects_noncanonical_subjects(subject: str) -> None:
    assert not is_valid_finding_subject(subject)


@pytest.mark.parametrize(
    ("name", "valid", "value"),
    [(row["name"], row["valid"], row["value"]) for row in _FIXTURE["rows"]],
)
def test_python_rows_have_declared_validity(
    name: str,
    valid: bool,
    value: dict[str, Any],
) -> None:
    del name
    if valid:
        assert dspy_rlm_bridge._validate_finding(value, 0) == value
    else:
        with pytest.raises(ValueError):
            dspy_rlm_bridge._validate_finding(value, 0)


@pytest.mark.parametrize("confidence", [math.nan, math.inf, -math.inf])
def test_python_rejects_nonfinite_confidence(confidence: float) -> None:
    with pytest.raises(ValueError, match="finite number"):
        dspy_rlm_bridge._validate_finding(
            {
                "severity": "high",
                "claim": "Non-finite confidence is invalid.",
                "confidence": confidence,
                "evidence": [{"uri": "trace://run/span/step-2"}],
            },
            0,
        )
