"""tangle-agent-eval — Python client for @tangle-network/agent-eval.

The TypeScript package is the source of truth for evaluation logic. This
client is a thin transport adapter — every judgement runs in the Node
runtime, marshalled over HTTP or stdio RPC. Two languages, one
implementation.

Quickstart
----------

    from tangle_agent_eval import Client

    client = Client()  # auto-detects HTTP server, falls back to subprocess
    result = client.judge(content="our scaffold supports zero-copy IO", rubric_name="anti-slop")
    print(result.composite, result.failure_modes)

Or as a one-shot using the bundled `agent-eval` CLI:

    result = client.judge(content="…", rubric={"name": "custom", ...})

See README.md for the full guide.
"""

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

__version__ = "0.19.0"

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
