# Let A Coding Agent Drive The Optimization

This example runs `selfImprove()` with GEPA's `autoresearch` engine.
The engine drives a real `claude` CLI subprocess that reads the candidate, edits it, and scores each attempt through `./eval.sh`.
Every CLI model call routes through Agent Eval's loopback proxy, so the whole agent session is metered, budgeted, and receipted.

## When To Use It

Use this path when you want a coding agent, not a reflection LM, to drive the optimization.
A reflection LM sees scores and proposes text; an agent engine also runs the evaluator itself, inspects failures, and iterates inside one session.
Use [`self-improve-optimizer`](../self-improve-optimizer/) when standard GEPA reflection is enough.
Use [`compare-optimization-methods`](../compare-optimization-methods/) when two or more optimizers must be benchmarked at equal budget.

## Install

Install the Node dependencies from the repository root:

```sh
pnpm install
```

Install the Python bridge and the published GEPA package:

```sh
python -m pip install agent-eval-rpc
python -m pip install "gepa[full]==0.1.4"
```

The engine also needs the `claude` CLI on `PATH`.
It runs against the loopback proxy, not against Anthropic; no Anthropic account is needed.

## Run

```sh
LLM_BASE_URL=https://router.tangle.tools/v1 \
LLM_API_KEY="$TANGLE_API_KEY" \
LLM_MODEL=deepseek-v4-flash \
GEPA_PRICE_IN_PER_M=0.168 \
GEPA_PRICE_OUT_PER_M=0.336 \
pnpm tsx examples/agent-engine-optimizer/index.ts
```

Any OpenAI-compatible endpoint works; replace the two rates with the exact rates your endpoint charges.
The script validates every required variable before it makes a paid call.

## Why It Is Trustworthy

The CLI never receives your provider key.
It receives `ANTHROPIC_BASE_URL` pointing at the loopback proxy and an ephemeral token; the key stays inside the execution owner in this process.
Every CLI call is one admitted, receipted execution-owner call, and the run fails if receipt count differs from admitted-call count.

The run prints the receipt fields that back each claim:

- `optimizer spend` with `accountingComplete` — the metered dollar total, and whether any spend escaped a receipt.
- `CLI wire` — `provenance.anthropicEndpoint.requestAttempts` and `successfulCompletions`, the proxy's own count of agent traffic.
- `evaluations` — `provenance.evaluationCount`, the callback-metered evaluation total (the trusted count).
- `upstream count` — `provenance.upstreamReportedEvaluations`, the engine's self-reported total; a difference means upstream skipped, cached, or double-counted work.
- `seed applied` — `provenance.seedApplied`, whether the run seed reached the engine configuration.

## Why It Is Built This Way

- The evaluator is deterministic: the judge scores the produced candidate text, so `expectUsage: 'off'` is set — `selfImprove` defaults to `'assert'`, which fails a run whose cells report zero usage, and zero usage is correct here.
- `maxEvaluations` (default 14) must be at least the train-set size (6 here). One registering aggregate eval scores the full training pool at once; a smaller budget lets zero evaluations register and GEPA scores every candidate `-inf`. The script enforces this at startup.
- `engineConfig.model` must equal `optimizer.model` because the engine passes `--model` to the CLI and the flag beats the injected environment.
- The optimizer budget keeps 32,768 output tokens of headroom per request. A reasoning model bills hidden reasoning tokens against `max_tokens`; a 4,096 cap starves it mid-thought.

## Cost

A measured run against `deepseek-v4-flash` at the rates above cost about $0.05 and finished in about 65 seconds.
Hard limits: `MAX_TOTAL_COST_USD` (default 2) caps the whole run and `GEPA_MAX_PROPOSER_COST_USD` (default 1) caps agent-session spend.

## Caveat

Unmodified CLI runs require the system-role translation fix shipped in `@tangle-network/agent-eval` 0.150.2.
On 0.150.1 the CLI's system-role messages are refused at the proxy and the session fails its first call.

## Controls

| Variable | Default | Meaning |
|---|---:|---|
| `LLM_BASE_URL` | required | OpenAI-compatible endpoint the owner executes against. |
| `LLM_API_KEY` | required | Key for that endpoint; never reaches the CLI. |
| `LLM_MODEL` | required | Exact model id the endpoint serves. |
| `GEPA_PRICE_IN_PER_M` | required | Exact input rate per million tokens. |
| `GEPA_PRICE_OUT_PER_M` | required | Exact output rate per million tokens. |
| `GEPA_MAX_EVALUATIONS` | `14` | Evaluation budget; must be at least the train-set size. |
| `GEPA_MAX_PROPOSER_COST_USD` | `1` | Maximum agent-session spend. |
| `MAX_TOTAL_COST_USD` | `2` | Hard cap across the whole run. |
| `OPTIMIZER_PYTHON` | `python` | Python executable containing the bridge and GEPA. |

The complete implementation is [`index.ts`](./index.ts).
