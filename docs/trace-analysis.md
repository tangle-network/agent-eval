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

const abortController = new AbortController()
const result = await analyzeTraces({
  question: 'Why did app-runtime holdout runs fail this week?',
}, {
  source: new OtlpFileTraceStore({ path: 'traces/otlp.jsonl' }),
  ai,
  model: 'gpt-4o-2024-11-20',
  maxSubqueries: 4,
  maxParallelSubqueries: 2,
  signal: abortController.signal,
})

console.log(result.findings)
```

Products can pass any `TraceAnalysisStore`; they do not need to use the file store in production.
The analyst runs one Ax executor loop and accepts only an explicit structured `final(task, { report, findings })` result; max-turn fallback text fails loud.

### Analyze captured tool spans in memory

Use `toolSpansToTraceAnalysisStore()` when a live worker already returns canonical `ToolSpan[]` records.
The function snapshots the records immediately, groups them by `runId`, and exposes the same bounded reads and searches as the file-backed store.

```ts
import {
  analyzeTraces,
  toolSpansToTraceAnalysisStore,
  type ToolSpan,
  ToolTraceMissingError,
} from '@tangle-network/agent-eval/traces'

declare const capturedToolSpans: ToolSpan[] | undefined

if (!capturedToolSpans?.length) throw new ToolTraceMissingError()
const source = toolSpansToTraceAnalysisStore(capturedToolSpans)
const result = await analyzeTraces({ question: 'Why are tools failing?' }, { source, ai, model })
```

`undefined`, `null`, and an empty array throw `ToolTraceMissingError` with code `capture_integrity`.
An empty tool list cannot distinguish a real tool-free run from broken capture, so the adapter never reports it as a clean trace set.
Use a complete OTLP trace source when proving that a run executed successfully without tools.

## Deterministic failure coverage (no LLM)

Before (or alongside) the LLM analyst, `OtlpFileTraceStore.getOverview()` returns a
`DatasetOverview` whose `error_clusters` are computed deterministically: error
spans are grouped by a normalized failure signature (uuids / hex ids / numbers /
absolute paths / durations collapsed), each cluster carrying its prevalence,
exemplar `trace_id`/`span_id`, and a verbatim sample. This is a zero-LLM,
reproducible failure checklist the analyst then explains and closes:

```ts
const overview = await store.getOverview()
for (const c of overview.error_clusters) {
  console.log(`${c.trace_count}× ${c.signature}: e.g. trace ${c.exemplar_trace_ids[0]}`)
}
```

See `failureClusters` in [insight-report.md](./insight-report.md) and the
`ErrorCluster` type doc-comments for the field-level contract.

## Recursive control integrity (no LLM)

`CONTROL_INTEGRITY_ANALYST` checks the existing `SupervisorRunSources` or `SupervisorRunTree` directly.
It does not define another run format.
Register it as a custom-input analyst and pass the existing value under its stable id:

```ts
import {
  AnalystRegistry,
  CONTROL_INTEGRITY_ANALYST,
} from '@tangle-network/agent-eval/analyst'
import {
  readLoopsSupervisorRun,
  supervisorRunRolloutLines,
} from '@tangle-network/agent-eval/supervisor-run'

const sources = await readLoopsSupervisorRun(runDir)
const tree = supervisorRunRolloutLines(sources)
const registry = new AnalystRegistry()
registry.register(CONTROL_INTEGRITY_ANALYST)

const result = await registry.run('run-123', {
  custom: { 'control-integrity': tree },
})
```

The deterministic pass can prove only facts represented by these two existing surfaces.

| Question | Current evidence | What the analyst can say |
|---|---|---|
| Is every invocation attached to one unambiguous tree? | `rootId`, `rollout_id`, `parent_rollout_id`, `run_id` | Duplicate ids, missing parents, extra parentless roots, cross-run edges, and ancestry cycles are violations with exact field references. |
| Did a recursive manager retain its role? | `RolloutLine.role` plus child edges | A node not labeled `supervisor` that owns a child is a recorded role inconsistency. |
| Is the causal order possible? | `outcome.metrics.spawned_at`, `started_at`, `settled_at`, `completed_at`, `finished_at` when present | A child before its parent, a child after its parent closed, or a close before a start is a violation; absent timestamps produce no timing claim. |
| Did a queued steer reach the worker? | `SupervisorRunSources.workers[].inbox` and `.events` | A completed run with queued requests and no delivered acknowledgement is a violation only when both artifacts are retained; a missing artifact is reported as unavailable, never zero. |
| Can behavior be attributed to an exact profile? | `policy.agent_profile_cell_id` | An absent id is reported as unavailable. |
| Can action authorship or reasoning be inspected? | `messages[]` | Empty gap rows are reported as unavailable. |

An empty finding list means only that no implemented rule fired on the captured fields.
It does not certify that an agent chose the action, that the action was authorized, that a budget or depth limit was enforced, or that a finding caused a later decision.
Those claims require upstream action-decision events carrying `action_id`, `actor_rollout_id`, `target_rollout_id`, `action_kind`, `authority_snapshot_id`, requested and granted resource/depth values, the authorization result, and any `finding_id` or evidence references that caused the action.
Resume integrity additionally requires an explicit prior-session id and resumed-session id rather than a prose summary.

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
