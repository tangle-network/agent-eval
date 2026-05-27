"""Hosted-tier ingest client — Python parity for ``@tangle-network/agent-eval/hosted``.

Ships eval-run events + trace spans to any orchestrator that speaks the
wire format frozen at ``HOSTED_WIRE_VERSION = '2026-05-26.v1'``. Same
contract as the TypeScript client; pydantic models mirror the TS types in
``src/hosted/types.ts``.

Quickstart
----------

    from agent_eval_rpc.hosted import (
        HostedClient,
        EvalRunEvent,
        EvalRunGenerationSnapshot,
        EvalRunCellScore,
    )

    client = HostedClient(endpoint="http://localhost:8080",
                          api_key="dev-token", tenant_id="acme")
    res = client.ingest_eval_run(EvalRunEvent(
        runId="run-1", runDir="/runs/run-1",
        timestamp="2026-05-27T00:00:00Z", status="finished",
        labels={"env": "test"}, generations=[],
        totalCostUsd=0.0, totalDurationMs=0,
    ))
    assert res.accepted == 1
"""

from __future__ import annotations

import random
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from .errors import TransportError

HOSTED_WIRE_VERSION: Literal["2026-05-26.v1"] = "2026-05-26.v1"

EvalRunStatus = Literal[
    "started",
    "baseline-complete",
    "generation-complete",
    "gate-decided",
    "finished",
    "errored",
]

GateDecision = Literal["ship", "hold", "need_more_work", "model_ceiling", "arch_ceiling"]


class _WireModel(BaseModel):
    """Permissive on input (forward-compat), camelCase-aware on output.

    The TS substrate adds optional fields between minor versions; Python
    consumers should silently accept those rather than reject the payload.
    On serialise, we emit the exact camelCase keys the TS server expects.
    """

    model_config = ConfigDict(populate_by_name=True, extra="allow")


class EvalRunCellScore(_WireModel):
    """One cell within a generation snapshot."""

    scenarioId: str
    rep: int = 0
    compositeMean: float
    dimensions: dict[str, dict[str, float]] = Field(default_factory=dict)
    errorMessage: str | None = None


class EvalRunGenerationSnapshot(_WireModel):
    """A generation snapshot. ``index=0`` is baseline."""

    index: int
    surfaceHash: str
    surface: Any = None
    cells: list[EvalRunCellScore] = Field(default_factory=list)
    compositeMean: float
    costUsd: float = 0.0
    durationMs: int = 0


class EvalRunEvent(_WireModel):
    """Top-level eval-run event; one POST per logical run lifecycle stage."""

    runId: str
    runDir: str
    timestamp: str
    status: EvalRunStatus
    labels: dict[str, str] = Field(default_factory=dict)
    baseline: EvalRunGenerationSnapshot | None = None
    generations: list[EvalRunGenerationSnapshot] = Field(default_factory=list)
    gateDecision: GateDecision | None = None
    holdoutLift: float | None = None
    totalCostUsd: float = 0.0
    totalDurationMs: int = 0
    errorMessage: str | None = None


class TraceSpanEventOuter(_WireModel):
    """OTel-shape trace span. Pivots into the eval-run stream via tangle.runId.

    ``tangle.runId``-style keys come through as-is; pydantic doesn't allow
    dotted names as Python attrs, so callers construct via ``model_validate``
    on a dict or set them through ``model_extra``. The convenience
    constructor ``TraceSpanEvent.build(...)`` handles both shapes.
    """

    traceId: str
    spanId: str
    parentSpanId: str | None = None
    name: str
    startTimeUnixNano: int
    endTimeUnixNano: int
    attributes: dict[str, str | int | float | bool] = Field(default_factory=dict)
    events: list[dict[str, Any]] | None = None
    status: dict[str, Any] | None = None


