# Trace Analysis

Trace analysis answers three different questions:

1. What happened in the run?
2. Which exact steps support a suspected problem?
3. Does an analyst find labeled problems reliably enough to use?

Keep those answers separate.
A generated finding is a review request, not training truth.

## Run The Built-In Analysts

The default registry always includes deterministic checks.
Model-assisted analysts are added only when you provide a model client.

```ts
import {
  buildDefaultAnalystRegistry,
} from '@tangle-network/agent-eval/analyst'
import { OtlpFileTraceStore } from '@tangle-network/agent-eval/traces'

const traceStore = new OtlpFileTraceStore({ path: 'traces.otlp.jsonl' })
const analysts = buildDefaultAnalystRegistry()

const result = await analysts.run('release-42', { traceStore })

for (const finding of result.findings) {
  console.log(finding.claim, finding.evidence_refs)
}
```

Use `result.per_analyst` to inspect failures, latency, calls, tokens, and cost.
An analyst failure is recorded separately from an agent failure.

Products can implement `TraceAnalysisStore`; they do not need to use the file store in production.
Custom stores provide `hasTrace` and batched `hasSpans` alongside the seven reads, and accept a `TraceAnalysisStoreContext` so cancellation reaches storage and scans.
The binding validates every custom-store result.
Missing fields, undeclared fields, inconsistent counts, and false continuation flags throw `TraceAnalysisStoreContractError` with code `backend_integrity`.
The analyst runs one Ax executor loop and accepts only an explicit structured `final(task, { report, findings })` result; max-turn fallback text fails loud.

### Bind the same reads into another agent environment

`buildTraceAnalysisToolDescriptors()` is the canonical definition of the analyst's seven bounded read operations and does not expose Ax types.
Each descriptor carries the stable `traces` namespace, function name, description, JSON input schema in `parameters`, and a handler already bound to the supplied `TraceAnalysisStore`.
`buildTraceAnalystTools()` adapts those descriptors into Ax functions; it does not define a second tool surface.
The bound handlers wrap custom stores with `createBoundedTraceAnalysisStore()`, so page limits, byte ceilings, not-found errors, and cancellation do not depend on the transport or adapter.

```ts
import {
  buildTraceAnalysisToolDescriptors,
  type TraceAnalysisStore,
} from '@tangle-network/agent-eval/traces'

declare const store: TraceAnalysisStore
declare function qualifyToolName(namespace: string, name: string): string

const tools = buildTraceAnalysisToolDescriptors({ store }).map(
  ({ namespace, name, description, parameters, handler }) => ({
    name: qualifyToolName(namespace, name),
    description,
    inputSchema: parameters,
    handler,
  }),
)
```

Map these fields into the host's existing tool transport.
The host owns namespace encoding; use its existing convention instead of inventing one here.
Do not copy the schemas or reimplement the handlers in an MCP, Runtime, or provider adapter.

`queryTraces.limit`, `viewSpans.span_ids`, and search `max_matches` caps are present in the JSON Schemas and enforced before store calls.
Invalid arguments throw `TraceAnalysisValidationError` with code `validation`; responses that cannot fit their byte ceiling throw `TraceAnalysisLimitError` with code `limit_exceeded`.
Search patterns use RE2 syntax, which rejects backreferences and lookaround instead of allowing exponential-time expressions.
Search results return `hits` and an exact `has_more` flag; they do not invent a total after a capped scan.
`viewSpans` partitions every requested id across `spans`, `missing_span_ids`, and `omitted_span_ids`; `has_more` is true when omitted ids must be retried.
Attribute and match text shortening includes a deterministic marker.
Trace pages set `has_more`, and the overview returns every error cluster or fails explicitly when the configured response limit is too small.

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
} from '@tangle-network/agent-eval/supervisor-run'

const sources = await readLoopsSupervisorRun(runDir)
const registry = new AnalystRegistry()
registry.register(CONTROL_INTEGRITY_ANALYST)

