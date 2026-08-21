"""Decode a raw-finding array against the contract TypeScript generates.

A finding array crosses a process boundary twice: this package writes it, the
TypeScript package reads it back. Two decoders written independently accept
different shapes, so this side could report a completed investigation whose
rows the other side then drops -- the paid work disappearing between two
"successes".

So nothing here is a hand-written copy of the schema. Every rule is read from
``finding_contract.json``, which ``scripts/emit-finding-contract.ts`` generates
from the TypeScript schema and CI checks byte-for-byte. Adding a field on one
side and not the other cannot ship.

Decoding never invents an empty result: a value that is not an array of rows
raises, and a malformed row is reported with its index and path while its valid
siblings survive.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

_CONTRACT_PATH: Final = Path(__file__).with_name("finding_contract.json")


def _load_contract() -> dict[str, Any]:
    with _CONTRACT_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


_CONTRACT: Final[dict[str, Any]] = _load_contract()

FINDING_WIRE_CONTRACT_VERSION: Final[int] = _CONTRACT["version"]
MAX_FINDING_ROWS: Final[int] = _CONTRACT["maxRows"]
_ROW_SCHEMA: Final[dict[str, Any]] = _CONTRACT["row"]
_SUBJECT_PATTERNS: Final[tuple[re.Pattern[str], ...]] = tuple(
    re.compile(entry["pattern"]) for entry in _CONTRACT["subjectPatterns"]
)


@dataclass(frozen=True)
class RejectedFindingRow:
    """A refused row, named precisely enough to repair or report."""

    index: int
    path: str
    code: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "path": self.path,
            "code": self.code,
            "message": self.message,
        }


def is_finding_subject(subject: str) -> bool:
    """True when ``subject`` matches the grammar the contract carries."""
    trimmed = subject.strip()
    if not trimmed:
        return False
    return any(pattern.match(trimmed) for pattern in _SUBJECT_PATTERNS)


def canonical_findings_json(value: Any) -> str:
    """Encode a list or mapping as the JSON string that crosses the boundary.

    Keys are sorted and separators are tight, which is RFC 8785 for the finite
    integers and strings a finding carries. Number formatting is NOT RFC 8785:
    Python's ``repr`` for floats can differ from the JavaScript form for values
    a finding never carries as an identity field (``confidence`` is compared
    numerically, never as bytes). Use this to hand a value across the string
    boundary, never to compute a digest.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def decode_raw_finding_array(value: Any) -> tuple[list[dict[str, Any]], list[RejectedFindingRow]]:
    """Decode ``value`` into accepted rows plus per-row diagnostics.

    Accepts a list of rows, a mapping wrapping one under ``findings``, or a
    string carrying a JSON array. Any other type raises ``TypeError``: a caller
    that asked for findings and got a number has a defect to report, not an
    empty result to record.
    """
    rows = _finding_rows(value)
    accepted: list[dict[str, Any]] = []
    rejected: list[RejectedFindingRow] = []
    for index, row in enumerate(rows):
        if index >= MAX_FINDING_ROWS:
            rejected.append(
                RejectedFindingRow(
                    index=index,
                    path="",
                    code="row-limit",
                    message=f"findings array exceeds {MAX_FINDING_ROWS} rows",
                )
            )
            continue
        failure = _validate_row(row)
        if failure is None:
            accepted.append(row)
        else:
            path, code, message = failure
            rejected.append(
                RejectedFindingRow(index=index, path=path, code=code, message=message)
            )
    return accepted, rejected


def describe_rejected_rows(rejected: list[RejectedFindingRow]) -> str:
    """One line per refused row, for a repair prompt or an error message."""
    lines = []
    for row in rejected:
        field = f" field '{row.path}'" if row.path else ""
        lines.append(f"row {row.index}{field}: {row.message}")
    return "\n".join(lines)


def _finding_rows(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        parsed = _extract_json_array(value)
        if parsed is None:
            raise TypeError("findings must be a JSON array; the string received is not JSON")
        return parsed
    if isinstance(value, dict):
        inner = value.get("findings")
        if isinstance(inner, list):
            return inner
        raise TypeError("findings must be an array, received a mapping without a findings array")
    raise TypeError(f"findings must be an array, received {type(value).__name__}")


def _extract_json_array(text: str) -> list[Any] | None:
    """Parse a JSON array out of model text, de-fencing first. None when absent."""
    candidate = _strip_code_fences(text).strip()
    if not candidate:
        return None
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("[")
        end = candidate.rfind("]")
        if start == -1 or end <= start:
            return None
        try:
            parsed = json.loads(candidate[start : end + 1])
        except json.JSONDecodeError:
            return None
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict) and isinstance(parsed.get("findings"), list):
        return parsed["findings"]
    return None