def make_trace_span(
    *,
    trace_id: str,
    span_id: str,
    name: str,
    start_time_unix_nano: int,
    end_time_unix_nano: int,
    attributes: dict[str, str | int | float | bool] | None = None,
    parent_span_id: str | None = None,
    tangle_run_id: str | None = None,
    tangle_generation: int | None = None,
    tangle_cell_id: str | None = None,
    tangle_scenario_id: str | None = None,
    status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a wire-shape trace span dict including ``tangle.*`` pivots."""
    span: dict[str, Any] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "startTimeUnixNano": start_time_unix_nano,
        "endTimeUnixNano": end_time_unix_nano,
        "attributes": dict(attributes or {}),
    }
    if parent_span_id is not None:
        span["parentSpanId"] = parent_span_id
    if status is not None:
        span["status"] = status
    if tangle_run_id is not None:
        span["tangle.runId"] = tangle_run_id
    if tangle_generation is not None:
        span["tangle.generation"] = tangle_generation
    if tangle_cell_id is not None:
        span["tangle.cellId"] = tangle_cell_id
    if tangle_scenario_id is not None:
        span["tangle.scenarioId"] = tangle_scenario_id
    return span


class IngestResponse(_WireModel):
    """Server response from any /v1/ingest endpoint."""

    accepted: int
    rejected: list[dict[str, Any]] = Field(default_factory=list)


# ── Client ──────────────────────────────────────────────────────────


_RETRYABLE_STATUSES: frozenset[int] = frozenset({408, 429, 500, 502, 503, 504})


class HostedClient:
    """Synchronous hosted-tier ingest client.

    Three modes (per the wire spec):

    - **Ours**: ``endpoint='https://intelligence.tangle.tools'``
    - **Self-hosted**: any URL running the reference receiver from
      ``examples/hosted-ingest-server/``
    - **Off**: don't construct the client

    Bearer auth + ``X-Tangle-Tenant-Id`` + wire-version pin on every call.
    Retries on 5xx / 408 / 429 with capped exponential backoff and jitter.
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
        if not endpoint:
            raise ValueError("endpoint is required")
        if not api_key:
            raise ValueError("api_key is required")
        if not tenant_id:
            raise ValueError("tenant_id is required")
        self.endpoint = endpoint.rstrip("/")
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

    def ingest_eval_run(
        self,
        event: EvalRunEvent | dict[str, Any],
        idempotency_key: str | None = None,
    ) -> IngestResponse:
        return self.ingest_eval_runs([event], idempotency_key)

    def ingest_eval_runs(
        self,
        events: list[EvalRunEvent | dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> IngestResponse:
        events_json = [self._to_event_json(e) for e in events]
        body = {"wireVersion": HOSTED_WIRE_VERSION, "events": events_json}
        raw = self._post("/v1/ingest/eval-runs", body, idempotency_key)
        return IngestResponse.model_validate(raw)

    def ingest_traces(
        self,
        spans: list[dict[str, Any]],
        idempotency_key: str | None = None,
    ) -> IngestResponse:
        body = {"wireVersion": HOSTED_WIRE_VERSION, "spans": list(spans)}
        raw = self._post("/v1/ingest/traces", body, idempotency_key)
        return IngestResponse.model_validate(raw)

    # ── Internals ───────────────────────────────────────────────────

    @staticmethod
    def _to_event_json(event: EvalRunEvent | dict[str, Any]) -> dict[str, Any]:
        if isinstance(event, EvalRunEvent):
            return event.model_dump(by_alias=True, exclude_none=True)
        return event

    def _post(
        self,
        path: str,
        body: dict[str, Any],
        idempotency_key: str | None,
    ) -> Any:
        url = f"{self.endpoint}{path}"
        headers: dict[str, str] = {
            "content-type": "application/json",
            "authorization": f"Bearer {self.api_key}",
            "x-tangle-tenant-id": self.tenant_id,
            "x-tangle-wire-version": HOSTED_WIRE_VERSION,
        }
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key

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
                self._sleep_backoff(attempt)
                continue
            raise TransportError(f"hosted ingest {url} failed ({resp.status_code}): {text}")

        assert last_err is not None
        raise last_err

    @staticmethod
    def _sleep_backoff(attempt: int) -> None:
        base_ms = (2**attempt) * 200
        jitter_ms = random.uniform(0, 200)
        time.sleep((base_ms + jitter_ms) / 1000.0)