const result = await registry.run('run-123', {
  custom: { 'control-integrity': sources },
})
```

Pass `SupervisorRunSources` when it is available.
A `SupervisorRunTree` does not retain raw journal multiplicity or worker request and acknowledgement rows, so tree input explicitly reports those checks as unavailable.

The deterministic pass can prove only facts represented by these two existing surfaces.

| Question | Current evidence | What the analyst can say |
|---|---|---|
| Is every invocation attached to one unambiguous tree? | `rootId`, `rollout_id`, `parent_rollout_id`, `run_id` | Duplicate ids, missing parents, extra parentless roots, cross-run edges, and ancestry cycles are violations with exact field references. |
| Did invocation roles survive capture? | Explicit journal and `RolloutLine.role` values | The root must remain `supervisor`; non-root roles are consumed as recorded, and workers may spawn workers. |
| Is the causal order possible? | `outcome.metrics.spawned_at`, `started_at`, `settled_at`, `completed_at`, `finished_at` when present | A child before its parent, a child after its parent closed, or a close before a start is a violation; absent timestamps produce no timing claim. |
| Did a queued steer reach the worker? | `SupervisorRunSources.workers[].inbox` and `.events` | Requests and acknowledgements are joined by request id, not compared as totals. Missing, malformed, duplicate, or uncorrelated rows make the affected count unavailable. |
| Can behavior be attributed to an exact profile? | `policy.agent_profile_cell_id` | An absent id is reported as unavailable. |
| Can action authorship or reasoning be inspected? | `messages[]` | Empty gap rows are reported as unavailable. |

An empty finding list means only that no implemented rule fired on the captured fields.
It does not certify that an agent chose the action, that the action was authorized, that a budget or depth limit was enforced, or that a finding caused a later decision.
Those claims require upstream action-decision events carrying `action_id`, `actor_rollout_id`, `target_rollout_id`, `action_kind`, `authority_snapshot_id`, requested and granted resource/depth values, the authorization result, and any `finding_id` or evidence references that caused the action.
Resume integrity additionally requires an explicit prior-session id and resumed-session id rather than a prose summary.

Malformed source rows are excluded from structural claims.
Their count is retained in `SupervisorRunTree.gaps`, so analyzing a projected tree later cannot turn an unreadable parent row into a missing-parent violation.

## Add A Custom Analyst

`defineTraceAnalyst()` fills the fixed registry fields.
The custom function receives the same bounded `TraceAnalysisStore` used by the built-ins.

```ts
import {
  AnalystRegistry,
  defineTraceAnalyst,
  makeFinding,
} from '@tangle-network/agent-eval/analyst'

const analysts = new AnalystRegistry()

analysts.register(defineTraceAnalyst({
  id: 'repeated-tool-errors',
  description: 'Reports the largest repeated tool error cluster.',
  cost: { kind: 'deterministic' },
  async analyze(store) {
    const overview = await store.getOverview({ has_errors: true })
    const cluster = overview.error_clusters[0]
    if (!cluster) return []

    return [makeFinding({
      analyst_id: 'repeated-tool-errors',
      area: 'tool-use',
      subject: cluster.signature,
      claim: `${cluster.span_count} failed spans share one error`,
      severity: 'high',
      confidence: 1,
      evidence_refs: [{
        kind: 'span',
        uri: `trace://${encodeURIComponent(cluster.exemplar_trace_ids[0])}/span/${encodeURIComponent(cluster.exemplar_span_ids[0])}`,
        excerpt: cluster.status_message_sample,
      }],
      recommended_action: 'Fix the highest-frequency tool error before changing prompts.',
      validation_plan: 'Run fresh cases and require this error signature to disappear.',
    })]
  },
}))
```

Use code for exact facts such as exit codes, missing fields, and repeated calls.
Use model-assisted analysts for semantic questions such as whether a response ignored user intent.

## Measure An Analyst

Do not judge an analyst by persuasive prose.
Label the issue identity and exact evidence locations, then run the same cases through every implementation.

```ts
import {
  compareAnalystRunners,
  registryBenchmarkRunner,
  renderAnalystBenchmarkMarkdown,
  runAnalystBenchmark,
  traceStoreEvidenceResolver,
} from '@tangle-network/agent-eval/analyst'

