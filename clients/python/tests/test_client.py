from __future__ import annotations

from typing import Any

import httpx
import pytest

from agent_eval_rpc import Client, TransportError
from agent_eval_rpc.client import DEFAULT_TIMEOUT_S


class _FakeHttpClient:
    def __init__(self, response: httpx.Response, calls: list[str], **_kwargs: Any) -> None:
        self.response = response
        self.calls = calls

    def __enter__(self) -> _FakeHttpClient:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def get(self, url: str) -> httpx.Response:
        self.calls.append(url)
        return self.response


def test_auto_transport_identifies_agent_eval_through_version_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    response = httpx.Response(
        200,
        json={
            "package": "@tangle-network/agent-eval",
            "version": "0.123.1",
            "wireVersion": "1.0.0",
            "apiSurface": ["judge"],
        },
    )
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: _FakeHttpClient(response, calls, **kwargs),
    )

    client = Client(base_url="http://127.0.0.1:5111")

    assert client.transport == "http"
    assert calls == ["http://127.0.0.1:5111/v1/version"]


def test_auto_transport_rejects_an_unrelated_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    response = httpx.Response(
        200,
        json={
            "package": "another-service",
            "version": "1.0.0",
            "wireVersion": "1.0.0",
            "apiSurface": [],
        },
    )
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: _FakeHttpClient(response, calls, **kwargs),
    )
    monkeypatch.setattr("agent_eval_rpc.client.shutil.which", lambda _path: None)

    with pytest.raises(TransportError, match="another-service"):
        Client(base_url="http://127.0.0.1:5111")

    assert calls == ["http://127.0.0.1:5111/v1/version"]


def test_default_timeout_covers_all_provider_attempts() -> None:
    assert DEFAULT_TIMEOUT_S == 200.0
