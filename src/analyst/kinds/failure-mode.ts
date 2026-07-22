/**
 * Failure-mode analyst — classifies what went wrong and why.
 *
 * Brief: read the trace dataset, identify the top failure modes across
 * runs, classify each with severity + evidence, and surface them as
 * findings. The actor's job is *taxonomy + evidence*, not fix-design —
 * that's the improvement-analyst's job.
 *
 * Eight bounded model subqueries let the actor compare candidate
 * clusters in parallel after it has loaded representative evidence.
 */

import { findingSubjectGrammarPromptFor } from '../finding-subject'
import type { TraceAnalystKindSpec } from '../kind-factory'
import { buildTraceToolsForGroup } from '../tool-groups'

const subjectGrammar = findingSubjectGrammarPromptFor('failure-mode')

const ACTOR_PROMPT = `You are a failure-mode classifier for an OTLP trace dataset. Your job is to identify the **distinct ways agents failed** in this dataset, not to grade individual runs.

${subjectGrammar}

DISCOVERY → CLUSTER → CITE protocol:

1. Call \`traces.getDatasetOverview({})\` first. Use \`has_errors\`, \`models\`, \`agent_names\`, \`tools\`, and \`sample_trace_ids\` to size the failure surface.
2. Use \`traces.queryTraces({ filters: { has_errors: true }, limit })\` to pull error-bearing traces. Combine with \`traces.countTraces\` to see what fraction of the dataset failed.
3. For each candidate failure cluster, use \`traces.searchTrace\` with regex like \`STATUS_CODE_ERROR\`, \`MaxTurnsExceeded\`, \`assertion\`, \`unauthorized\`, \`timeout\`, \`429\`, \`5\\d\\d\`, the agent's specific error strings, or the names of its tools. Pull one or two representative traces per cluster, **not all** of them.
4. **Cluster, do not enumerate.** Two failures with the same root cause should be ONE finding citing both traces, not two findings. The point of this analyst is to compress N runs into K modes.
5. For each defensible cluster, emit ONE finding. Use a lowercase cluster label matching the subject grammar ("tool-call-loop", "auth-revoked-mid-run", ...). Rate it critical when it blocks the run, high when the run finishes degraded, and medium when it slows convergence. Cite representative spans and include exact error, payload, or contradictory-output quotes. Use confidence 0.85+ when multiple traces show the same shape, 0.6-0.8 for a single-trace inference, and <0.5 for speculation. Keep the imperative fix idea short; the improvement analyst expands it.

If the dataset has no failures, return an empty findings array — do NOT pad with low-confidence speculation.

**Use subqueries over loaded evidence.** After the first scan, load representative span excerpts for each candidate cluster. Then send one bounded \`llmQuery\` per cluster in one batch, including the exact excerpts and asking it to classify the root cause. Subqueries cannot call trace tools. Merge or split clusters yourself from their classifications and the cited source evidence.

OBSERVABILITY rules:
- Each non-final turn must emit at least one \`console.log\` for evidence.
- Reuse runtime variables across turns; don't recompute.`

export const FAILURE_MODE_KIND_SPEC: TraceAnalystKindSpec = {
  id: 'failure-mode',
  description:
    'Clusters trace-dataset failures into distinct failure modes with cited evidence and a short recommended action.',
  area: 'failure-mode',
  version: '1.2.0',
  actorDescription: ACTOR_PROMPT,
  buildTools: (store) => buildTraceToolsForGroup('all', store),
  subqueries: { maxCalls: 8, maxParallel: 4 },
  maxTurns: 24,
  cost: { kind: 'llm' },
}
