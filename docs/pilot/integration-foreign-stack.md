# Integration — Tangle Intelligence on any stack (OpenRouter, OpenAI, Anthropic, LangChain, LlamaIndex, custom)

Companion to `integration-tangle-stack.md`. This doc is the path for customers NOT on `@tangle-network/sandbox` + tcloud — you bring your own agent, your own LLM provider, your own trace format. We meet you where you are.

## Zero-setup demo first

```sh
npx @tangle-network/intelligence demo
```

Synthetic agent + scenarios + selfImprove end-to-end with zero setup. Prints the `InsightReport` shape — same output you'll get against your real data. Hosted equivalent: **[staging-intelligence.tangle.tools](https://staging-intelligence.tangle.tools)**.

## Decision tree — pick your starting point

```
What's your trace source?
├── OTel-compatible (Datadog APM, Honeycomb, NewRelic, raw OTLP) → fromOtelSpans
├── LangChain (LangSmith traces, LCEL run traces)               → fromLangChain      (#104, queued)
├── LlamaIndex (callback traces)                                → fromLlamaIndex     (#104, queued)
├── Anthropic SDK direct (Messages API call logs)               → fromAnthropicSDK   (#104, queued)
├── OpenAI Assistants API (run + step events)                   → fromOpenAIAssistants (#104, queued)
├── Multi-rater human approval/reject corpus                    → fromFeedbackTable
├── Custom (your own logs / DB rows)                            → 20-line mapper to RunRecord
└── @tangle-network/sandbox                                     → fromTangleSandbox (see Tangle-stack doc)

What's your LLM provider for the closed loop?
├── OpenAI                          → gepaDriver({ llm: { apiKey, baseUrl: 'https://api.openai.com/v1' } })
├── Anthropic                       → gepaDriver({ llm: { apiKey, baseUrl: 'https://api.anthropic.com/v1' } })
├── OpenRouter                      → gepaDriver({ llm: { apiKey, baseUrl: 'https://openrouter.ai/api/v1' } })
├── Tangle tcloud                   → gepaDriver({ llm: { apiKey, baseUrl: 'https://router.tangle.tools/v1' } })
├── Azure OpenAI                    → gepaDriver({ llm: { apiKey, baseUrl: 'https://<resource>.openai.azure.com/...' } })
├── Bedrock / Vertex                → custom client wrapper (we help)
└── Self-hosted (vLLM, Ollama, etc.) → OpenAI-compat endpoint works directly
```

## OTel → InsightReport (5 minutes)

```ts
import { fromOtelSpans } from '@tangle-network/agent-eval'
import { analyzeRuns } from '@tangle-network/agent-eval/contract'

// You probably already export OTel via OTLP. Pull a JSONL dump of spans
// for your last week of agent activity.
const spans = JSON.parse(fs.readFileSync('./agent-traces.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse))

const runs = fromOtelSpans({ spans })  // RunRecord[]
const report = await analyzeRuns({ runs })

console.log(report.composite.mean)
console.log(report.recommendations)
```

