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
                    scenarioId="s1", rep=0, compositeMean=0.5, dimensions={"llm": {"accuracy": 0.5}}
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
            "X-Tangle-Wire-Version": "2026-05-26.v1",
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
                start_time_unix_nano=1_700_000_000_000_000_000 + i,
                end_time_unix_nano=1_700_000_001_000_000_000 + i,
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
            "X-Tangle-Wire-Version": "2026-05-26.v1",
        },
        timeout=5.0,
    )
    assert r.status_code == 200
    span_ids = sorted(s["spanId"] for s in r.json()["spans"])
    assert span_ids == ["s-0", "s-1", "s-2"]


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


def test_snake_case_typo_warns():
    """Cross-language drift guard: passing run_id (snake_case) emits a warning.

    The TS server expects ``runId`` on the wire; Python ``extra='allow'``
    would silently send ``run_id`` and the server would reject it. The
    warning gives users a same-process signal instead of a server error.
    """
    import warnings as _w

    with _w.catch_warnings(record=True) as caught:
        _w.simplefilter("always")
        EvalRunEvent(
            runId="r1",
            runDir="/r1",
            timestamp="2026-05-27T00:00:00Z",
            status="finished",
            run_id="r1-typo",  # snake_case shadow of runId — should warn
        )
    user_warnings = [w for w in caught if issubclass(w.category, UserWarning)]
    assert len(user_warnings) == 1
    msg = str(user_warnings[0].message)
    assert "run_id" in msg
    assert "runId" in msg


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
        startTimeUnixNano=0,
        endTimeUnixNano=1,
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
