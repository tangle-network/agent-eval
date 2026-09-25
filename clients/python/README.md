# `agent-eval-rpc` Python Client

`agent-eval-rpc` lets Python programs call the judging and ingestion APIs implemented by `@tangle-network/agent-eval`.
The Python package validates requests and responses with Pydantic.
The Node package owns rubric execution, model calls, and scoring.

## Install

Python 3.10 or newer and Node.js 20.19 or newer are required.
Install matching package versions:

```sh
pip install agent-eval-rpc
npm install --global @tangle-network/agent-eval
```

Configure an OpenAI-compatible model endpoint for judge calls:

```sh
export AGENT_EVAL_LLM_BASE_URL=https://api.openai.com/v1
export AGENT_EVAL_LLM_API_KEY="$YOUR_API_KEY"
export AGENT_EVAL_LLM_MODEL="$YOUR_MODEL_ID"
```

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` are also accepted.
The endpoint receives the content, rubric, and context passed to `client.judge()`.

The CLI resolves provider settings from environment variables.
An `OPENAI_API_KEY` or `TANGLE_API_KEY` can select that provider's default endpoint.
Set `AGENT_EVAL_LLM_BASE_URL` and `AGENT_EVAL_LLM_API_KEY` to make the route explicit.
TypeScript callers supply their transport, endpoint, and credentials directly.
Without a resolved endpoint and credential, `judge()` fails with `llm_not_configured`.

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
client = Client(
    base_url="http://127.0.0.1:5005",
    cli_path="agent-eval",
    transport="auto",
    timeout_s=200.0,
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

## Hosted Trace Ingestion

`HostedClient` sends trace spans to a server that implements the hosted ingest format.
This is separate from `Client`, which calls the local judging API.
Search ledgers ship from TypeScript with `agent-eval search ship`, because the TypeScript package writes them.

```python
from agent_eval_rpc import HostedClient, make_trace_span

with HostedClient(
    endpoint="https://your-ingest.example",
    api_key="tenant-token",
    tenant_id="acme",
) as client:
    response = client.ingest_traces([make_trace_span(
        trace_id="t-1", span_id="s-1", name="dispatch",
        start_time_unix_nano="1700000000000000000",
        end_time_unix_nano="1700000001000000000",
        tangle_run_id="run-1",
    )])
    assert response.accepted == 1
```

Review [`hosted.py`](./src/agent_eval_rpc/hosted.py) for the typed span fields and retry behavior.
The client waits for a server's `Retry-After` before it retries a 408, 429, or 5xx response.
Span attributes can include run IDs, scenario IDs, and any values the producer adds.

## Official Optimizer Bridges

The TypeScript campaign API can run official GEPA and SkillOpt through this package.
The Python client does not reimplement either algorithm.

### GEPA

Install the client and published GEPA package for the standard engine:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "gepa==0.1.4" \
  "litellm>=1.83.0,<1.92" \
  "tqdm>=4.66.1" \
  "cloudpickle>=3.0.0" \
  "datasets>=2.14.6" \
  "wandb"
```

Install these packages instead of `gepa[full]` because the full extra includes the unpatched MLflow server dependency.

The published package runs direct recipes with the standard `gepa` engine.
Sequential, adaptive, best-of, vote, Omni, AutoResearch, Meta Harness, and Best-of-N currently require this tested official source revision:

```sh
python -m pip install \
  "gepa @ git+https://github.com/gepa-ai/gepa.git@f919db0a622e2e9f9204779b81fe00cc1b2d808f" \
  "litellm>=1.83.0,<1.92" \
  "tqdm>=4.66.1" \
  "cloudpickle>=3.0.0" \
  "datasets>=2.14.6" \
  "wandb"
```

From `clients/python` in an Agent Eval source checkout, choose the required environment:

```sh
uv sync --frozen --group gepa-release
# For source-only engines or compositions, use this instead:
uv sync --frozen --group gepa-source
```

