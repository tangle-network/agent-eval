"""Integration tests against the real `agent-eval rpc` binary.

These run end-to-end against the bundled CLI in this repo's `dist/`.
We exercise every method that doesn't need a live LLM:
  - version
  - listRubrics
  - judge with no rubric (validation error path)
  - judge with bad rubric_name (rubric_not_found path)

Live judge calls (which DO hit an LLM) live in test_live_judge.py and
are gated by the AGENT_EVAL_LIVE=1 env var.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from agent_eval_rpc import (
    Client,
    Rubric,
    RubricDimension,
    RubricNotFoundError,
    ValidationError,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI_DIST = REPO_ROOT / "dist" / "cli.js"

pytestmark = pytest.mark.skipif(
    not CLI_DIST.exists(),
    reason="run `pnpm build` in agent-eval root before these tests",
)


def _client() -> Client:
    """Subprocess client that invokes the bundled CLI directly via node."""

    class _NodeWrappedClient(Client):
        def _subprocess_call(self, method: str, params):  # type: ignore[override]
            import json
            import subprocess

            proc = subprocess.run(
                ["node", str(CLI_DIST), "rpc", method],
                input=json.dumps(params),
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
                check=False,
            )
            if not proc.stdout:
                raise RuntimeError(f"no stdout. stderr: {proc.stderr}")
            envelope = json.loads(proc.stdout.strip().splitlines()[-1])
            if "error" in envelope:
                from agent_eval_rpc.errors import from_error_body

                raise from_error_body(proc.returncode or 500, envelope)
            return envelope["result"]

    c = _NodeWrappedClient(transport="subprocess")
    # Override the resolved transport to bypass shutil.which check
    c._transport = "subprocess"  # type: ignore[assignment]
    return c


def test_version_via_subprocess() -> None:
    c = _client()
    v = c.version()
    assert v.package == "@tangle-network/agent-eval"
    assert v.version
    assert "judge" in v.api_surface


def test_list_rubrics_includes_anti_slop() -> None:
    c = _client()
    rubrics = c.list_rubrics()
    names = [r.name for r in rubrics.rubrics]
    assert "anti-slop" in names


def test_judge_unknown_rubric_name_raises_RubricNotFoundError() -> None:
    """A missing rubric raises the typed client error."""
    c = _client()
    with pytest.raises(RubricNotFoundError):
        c.judge(content="hello world", rubric_name="no-such-rubric-xyz")


def test_judge_empty_content_raises_ValidationError() -> None:
    """Regression: pydantic should catch this before subprocess fires."""
    c = _client()
    with pytest.raises((ValidationError, ValueError)):
        c.judge(content="", rubric_name="anti-slop")


def test_judge_uses_provider_configuration_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[dict[str, object]] = []

    class ProviderHandler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length))
            requests.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("authorization"),
                    "body": body,
                }
            )
            payload = {
                "model": body["model"],
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "dimensions": {"quality": 0.8},
                                    "failureModes": [],
                                    "wins": [],
                                    "rationale": "Clear.",
                                }
                            )
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
            encoded = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv(
            "AGENT_EVAL_LLM_BASE_URL",
            f"http://127.0.0.1:{server.server_port}/v1",
        )
        monkeypatch.setenv("AGENT_EVAL_LLM_API_KEY", "provider-key")
        monkeypatch.setenv("AGENT_EVAL_LLM_MODEL", "provider-model")

        result = _client().judge(
            content="hello",
            rubric=Rubric(
                name="quality",
                description="Quality",
                systemPrompt="Score quality.",
                dimensions=[RubricDimension(id="quality", description="Quality")],
            ),
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.composite == 0.8
    assert len(requests) == 1
    request = requests[0]
    assert request["path"] == "/v1/chat/completions"
    assert request["authorization"] == "Bearer provider-key"
    body = request["body"]
    assert isinstance(body, dict)
    assert body["model"] == "provider-model"
