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

import shutil
from pathlib import Path

import pytest

from agent_eval_rpc import Client, RubricNotFoundError, ValidationError

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
    """Regression: server returns 404; client must raise the typed error, not bubble TransportError."""
    c = _client()
    with pytest.raises(RubricNotFoundError):
        c.judge(content="hello world", rubric_name="no-such-rubric-xyz")


def test_judge_empty_content_raises_ValidationError() -> None:
    """Regression: pydantic should catch this before subprocess fires."""
    c = _client()
    with pytest.raises((ValidationError, ValueError)):
        c.judge(content="", rubric_name="anti-slop")
