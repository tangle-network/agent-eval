"""Exception hierarchy.

All errors raised by this client subclass `AgentEvalError`. Catch the
specific ones (`RubricNotFoundError`, `ValidationError`) for cases that
are fixable in caller code; let `TransportError` bubble or retry it.
"""

from __future__ import annotations


class AgentEvalError(Exception):
    """Base class for every error raised by this client."""

    def __init__(self, message: str, *, code: str | None = None, details: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class TransportError(AgentEvalError):
    """The HTTP request or subprocess invocation failed at the transport layer.

    Distinct from server-side errors (which arrive as 4xx with a typed
    body — those map to other subclasses). TransportError = the request
    couldn't be made or the response couldn't be parsed.
    """


class ValidationError(AgentEvalError):
    """Server rejected the request as malformed (HTTP 400 with code='validation_error')."""


class RubricNotFoundError(AgentEvalError):
    """Server has no rubric by that name (HTTP 404 with code='rubric_not_found')."""


def from_error_body(status: int, body: object) -> AgentEvalError:
    """Map a server error envelope to the right exception class."""
    code = None
    message = "Unknown error"
    details = None
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            code = err.get("code")
            message = err.get("message", message)
            details = err.get("details")
    if code == "rubric_not_found":
        return RubricNotFoundError(message, code=code, details=details)
    if code == "validation_error":
        return ValidationError(message, code=code, details=details)
    return AgentEvalError(f"HTTP {status}: {message}", code=code, details=details)