What `fromOtelSpans` expects in spans (it's flexible — it tries multiple attribute keys):
- `trace_id` (groups spans into a run)
- `attributes['llm.tokens.in' | 'llm.input_tokens']` (optional)
- `attributes['llm.tokens.out' | 'llm.output_tokens']` (optional)
- `attributes['tool.name']` (optional, for tool-failure-rate analysis)
- `status.code: 'ERROR' | 'OK'` (for failure detection)
- `start_unix_nano` + `end_unix_nano` (for duration)

If your spans use different attribute keys, pass `{ attributeMap }` to override.

## OpenRouter as your closed-loop LLM provider

OpenRouter speaks OpenAI-compat. Plug it in directly:

```ts
import { selfImprove, gepaDriver } from '@tangle-network/agent-eval/contract'

const result = await selfImprove({
  scenarios: yourScenarios,
  agent: yourAgent,             // your existing dispatch — any framework
  judge: yourJudge,
  baselineSurface: currentPrompt,
  driver: gepaDriver({
    llm: {
      apiKey: process.env.OPENROUTER_KEY!,
      baseUrl: 'https://openrouter.ai/api/v1',
    },
    model: 'anthropic/claude-sonnet-4.6',     // any OpenRouter-supported model
    target: 'agent system prompt',
  }),
  budget: { generations: 3, populationSize: 4, holdoutFraction: 0.3, maxUsd: 25 },
})
```

Same shape works for: OpenAI direct, Anthropic direct, Azure OpenAI, Vertex (with their OpenAI-compat layer), Bedrock (via LiteLLM proxy), self-hosted vLLM / Ollama / LMStudio.

## LangChain customer — three minute integration

While the dedicated `fromLangChain` adapter is queued (#104), the universal path:

```ts
// Step 1: configure LangSmith to also export OTel
// (LangSmith → Project Settings → Trace exports → enable OTLP)

// Step 2: ingest as OTel
import { fromOtelSpans } from '@tangle-network/agent-eval'
const runs = fromOtelSpans({ spans: yourLangSmithOtelDump })

// Step 3: analyze
import { analyzeRuns } from '@tangle-network/agent-eval/contract'
const report = await analyzeRuns({ runs })
```

When `fromLangChain` lands, it'll be a one-liner:

```ts
// Coming in 0.55.0
import { fromLangChain } from '@tangle-network/agent-eval/adapters/langchain'
const runs = fromLangChain({ traces: yourLangSmithExport })
```

Same for LlamaIndex / OpenAI Assistants / Anthropic SDK — direct adapters queued in #104.

## LlamaIndex customer

LlamaIndex's callback manager emits OTel spans natively. Wire it once:

```python
# Python side — your LlamaIndex setup
from llama_index.callbacks import OpenInferenceCallbackHandler

callback_handler = OpenInferenceCallbackHandler()
# This emits to your OTel exporter

# Then on the agent-eval side (TypeScript or Python):
from agent_eval_rpc import Client
client = Client(base_url='https://api.tangle.tools/v1', api_key=YOUR_KEY)
report = client.analyze_runs(spans=your_otel_spans)
```

The Python client (`agent-eval-rpc@0.53.0`) speaks the same wire protocol — no functional difference between TS and Python customers.

## Anthropic SDK direct (no framework)

If you're calling `@anthropic-ai/sdk` directly without an agent framework:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { fromOtelSpans } from '@tangle-network/agent-eval'

// Step 1: wrap your Anthropic calls to emit OTel
import { trace } from '@opentelemetry/api'
const tracer = trace.getTracer('your-agent')

async function callAnthropic(scenario: Scenario) {
  return tracer.startActiveSpan('agent.turn', async (span) => {
    const result = await anthropic.messages.create({...})
    span.setAttribute('llm.input_tokens', result.usage.input_tokens)
    span.setAttribute('llm.output_tokens', result.usage.output_tokens)
    span.setAttribute('tangle.runId', scenario.id)
    span.end()
    return result
  })
}

// Step 2: same pipeline
const runs = fromOtelSpans({ spans: yourOtelExport })
const report = await analyzeRuns({ runs })
```

20 lines of OTel wrapping; the rest is pure substrate.

## OpenAI Assistants API

The Assistants API emits `runs.steps` events natively. Map them to RunRecord:

```ts
// Custom mapper while fromOpenAIAssistants (queued #104) lands:
function mapAssistantRunToRunRecord(threadId: string, runId: string): RunRecord {
  const run = await openai.beta.threads.runs.retrieve(threadId, runId)
  const steps = await openai.beta.threads.runs.steps.list(threadId, runId)

  return {
    runId: run.id,
    experimentId: 'default',
    candidateId: run.assistant_id,
    seed: 0,
    model: run.model,
    promptHash: hashOf(run.instructions),
    configHash: hashOf({ tools: run.tools, model: run.model }),
    commitSha: process.env.GIT_SHA ?? 'unknown',
    wallMs: (run.completed_at - run.created_at) * 1000,
    costUsd: estimateCostFromUsage(run.usage),
    tokenUsage: {
      input: run.usage?.prompt_tokens ?? 0,
      output: run.usage?.completion_tokens ?? 0,
    },
    outcome: {
      holdoutScore: yourScoring(run),
      raw: { stepCount: steps.data.length, status: run.status },
    },
    splitTag: 'holdout',
  }
}
```

Once the dedicated adapter ships in 0.55.0 this becomes one line.

## Custom trace format

Your logs / DB rows / proprietary schema → `RunRecord`:

```ts
import type { RunRecord } from '@tangle-network/agent-eval'

function mapMyRowToRunRecord(row: MyAgentLog): RunRecord {
  return {
    runId: row.id,
    experimentId: row.experiment_name ?? 'default',
    candidateId: row.model_version,
    seed: row.random_seed ?? 0,
    model: row.model,
    promptHash: row.prompt_hash,
    configHash: row.config_hash,
    commitSha: row.git_sha,
    wallMs: row.duration_ms,
    costUsd: row.cost,
    tokenUsage: {
      input: row.input_tokens,
      output: row.output_tokens,
    },
    outcome: {
      holdoutScore: row.score,
      raw: row.raw_output,    // free-form bag for fields the substrate doesn't standardize
    },
    splitTag: row.is_holdout ? 'holdout' : 'search',
  }
}

const runs = myLogs.map(mapMyRowToRunRecord)
const report = await analyzeRuns({ runs })
```

That's the worst case. ~20 lines of mapping, and you're in.

## Multi-rater human feedback (no LLM-as-judge yet)

If you don't have an automated judge but you DO have human raters approving/rejecting agent outputs:

```ts
import { fromFeedbackTable } from '@tangle-network/agent-eval'
import { analyzeRuns } from '@tangle-network/agent-eval/contract'

// Your data shape:
const ratings = [
  { runId: 'r-001', rater: 'alice', score: 1 },   // approved
  { runId: 'r-001', rater: 'bob', score: 0 },     // rejected — disagreement!
  { runId: 'r-002', rater: 'alice', score: 1 },
  { runId: 'r-002', rater: 'bob', score: 1 },
  // ...
]

const { runs, raterScores } = fromFeedbackTable({ ratings })
const report = await analyzeRuns({ runs, raterScores })

// report.interRater.kappa → how much your raters agree
// report.interRater.disagreementCases → which runs raters split on
// → use these to iterate the rubric until kappa > 0.7
// → then build an LLM-as-judge against that aligned rubric
```

This is the warm-up path for customers who don't have a judge yet.

## Hosted vs self-hosted — what's the difference?

| | Self-hosted | Hosted (Tangle Intelligence) |
|---|---|---|
| Cost | Your LLM bills + your compute | Same LLM bills + hosted-tier subscription |
| Dashboard | You build it (or use the OSS examples) | Renders InsightReport out of the box |
| Cron / scheduling | Your CI / cron / GitHub Action | Managed scheduler runs weekly |
| Slack / email digest | You wire it | Included |
| Multi-week trends | You persist | Persisted for you |
| Decision packet generation | Local (free) | API call (same code; we run it) |
| Closed-loop campaigns | Local (you pay LLM directly) | Pass-through pricing on LLM, plus per-campaign fee |
| Auto-PR | Your GitHub token | Your GitHub token via OAuth |

Both work end-to-end. Hosted tier is convenience; self-hosted is fine for engineering-heavy teams who want full control.

## Common foreign-stack questions

**Q: We use vLLM / Ollama / a custom self-hosted LLM. Does the closed-loop driver work?**
A: Yes if your server speaks OpenAI-compat (most do). Pass `baseUrl: 'http://localhost:8000/v1'` (or wherever) and your dummy `apiKey`. We've shipped customers running selfImprove against local LMStudio + Ollama.

**Q: We're a Python shop, not TypeScript. Does anything change?**
A: `agent-eval-rpc@0.53.0` on PyPI speaks the same wire protocol. The Python client is a thin wrapper around the hosted endpoints — same `analyzeRuns()` / `selfImprove()` calls, same `InsightReport` shape, same `gateDecision` values.

**Q: We have an extremely custom agent (not LLM-call-shaped). Can we still use this?**
A: Yes. The substrate doesn't care what your agent IS — it only cares that you can express your runs as `RunRecord[]` and your judge as `(artifact) → JudgeScore`. RL-trained agents, multi-step plan-and-execute, browser-driving agents, code-generating agents — all map cleanly.

**Q: What's the minimum cost to try it?**
A: Free. `analyzeRuns()` is deterministic, runs locally, $0 LLM cost. You can ingest your last week of traces and get a real decision packet without spending a cent. The LLM-cost-incurring step is `selfImprove()` and you set the ceiling.

**Q: We don't want to send traces to your hosted tier. Self-hosted only — works?**
A: Yes. Every primitive in this doc runs locally. The package is MIT-licensed, no SaaS lock-in, no required network call.
