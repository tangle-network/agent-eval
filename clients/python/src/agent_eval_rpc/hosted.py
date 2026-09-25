"""Hosted-tier trace ingest: Python parity for ``@tangle-network/agent-eval/hosted``.

Ships trace spans to any orchestrator that speaks the wire format pinned at
``HOSTED_WIRE_VERSION = '2026-07-24.v1'``. Same contract as the TypeScript
client; pydantic models mirror the TS types in ``src/hosted/types.ts``.
Search ledgers ship from TypeScript, where they are written
(``agent-eval search ship``).

Quickstart
----------

    from agent_eval_rpc.hosted import HostedClient, make_trace_span

    client = HostedClient(endpoint="http://localhost:8080",
                          api_key="dev-token", tenant_id="acme")
    res = client.ingest_traces([make_trace_span(
        trace_id="t-1", span_id="s-1", name="dispatch",
        start_time_unix_nano="1700000000000000000",
        end_time_unix_nano="1700000001000000000",
        tangle_run_id="run-1",
    )])
    assert res.accepted == 1
"""

from __future__ import annotations

import random
import time
from email.utils import parsedate_to_datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

import httpx
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)
from pydantic import (
    ValidationError as PydanticValidationError,
)

from .errors import TransportError

HOSTED_WIRE_VERSION: Literal["2026-07-24.v1"] = "2026-07-24.v1"


def _not_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


def _unix_nano_timestamp(value: str) -> str:
    if not value.isascii() or not value.isdecimal():
        raise ValueError("must be an unsigned base-10 integer string")
    if len(value) > 1 and value.startswith("0"):
        raise ValueError("must use canonical base-10 encoding")
    if int(value) > 18_446_744_073_709_551_615:
        raise ValueError("must fit in an unsigned 64-bit integer")
    return value


NonEmptyString = Annotated[
    str,
    StringConstraints(strict=True, min_length=1),
    AfterValidator(_not_blank),
]
UnixNanoTimestamp = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^(0|[1-9][0-9]*)$"),
    AfterValidator(_unix_nano_timestamp),
]
NonNegativeInteger = Annotated[int, Field(strict=True, ge=0)]


