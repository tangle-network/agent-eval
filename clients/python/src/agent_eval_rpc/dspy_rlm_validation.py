"""Validate bounded bridge input and strict finite JSON values."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def _read_json(path: Path, max_input_bytes: int) -> dict[str, Any]:
    if path.stat().st_size > max_input_bytes:
        raise ValueError(f"DSPy RLM bridge input exceeds {max_input_bytes} bytes")
    raw = path.read_bytes()
    if len(raw) > max_input_bytes:
        raise ValueError(f"DSPy RLM bridge input exceeds {max_input_bytes} bytes")
    try:
        value = json.loads(raw, parse_constant=_reject_json_constant)
    except json.JSONDecodeError as error:
        raise ValueError("DSPy RLM bridge input must be valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("DSPy RLM bridge input must be a JSON object")
    return value


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"non-finite JSON constant {value} is not allowed")


def _require_exact_keys(
    value: Mapping[str, Any],
    expected: set[str],
    label: str,
    optional: set[str] | None = None,
) -> None:
    present = set(value)
    allowed = expected | (optional or set())
    if not expected <= present or not present <= allowed:
        detail = f"exactly {sorted(expected)}"
        if optional:
            detail = f"{detail} and may contain {sorted(optional)}"
        raise ValueError(f"{label} must contain {detail}")


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError(f"{label} must be a non-empty trimmed string")
    return value


def _require_positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _require_http_url(value: Any, label: str) -> str:
    result = _require_non_empty_string(value, label)
    parsed = urlparse(result)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{label} must not contain credentials")
    return result


def _require_finite_json(value: Any, label: str) -> None:
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be finite JSON") from error