const benchmark = await runAnalystBenchmark({
  cases: [{
    id: 'failed-command',
    input: { traceStore },
    expectedIssues: [{
      id: 'repeated-command',
      subjects: ['failure-mode:repeated-command'],
      evidence: [{ kind: 'span', uri: 'trace://run-1/span/tool-3' }],
      criticalEvidence: [{ kind: 'span', uri: 'trace://run-1/span/tool-1' }],
    }],
    labeledEvidence: [
      { kind: 'span', uri: 'trace://run-1/span/tool-1' },
      { kind: 'span', uri: 'trace://run-1/span/tool-3' },
    ],
  }],
  runners: [registryBenchmarkRunner({ id: 'built-in', registry: analysts })],
  repetitions: 3,
  resolveEvidence: traceStoreEvidenceResolver((input) => input.traceStore),
  benchmark: {
    id: 'failure-localization',
    dataset: {
      id: 'my-team/trace-failures',
      revision: 'git-sha-or-content-digest',
      split: 'test',
    },
  },
})

console.log(renderAnalystBenchmarkMarkdown(benchmark))
```

The result reports:

- issue recall and finding precision,
- first bad step accuracy,
- citation coverage, agreement with labeled locations, and actual location resolution,
- false positives on clean cases,
- repeat agreement,
- failed runs,
- latency, calls, every reported token counter, and known or missing cost,
- dataset revision, case tags, case metadata, and runner metadata.

Use `compareAnalystRunners()` for paired differences between two implementations.
Repetitions are averaged within each case before comparison.
Treat its interval as inferential only with at least 20 independent cases.

## Load Public Trace Labels

Use the published label adapters with `@tangle-network/traces` or your own trajectory loader.
Agent Eval does not download datasets or own trace capture.
Load public data at an immutable commit and record that commit in `benchmark.dataset.revision`.

```ts
import {
  agentRxBenchmarkCase,
  agentRxPredictionsToFindings,
  codeTraceBenchCase,
  codeTracerPredictionsToFindings,
} from '@tangle-network/agent-eval/analyst'
import { otlpTextToTraceAnalysisStore } from '@tangle-network/agent-eval/traces'
import { chatTrajectoryToSpans, serializeSpans } from '@tangle-network/traces'

const codeSpans = chatTrajectoryToSpans(codeTraceTrajectory, {
  traceId: codeTraceRow.traj_id,
})
const codeCase = codeTraceBenchCase(codeTraceRow, {
  traceStore: otlpTextToTraceAnalysisStore(serializeSpans(codeSpans)),
})

const agentRxSpans = chatTrajectoryToSpans(agentRxMessages, {
  traceId: String(agentRxRow.trajectory_id),
  stepMode: 'message',
})
const rootCauseCase = agentRxBenchmarkCase(agentRxRow, {
  traceStore: otlpTextToTraceAnalysisStore(serializeSpans(agentRxSpans)),
}, {
  stepCount: agentRxMessages.length,
})

const codeTracerFindings = codeTracerPredictionsToFindings(
  codeTraceRow.traj_id,
  codetracerLabels,
  { stepCount: codeTraceRow.step_count },
)
const agentRxFindings = agentRxPredictionsToFindings(
  agentRxRow.trajectory_id,
  agentRxJudgeOutput,
  { stepCount: agentRxMessages.length },
)
```

`codeTraceBenchCase()` accepts the public [CodeTraceBench](https://huggingface.co/datasets/NJU-LINK/CodeTraceBench) JSONL format.
It scores the published incorrect-step task by default, including clean trajectories.
Pass `labelSet: 'incorrect-and-unuseful'` to both the case and prediction adapters only for an explicitly combined experiment.
Every cited step is checked against `step_count`.

`agentRxBenchmarkCase()` accepts the public [AgentRx](https://huggingface.co/datasets/microsoft/AgentRx) label format.
It evaluates the published root-cause task by default: category accuracy and first unrecoverable step are measured separately.
Pass `target: 'all-failures'` only when the analyst is designed to identify every annotated failure.

Both adapters emit `trace://<id>/span/step-<n>` evidence by default.
`@tangle-network/traces` uses the same IDs when converting chat trajectories.
Pass `stepUri` when your trace store uses another URI scheme.
`codeTracerPredictionsToFindings()` and `agentRxPredictionsToFindings()` translate the maintained upstream engines' native outputs into the same evidence and category shape.
The AgentRx adapter accepts its `Report.to_dict()` shape or the contained `failures` array.
`failure_case: 0` produces no finding, which scores as a missed root cause on AgentRx's failed trajectories.

