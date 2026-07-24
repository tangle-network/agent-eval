"""Build and account for the official GEPA reflection model."""

from __future__ import annotations

import copy
import math
import threading
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class _ProxyUsage:
    models: list[Any] = field(default_factory=list)
    clients: list[httpx.Client] = field(default_factory=list)
    calls: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def observe_request(self, _request: httpx.Request) -> None:
        with self.lock:
            self.calls += 1

    def register(self, model: Any, client: httpx.Client) -> None:
        with self.lock:
            self.models.append(model)
            self.clients.append(client)

    def snapshot(self) -> dict[str, int | float]:
        with self.lock:
            models = list(self.models)
            calls = self.calls
        input_tokens = sum(int(model.total_tokens_in) for model in models)
        output_tokens = sum(int(model.total_tokens_out) for model in models)
        return {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": input_tokens + output_tokens,
            "calls": calls,
            "costUsd": sum(float(model.total_cost) for model in models),
        }

    def close(self) -> None:
        with self.lock:
            clients = list(self.clients)
            self.clients.clear()
        for client in clients:
            client.close()


def _official_reflection_model(
    *,
    config: dict[str, Any],
    options: dict[str, Any],
    shared_usage: _ProxyUsage,
) -> Any:
    from gepa.lm import LM
    from openai import OpenAI

    budget = config["budget"]
    request_options = _validated_reflection_options(options, budget)
    pricing = budget["pricing"]
    request_options["input_cost_per_token"] = pricing["inputUsdPerMillion"] / 1_000_000
    request_options["output_cost_per_token"] = pricing["outputUsdPerMillion"] / 1_000_000
    request_timeout = budget.get("requestTimeoutMs", 300_000) / 1000
    http_client = httpx.Client(
        event_hooks={"request": [shared_usage.observe_request]},
        timeout=request_timeout,
    )
    try:
        openai_client = OpenAI(
            api_key=config["apiKey"],
            base_url=config["baseUrl"],
            http_client=http_client,
            max_retries=0,
            timeout=request_timeout,
        )
        request_options.update(
            {
                "api_base": config["baseUrl"],
                "api_key": config["apiKey"],
                "client": openai_client,
            }
        )
        model = LM(f"openai/{config['model']}", **request_options)
    except BaseException:
        http_client.close()
        raise
    shared_usage.register(model, http_client)
    return model


def _validated_reflection_options(
    options: dict[str, Any],
    budget: dict[str, Any],
) -> dict[str, Any]:
    request_options = copy.deepcopy(options)
    reserved_options = {
        "api_base",
        "api_key",
        "api_url",
        "base_url",
        "client",
        "endpoint",
        "input_cost_per_token",
        "messages",
        "model",
        "output_cost_per_token",
        "stream",
    }
    if reserved_options.intersection(request_options):
        raise ValueError("GEPA proxied reflection transport settings belong in modelProxy")

    output_limits = [
        request_options[key]
        for key in ("max_tokens", "max_completion_tokens", "max_output_tokens")
        if key in request_options
    ]
    if any(
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or limit <= 0
        or limit > budget["maxOutputTokensPerRequest"]
        for limit in output_limits
    ):
        raise ValueError(
            "GEPA proxied reflection max tokens must be positive integers "
            "within modelProxy.budget.maxOutputTokensPerRequest"
        )
    request_options.setdefault(
        "max_tokens",
        max(output_limits, default=budget["maxOutputTokensPerRequest"]),
    )

    request_timeout = budget.get("requestTimeoutMs", 300_000) / 1000
    for key in ("timeout", "request_timeout"):
        configured_timeout = request_options.get(key)
        if configured_timeout is not None and (
            isinstance(configured_timeout, bool)
            or not isinstance(configured_timeout, (int, float))
            or not math.isfinite(configured_timeout)
            or configured_timeout <= 0
            or configured_timeout > request_timeout
        ):
            raise ValueError(
                f"GEPA reflection_lm_kwargs.{key} must be positive and no greater "
                "than modelProxy.budget.requestTimeoutMs"
            )
    request_options.setdefault("timeout", request_timeout)
    return request_options
