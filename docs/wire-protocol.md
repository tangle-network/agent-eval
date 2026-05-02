# Wire protocol

agent-eval exposes its evaluation logic over a versioned wire protocol so non-TypeScript clients (Python, Rust, Go, …) can drive it without a parallel implementation. The TypeScript runtime is the single source of truth; clients in other languages are *transport adapters*, not ports.

## Mental model

```
your code (any language)
        │
        ▼
   thin transport client  ──HTTP──▶  agent-eval serve   ──┐
        │                                                  │
        └─────subprocess────────▶  agent-eval rpc        ──┤
                                                           ▼
                                              same TS handlers, same rubrics,
                                              same scoring code
```

Both transports talk to identical handlers. If you need a sustained connection (live agent paths, high-frequency calls), use HTTP. If you need a one-shot (cron, CI, batch), use stdio RPC. The wire shape is the same.

## Two transports, one contract

| | HTTP | stdio RPC |
|---|---|---|
| Start | `agent-eval serve --port 5005` | per-call: `agent-eval rpc <method>` |
| Latency | ~10 ms | ~500 ms (Node startup) |
| Best for | live calls, agent paths, dashboards | cron, CI, batch evaluation |
| Requires | running server | binary on PATH |

## Methods

The current surface is the smallest useful slice. Adding a method is mechanical — see [§Adding a method](#adding-a-method).

### `judge` — score content against a rubric

```http
POST /v1/judge
{
  "rubricName": "anti-slop",
  "content": "We just shipped zero-copy IO between sandboxes",
  "context": { "platform": "x", "author": "drew", "impressions": 1240 }
}
```

```json
{
  "composite": 0.78,
  "dimensions": { "buyer_quality": 0.85, "voice": 0.7, "signal": 0.8 },
  "failureModes": [],
  "wins": ["specific-component", "earned-detail"],
  "rationale": "Specific architectural detail, no AI cadence, technical voice.",
  "rubricVersion": "anti-slop@a4f2b8c1",
  "model": "claude-sonnet-4-6",
  "durationMs": 1840
}
```

Pass either `rubricName` (built-in) or `rubric` (inline definition). Not both. The handler:
1. Resolves the rubric.
2. Calls the judging LLM with a JSON-schema-constrained response.
3. Computes `composite = Σ(weight_i × normalized_score_i) / Σ(weight_i)`.
4. Returns a typed `JudgeResult`.

`rubricVersion` is the stable hash of the rubric used. Scores are only comparable across runs when this matches.

### `listRubrics` — discover what's registered

```http
GET /v1/rubrics
```

```json
{
  "rubrics": [
    {
      "name": "anti-slop",
      "description": "Voice and signal quality for technical-buyer content.",
      "dimensions": [
        { "id": "buyer_quality", "description": "Would the target buyer care?", "weight": 0.5 },
        { "id": "voice", "description": "Builder voice, not AI/marketing?", "weight": 0.3 },
        { "id": "signal", "description": "Non-obvious detail or constraint?", "weight": 0.2 }
      ],
      "failureModes": ["ai-cadence", "marketing-tone", "vague-claim", "no-hook", "engagement-bait", "off-icp", "stale-claim"],
      "rubricVersion": "anti-slop@a4f2b8c1"
    }
  ]
}
```

### `version` — server + wire-protocol versions

```http
GET /v1/version
```

```json
{
  "package": "@tangle-network/agent-eval",
  "version": "0.18.0",
  "wireVersion": "1.0.0",
  "apiSurface": ["judge", "listRubrics", "version"]
}
```

`version` matches the npm/PyPI package version. `wireVersion` bumps independently — only on breaking request/response schema changes. Package versions can differ across releases as long as `wireVersion` matches.

### `GET /healthz` — liveness

For probing whether a server is up. Returns `{ "status": "ok", "uptimeSec": <number> }`.

### `GET /openapi.json` — full spec

Auto-generated from the Zod schemas. This is what code generators consume to produce typed clients in other languages.

## Errors

Every error response uses the same shape:

```json
{
  "error": {
    "code": "rubric_not_found",
    "message": "No built-in rubric named \"missing-name\".",
    "details": null
  }
}
```

| HTTP | code | meaning |
|---|---|---|
| 400 | `validation_error` | Request didn't match the schema. |
| 404 | `rubric_not_found` | Unknown `rubricName`. |
| 500 | `judge_error` | LLM returned malformed output. |
| 500 | `internal_error` | Unexpected server error. |

stdio RPC uses the same shape inside an envelope: `{"error": {...}}` instead of `{"result": {...}}`. Exit code is non-zero on error.

## Running the server

```sh
agent-eval serve --port 5005 --host 127.0.0.1
```

Defaults to `127.0.0.1:5005`. Bind to `0.0.0.0` only if you trust the network.

```sh
# health
curl http://localhost:5005/healthz

# discover
curl http://localhost:5005/v1/rubrics | jq

# judge
curl -X POST http://localhost:5005/v1/judge \
  -H 'content-type: application/json' \
  -d '{"rubricName":"anti-slop","content":"We just shipped …"}'
```

## Using stdio RPC

```sh
# version
echo '{}' | agent-eval rpc version

# listRubrics
echo '{}' | agent-eval rpc listRubrics

# judge (one-shot)
echo '{"rubricName":"anti-slop","content":"…"}' | agent-eval rpc judge

# JSONL batch — one request per line
cat requests.jsonl | agent-eval rpc-batch judge > results.jsonl
```

Each invocation is one process — Node startup adds ~500 ms. For more than a few calls, stand up a server.

## Clients

- **Python**: [`tangle-agent-eval`](../clients/python/README.md) on PyPI. Auto-detects HTTP, falls back to subprocess. Version-locked to npm.
- **TypeScript**: import directly from `@tangle-network/agent-eval` (no wire round-trip needed in-process).
- **Rust / Go / Other**: generate from `dist/openapi.json`. PRs welcome to add an officially-maintained client.

## Adding a method

1. **Schema** — define `XRequestSchema` and `XResponseSchema` in `src/wire/schemas.ts`. Every field gets a `.describe()` so docs flow through to OpenAPI.
2. **Handler** — pure function in `src/wire/handlers.ts`. Throws `WireError` for caller-fixable issues.
3. **Server route** — `app.post('/v1/x', …)` in `src/wire/server.ts`.
4. **RPC case** — add `case 'x':` in `dispatchRpc` in `src/wire/rpc.ts`.
5. **OpenAPI route** — register in `src/wire/openapi.ts` so it shows up in the spec.
6. **Test** — add to `tests/wire/`. At minimum: schema validation, happy-path, error-path.
7. **Python client** — add a method on `Client` in `clients/python/src/tangle_agent_eval/client.py`, plus pydantic models in `models.py` mirroring the new schemas.

The pattern is mechanical. When the surface grows past ~10 methods, swap the hand-written Python models for `datamodel-code-generator -i openapi.json -o models.py`.

## Wire-protocol versioning

`WIRE_VERSION` (in `src/wire/schemas.ts`) is a separate semver from the npm/PyPI package version. It bumps on **breaking** changes to a request/response schema. Additive changes (new optional fields, new methods) don't require a bump.

When `WIRE_VERSION` bumps, every language client gets a new major version; the dual-publish CI (see `.github/workflows/publish.yml`) enforces this lock-step.
