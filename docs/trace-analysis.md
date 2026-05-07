# Trace Analysis

Trace analysis is the bridge between raw product telemetry and useful eval work.

```txt
live product run
  -> TraceEmitter / TraceStore
  -> TraceAnalyst investigates trace corpora
  -> findings become ASI, failures, replay cases, and release actions
```

## When To Use TraceAnalyst

Use `TraceAnalyst` when you have more than a few traces and need to answer:

- which failure modes are recurring?
- which spans explain a regression?
- did retrieval, integrations, sandbox, or policy block the run?
- are failed runs missing evidence that the optimizer needs?
- which product surfaces deserve the next fix?

Use summary tables and release confidence for promotion decisions. Use
TraceAnalyst to explain the evidence behind those decisions.

## Minimal Flow

```ts
import {
  OtlpFileTraceStore,
  analyzeTraces,
} from '@tangle-network/agent-eval'

const result = await analyzeTraces({
  question: 'Why did app-runtime holdout runs fail this week?',
}, {
  source: new OtlpFileTraceStore({ path: 'traces/otlp.jsonl' }),
  ai,
  model: 'gpt-4o-2024-11-20',
})

console.log(result.findings)
```

Products can pass any `TraceAnalysisStore`; they do not need to use the file
store in production.

## Required Trace Shape

Every serious product run should include:

- `runId`, `projectId`, `scenarioId`, `variantId`, and `layer`
- commit, prompt hash, config hash, model fingerprint, and dataset version
- LLM spans with model, inputs, outputs, token counts, and cost
- tool/integration spans with arguments, result summaries, and error codes
- retrieval spans with query, source ids, hit scores, and freshness metadata
- sandbox/build/test/deploy spans with exit codes and log artifacts
- custom events for knowledge readiness and integration gates
- final run outcome with pass/score/failure class

Do not put secrets, raw OAuth tokens, or unredacted PII in traces.

## Product Loop

The product loop should not treat traces as a separate debug dump. The intended
path is:

1. Wrap the real workflow in `runAgentControlLoop` or the product runtime.
2. Emit canonical spans/events while the user task runs.
3. Convert the completed run to `FeedbackTrajectory` for replay.
4. Convert promotion-grade runs to `RunRecord` with `controlRunToRunRecord`.
5. Run TraceAnalyst over failure-heavy trace sets.
6. Feed findings into `ActionableSideInfo`, failure clusters, and release
   reports.

That makes normal product usage become eval data instead of isolated logs.
