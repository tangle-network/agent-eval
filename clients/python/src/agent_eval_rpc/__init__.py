"""agent-eval-rpc — Python RPC client for @tangle-network/agent-eval.

The TypeScript package is the source of truth for evaluation logic. This
client is a thin transport adapter — every judgement runs in the Node
runtime, marshalled over HTTP or stdio RPC. Two languages, one
implementation.

The package distributes as ``agent-eval-rpc`` on PyPI and imports as
``agent_eval_rpc`` to make the wire-client nature explicit; the rubric
logic lives upstream in ``@tangle-network/agent-eval`` on npm.

Quickstart
----------

    from agent_eval_rpc import Client

    client = Client()  # auto-detects HTTP server, falls back to subprocess
    result = client.judge(content="our scaffold supports zero-copy IO", rubric_name="anti-slop")
    print(result.composite, result.failure_modes)

Or as a one-shot using the bundled `agent-eval` CLI:

    result = client.judge(content="…", rubric={"name": "custom", ...})

See README.md for the full guide.
"""

from importlib.metadata import PackageNotFoundError, version

from .client import Client
from .errors import (
    AgentEvalError,
    RubricNotFoundError,
    TransportError,
    ValidationError,
)
from .models import (
    FailureMode,
    JudgeRequest,
    JudgeResult,
    ListRubricsResponse,
    Rubric,
    RubricDimension,
    RubricInfo,
    VersionResponse,
)

try:
    __version__ = version("agent-eval-rpc")
except PackageNotFoundError:
    __version__ = "0.27.2"

__all__ = [
    "Client",
    "AgentEvalError",
    "TransportError",
    "RubricNotFoundError",
    "ValidationError",
    "JudgeRequest",
    "JudgeResult",
    "Rubric",
    "RubricDimension",
    "FailureMode",
    "RubricInfo",
    "ListRubricsResponse",
    "VersionResponse",
]