class _WireModel(BaseModel):
    """Strict current-version wire model with camelCase aliases."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid", strict=True)


class TraceSpanEventEntry(_WireModel):
    """One timestamped event attached to an OTLP span."""

    timeUnixNano: UnixNanoTimestamp
    name: NonEmptyString
    attributes: dict[str, str | int | float | bool] | None = None


class TraceSpanStatus(_WireModel):
    """OTLP span status."""

    code: Literal["OK", "ERROR", "UNSET"]
    message: str | None = None


class TraceSpanEventOuter(_WireModel):
    """OTel-shape trace span — full surface including ``tangle.*`` pivots.

    Pydantic's Python-attribute restriction blocks dotted names like
    ``tangle.runId``, so the pivots are exposed via underscore-aliased
    fields that round-trip through ``model_validate(by_alias=True)`` and
    ``model_dump(by_alias=True)``:

        TraceSpanEventOuter(
            traceId="t", spanId="s", name="dispatch",
            startTimeUnixNano="0", endTimeUnixNano="1",
            attributes={},
            tangle_run_id="run-1", tangle_scenario_id="s1",
        ).model_dump(by_alias=True, exclude_none=True)
        # → {..., 'tangle.runId': 'run-1', 'tangle.scenarioId': 's1'}

    For most consumers ``make_trace_span(...)`` is simpler and returns a
    plain dict ready for ``HostedClient.ingest_traces``. Use this class
    when you want pydantic validation on inbound spans (e.g. parsing a
    response payload).
    """

    traceId: NonEmptyString
    spanId: NonEmptyString
    parentSpanId: NonEmptyString | None = None
    name: NonEmptyString
    startTimeUnixNano: UnixNanoTimestamp
    endTimeUnixNano: UnixNanoTimestamp
    attributes: dict[str, str | int | float | bool] = Field(default_factory=dict)
    events: list[TraceSpanEventEntry] | None = None
    status: TraceSpanStatus | None = None
    tangle_run_id: NonEmptyString | None = Field(default=None, alias="tangle.runId")
    tangle_generation: NonNegativeInteger | None = Field(default=None, alias="tangle.generation")
    tangle_cell_id: NonEmptyString | None = Field(default=None, alias="tangle.cellId")
    tangle_scenario_id: NonEmptyString | None = Field(default=None, alias="tangle.scenarioId")

    @model_validator(mode="after")
    def _validate_time_order(self) -> TraceSpanEventOuter:
        if int(self.endTimeUnixNano) < int(self.startTimeUnixNano):
            raise ValueError("endTimeUnixNano must be greater than or equal to startTimeUnixNano")
        return self


def make_trace_span(
    *,
    trace_id: str,
    span_id: str,
    name: str,
    start_time_unix_nano: str,
    end_time_unix_nano: str,
    attributes: dict[str, str | int | float | bool] | None = None,
    parent_span_id: str | None = None,
    tangle_run_id: str | None = None,
    tangle_generation: int | None = None,
    tangle_cell_id: str | None = None,
    tangle_scenario_id: str | None = None,
    status: dict[str, Any] | TraceSpanStatus | None = None,
) -> dict[str, Any]:
    """Build a wire-shape trace span dict including ``tangle.*`` pivots."""
    return TraceSpanEventOuter(
        traceId=trace_id,
        spanId=span_id,
        parentSpanId=parent_span_id,
        name=name,
        startTimeUnixNano=start_time_unix_nano,
        endTimeUnixNano=end_time_unix_nano,
        attributes=dict(attributes or {}),
        status=status,
        tangle_run_id=tangle_run_id,
        tangle_generation=tangle_generation,
        tangle_cell_id=tangle_cell_id,
        tangle_scenario_id=tangle_scenario_id,
    ).model_dump(mode="json", by_alias=True, exclude_none=True)


class IngestRejection(_WireModel):
    """One rejected item in an ingest response."""

    index: NonNegativeInteger
    reason: NonEmptyString


class IngestResponse(_WireModel):
    """Server response from any /v1/ingest endpoint."""

    accepted: NonNegativeInteger
    rejected: list[IngestRejection]


# ── Client ──────────────────────────────────────────────────────────


def _retry_after_seconds(value: str | None) -> float | None:
    """``Retry-After`` as seconds: delay-seconds or an HTTP date; None when absent or unreadable."""
    if value is None:
        return None
    value = value.strip()
    if value.isascii() and value.isdecimal():
        return float(value)
    try:
        at = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, at.timestamp() - time.time())


_RETRYABLE_STATUSES: frozenset[int] = frozenset({408, 429, 500, 502, 503, 504})
_MAX_IDEMPOTENCY_KEY_LENGTH = 256


class HostedClient:
    """Synchronous hosted-tier ingest client.

    Three modes (per the wire spec):

    - **Ours**: ``endpoint='https://intelligence.tangle.tools'``
    - **Self-hosted**: any URL running the reference receiver from
      ``examples/hosted-ingest-server/``
    - **Off**: don't construct the client

    Bearer auth + ``X-Tangle-Tenant-Id`` + wire-version pin on every call.
    Retries on 5xx / 408 / 429; waits the server's ``Retry-After`` when it
    sends one, otherwise capped exponential backoff with jitter.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        tenant_id: str,
        timeout_s: float = 30.0,
        retries: int = 2,
        http_client: httpx.Client | None = None,
    ) -> None:
        endpoint = endpoint.strip()
        api_key = api_key.strip()
        tenant_id = tenant_id.strip()
        if not endpoint:
            raise ValueError("endpoint is required")
        if not api_key:
            raise ValueError("api_key is required")
        if not tenant_id:
            raise ValueError("tenant_id is required")
        if timeout_s <= 0:
            raise ValueError("timeout_s must be greater than 0")
        if retries < 0:
            raise ValueError("retries must be non-negative")
        self.endpoint = endpoint.rstrip("/")
        self._base_url = self.endpoint.removesuffix("/v1")
        self.api_key = api_key
        self.tenant_id = tenant_id
        self.timeout_s = timeout_s
        self.retries = retries
        self.wire_version = HOSTED_WIRE_VERSION
        self._owned_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout_s)

    def __enter__(self) -> HostedClient:
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._owned_client:
            self._http.close()

    # ── Public methods ──────────────────────────────────────────────

    def ingest_traces(
        self,
        spans: list[TraceSpanEventOuter | dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> IngestResponse:
        spans_json = [
            (
                span
                if isinstance(span, TraceSpanEventOuter)
                else TraceSpanEventOuter.model_validate(span)
            ).model_dump(mode="json", by_alias=True, exclude_none=True)
            for span in spans
        ]
        body = {"wireVersion": HOSTED_WIRE_VERSION, "spans": spans_json}
        raw = self._post("/v1/ingest/traces", body, idempotency_key)
        return self._validate_response(raw)

    # ── Internals ───────────────────────────────────────────────────

    @staticmethod
    def _validate_response(raw: Any) -> IngestResponse:
        try:
            return IngestResponse.model_validate(raw)
        except PydanticValidationError as error:
            raise TransportError(f"hosted ingest returned an invalid response: {error}") from error

    def _post(
        self,
        path: str,
        body: dict[str, Any],
        idempotency_key: str | None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        request_key = idempotency_key if idempotency_key is not None else str(uuid4())
        if not request_key.strip():
            raise ValueError("idempotency_key must not be blank")
        if len(request_key) > _MAX_IDEMPOTENCY_KEY_LENGTH:
            raise ValueError(
                f"idempotency_key must be at most {_MAX_IDEMPOTENCY_KEY_LENGTH} characters"
            )
        headers: dict[str, str] = {
            "content-type": "application/json",
            "authorization": f"Bearer {self.api_key}",
            "x-tangle-tenant-id": self.tenant_id,
            "x-tangle-wire-version": HOSTED_WIRE_VERSION,
            "idempotency-key": request_key,
        }

        last_err: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                resp = self._http.post(url, headers=headers, json=body)
            except httpx.HTTPError as e:
                last_err = TransportError(f"hosted ingest {url} failed: {e}")
                if attempt == self.retries:
                    raise last_err from e
                self._sleep_backoff(attempt)
                continue

            if resp.is_success:
                try:
                    return resp.json()
                except Exception as e:
                    raise TransportError(f"hosted ingest {url} returned non-JSON: {e}") from e

            text = resp.text[:500] if resp.text else ""
            if resp.status_code in _RETRYABLE_STATUSES and attempt < self.retries:
                last_err = TransportError(
                    f"hosted ingest {url} retryable {resp.status_code}: {text}"
                )
                retry_after = _retry_after_seconds(resp.headers.get("retry-after"))
                if retry_after is None:
                    self._sleep_backoff(attempt)
                else:
                    time.sleep(retry_after)
                continue
            raise TransportError(f"hosted ingest {url} failed ({resp.status_code}): {text}")

        assert last_err is not None
        raise last_err

    @staticmethod
    def _sleep_backoff(attempt: int) -> None:
        base_ms = (2**attempt) * 200
        jitter_ms = random.uniform(0, 200)
        time.sleep((base_ms + jitter_ms) / 1000.0)
