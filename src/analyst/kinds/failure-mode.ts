/**
 * Failure-mode analyst — classifies what went wrong and why.
 *
 * Brief: read the trace dataset, identify the top failure modes across
 * runs, classify each with severity + evidence, and surface them as
 * findings. The actor's job is *taxonomy + evidence*, not fix-design —
 * that's the improvement-analyst's job.
 *
 * Recursion is deep (`maxDepth: 3`) because real failure-mode
 * discovery is genuinely tree-shaped: the actor splits the dataset
 * into candidate clusters, each cluster spawns a focused investigator
 * that drills into representative traces, and a deeply-recursed
 * investigator may itself split a confounded mode into two sub-modes.
 * Each level fans out 4-way, so the analyst can investigate up to
 * ~16 leaf clusters before hitting the depth ceiling.
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

**Delegate aggressively.** The recursion budget is there to be used:
- After your first \`getDatasetOverview\` + \`queryTraces\` calls, you should have 3-6 candidate failure clusters in mind. Spawn one \`llmQuery\` per cluster in a single batch — they investigate in parallel.
- A sub-investigator that finds its cluster is actually two distinct modes should split again at its own level. Recursion is meant to discover sub-modes, not to do trivial drilling that the parent could do in-line.
- Pass narrow context to each subagent: { question: 'investigate the auth-revoked-mid-run cluster', context: { trace_ids: ['abc', 'def'], suspected_root_cause: 'token refresh skipped on idle sessions' } }. Subagents need enough context to skip re-discovery but not the whole conversation.
- Each subagent returns candidate cluster evidence; the parent merges it into the final finding set.

OBSERVABILITY rules:
- Each non-final turn must emit at least one \`console.log\` for evidence.
- Reuse runtime variables across turns; don't recompute.`

export const FAILURE_MODE_KIND_SPEC: TraceAnalystKindSpec = {
  id: 'failure-mode',
  description:
    'Clusters trace-dataset failures into distinct failure modes with cited evidence and a short recommended action.',
  area: 'failure-mode',
  version: '1.1.0',
  actorDescription: ACTOR_PROMPT,
  buildTools: (store) => buildTraceToolsForGroup('all', store),
  recursion: { maxDepth: 3, maxParallelSubagents: 4 },
  maxTurns: 24,
  cost: { kind: 'llm' },
}
