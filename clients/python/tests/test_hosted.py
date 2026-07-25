"""Hosted-tier client E2E: Python client ↔ TS reference receiver.

Spawns the reference receiver from ``examples/hosted-ingest-server/server.ts``
on an OS-assigned port via ``tsx``, points the Python ``HostedClient`` at it,
and proves the wire spec is binary-compatible across languages.

This is the Python mirror of ``tests/hosted-roundtrip.test.ts`` on the TS
side. The two tests cover the same surface; if either drifts, the wire
spec is broken.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from agent_eval_rpc import (
    EvalRunCellScore,
    EvalRunEvent,
    EvalRunGenerationSnapshot,
    HostedClient,
    make_trace_span,
)
from agent_eval_rpc.errors import TransportError

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVER_TS = REPO_ROOT / "examples" / "hosted-ingest-server" / "server.ts"
TENANT_ID = "py-tenant"
TENANT_KEY = "py-test-key"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_for_health(url: str, timeout_s: float = 15.0) -> None:
    deadline = time.time() + timeout_s
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            r = httpx.get(f"{url}/healthz", timeout=1.0)
            if r.status_code == 200:
                return
        except httpx.HTTPError as e:
            last_err = e
        time.sleep(0.1)
    raise RuntimeError(f"reference receiver did not become healthy: {last_err}")


def _have_tsx() -> bool:
    if shutil.which("tsx"):
        return True
    if shutil.which("pnpm"):
        try:
            r = subprocess.run(
                ["pnpm", "exec", "tsx", "--version"],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
                timeout=10,
            )
            return r.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
    return False


@pytest.fixture
def receiver():
    if not _have_tsx():
        pytest.skip("tsx not available — install pnpm + run `pnpm install` in agent-eval")
    if not SERVER_TS.exists():
        pytest.skip(f"reference receiver not found at {SERVER_TS}")
    port = _free_port()
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["TENANT_ID"] = TENANT_ID
    env["TENANT_KEY"] = TENANT_KEY
    runner = (
        ["tsx", str(SERVER_TS)] if shutil.which("tsx") else ["pnpm", "exec", "tsx", str(SERVER_TS)]
    )
    proc = subprocess.Popen(
        runner,
        env=env,
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        _wait_for_health(url)
        yield {"url": url, "port": port}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()


def _make_run_event(run_id: str) -> EvalRunEvent:
    return EvalRunEvent(
        runId=run_id,
        runDir=f"/runs/{run_id}",
        timestamp="2026-05-27T00:00:00Z",
        status="finished",
        labels={"env": "py-test"},
        baseline=EvalRunGenerationSnapshot(
            index=0,
            surfaceHash="h-base",
            cells=[
                EvalRunCellScore(
                    scenarioId="s1",
                    rep=0,
                    compositeMean=0.5,
                    dimensions={"llm": {"accuracy": 0.5}},
                    terminalOutcome="succeeded",
                    executionErrorCount=0,
                )
            ],
            compositeMean=0.5,
            costUsd=0.1,
            durationMs=1000,
        ),
        generations=[
            EvalRunGenerationSnapshot(
                index=1,
                surfaceHash="h-cand",
                cells=[
                    EvalRunCellScore(
                        scenarioId="s1",
                        rep=0,
                        compositeMean=0.8,
                        dimensions={"llm": {"accuracy": 0.8}},
                        terminalOutcome="succeeded",
                        executionErrorCount=0,
                    )
                ],
                compositeMean=0.8,
                costUsd=0.2,
                durationMs=1200,
            ),
        ],
        gateDecision="ship",
        holdoutLift=0.3,
        totalCostUsd=0.3,
        totalDurationMs=2200,
    )


def test_unscored_cell_serializes_null_without_losing_execution_state():
    cell = EvalRunCellScore(
        scenarioId="unscored",
        rep=0,
        compositeMean=None,
        dimensions={},
        terminalOutcome="succeeded",
        executionErrorCount=0,
    )

    payload = cell.model_dump(by_alias=True)
    assert payload["compositeMean"] is None
    assert payload["terminalOutcome"] == "succeeded"
    assert payload["executionErrorCount"] == 0


def test_ingest_eval_run_roundtrip(receiver):
    with HostedClient(endpoint=receiver["url"], api_key=TENANT_KEY, tenant_id=TENANT_ID) as client:
        res = client.ingest_eval_run(_make_run_event("py-1"))
        assert res.accepted == 1
        assert res.rejected == []

    r = httpx.get(
        f"{receiver['url']}/v1/runs",
        headers={
            "Authorization": f"Bearer {TENANT_KEY}",
            "X-Tangle-Tenant-Id": TENANT_ID,
            "X-Tangle-Wire-Version": "2026-07-24.v1",
        },
        timeout=5.0,
    )
    assert r.status_code == 200
    runs = r.json()["runs"]
    assert any(run["runId"] == "py-1" for run in runs)


def test_ingest_traces_roundtrip(receiver):
    with HostedClient(endpoint=receiver["url"], api_key=TENANT_KEY, tenant_id=TENANT_ID) as client:
        client.ingest_eval_run(_make_run_event("py-traces"))
        spans = [
            make_trace_span(
                trace_id="t",
                span_id=f"s-{i}",
                name=f"step-{i}",
                start_time_unix_nano=str(1_700_000_000_000_000_000 + i),
                end_time_unix_nano=str(1_700_000_001_000_000_000 + i),
                attributes={"i": i},
                tangle_run_id="py-traces",
                tangle_generation=1,
                tangle_scenario_id="s1",
            )
            for i in range(3)
        ]
        res = client.ingest_traces(spans)
        assert res.accepted == 3

    r = httpx.get(
        f"{receiver['url']}/v1/runs/py-traces/traces",
        headers={
            "Authorization": f"Bearer {TENANT_KEY}",
            "X-Tangle-Tenant-Id": TENANT_ID,
            "X-Tangle-Wire-Version": "2026-07-24.v1",
        },
        timeout=5.0,
    )
    assert r.status_code == 200
    span_ids = sorted(s["spanId"] for s in r.json()["spans"])
    assert span_ids == ["s-0", "s-1", "s-2"]


def test_adjacent_nanoseconds_round_trip_exactly_between_python_and_typescript(receiver):
    run_id = "py-adjacent-nanoseconds"
    span = make_trace_span(
        trace_id="trace-adjacent",
        span_id="span-adjacent",
        name="adjacent",
        start_time_unix_nano="1700000000000000000",
        end_time_unix_nano="1700000000000000001",
        tangle_run_id=run_id,
    )
    with HostedClient(endpoint=receiver["url"], api_key=TENANT_KEY, tenant_id=TENANT_ID) as client:
        client.ingest_eval_run(_make_run_event(run_id))
        result = client.ingest_traces([span])
        assert result.accepted == 1

    response = httpx.get(
        f"{receiver['url']}/v1/runs/{run_id}/traces",
        headers={
            "Authorization": f"Bearer {TENANT_KEY}",
            "X-Tangle-Tenant-Id": TENANT_ID,
            "X-Tangle-Wire-Version": "2026-07-24.v1",
        },
        timeout=5.0,
    )
    stored = response.json()["spans"][0]

    assert stored["startTimeUnixNano"] == "1700000000000000000"
    assert stored["endTimeUnixNano"] == "1700000000000000001"
    assert int(stored["endTimeUnixNano"]) - int(stored["startTimeUnixNano"]) == 1


def test_rejects_wrong_tenant(receiver):
    client = HostedClient(
        endpoint=receiver["url"],
        api_key=TENANT_KEY,
        tenant_id="not-this-tenant",
        retries=0,
    )
    try:
        with pytest.raises(TransportError, match=re.compile(r"unknown tenant|404", re.IGNORECASE)):
            client.ingest_eval_run(_make_run_event("forge-1"))
    finally:
        client.close()


def test_rejects_bad_bearer(receiver):
    client = HostedClient(
        endpoint=receiver["url"],
        api_key="not-the-real-key",
        tenant_id=TENANT_ID,
        retries=0,
    )
    try:
        with pytest.raises(TransportError, match=re.compile(r"401|invalid bearer", re.IGNORECASE)):
            client.ingest_eval_run(_make_run_event("bad-key"))
    finally:
        client.close()


def test_idempotency(receiver):
    with HostedClient(endpoint=receiver["url"], api_key=TENANT_KEY, tenant_id=TENANT_ID) as client:
        first = client.ingest_eval_run(_make_run_event("idem-py"), idempotency_key="key-py")
        second = client.ingest_eval_run(_make_run_event("idem-py"), idempotency_key="key-py")
        assert first.accepted == second.accepted == 1


def test_endpoint_v1_normalization_matches_typescript():
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_urls.append(str(request.url))
        return httpx.Response(200, json={"accepted": 1, "rejected": []})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        client = HostedClient(
            endpoint="https://example.test/v1/",
            api_key=TENANT_KEY,
            tenant_id=TENANT_ID,
            http_client=http_client,
        )
        client.ingest_eval_run(_make_run_event("normalized-python"))

    assert seen_urls == ["https://example.test/v1/ingest/eval-runs"]


def test_retry_reuses_one_automatic_idempotency_key(monkeypatch):
    keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers["idempotency-key"])
        if len(keys) == 1:
            return httpx.Response(503, json={"error": "temporary"})
        return httpx.Response(200, json={"accepted": 1, "rejected": []})

    monkeypatch.setattr(HostedClient, "_sleep_backoff", staticmethod(lambda _attempt: None))
    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        client = HostedClient(
            endpoint="https://example.test",
            api_key=TENANT_KEY,
            tenant_id=TENANT_ID,
            retries=1,
            http_client=http_client,
        )
        result = client.ingest_eval_run(_make_run_event("python-retry"))

    assert result.accepted == 1
    assert len(keys) == 2
    assert keys[0]
    assert keys[1] == keys[0]


def test_malformed_success_response_is_rejected():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"accepted": -1, "rejected": [42]})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        client = HostedClient(
            endpoint="https://example.test",
            api_key=TENANT_KEY,
            tenant_id=TENANT_ID,
            http_client=http_client,
        )
        with pytest.raises(TransportError, match="invalid response"):
            client.ingest_eval_run(_make_run_event("bad-python-response"))


def test_python_wire_models_reject_invalid_ids_timestamps_costs_and_durations():
    payload = _make_run_event("strict-python").model_dump(mode="json", by_alias=True)

    for field, invalid in (
        ("runId", ""),
        ("timestamp", "2026-07-24T12:00:00"),
        ("totalCostUsd", -0.01),
        ("totalDurationMs", -1),
    ):
        malformed = {**payload, field: invalid}
        with pytest.raises(ValueError, match=field):
            EvalRunEvent.model_validate(malformed)

    with pytest.raises(ValueError, match="scenarioId"):
        EvalRunCellScore(
            scenarioId=" ",
            rep=0,
            compositeMean=0.5,
            dimensions={},
            terminalOutcome="succeeded",
            executionErrorCount=0,
        )

    from agent_eval_rpc import TraceSpanEventOuter

    with pytest.raises(ValueError, match="traceId"):
        TraceSpanEventOuter(
            traceId="",
            spanId="span",
            name="dispatch",
            startTimeUnixNano="0",
            endTimeUnixNano="1",
            attributes={},
        )
    with pytest.raises(ValueError, match="startTimeUnixNano"):
        TraceSpanEventOuter(
            traceId="trace",
            spanId="span",
            name="dispatch",
            startTimeUnixNano=1,
            endTimeUnixNano="2",
            attributes={},
        )
    with pytest.raises(ValueError, match="endTimeUnixNano"):
        TraceSpanEventOuter(
            traceId="trace",
            spanId="span",
            name="dispatch",
            startTimeUnixNano="0",
            endTimeUnixNano="18446744073709551616",
            attributes={},
        )


def test_snake_case_typo_is_rejected():
    with pytest.raises(ValueError, match="run_id"):
        EvalRunEvent(
            runId="r1",
            runDir="/r1",
            timestamp="2026-05-27T00:00:00Z",
            status="finished",
            labels={},
            generations=[],
            totalCostUsd=0,
            totalDurationMs=0,
            run_id="r1-typo",
        )


def test_hosted_model_required_fields_match_typescript_contract():
    assert set(EvalRunCellScore.model_json_schema()["required"]) == {
        "scenarioId",
        "rep",
        "compositeMean",
        "dimensions",
        "terminalOutcome",
        "executionErrorCount",
    }
    assert set(EvalRunGenerationSnapshot.model_json_schema()["required"]) == {
        "index",
        "surfaceHash",
        "cells",
        "compositeMean",
        "costUsd",
        "durationMs",
    }
    assert set(EvalRunEvent.model_json_schema()["required"]) == {
        "runId",
        "runDir",
        "timestamp",
        "status",
        "labels",
        "generations",
        "totalCostUsd",
        "totalDurationMs",
    }


def test_insight_report_round_trips_as_structured_data():
    event = _make_run_event("py-insight")
    event.insightReport = {
        "n": 1,
        "execution": {
            "executionErrors": {"fraction": None, "reportingRuns": 0},
            "terminalOutcomes": {"succeeded": 1},
        },
    }

    payload = event.model_dump(by_alias=True, exclude_none=True)
    restored = EvalRunEvent.model_validate(payload)

    assert restored.insightReport == event.insightReport


def test_trace_span_outer_round_trips_tangle_fields():
    """TraceSpanEventOuter exposes tangle.* pivots via field aliases.

    Pydantic forbids dotted attribute names, so the pivots are declared as
    ``tangle_run_id`` / ``tangle_scenario_id`` / etc. with the dotted alias,
    and round-trip cleanly via ``model_dump(by_alias=True)``.
    """
    from agent_eval_rpc import TraceSpanEventOuter

    span = TraceSpanEventOuter(
        traceId="t",
        spanId="s",
        name="dispatch",
        startTimeUnixNano="0",
        endTimeUnixNano="1",
        attributes={},
        tangle_run_id="run-1",
        tangle_scenario_id="s1",
        tangle_generation=2,
        tangle_cell_id="cell-3",
    )
    dumped = span.model_dump(by_alias=True, exclude_none=True)
    assert dumped["tangle.runId"] == "run-1"
    assert dumped["tangle.scenarioId"] == "s1"
    assert dumped["tangle.generation"] == 2
    assert dumped["tangle.cellId"] == "cell-3"

    # Validate the dump round-trips back through the model.
    restored = TraceSpanEventOuter.model_validate(dumped)
    assert restored.tangle_run_id == "run-1"
    assert restored.tangle_scenario_id == "s1"