_FENCE = re.compile(r"^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$")


def _strip_code_fences(text: str) -> str:
    match = _FENCE.match(text.strip())
    return match.group(1).strip() if match else text


def _validate_row(row: Any) -> tuple[str, str, str] | None:
    """Return (path, code, message) for the first defect, or None when valid."""
    if not isinstance(row, dict):
        return ("", "not-an-object", f"finding row must be an object, received {_name(row)}")
    failure = _validate_object(row, _ROW_SCHEMA, "")
    if failure is not None:
        path, message = failure
        subject = row.get("subject")
        if path == "subject" and isinstance(subject, str) and not is_finding_subject(subject):
            return (path, "invalid-subject", message)
        return (path, "schema", message)
    subject = row.get("subject")
    if subject is not None and not is_finding_subject(subject):
        return ("subject", "invalid-subject", "subject does not match the finding-subject grammar")
    return None


def _validate_object(
    value: dict[str, Any], schema: dict[str, Any], path: str
) -> tuple[str, str] | None:
    properties: dict[str, Any] = schema.get("properties", {})
    required: set[str] = set(schema.get("required", []))
    # Report in the schema's declaration order, and treat a missing required
    # property at the point it is declared. The TypeScript schema reports its
    # first issue in that same order, and the two sides must name the same
    # field for one row -- a repair turn is told which field to fix.
    for key, entry in properties.items():
        if key not in value:
            if key in required:
                field = _join(path, key)
                expected = entry.get("type", "value")
                return (
                    field,
                    f"Invalid input: expected {expected}, received undefined",
                )
            continue
        failure = _validate_value(value[key], entry, _join(path, key))
        if failure is not None:
            return failure
    if schema.get("additionalProperties") is False:
        for key in value:
            if key not in properties:
                # Path convention matches the TypeScript schema's: an unknown
                # key is reported at the OBJECT's path, not the key's.
                return (path, f'Unrecognized key: "{key}"')
    return None


def _validate_value(value: Any, schema: dict[str, Any], path: str) -> tuple[str, str] | None:
    expected = schema.get("type")
    if expected == "string":
        if not isinstance(value, str):
            return (path, f"{path} must be a string, received {_name(value)}")
        if "enum" in schema and value not in schema["enum"]:
            return (path, f"{path} must be one of {', '.join(schema['enum'])}")
        minimum = schema.get("minLength")
        if minimum is not None and len(value) < minimum:
            return (path, f"{path} must be at least {minimum} characters")
        maximum = schema.get("maxLength")
        if maximum is not None and len(value) > maximum:
            return (path, f"{path} must be at most {maximum} characters")
        return None
    if expected == "number" or expected == "integer":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return (path, f"{path} must be a number, received {_name(value)}")
        if not math.isfinite(value):
            return (path, f"{path} must be finite")
        minimum = schema.get("minimum")
        if minimum is not None and value < minimum:
            return (path, f"{path} must be at least {minimum}")
        maximum = schema.get("maximum")
        if maximum is not None and value > maximum:
            return (path, f"{path} must be at most {maximum}")
        return None
    if expected == "boolean":
        if not isinstance(value, bool):
            return (path, f"{path} must be a boolean, received {_name(value)}")
        return None
    if expected == "array":
        if not isinstance(value, list):
            return (path, f"{path} must be an array, received {_name(value)}")
        minimum = schema.get("minItems")
        if minimum is not None and len(value) < minimum:
            return (path, f"{path} must have at least {minimum} item(s)")
        maximum = schema.get("maxItems")
        if maximum is not None and len(value) > maximum:
            return (path, f"{path} must have at most {maximum} item(s)")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                failure = _validate_value(item, item_schema, f"{path}.{index}")
                if failure is not None:
                    return failure
        return None
    if expected == "object":
        if not isinstance(value, dict):
            return (path, f"{path} must be an object, received {_name(value)}")
        return _validate_object(value, schema, path)
    if "enum" in schema:
        if value not in schema["enum"]:
            return (path, f"{path} must be one of {', '.join(map(str, schema['enum']))}")
        return None
    return None


def _join(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def _name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, list):
        return "an array"
    if isinstance(value, dict):
        return "an object"
    return f"a {type(value).__name__}"