## Use Upstream Scorers

Agent Eval adapts upstream evaluators instead of copying them.

```ts
import { createEvaluator } from '@arizeai/phoenix-evals'
import { ExactMatch } from 'autoevals'
import {
  autoevalsScorerJudge,
  phoenixEvaluatorJudge,
} from '@tangle-network/agent-eval/campaign'

const phoenix = createEvaluator(
  ({ output, expected }) => output === expected ? 1 : 0,
  { name: 'exact-match', telemetry: { isEnabled: false } },
)

const phoenixJudge = phoenixEvaluatorJudge(phoenix, {
  mapInput: ({ artifact, scenario }) => ({ output: artifact, expected: scenario.expected }),
})

const autoevalsJudge = autoevalsScorerJudge(ExactMatch, {
  name: 'exact-match',
  mapInput: ({ artifact, scenario }) => ({ output: artifact, expected: scenario.expected }),
})
```

These adapters do not install either upstream package for consumers.
Install only the scorer package you use.
Missing or non-finite scores throw instead of becoming passes.
Phoenix evaluators marked `MINIMIZE` or `NEUTRAL` require `toComposite` so candidate selection never assumes the wrong direction.

## Turn Reviewed Findings Into Eval Data

Generated findings can populate a review queue.
They cannot promote themselves into learning data.

```ts
import {
  analystFindingsToReviewRequests,
  analystRunToFeedbackTrajectory,
} from '@tangle-network/agent-eval'

const requests = analystFindingsToReviewRequests(result.findings)
await reviewQueue.add(requests)

declare const acceptedFindingIds: ReadonlySet<string>

const trajectory = analystRunToFeedbackTrajectory(result, {
  task: { intent: 'Find why the command failed.' },
  reviewRequests: requests,
  reviewDecisions: result.findings.map((finding) => ({
    findingId: finding.finding_id,
    verdict: acceptedFindingIds.has(finding.finding_id) ? 'confirmed' : 'rejected',
    source: 'user',
    reviewerId: 'reviewer-42',
    reviewId: 'trace-review-918',
    reason: 'Reviewed against the cited span.',
    decidedAt: new Date().toISOString(),
  })),
  trace: { artifactUri: 'traces.otlp.jsonl', traceIds: ['run-1'] },
})
```

`analystRunToFeedbackTrajectory()` stores review requests separately from labels.
It can archive an unreviewed run.
`feedbackTrajectoryToOptimizerRow()` requires one independent confirmed or rejected decision for every finding.
A run with no findings requires one independent `confirmed_clean` decision.
Generic labels and run-level outcomes do not satisfy these requirements.

## Required Trace Data

Useful analysis needs:

- stable run, trace, and span IDs,
- parent-child links and ordered timestamps,
- model, prompt, and configuration identity,
- complete tool names, arguments, results, and error codes,
- token, cost, and latency data when available,
- retrieval source IDs and scores when retrieval is involved,
- final environment outcomes such as tests, task completion, or policy blocks.

Do not include secrets, raw OAuth tokens, or unredacted personal data.

Use [`@tangle-network/traces`](https://github.com/tangle-network/traces) to normalize coding-agent sessions, run HALO as an external report engine, or run Hodoscope as a behavior-discovery engine.
