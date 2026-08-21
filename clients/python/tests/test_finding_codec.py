"""The raw-finding codec, driven by the corpus the TypeScript lane also runs.

Both lanes read `tests/fixtures/finding-codec/*.json`. A case that accepts a
row here and rejects it there is the exact defect the shared contract exists to
prevent, so the corpus is the test, not a copy of it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_eval_rpc.finding_codec import (
    FINDING_WIRE_CONTRACT_VERSION,
    MAX_FINDING_ROWS,
    canonical_findings_json,
    decode_raw_finding_array,
    describe_rejected_rows,
    is_finding_subject,
)

_CORPUS_DIR = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "finding-codec"


def _corpus() -> list[tuple[str, dict[str, Any]]]:
    cases = []
    for path in sorted(_CORPUS_DIR.glob("*.json")):
        with path.open(encoding="utf-8") as handle:
            cases.append((path.name, json.load(handle)))
    return cases


CORPUS = _corpus()

ROW = {
    "severity": "high",
    "claim": "the retry loop never backs off",
    "evidence": [{"uri": "trace://t1/span/s1"}],
    "confidence": 0.9,
}


def test_the_corpus_is_present() -> None:
    # A corpus that failed to load would make every parity test vacuously pass.
    assert len(CORPUS) >= 12


@pytest.mark.parametrize("name,case", CORPUS, ids=[name for name, _ in CORPUS])
def test_parity_with_typescript(name: str, case: dict[str, Any]) -> None:
    accepted, rejected = decode_raw_finding_array(case["input"])
    rows = case["input"]

    assert accepted == [rows[index] for index in case["acceptedIndexes"]], name
    assert [
        {"index": row.index, "path": row.path, "code": row.code} for row in rejected
    ] == case["rejections"], name


@pytest.mark.parametrize("value", [42, True, None, 1.5, {"severity": "high"}])
def test_a_non_array_raises_instead_of_returning_empty(value: Any) -> None:
    # #636: the failure mode is reporting success with an empty result after
    # paid work. A wrong top-level type is a defect, not "no findings".
    with pytest.raises(TypeError):
        decode_raw_finding_array(value)


def test_unparseable_text_raises() -> None:
    with pytest.raises(TypeError):
        decode_raw_finding_array("not json at all {{{")


def test_python_repr_of_a_list_is_refused_not_silently_emptied() -> None:
    # The #636 regression: str([{...}]) is not JSON. It used to parse to zero
    # rows and report success; a valid submission must never vanish that way.
    with pytest.raises(TypeError):
        decode_raw_finding_array(str([ROW]))


def test_a_list_crosses_the_boundary_through_canonical_json() -> None:
    encoded = canonical_findings_json([ROW])
    accepted, rejected = decode_raw_finding_array(encoded)
    assert accepted == [ROW]
    assert rejected == []


def test_a_fenced_array_is_accepted() -> None:
    accepted, _ = decode_raw_finding_array(f"```json\n{json.dumps([ROW])}\n```")
    assert accepted == [ROW]


def test_findings_wrapper_is_unwrapped_but_a_bare_row_is_not_promoted() -> None:
    accepted, _ = decode_raw_finding_array({"findings": [ROW]})
    assert accepted == [ROW]
    with pytest.raises(TypeError):
        decode_raw_finding_array(ROW)


def test_rows_past_the_bound_are_refused() -> None:
    accepted, rejected = decode_raw_finding_array([ROW] * (MAX_FINDING_ROWS + 2))
    assert len(accepted) == MAX_FINDING_ROWS
    assert [row.code for row in rejected] == ["row-limit", "row-limit"]


def test_describe_rejected_rows_names_the_field() -> None:
    _, rejected = decode_raw_finding_array([{"claim": "no evidence"}])
    assert describe_rejected_rows(rejected).startswith("row 0 field 'severity': ")


def test_subject_grammar_is_enforced_here_too() -> None:
    # #606: Python accepted subjects TypeScript refused, so Python reported
    # success for rows the other side dropped.
    assert is_finding_subject("skill:agent-eval")
    assert not is_finding_subject("Not A Subject")
    accepted, rejected = decode_raw_finding_array([{**ROW, "subject": "Not A Subject"}])
    assert accepted == []
    assert [row.code for row in rejected] == ["invalid-subject"]


def test_contract_version_is_pinned() -> None:
    assert FINDING_WIRE_CONTRACT_VERSION == 1
