"""Python integrations for @tangle-network/agent-eval.

The package provides the judging client, a native DSPy metric, and process
bridges for official GEPA and SkillOpt. TypeScript remains responsible for
agent execution, case separation, scoring, cost records, and final comparison.

The package distributes as ``agent-eval-rpc`` on PyPI and imports as
``agent_eval_rpc``.

Quickstart
----------

    from agent_eval_rpc import Client

    client = Client()  # auto-detects HTTP server, falls back to subprocess
    result = client.judge(content="our scaffold supports zero-copy IO", rubric_name="anti-slop")
    print(result.composite, result.failure_modes)

See README.md for the full guide.
"""

from importlib.metadata import PackageNotFoundError, version

from .client import Client
from .dspy_metric import DspyContentBuilder, DspyContextBuilder, DspyJudgeMetric
from .errors import (
    AgentEvalError,
    RubricNotFoundError,
    TransportError,
    ValidationError,
)
from .hosted import (
    HOSTED_WIRE_VERSION,
    EvalRunCellScore,
    EvalRunEvent,
    EvalRunGenerationSnapshot,
    HostedClient,
    IngestResponse,
    TraceSpanEventOuter,
    make_trace_span,
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
    __version__ = "0.126.1"

__all__ = [
    "Client",
    "DspyJudgeMetric",
    "DspyContentBuilder",
    "DspyContextBuilder",
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
    # Hosted-tier ingest (mirrors @tangle-network/agent-eval/hosted)
    "HostedClient",
    "HOSTED_WIRE_VERSION",
    "EvalRunEvent",
    "EvalRunGenerationSnapshot",
    "EvalRunCellScore",
    "TraceSpanEventOuter",
    "IngestResponse",
    "make_trace_span",
]
