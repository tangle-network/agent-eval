from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_section(text: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{label}: start marker not found")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"{label}: end marker not found")
    return text[:start_index] + replacement + text[end_index:]


def update_digests() -> None:
    completed = subprocess.run(
        ["node", "scripts/check-analyst-benchmark-implementation.mjs", "--print"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    digests = [line.strip() for line in completed.stdout.splitlines() if re.fullmatch(r"[a-f0-9]{64}", line.strip())]
    if len(digests) != 2:
        raise SystemExit(f"digest checker returned {digests!r}")
    implementation_digest, dependency_digest = digests
    path = ROOT / "src/analyst/benchmark-implementation.ts"
    text = path.read_text()
    text, implementation_count = re.subn(
        r"(export const ANALYST_BENCHMARK_IMPLEMENTATION_SHA256 =\n  ')[a-f0-9]{64}(')",
        rf"\g<1>{implementation_digest}\g<2>",
        text,
        count=1,
    )
    text, dependency_count = re.subn(
        r"(export const ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256 =\n  ')[a-f0-9]{64}(')",
        rf"\g<1>{dependency_digest}\g<2>",
        text,
        count=1,
    )
    if implementation_count != 1 or dependency_count != 1:
        raise SystemExit(
            "failed to update benchmark digests: "
            f"implementation={implementation_count}, dependency={dependency_count}"
        )
    path.write_text(text)
    return


if sys.argv[1:] == ["--digests"]:
    update_digests()
    raise SystemExit(0)
if sys.argv[1:]:
    raise SystemExit("usage: finalize-finding-validation-parity.py [--digests]")

finding_subject_source = '''"""Canonical Python mirror of the TypeScript ``FindingSubject`` grammar.

The DSPy bridge must reject and normalize subjects exactly as the TypeScript
``RawAnalystFindingSchema`` boundary does. ``parse_finding_subject`` returns the
canonical rendered string, making acceptance and normalization testable from
one shared fixture rather than maintaining two merely similar validators.
"""

from __future__ import annotations

import re

_MAX_CLUSTER_LENGTH = 80
_WIKI = re.compile(
    r"agent-knowledge:wiki:[a-z0-9][a-z0-9-]*(?:#[a-z0-9][a-z0-9-]*)?"
)
_STALE = re.compile(r"agent-knowledge:stale:[a-z0-9][a-z0-9-]*")
_SKILL = re.compile(r"skill:[a-z0-9][a-z0-9_.-]*")
_TOOL_DOC_ASPECT = re.compile(r"tool-doc:([a-z0-9][a-z0-9_-]*):(.+)")
_TOOL_DOC = re.compile(r"tool-doc:[a-z0-9][a-z0-9_-]*")
_NEW_TOOL = re.compile(r"new-tool:[a-z0-9][a-z0-9_-]*")
_MCP = re.compile(r"mcp:[a-z0-9][a-z0-9_.-]*(?::[a-z0-9][a-z0-9_.-]*)?")
_NAMED_LOCUS = re.compile(r"(?:hook|subagent|workflow):[a-z0-9][a-z0-9_.-]*")
_RAG = re.compile(r"rag:([a-z0-9][a-z0-9_-]*):(.+)")
_CLUSTER = re.compile(r"[a-z0-9][a-z0-9._-]*")


def _payload(subject: str, prefix: str) -> str | None:
    if not subject.startswith(prefix):
        return None
    value = subject[len(prefix) :].strip()
    return value or None


def parse_finding_subject(value: object) -> str | None:
    """Return TypeScript's canonical rendered subject, or ``None``.

    The whole input and every free-form payload are trimmed exactly like
    ``parseFindingSubject`` followed by ``renderFindingSubject``. Routed names
    remain lowercase and structurally constrained; an unprefixed cluster label
    is bounded to 80 characters and excludes ``:``.
    """

    if not isinstance(value, str):
        return None
    subject = value.strip()
    if not subject:
        return None
    if _WIKI.fullmatch(subject) or _STALE.fullmatch(subject):
        return subject
    for prefix in (
        "agent-knowledge:claim:",
        "agent-knowledge:raw:",
        "system-prompt:",
        "rollout-policy:",
        "agent-profile:",
        "code:",
        "memory:",
        "scaffolding:",
        "output-schema:",
        "websearch:outdated:",
        "prior-run-summary:",
    ):
        payload = _payload(subject, prefix)
        if payload is not None:
            return f"{prefix}{payload}"
    if _SKILL.fullmatch(subject) or _TOOL_DOC.fullmatch(subject):
        return subject
    tool_doc = _TOOL_DOC_ASPECT.fullmatch(subject)
    if tool_doc:
        aspect = tool_doc.group(2).strip()
        if aspect:
            return f"tool-doc:{tool_doc.group(1)}:{aspect}"
        return None
    if _NEW_TOOL.fullmatch(subject) or _MCP.fullmatch(subject) or _NAMED_LOCUS.fullmatch(subject):
        return subject
    rag = _RAG.fullmatch(subject)
    if rag:
        document = rag.group(2).strip()
        if document:
            return f"rag:{rag.group(1)}:{document}"
        return None
    if len(subject) <= _MAX_CLUSTER_LENGTH and _CLUSTER.fullmatch(subject):
        return subject
    return None


def is_valid_finding_subject(value: object) -> bool:
    """Return whether ``value`` belongs to the canonical subject grammar."""

    return parse_finding_subject(value) is not None
'''
(ROOT / "clients/python/src/agent_eval_rpc/finding_subject.py").write_text(finding_subject_source)

fixture = {
    "validSubjects": [
        "agent-knowledge:wiki:router-retries#failure-taxonomy",
        "agent-knowledge:claim:provider identity",
        "system-prompt:verification",
        "skill:trace-analysis",
        "tool-doc:view_trace:pagination",
        "mcp:github:create_pull_request",
        "agent-profile:prompt.instructions",
        "code:src/runtime.ts",
        "rag:runbooks:billing-reconciliation",
        "websearch:outdated:model pricing",
        "prior-run-summary:timeout failures",
        "appworld.task.530b157_1",
    ],
    "normalizedSubjects": [
        {
            "input": " system-prompt: verification ",
            "canonical": "system-prompt:verification",
        },
        {
            "input": "tool-doc:view_trace: pagination ",
            "canonical": "tool-doc:view_trace:pagination",
        },
        {
            "input": "rag:runbooks: billing reconciliation ",
            "canonical": "rag:runbooks:billing reconciliation",
        },
        {
            "input": " appworld.task.530b157_1 ",
            "canonical": "appworld.task.530b157_1",
        },
    ],
    "invalidSubjects": [
        "",
        "   ",
        "What changed",
        "agent-knowledge:wiki:Uppercase",
        "skill:Bad Name",
        "tool-doc:viewTrace:pagination",
        "mcp:github:",
        "system-prompt:   ",
        "cluster:with-colon-but-no-grammar",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ],
    "rows": [
        {
            "name": "canonical subject",
            "valid": True,
            "value": {
                "severity": "high",
                "claim": "The prompt omitted the verification rule.",
                "subject": "system-prompt:verification",
                "confidence": 0.9,
                "evidence": [
                    {
                        "uri": "trace://run/span/step-2",
                        "excerpt": "No verification was run.",
                    }
                ],
            },
        },
        {
            "name": "subject omitted",
            "valid": True,
            "value": {
                "severity": "info",
                "claim": "The trace is clean.",
                "confidence": 0.75,
                "evidence": [{"uri": "trace://run/span/step-1"}],
            },
        },
        {
            "name": "free-form subject",
            "valid": False,
            "value": {
                "severity": "high",
                "claim": "The prompt changed.",
                "subject": "What changed",
                "confidence": 0.9,
                "evidence": [{"uri": "trace://run/span/step-2"}],
            },
        },
        {
            "name": "unknown field",
            "valid": False,
            "value": {
                "severity": "high",
                "claim": "Unknown metadata must not cross the boundary.",
                "confidence": 0.9,
                "evidence": [{"uri": "trace://run/span/step-2"}],
                "extra": True,
            },
        },
        {
            "name": "empty evidence",
            "valid": False,
            "value": {
                "severity": "high",
                "claim": "A finding must be citable.",
                "confidence": 0.9,
                "evidence": [],
            },
        },
        {
            "name": "confidence above one",
            "valid": False,
            "value": {
                "severity": "high",
                "claim": "Confidence is bounded.",
                "confidence": 1.1,
                "evidence": [{"uri": "trace://run/span/step-2"}],
            },
        },
    ],
}
(ROOT / "clients/python/tests/fixtures/finding-validation-parity.json").write_text(
    json.dumps(fixture, indent=2) + "\n"
)

python_parity_test = '''from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from agent_eval_rpc import dspy_rlm_bridge
from agent_eval_rpc.finding_subject import (
    is_valid_finding_subject,
    parse_finding_subject,
)

_FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "finding-validation-parity.json").read_text()
)


@pytest.mark.parametrize("subject", _FIXTURE["validSubjects"])
def test_python_accepts_canonical_subjects(subject: str) -> None:
    assert parse_finding_subject(subject) == subject
    assert is_valid_finding_subject(subject)


@pytest.mark.parametrize(
    ("value", "canonical"),
    [(row["input"], row["canonical"]) for row in _FIXTURE["normalizedSubjects"]],
)
def test_python_normalizes_subjects(value: str, canonical: str) -> None:
    assert parse_finding_subject(value) == canonical


@pytest.mark.parametrize("subject", _FIXTURE["invalidSubjects"])
def test_python_rejects_noncanonical_subjects(subject: str) -> None:
    assert parse_finding_subject(subject) is None
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
'''
(ROOT / "clients/python/tests/test_finding_validation_parity.py").write_text(python_parity_test)

ts_parity_test = '''import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseFindingSubject, parseRawFinding, renderFindingSubject } from '../src/analyst'

interface FindingValidationFixture {
  validSubjects: string[]
  normalizedSubjects: Array<{ input: string; canonical: string }>
  invalidSubjects: string[]
  rows: Array<{ name: string; valid: boolean; value: unknown }>
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../clients/python/tests/fixtures/finding-validation-parity.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as FindingValidationFixture

describe('finding validation parity fixture', () => {
  it.each(fixture.validSubjects)('accepts canonical subject %s', (subject) => {
    const parsed = parseFindingSubject(subject)
    expect(parsed).not.toBeNull()
    if (parsed === null) throw new Error(`expected canonical subject: ${subject}`)
    expect(renderFindingSubject(parsed)).toBe(subject)
  })

  it.each(fixture.normalizedSubjects)('normalizes $input', ({ input, canonical }) => {
    const parsed = parseFindingSubject(input)
    expect(parsed).not.toBeNull()
    if (parsed === null) throw new Error(`expected normalizable subject: ${input}`)
    expect(renderFindingSubject(parsed)).toBe(canonical)
  })

  it.each(fixture.invalidSubjects)('rejects non-canonical subject %s', (subject) => {
    expect(parseFindingSubject(subject)).toBeNull()
  })

  it.each(fixture.rows)('$name has the declared TypeScript validity', ({ valid, value }) => {
    expect(parseRawFinding(value) !== null).toBe(valid)
  })

  it('rejects non-finite confidence at the TypeScript boundary', () => {
    expect(
      parseRawFinding({
        severity: 'high',
        claim: 'Non-finite confidence is invalid.',
        confidence: Number.NaN,
        evidence: [{ uri: 'trace://run/span/step-2' }],
      }),
    ).toBeNull()
  })
})
'''
(ROOT / "tests/finding-validation-parity.test.ts").write_text(ts_parity_test)

bridge_path = ROOT / "clients/python/src/agent_eval_rpc/dspy_rlm_bridge.py"
bridge = bridge_path.read_text()
bridge = replace_once(
    bridge,
    "from agent_eval_rpc.optimizer_bridge_common import atomic_write_json\n",
    "from agent_eval_rpc.finding_subject import parse_finding_subject\n"
    "from agent_eval_rpc.optimizer_bridge_common import atomic_write_json\n",
    "finding subject import",
)
bridge = replace_once(
    bridge,
    '   - subject: an optional non-empty string\n',
    '   - subject: an optional canonical FindingSubject locus or lowercase cluster label; never prose\n',
    "analysis prompt subject contract",
)
bridge = replace_once(
    bridge,
    "    repair_error: str | None = None\n",
    "    repair_error: str | None = None\n"
    "    finding_rejections: list[dict[str, Any]] = []\n",
    "finding rejection initialization",
)
analysis_replacement = '''        raw_findings_json = _prediction_string(prediction, "findings_json")
        parsed_findings = _extract_json_array(raw_findings_json)
        findings = _validated_rows(
            parsed_findings,
            finding_rejections,
            phase="initial",
        )
        # The recovered-answer placeholder is adapter output, not model text, so
        # it never feeds salvage and never earns a repair turn by itself.
        answer_text = "" if answer == _SAFE_FIELD_DEFAULTS["answer"] else answer
        if not findings:
            for source_text in (raw_findings_json, answer_text):
                salvaged = _salvage_findings_json(source_text) if source_text else None
                if salvaged:
                    findings, findings_salvage = salvaged
                    break
        should_repair = (
            not findings
            and findings_salvage is None
            and (bool(finding_rejections) or bool(answer_text))
        )
        if should_repair:
            # EXACTLY one repair turn on the same LM handle. A genuine [] with
            # no prose remains a valid empty result; an all-invalid submitted
            # array is re-presented even when the model emitted no prose.
            repair_parts: list[str] = []
            if answer_text:
                repair_parts.append(f"ANSWER:\n{answer_text}")
            if finding_rejections and raw_findings_json.strip():
                repair_parts.append(f"SUBMITTED_FINDINGS:\n{raw_findings_json.strip()}")
            repair_source = "\n\n".join(repair_parts)
            if repair_source:
                format_repair_used = True
                findings, repair_error, repair_rejections = _repair_findings_turn(
                    lm,
                    repair_source,
                )
                finding_rejections.extend(repair_rejections)
'''
bridge = replace_section(
    bridge,
    '        raw_findings_json = _prediction_string(prediction, "findings_json")\n',
    "    model_calls = _lm_history_length(lm) - history_before\n",
    analysis_replacement,
    "generic finding analysis",
)
bridge = replace_once(
    bridge,
    '            **({"format_repair_error": repair_error} if repair_error is not None else {}),\n',
    '            **({"format_repair_error": repair_error} if repair_error is not None else {}),\n'
    '            **({"finding_rejections": finding_rejections} if finding_rejections else {}),\n',
    "runtime rejection record",
)
validation_section = '''def _parse_findings_json(value: str) -> list[dict[str, Any]]:
    # findings_json is model output. A model that wraps the array in a fenced
    # block or leaves prose around it should not void a completed investigation,
    # so the array is extracted before parsing. A genuinely absent array means
    # "no citable finding", which is a valid empty result, not a crash. Each
    # surviving row is still validated strictly.
    return _validated_rows(_extract_json_array(value))


def _validated_rows(
    parsed: list[Any] | None,
    rejections: list[dict[str, Any]] | None = None,
    *,
    phase: str = "parse",
) -> list[dict[str, Any]]:
    if parsed is None:
        return []
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(parsed):
        # One malformed finding row is dropped, not fatal. Its exact rejection
        # is retained when the caller supplies a collector, so a completed paid
        # investigation never appears to have emitted a clean empty result.
        try:
            rows.append(_validate_finding(row, index))
        except ValueError as error:
            if rejections is not None:
                rejections.append(
                    {
                        "phase": phase,
                        "index": index,
                        "reason": " ".join(str(error).split())[:500],
                    }
                )
    return rows


'''
bridge = replace_section(
    bridge,
    "def _parse_findings_json(value: str) -> list[dict[str, Any]]:\n",
    "# The findings_json marker family with damaged brackets",
    validation_section,
    "validated finding rows",
)
bridge = replace_once(
    bridge,
    "Each element must contain only severity, claim, optional subject, confidence, optional rationale, optional recommended_action, and evidence (a non-empty array of objects with uri and optional excerpt).\n",
    "Each element must contain only severity, claim, optional canonical FindingSubject, confidence, optional rationale, optional recommended_action, and evidence (a non-empty array of objects with uri and optional excerpt).\n",
    "repair prompt subject contract",
)
repair_section = '''def _repair_findings_turn(
    lm: Any,
    source_text: str,
) -> tuple[list[dict[str, Any]], str | None, list[dict[str, Any]]]:
    # A repair failure must not void the already-completed investigation: the
    # error and any row-level defects are returned for the runtime record.
    try:
        completions = lm(
            messages=[{"role": "user", "content": f"{_FINDINGS_REPAIR_PROMPT}{source_text}"}]
        )
    except Exception as error:  # noqa: BLE001 — recorded in runtime, never silent
        summary = " ".join(str(error).split())[:200]
        return [], f"{type(error).__name__}: {summary}", []
    completion = completions[0] if isinstance(completions, list) and completions else completions
    if not isinstance(completion, str):
        return [], f"repair completion has unexpected type {type(completion).__name__}", []
    parsed = _extract_json_array(completion)
    if parsed is None:
        return [], "repair completion did not contain a JSON array", []
    rejections: list[dict[str, Any]] = []
    rows = _validated_rows(parsed, rejections, phase="repair")
    return rows, None, rejections


'''
bridge = replace_section(
    bridge,
    "def _repair_findings_turn(lm: Any, answer_text: str) -> tuple[list[dict[str, Any]], str | None]:\n",
    "def _extract_json_array(value: str) -> list[Any] | None:\n",
    repair_section,
    "finding repair turn",
)
bridge = replace_once(
    bridge,
    '    if "subject" in finding:\n        _require_bounded_string(finding["subject"], f"findings[{index}].subject", 400)\n',
    '    if "subject" in finding:\n'
    '        canonical_subject = parse_finding_subject(finding["subject"])\n'
    '        if canonical_subject is None:\n'
    '            raise ValueError(\n'
    '                f"findings[{index}].subject must match the canonical FindingSubject grammar"\n'
    '            )\n'
    '        if canonical_subject != finding["subject"]:\n'
    '            finding = {**finding, "subject": canonical_subject}\n',
    "canonical finding subject validation",
)
bridge_path.write_text(bridge)

bridge_test_path = ROOT / "clients/python/tests/test_dspy_rlm_bridge.py"
bridge_test = bridge_test_path.read_text()
additional_tests = '''

def test_all_invalid_structured_findings_trigger_one_repair_and_record_rejections(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: dict[str, Any] = {}
    invalid = {**_VALID_FINDING, "subject": "What changed"}
    fake = _fake_dspy(
        calls,
        answer=dspy_rlm_bridge._SAFE_FIELD_DEFAULTS["answer"],
        findings_json=json.dumps([invalid]),
        invoke_tool=False,
        repair_completion=json.dumps([_VALID_FINDING]),
    )

    output = _run_analyze_main(monkeypatch, tmp_path, fake)

    assert output["findings"] == [_VALID_FINDING]
    assert output["runtime"]["format_repair_used"] is True
    assert output["runtime"]["finding_rejections"] == [
        {
            "phase": "initial",
            "index": 0,
            "reason": "findings[0].subject must match the canonical FindingSubject grammar",
        }
    ]
    assert len(calls["repair_calls"]) == 1
    assert "What changed" in json.dumps(calls["repair_calls"][0])
    assert output["modelCalls"] == 4


def test_invalid_sibling_preserves_valid_finding_and_exact_rejection_without_repair(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: dict[str, Any] = {}
    invalid = {**_VALID_FINDING, "subject": "What changed"}
    fake = _fake_dspy(
        calls,
        answer=dspy_rlm_bridge._SAFE_FIELD_DEFAULTS["answer"],
        findings_json=json.dumps([invalid, _VALID_FINDING]),
        invoke_tool=False,
    )

    output = _run_analyze_main(monkeypatch, tmp_path, fake)

    assert output["findings"] == [_VALID_FINDING]
    assert output["runtime"]["format_repair_used"] is False
    assert output["runtime"]["finding_rejections"] == [
        {
            "phase": "initial",
            "index": 0,
            "reason": "findings[0].subject must match the canonical FindingSubject grammar",
        }
    ]
    assert "repair_calls" not in calls
    assert output["modelCalls"] == 3


def test_finding_subject_is_canonicalized_before_crossing_the_bridge() -> None:
    finding = {
        **_VALID_FINDING,
        "subject": " system-prompt: verification ",
    }

    assert dspy_rlm_bridge._validate_finding(finding, 0)["subject"] == (
        "system-prompt:verification"
    )


def test_repair_row_rejections_are_retained_with_the_initial_defect(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: dict[str, Any] = {}
    invalid = {**_VALID_FINDING, "subject": "What changed"}
    fake = _fake_dspy(
        calls,
        answer=dspy_rlm_bridge._SAFE_FIELD_DEFAULTS["answer"],
        findings_json=json.dumps([invalid]),
        invoke_tool=False,
        repair_completion=json.dumps([invalid]),
    )

    output = _run_analyze_main(monkeypatch, tmp_path, fake)

    assert output["findings"] == []
    assert output["runtime"]["finding_rejections"] == [
        {
            "phase": "initial",
            "index": 0,
            "reason": "findings[0].subject must match the canonical FindingSubject grammar",
        },
        {
            "phase": "repair",
            "index": 0,
            "reason": "findings[0].subject must match the canonical FindingSubject grammar",
        },
    ]
    assert len(calls["repair_calls"]) == 1
    assert output["modelCalls"] == 4
'''
bridge_test = replace_once(
    bridge_test,
    "\n\ndef _fake_dspy(\n",
    additional_tests + "\n\ndef _fake_dspy(\n",
    "bridge parity tests",
)
bridge_test_path.write_text(bridge_test)

checker_path = ROOT / "scripts/check-analyst-benchmark-implementation.mjs"
checker = checker_path.read_text()
checker = replace_once(
    checker,
    "  'clients/python/src/agent_eval_rpc/dspy_rlm_bridge.py',\n"
    "  'clients/python/src/agent_eval_rpc/optimizer_bridge_common.py',\n",
    "  'clients/python/src/agent_eval_rpc/dspy_rlm_bridge.py',\n"
    "  'clients/python/src/agent_eval_rpc/finding_subject.py',\n"
    "  'clients/python/src/agent_eval_rpc/optimizer_bridge_common.py',\n",
    "Python benchmark implementation manifest",
)
checker_path.write_text(checker)

for relative in (
    "src/analyst/benchmark-implementation.ts",
    "src/analyst/benchmark-implementation.test.ts",
):
    path = ROOT / relative
    text = path.read_text()
    text = replace_once(
        text,
        "  'clients/python/src/agent_eval_rpc/dspy_rlm_bridge.py',\n"
        "  'clients/python/src/agent_eval_rpc/optimizer_bridge_common.py',\n",
        "  'clients/python/src/agent_eval_rpc/dspy_rlm_bridge.py',\n"
        "  'clients/python/src/agent_eval_rpc/finding_subject.py',\n"
        "  'clients/python/src/agent_eval_rpc/optimizer_bridge_common.py',\n",
        f"{relative} Python source manifest",
    )
    path.write_text(text)

package_path = ROOT / "package.json"
package = json.loads(package_path.read_text())
if package.get("version") != "0.145.22":
    raise SystemExit(f"unexpected package version {package.get('version')!r}")
package["version"] = "0.145.23"
package_path.write_text(json.dumps(package, indent=2) + "\n")

pyproject_path = ROOT / "clients/python/pyproject.toml"
pyproject = pyproject_path.read_text()
pyproject = replace_once(
    pyproject,
    'version = "0.145.22"\n',
    'version = "0.145.23"\n',
    "Python package version",
)
pyproject_path.write_text(pyproject)
