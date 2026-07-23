# `agent-eval-rpc` Python Client

`agent-eval-rpc` lets Python programs call the judging and ingestion APIs implemented by `@tangle-network/agent-eval`.
The Python package validates requests and responses with Pydantic.
The Node package owns rubric execution, model calls, and scoring.

## Install

Python 3.10 or newer and Node.js 20 or newer are required.
Install matching package versions:

```sh
pip install agent-eval-rpc
npm install --global @tangle-network/agent-eval
```

Configure an OpenAI-compatible model endpoint for judge calls:

```sh
export AGENT_EVAL_LLM_BASE_URL=https://api.openai.com/v1
export AGENT_EVAL_LLM_API_KEY="$YOUR_API_KEY"
export AGENT_EVAL_LLM_MODEL=gpt-4.1-mini
```

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` are also accepted.
The endpoint receives the content, rubric, and context passed to `client.judge()`.

## Judge Content

```python
from agent_eval_rpc import Client

client = Client()
result = client.judge(
    content="The retry budget is checked before each provider call.",
    rubric_name="anti-slop",
)

print(result.composite)
print(result.dimensions)
print(result.failure_modes)
print(result.rationale)
```

`Client()` first checks for an HTTP server at `http://127.0.0.1:5005`.
If none is running, it invokes `agent-eval rpc` as a subprocess.
Inspect `client.transport` to see which path was selected.

For repeated or concurrent calls, start the server once:

```sh
agent-eval serve --port 5005
```

Then force HTTP from Python when desired:

```python
client = Client(transport="http", base_url="http://127.0.0.1:5005")
```

## Define A Rubric

Use a built-in rubric by name or pass an inline rubric.
Exactly one is required.

```python
from agent_eval_rpc import Client, FailureMode, Rubric, RubricDimension

rubric = Rubric(
    name="commit-message",
    description="Checks whether a commit message explains why the change exists.",
    systemPrompt="Score the commit message using the supplied response schema.",
    dimensions=[
        RubricDimension(
            id="explains_why",
            description="The message states the reason for the change.",
            weight=1.0,
        ),
    ],
    failureModes=[
        FailureMode(
            id="what-only",
            description="The message states the edit without its reason.",
        ),
    ],
)

result = Client().judge(content="fix retry accounting", rubric=rubric)
```

List the built-in rubrics and their version hashes:

```python
for rubric in Client().list_rubrics().rubrics:
    print(rubric.name, rubric.rubric_version)
```

## Client Options

```python
Client(
    base_url: str | None = None,
    cli_path: str | None = None,
    transport: "auto" | "http" | "subprocess" = "auto",
    timeout_s: float = 200.0,
)
```

`client.judge()` returns:

| Field | Meaning |
|---|---|
| `composite` | Weighted score from `0` to `1` |
| `dimensions` | Score for each rubric dimension |
| `failure_modes` | Detected negative-pattern IDs |
| `wins` | Detected positive-pattern IDs |
| `rationale` | Model explanation |
| `rubric_version` | Stable rubric hash used for comparison |
| `model` | Model reported by the provider |
| `duration_ms` | Total call duration |

## Hosted Event Ingestion

`HostedClient` sends evaluation events and trace spans to a server that implements the hosted ingest format.
This is separate from `Client`, which calls the local judging API.

```python
from agent_eval_rpc import HostedClient

with HostedClient(
    endpoint="https://your-ingest.example",
    api_key="tenant-token",
    tenant_id="acme",
) as client:
    response = client.ingest_eval_run(event)
    assert response.accepted == 1
```

Review [`hosted.py`](./src/agent_eval_rpc/hosted.py) for the typed event fields and retry behavior.
The event payload can include run paths, scenario IDs, candidate values, scores, errors, costs, summaries, and trace attributes.

## Optional GEPA Candidate Search

Install `agent-eval-rpc[gepa]` to use `gepaOptimizationMethod()` from the Node campaign API.
This extra pins GEPA commit `f919db0` because the published `gepa==0.1.4` package does not yet include its four-engine Optimize Anything API.
The Python bridge calls GEPA's own Optimize Anything recipes for text candidates, then calls a loopback endpoint that runs the real TypeScript agent and judges.
It starts GEPA in an empty run directory and gives it only caller-described train and selection cases.
`compareOptimizationMethods()` keeps final test cases in Node and scores them after GEPA exits.

The bridge maps the documented Omni shape directly to GEPA's `optimize_best_of()` followed by `optimize_anything()`.
It does not reproduce GEPA's search loop.
Each GEPA engine run requires its own evaluation limit and proposer-dollar cap.
GEPA's proposer cost is still reported separately from agent-eval's receipt log, so method comparisons mark its cost accounting incomplete rather than treating a reported zero as confirmed spend.

## Errors

| Exception | Meaning |
|---|---|
| `ValidationError` | The request does not match the Python or server schema |
| `RubricNotFoundError` | The named built-in rubric does not exist |
| `TransportError` | The HTTP server or subprocess could not be reached |
| `AgentEvalError` | Base class for client errors |

Errors include `.code` and `.details` when the server returned structured error data.

## Versions

The Python and npm packages are released with the same version.
Use `client.version()` to check the running Node package and wire-format version:

```python
version = Client().version()
print(version.version, version.wire_version)
```

## Development

```sh
cd clients/python
pip install -e ".[dev]"
pytest
```

Run the cross-language tests after building the Node package:

```sh
cd ../..
pnpm build
cd clients/python
pytest
```

The runnable Python example is [`examples/judge_anti_slop.py`](./examples/judge_anti_slop.py).
