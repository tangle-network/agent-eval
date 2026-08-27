"""Client — the public entry point.

Two transports, one API:

- HTTP (default if reachable): talks to a running `agent-eval serve`.
  Best for live agent paths and high-frequency calls.
- Subprocess (fallback / explicit): shells out to `agent-eval rpc <method>`.
  Best for batch / cron — no service to manage.

Auto-detection: if `base_url` reaches a running server in `auto_probe_timeout`
seconds, HTTP wins. Otherwise the client falls back to subprocess. Force one
transport with `transport="http"` or `transport="subprocess"`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any, Literal

import httpx

from .errors import AgentEvalError, TransportError, from_error_body
from .models import (
    JudgeRequest,
    JudgeResult,
    ListRubricsResponse,
    Rubric,
    VersionResponse,
)

Transport = Literal["http", "subprocess", "auto"]

DEFAULT_BASE_URL = "http://127.0.0.1:5005"
DEFAULT_CLI = "agent-eval"
DEFAULT_TIMEOUT_S = 200.0
SUPPORTED_WIRE_MAJOR = 1


class Client:
    """Synchronous client for agent-eval.

    Parameters
    ----------
    base_url:
        Where to find the HTTP server. Defaults to AGENT_EVAL_URL env var
        or http://127.0.0.1:5005.
    cli_path:
        Name or absolute path of the `agent-eval` binary used by the
        subprocess transport. Defaults to AGENT_EVAL_CLI or 'agent-eval'.
    transport:
        'auto' (default), 'http', or 'subprocess'.
    timeout_s:
        Per-call timeout, default 200 seconds. A judge call can make up to
        three 60-second provider attempts before returning.
    auto_probe_timeout:
        How long to wait for the HTTP /healthz check during auto-detect.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        cli_path: str | None = None,
        transport: Transport = "auto",
        timeout_s: float = DEFAULT_TIMEOUT_S,
        auto_probe_timeout: float = 1.0,
    ) -> None:
        self.base_url = (
            base_url or os.environ.get("AGENT_EVAL_URL") or DEFAULT_BASE_URL
        ).rstrip("/")
        self.cli_path = cli_path or os.environ.get("AGENT_EVAL_CLI") or DEFAULT_CLI
        self.timeout_s = timeout_s
        self._transport = self._resolve_transport(transport, auto_probe_timeout)

    # ── Public methods ──────────────────────────────────────────────

    def judge(
        self,
        *,
        content: str,
        rubric_name: str | None = None,
        rubric: Rubric | dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        model: str | None = None,
    ) -> JudgeResult:
        """Score `content` against a rubric and return a typed result."""
        # Validate locally so the user sees a Python-side error before the
        # transport even fires. The server validates again as defense in depth.
        rubric_value: Rubric | None
        if isinstance(rubric, dict):
            rubric_value = Rubric.model_validate(rubric)
        else:
            rubric_value = rubric
        request = JudgeRequest(
            rubric_name=rubric_name,
            rubric=rubric_value,
            content=content,
            context=context,
            model=model,
        )
        body = self._call("judge", request.model_dump(by_alias=True, exclude_none=True))
        return JudgeResult.model_validate(body)

    def list_rubrics(self) -> ListRubricsResponse:
        body = self._call("listRubrics", {})
        return ListRubricsResponse.model_validate(body)

    def version(self) -> VersionResponse:
        body = self._call("version", {})
        return VersionResponse.model_validate(body)

    @property
    def transport(self) -> Literal["http", "subprocess"]:
        return self._transport

    # ── Transport dispatch ──────────────────────────────────────────

    def _resolve_transport(
        self, requested: Transport, probe_timeout: float
    ) -> Literal["http", "subprocess"]:
        if requested == "http":
            return "http"
        if requested == "subprocess":
            return "subprocess"
        # Auto mode identifies the service before selecting HTTP. A generic
        # health endpoint is not enough because another local service may own
        # the configured port.
        probe_problem = f"no service responded at {self.base_url}"
        try:
            with httpx.Client(timeout=probe_timeout) as c:
                r = c.get(f"{self.base_url}/v1/version")
                if r.status_code == 200:
                    version = VersionResponse.model_validate(r.json())
                    if version.package != "@tangle-network/agent-eval":
                        probe_problem = f"{self.base_url} is package {version.package!r}"
                    elif _wire_major(version.wire_version) != SUPPORTED_WIRE_MAJOR:
                        probe_problem = (
                            f"{self.base_url} uses unsupported wire version "
                            f"{version.wire_version!r}"
                        )
                    else:
                        return "http"
                else:
                    probe_problem = f"{self.base_url}/v1/version returned HTTP {r.status_code}"
        except (httpx.HTTPError, OSError, ValueError) as error:
            probe_problem = f"{self.base_url}/v1/version failed: {error}"
        if shutil.which(self.cli_path) is None:
            raise TransportError(
                f"No compatible agent-eval server ({probe_problem}) and no "
                f"`{self.cli_path}` binary on PATH. "
                "Either run `agent-eval serve` or `npm i -g @tangle-network/agent-eval`."
            )
        return "subprocess"

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        if self._transport == "http":
            return self._http_call(method, params)
        return self._subprocess_call(method, params)

    def _http_call(self, method: str, params: dict[str, Any]) -> Any:
        path = _http_path_for(method)
        try:
            with httpx.Client(timeout=self.timeout_s, base_url=self.base_url) as c:
                if path.method == "GET":
                    r = c.get(path.url)
                else:
                    r = c.post(path.url, json=params)
        except httpx.HTTPError as e:
            raise TransportError(f"HTTP transport failed: {e}") from e
        if r.status_code >= 400:
            try:
                error_body = r.json()
            except json.JSONDecodeError as error:
                raise TransportError(f"HTTP {r.status_code}: {r.text[:500]}") from error
            raise from_error_body(r.status_code, error_body)
        try:
            return r.json()
        except json.JSONDecodeError as e:
            raise TransportError(f"Server returned non-JSON body: {e}") from e

    def _subprocess_call(self, method: str, params: dict[str, Any]) -> Any:
        try:
            proc = subprocess.run(
                [self.cli_path, "rpc", method],
                input=json.dumps(params),
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            raise TransportError(f"Subprocess transport failed: {e}") from e
        if not proc.stdout:
            raise TransportError(
                f"agent-eval rpc {method} produced no output. stderr: {proc.stderr[:500]}"
            )
        try:
            envelope = json.loads(proc.stdout.strip().splitlines()[-1])
        except json.JSONDecodeError as e:
            raise TransportError(f"agent-eval rpc returned non-JSON: {proc.stdout[:500]}") from e
        if "error" in envelope:
            # Map to the right exception class — same as HTTP path.
            raise from_error_body(proc.returncode or 500, envelope)
        if "result" not in envelope:
            raise TransportError(f"Malformed RPC envelope: {envelope}")
        return envelope["result"]


# ── Method → HTTP path mapping ──────────────────────────────────────


class _HttpPath:
    __slots__ = ("method", "url")

    def __init__(self, method: str, url: str) -> None:
        self.method = method
        self.url = url


_PATHS = {
    "judge": _HttpPath("POST", "/v1/judge"),
    "listRubrics": _HttpPath("GET", "/v1/rubrics"),
    "version": _HttpPath("GET", "/v1/version"),
}


def _http_path_for(method: str) -> _HttpPath:
    try:
        return _PATHS[method]
    except KeyError as e:
        raise AgentEvalError(f"Unknown method: {method}") from e


def _wire_major(version: str) -> int:
    try:
        return int(version.split(".", 1)[0])
    except (TypeError, ValueError) as error:
        raise ValueError(f"Invalid wire version: {version!r}") from error