The bridge calls GEPA's official engine and composition functions.
It supports direct engine, sequential, adaptive sequential, best-of, vote, and Omni recipes.
The bridge forwards the run seed into every standard `gepa` engine configuration at `engine.seed`.
Agent engines accept no seed parameter, so the output reports `seedApplied: false` for recipes that include one.
A caller-supplied `engineConfig.engine.seed` is rejected because the run seed owns that field.
GEPA receives only the serialized train and selection cases supplied by the caller.
`compareOptimizationMethods()` keeps final cases in TypeScript and evaluates them only after GEPA exits.
For a direct standard engine, the bridge writes a digest-addressed candidate population artifact.
The artifact preserves GEPA's candidate indices, parent indices, selection scores, and discovery evaluation counts.
It does not include final cases or large rollout outputs.

Every engine run requires an evaluation limit and an optimizer-model dollar limit.
Agent Eval enforces callback counts before executing an agent or judge.
For standard GEPA engines, the TypeScript `optimizer` option routes reflection through Agent Eval's local model proxy.
The proxy enforces whole-run request and dollar limits, keeps the provider key out of Python, and records exact provider usage in the shared cost log.
With `optimizer.anthropicEndpoint: true`, the AutoResearch and Meta Harness agent engines run fully metered too: the proxy serves an Anthropic Messages route, and every `claude` CLI call is admitted, receipted, and budget-enforced.
The canonical description of that path is [`docs/campaign-proposers.md`](../../docs/campaign-proposers.md#metered-agent-cli-engines).
An unproxied engine can still receive its native configuration; its external model spend remains incomplete unless that engine reports it.

### SkillOpt

Install the client and the exact SkillOpt source revision tested by Agent Eval:

```sh
python -m pip install agent-eval-rpc
python -m pip install \
  "skillopt @ git+https://github.com/microsoft/SkillOpt.git@61735e3922efc2b90c6d6cab561e62e98452ca90"
```

From `clients/python` in an Agent Eval source checkout, install the locked package with:

```sh
uv sync --frozen --group skillopt-source
```

The published `skillopt==0.2.0` wheel omits the 21 prompt files required by `ReflACTTrainer`.
The source revision contains those files and is checked before each release.

`skillOptOptimizationMethod()` runs SkillOpt's `ReflACTTrainer` with an Agent Eval environment adapter.
The adapter sends candidate and case pairs back to the TypeScript process for execution and scoring.
It disables SkillOpt's test split because final cases remain private to `compareOptimizationMethods()`.

The TypeScript method requires:

- an OpenAI-compatible endpoint and key in the TypeScript method's `optimizer` option,
- exact input and output rates,
- maximum model dollars, requests, request bytes, response bytes, and output tokens,
- a maximum candidate evaluation count.

Agent Eval starts a local proxy, gives SkillOpt only the proxy credential, checks every request before forwarding it, and records provider token usage in the shared cost log.
Before optimization starts, it records and hashes the installed optimizer source, bridge source, Python runtime, runner settings, endpoint settings, data, and evaluation ID into one run ID.
The Python process checks that identity again before it restores any state.
Missing provider usage fails the run instead of assuming zero cost.

### DSPy

Install DSPy 3.2.1 and the Agent Eval adapters with:

```sh
python -m pip install "agent-eval-rpc[dspy]"
```

```python
import os

import dspy

from agent_eval_rpc import DspyJudgeMetric

dspy.configure_cache(restrict_pickle=True)
metric = DspyJudgeMetric(rubric_name="answer-quality")

gepa = dspy.GEPA(
    metric=metric.feedback,
    reflection_lm=dspy.LM(os.environ["DSPY_REFLECTION_MODEL"]),
    max_metric_calls=100,
)
optimized = gepa.compile(program, trainset=train, valset=selection)

mipro = dspy.MIPROv2(metric=metric, auto="light")
```

Set `DSPY_REFLECTION_MODEL` to your configured DSPy model identifier, including its provider prefix.
Use `metric.feedback` for `dspy.GEPA`.
It returns `dspy.Prediction(score=..., feedback=...)` with dimension scores, failure modes, wins, and rationale.
Use the metric object directly for MIPROv2, SIMBA, bootstrap, and evaluation APIs that expect a number.
Identical calls share one judge result, including concurrent calls.
`DspyJudgeMetric` rejects DSPy's default unrestricted disk-cache pickle handling.
Configure the official restricted cache as shown above, or call `dspy.configure_cache(enable_disk_cache=False)` before creating the metric.

DSPy programs should use DSPy's official optimizers directly.
Agent Eval also runs the official `dspy.RLM` for recursive trace analysis.
The TypeScript API starts the Python bridge, provides authenticated trace tools, calls a caller-owned model execution path, enforces model and trace-read limits, and validates cited findings.
The Python bridge owns no trace storage or model credentials.

### The raw-finding wire contract

Both languages decode a findings array with the same rules.
`agent_eval_rpc.finding_codec.decode_raw_finding_array(value)` returns `(accepted, rejected)`.
It validates against `finding_contract.json`, which `pnpm run contract:finding` generates from the TypeScript schema and CI checks byte-for-byte, so neither side keeps a hand-written copy.

- A row TypeScript rejects, Python rejects, with the same field path and rejection code.
- A malformed row does not remove its valid siblings; each refused row reports its index, field path, and code.
- A list or mapping is canonical-JSON encoded before it crosses the string boundary. A Python repr is not JSON and is refused.
- A value that is not a findings array raises `TypeError`. Only an explicitly empty array is an empty result.

`canonical_findings_json(value)` writes the string form: sorted keys, tight separators, no ASCII escaping.
That is RFC 8785 for the finite integers and strings a finding carries.
Number formatting is not RFC 8785, so use this to cross the string boundary, never to compute a digest.

```ts
import {
  createDspyRlmTraceEngine,
  type DspyRlmTraceEngineOptions,
} from '@tangle-network/agent-eval/analyst'
import { analyzeTraces } from '@tangle-network/agent-eval/traces'

type ModelOwner = Pick<
  DspyRlmTraceEngineOptions,
  'call' | 'callRef' | 'recordExecution' | 'model' | 'pricing'
>

export async function analyzeRun(modelOwner: ModelOwner) {
  const engine = createDspyRlmTraceEngine({
    ...modelOwner,
    runner: { command: '.venv/bin/python' },
  })

  return analyzeTraces(
    { question: 'What first caused this run to fail?' },
    { source: 'run.otlp.jsonl', engine, toolGroup: 'singleTrace' },
  )
}
```

See [Trace Analysis](../../docs/trace-analysis.md) for custom definitions, limits, result fields, and the public quality benchmark.

The caller supplies the model identifier and endpoint rates with its execution callbacks.
DSPy and the Optimize Anything bridge require different GEPA versions.
The [development commands](#development) select each locked environment separately.

The bridge records the installed upstream package version and source revision with each run.
SkillOpt and a direct GEPA engine can restore official state only when the package revision, settings, starting candidate, described data, evaluation ID, and seed match.
Direct GEPA resume also requires `trustResumeState: true` because its upstream checkpoint uses Python pickle.
Enable it only for a checkpoint created locally in a directory you control.
Composed GEPA recipes restart and never claim that upstream state was restored.

The official optimizer subprocess requires POSIX process-group cleanup.
Use Linux or WSL rather than native Windows so a timeout can terminate the complete Python process tree.

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

From the repository root, build Node before running cross-language tests:

```sh
pnpm install --frozen-lockfile
pnpm build
cd clients/python
```

Run each compatibility suite with its locked dependencies:

```sh
uv sync --frozen --extra dev --group gepa-release
AGENT_EVAL_EXPECT_GEPA_RELEASE=1 \
  uv run --frozen --extra dev --group gepa-release \
  pytest tests/test_gepa_release_compatibility.py tests/test_gepa_bridge.py

uv sync --frozen --extra dev --group skillopt-source --group gepa-source
uv run --frozen --extra dev --group skillopt-source --group gepa-source pytest

uv sync --frozen --extra dev --extra dspy
uv run --frozen --extra dev --extra dspy pytest tests/test_dspy_metric.py
```

Keep the same extras and groups on `uv sync` and `uv run`.
Each `uv sync` switches the local environment to that optimizer's required dependency set.
The runnable Python example is [`examples/judge_anti_slop.py`](./examples/judge_anti_slop.py).
