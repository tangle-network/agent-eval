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

## Official Optimizer Bridges

The TypeScript campaign API can run official GEPA and SkillOpt through this package.
The Python client does not reimplement either algorithm.

### GEPA

Install the client and the exact GEPA source revision tested by Agent Eval:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "gepa[full] @ git+https://github.com/gepa-ai/gepa.git@f919db0a622e2e9f9204779b81fe00cc1b2d808f"
```

The published `gepa==0.1.4` wheel does not contain the Optimize Anything API used by `gepaOptimizationMethod()`.
PyPI package metadata cannot depend directly on a Git URL, so GEPA is a separate install.

From an Agent Eval source checkout, install the same revision with:

```sh
uv sync --frozen --group gepa-source
```

The bridge calls GEPA's official engine and composition functions.
It supports direct engine, sequential, adaptive sequential, best-of, vote, and Omni recipes.
GEPA receives only the serialized train and selection cases supplied by the caller.
`compareOptimizationMethods()` keeps final cases in TypeScript and evaluates them only after GEPA exits.

Every engine run requires an evaluation limit and an optimizer-model dollar limit.
Agent Eval enforces callback counts before executing an agent or judge.
For standard GEPA engines, the TypeScript `optimizer` option routes reflection through Agent Eval's local model proxy.
The proxy enforces whole-run request and dollar limits, keeps the provider key out of Python, and records exact provider usage in the shared cost log.
Other official GEPA engines can still receive their native configuration.
Their external model spend remains incomplete unless that engine reports it.

### SkillOpt

Install the client and the exact SkillOpt source revision tested by Agent Eval:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "skillopt @ git+https://github.com/microsoft/SkillOpt.git@61735e3922efc2b90c6d6cab561e62e98452ca90"
```

From an Agent Eval source checkout, install the locked package with:

```sh
uv sync --frozen --group skillopt-source
```

The published `skillopt==0.2.0` wheel omits the 21 prompt files required by `ReflACTTrainer`.
The source revision contains those files and is checked before each release.

`skillOptOptimizationMethod()` runs SkillOpt's `ReflACTTrainer` with an Agent Eval environment adapter.
The adapter sends candidate and case pairs back to the TypeScript process for execution and scoring.
It disables SkillOpt's test split because final cases remain private to `compareOptimizationMethods()`.

The TypeScript method requires:

- an OpenAI-compatible endpoint and key in `runner.env`,
- exact input and output rates,
- maximum model dollars, requests, request bytes, response bytes, and output tokens,
- a maximum candidate evaluation count.

Agent Eval starts a local proxy, gives SkillOpt only the proxy credential, checks every request before forwarding it, and records provider token usage in the shared cost log.
Missing provider usage fails the run instead of assuming zero cost.

### DSPy

DSPy programs should use DSPy's official optimizers directly.
Install DSPy 3.2.1 and the Agent Eval metric adapter with:

```sh
python -m pip install "agent-eval-rpc[dspy]"
```

```python
import dspy

from agent_eval_rpc import DspyJudgeMetric

metric = DspyJudgeMetric(rubric_name="answer-quality")

gepa = dspy.GEPA(
    metric=metric.feedback,
    reflection_lm=dspy.LM("openai/gpt-4.1-mini"),
    max_metric_calls=100,
)
optimized = gepa.compile(program, trainset=train, valset=selection)

mipro = dspy.MIPROv2(metric=metric, auto="light")
```

Use `metric.feedback` for `dspy.GEPA`.
It returns `dspy.Prediction(score=..., feedback=...)` with dimension scores, failure modes, wins, and rationale.
Use the metric object directly for MIPROv2, SIMBA, bootstrap, and evaluation APIs that expect a number.
Identical calls share one judge result, including concurrent calls.

DSPy 3.2.1 pins GEPA 0.0.27.
The general Optimize Anything bridge uses GEPA 0.1.4, so repository checks install them in separate environments:

```sh
uv sync --frozen --extra dev --group skillopt-source --group gepa-source
uv run --frozen pytest

uv sync --frozen --extra dev --extra dspy
uv run --frozen pytest tests/test_dspy_metric.py
```

The bridge records the installed upstream package version and source revision with each run.
SkillOpt and a direct GEPA engine can restore official state only when the package revision, settings, starting candidate, described data, evaluation revision, and seed match.
Composed GEPA recipes restart and never claim that upstream state was restored.

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
