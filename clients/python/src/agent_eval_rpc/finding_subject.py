"""Canonical Python mirror of the TypeScript ``FindingSubject`` grammar.

The DSPy bridge must reject a subject before reporting success whenever the
TypeScript ``RawAnalystFindingSchema`` would reject it later. Keep this module
small and deterministic so the cross-language fixture can lock both parsers to
the same acceptance set.
"""

from __future__ import annotations

import re
from collections.abc import Callable

_MAX_CLUSTER_LENGTH = 80


def _fullmatch(pattern: str) -> Callable[[str], bool]:
    compiled = re.compile(pattern)
    return lambda value: compiled.fullmatch(value) is not None


_SUBJECT_MATCHERS: tuple[Callable[[str], bool], ...] = (
    _fullmatch(r"agent-knowledge:wiki:[a-z0-9][a-z0-9-]*(?:#[a-z0-9][a-z0-9-]*)?"),
    _fullmatch(r"agent-knowledge:claim:.+"),
    _fullmatch(r"agent-knowledge:raw:.+"),
    _fullmatch(r"agent-knowledge:stale:[a-z0-9][a-z0-9-]*"),
    _fullmatch(r"system-prompt:.+"),
    _fullmatch(r"skill:[a-z0-9][a-z0-9_.-]*"),
    _fullmatch(r"tool-doc:[a-z0-9][a-z0-9_-]*(?::.+)?"),
    _fullmatch(r"new-tool:[a-z0-9][a-z0-9_-]*"),
    _fullmatch(r"mcp:[a-z0-9][a-z0-9_.-]*(?::[a-z0-9][a-z0-9_.-]*)?"),
    _fullmatch(r"(?:hook|subagent|workflow):[a-z0-9][a-z0-9_.-]*"),
    _fullmatch(r"rollout-policy:.+"),
    _fullmatch(r"agent-profile:.+"),
    _fullmatch(r"code:.+"),
    _fullmatch(r"rag:[a-z0-9][a-z0-9_-]*:.+"),
    _fullmatch(r"memory:.+"),
    _fullmatch(r"scaffolding:.+"),
    _fullmatch(r"output-schema:.+"),
    _fullmatch(r"websearch:outdated:.+"),
    _fullmatch(r"prior-run-summary:.+"),
)
_CLUSTER = re.compile(r"[a-z0-9][a-z0-9._-]*")


def is_valid_finding_subject(value: object) -> bool:
    """Return whether ``value`` is accepted by TypeScript's subject parser.

    Trimming mirrors ``parseFindingSubject``. Prefix variants require a
    non-empty payload after trimming. The unprefixed cluster form is bounded to
    80 characters and deliberately excludes ``:`` so it cannot collide with a
    routed locus.
    """

    if not isinstance(value, str):
        return False
    subject = value.strip()
    if not subject:
        return False
    if any(matches(subject) for matches in _SUBJECT_MATCHERS):
        return True
    return len(subject) <= _MAX_CLUSTER_LENGTH and _CLUSTER.fullmatch(subject) is not None
