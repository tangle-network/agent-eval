# agent-eval-rpc — Python client

Python client for [`@tangle-network/agent-eval`](https://github.com/tangle-network/agent-eval) — a content/code judging framework written in TypeScript. This package is a **thin transport adapter**: every judgement runs in the Node runtime, marshalled over HTTP or stdio RPC. Two languages, one implementation. No drift.

## What you get

A function-call interface to score any string against a rubric:

```python
from agent_eval_rpc import Client

client = Client()  # auto-detects HTTP server, falls back to subprocess
result = client.judge(
    content="We just launched zero-copy IO between agents and their workdir",
    rubric_name="anti-slop",
)

print(result.composite)         # 0.0..1.0 — single number to gate on
print(result.dimensions)        # {"buyer_quality": 0.7, "voice": 0.8, "signal": 0.9}
print(result.failure_modes)     # [] or ["ai-cadence", "marketing-tone", ...]
print(result.wins)              # ["specific-component", "earned-detail", ...]
print(result.rationale)         # "The post names a real architectural detail..."
```

That's the entire surface for content judging.

## Install

```sh
cd clients/python
pip install -e .
```

To use it, **one of**:

- `npm install -g @tangle-network/agent-eval` — gives you the `agent-eval` binary, used by the subprocess transport (works offline, slower per call due to Node startup ~500ms).
- Run a server: `agent-eval serve --port 5005` — gives you HTTP transport (~10ms per call once up).

The Python client picks whichever is available. Force one with `Client(transport="http")` or `Client(transport="subprocess")`.

## Why the architecture works this way

The TypeScript package is the source of truth for evaluation logic. We don't reimplement rubrics, scoring, or judges in Python — we marshal JSON to the canonical runtime over a versioned wire protocol (defined as Zod schemas, exported as OpenAPI, mirrored in this package as pydantic models).

Adding a new method to the API means: define a Zod schema in `src/wire/schemas.ts`, write the handler in `src/wire/handlers.ts`, and the Python client picks it up on the next regeneration. **There is no separate Python implementation to maintain.**

This is the same pattern as the Anthropic SDK, Stripe SDK, and gRPC: one canonical implementation, language-specific transport clients.

## API

### `Client`

```python
Client(
    base_url: str | None = None,        # AGENT_EVAL_URL or http://127.0.0.1:5005
    cli_path: str | None = None,        # AGENT_EVAL_CLI or 'agent-eval'
    transport: "auto" | "http" | "subprocess" = "auto",
    timeout_s: float = 120.0,
)
```

### `client.judge(...)`

Score a piece of content against a rubric.

```python
def judge(
    *,
    content: str,                                  # the text being judged
    rubric_name: str | None = None,                # OR
    rubric: Rubric | dict | None = None,           # an inline rubric definition
    context: dict | None = None,                   # free-form metadata for the judge
    model: str | None = None,                      # override the judge LLM
) -> JudgeResult
```

**Either** `rubric_name` (use a built-in like `"anti-slop"`) **or** `rubric` (an inline definition with your own dimensions/prompt). Not both.

**Returns** `JudgeResult`:
- `composite: float` — weighted score in 0..1. The single number to gate on.
- `dimensions: dict[str, float]` — per-axis scores (e.g. `{"buyer_quality": 0.7}`).
- `failure_modes: list[str]` — ids of negative patterns detected.
- `wins: list[str]` — ids of positive patterns detected.
- `rationale: str` — plain-English explanation.
- `rubric_version: str` — stable hash of the rubric used. Compare scores only when this matches.
- `model: str` — LLM that produced the judgement.
- `duration_ms: int` — wall-clock latency.

### `client.list_rubrics()`

Return every rubric the server has registered, with their dimensions and stable `rubric_version`.

```python
rubrics = client.list_rubrics()
for r in rubrics.rubrics:
    print(r.name, r.description, r.rubric_version)
```

### `client.version()`

Return server + wire-protocol version. Match your `pip install` version to `version`; check `wire_version` for compatibility.

```python
v = client.version()
assert v.version.startswith("0.20")
assert v.wire_version == "1.0.0"
```

## Defining a custom rubric

Built-in `anti-slop` is tuned for technical-buyer audiences. For different scoring, pass a `Rubric` inline:

```python
from agent_eval_rpc import Client, Rubric, RubricDimension, FailureMode

rubric = Rubric(
    name="my-rubric",
    description="Does this commit message explain WHY, not just what?",
    systemPrompt="You score commit messages. Score 0..1 on whether the WHY is clear...",
    dimensions=[
        RubricDimension(id="explains_why", description="Does the message say *why*?", weight=1.0),
    ],
    failureModes=[
        FailureMode(id="what-not-why", description="States the change but not the reason"),
    ],
)

result = client.judge(content="bumped the version", rubric=rubric)
```

## Errors

| Exception | When |
|---|---|
| `ValidationError` | Server (or pydantic) rejected the request as malformed. Fix your inputs. |
| `RubricNotFoundError` | Unknown `rubric_name`. Call `list_rubrics()` to see what's registered. |
| `TransportError` | HTTP unreachable or subprocess failed. Retry or check the server. |
| `AgentEvalError` | Base class — catches everything above. |

All errors carry `.code` and `.details` (the structured payload from the server).

## Versioning

This package is **version-locked** to the npm package. `agent-eval-rpc==0.21.0` ↔ `@tangle-network/agent-eval@0.21.0`. CI verifies the npm package, Python package, runtime `__version__`, and release tag all agree before publish. If one registry publish fails after the other succeeds, retry the failed publish from the same tag or supersede with the next patch release.

`wire_version` is separate. It bumps only on breaking schema changes. Package versions can differ across releases as long as `wire_version` is the same.

## Development

```sh
# install in editable mode
pip install -e ".[dev]"

# unit tests (no Node required)
pytest tests/test_models.py

# integration tests against the bundled CLI
cd ../.. && pnpm build         # build the agent-eval CLI in repo root
cd clients/python && pytest    # runs subprocess tests against dist/cli.js
```

## Adding a new method

When the TS side adds a new endpoint (say `evaluateScenario`):
1. Update `src/wire/schemas.ts` with `EvaluateScenarioRequestSchema` and `EvaluateScenarioResponseSchema`.
2. Add a handler in `src/wire/handlers.ts`, route in `src/wire/server.ts`, and case in `src/wire/rpc.ts`.
3. In this client, add the matching pydantic model in `models.py` and method on `Client`. The pattern is mechanical — copy the shape from `judge`.
4. Test in both languages. Bump versions together.

A future iteration moves step 3 to `datamodel-code-generator -i openapi.json` so it's mechanical-and-automatic instead of mechanical-by-hand. Until the surface grows past ~10 endpoints, hand-written models are more readable.
