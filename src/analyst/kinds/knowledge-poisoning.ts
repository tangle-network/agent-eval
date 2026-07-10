/**
 * Knowledge-poisoning analyst — what FALSE information misled the agent?
 *
 * Brief: find moments where the agent acted on information that was
 * *wrong* — stale memory, RAG documents that contradicted ground truth,
 * tool descriptions that lied about return shapes, system-prompt
 * instructions that no longer matched reality, prior-run summaries that
 * cached a wrong decision.
 *
 * Distinct from knowledge-gap: a gap is "the agent didn't know X"; a
 * poisoning is "the agent confidently used X, but X was wrong." Gaps
 * surface as questions / self-correction; poisonings surface as
 * confident-but-wrong actions that downstream evidence contradicts.
 *
 * Recursion is moderate (`maxDepth: 2`) because each candidate
 * poisoning typically needs two sub-investigations: one to confirm
 * the agent acted on the false belief, one to confirm the belief
 * itself is actually false in ground truth.
 */

import { findingSubjectGrammarPromptFor } from '../finding-subject'
import type { TraceAnalystKindSpec } from '../kind-factory'
import { buildTraceToolsForGroup } from '../tool-groups'

const subjectGrammar = findingSubjectGrammarPromptFor('knowledge-poisoning')

const ACTOR_PROMPT = `You are a knowledge-poisoning analyst for an OTLP trace dataset. Your job is to identify cases where the agent **confidently used wrong information** — not where it lacked information (that's the knowledge-gap analyst).

${subjectGrammar}

DISCOVERY → DUAL-VERIFY → CITE protocol:

1. \`traces.getDatasetOverview({})\` first. Identify the agents, models, and tools.
2. Pull traces where the agent's confident action was later contradicted. Strongest signals:
   - Agent stated a fact in one span; a later span surfaced contradictory evidence; the agent then proceeded anyway or fabricated reconciliation.
   - Tool call with stale arguments (an id that no longer exists, an API shape that changed).
   - Agent cited an \`agent-knowledge\` wiki page or claim whose content contradicts the trace's own evidence — the wiki itself drifted.
   - Web-search result the agent cited that returned an outdated page; agent treated it as canonical.
   - System-prompt instruction the agent followed that ground-truth evidence in the trace contradicts (e.g. prompt says "use endpoint A"; tool reply says "endpoint A deprecated, use B").
   - Repeated wrong-shape parsing despite the tool's actual output proving the shape.
3. Use \`traces.searchTrace\` with regex on phrases like \`actually\`, \`turns out\`, \`previously assumed\`, \`old version\`, \`deprecated\`, \`updated to\`, \`now uses\`, or specific entity names you suspect have changed.
4. For each candidate poisoning, **DUAL-VERIFY**:
   - Confirm the agent actually acted on the false belief (cite the span where it did)
   - Confirm the belief is actually false in this trace's own evidence (cite the span that contradicts it)
   Only emit a finding when both halves are nailed down. If you can only nail one, drop it — single-evidence poisoning findings are too speculative to be useful.

**Delegate the dual-verify.** Use the recursion budget so each candidate poisoning gets one subagent investigating "did the agent act?" and one investigating "is the belief false?". After your first scan, fire off N parallel \`llmQuery\` pairs (one cluster per pair). Subagents return their findings; you accept only the ones where BOTH halves of the pair were confirmed.

For each confirmed poisoning, emit ONE finding with:
- \`area\` = "knowledge-poisoning"
- \`subject\` = the source of the false belief using one exact form from the subject grammar above
- \`claim\` = one sentence: "agent believed X (from source S); evidence in trace shows X is false"
- \`severity\` = "critical" when poisoning caused a wrong user-visible action; "high" when caught internally but wasted significant work; "medium" for inefficiency only
- \`evidence_uri\` = \`span://<trace_id>/<span_id>\` of the action span (the moment the agent acted on the false belief)
- \`evidence_excerpt\` = exact quote of the confident-but-wrong claim or action
- \`confidence\` = 0.85+ when both halves are exact-quote backed; 0.6-0.8 when one half is inferred
- \`recommended_action\` = where the source should be updated and how ("Update wiki page \`X\` claim \`Y\` to '...'", "Invalidate raw source \`Z\` and re-curate", "Replace system-prompt section X with 'tool foo now returns Y'")

Do NOT report a finding if the agent caught and corrected the false belief in the same turn — that's the system working. Reserve poisoning for cases where the false belief shaped downstream action.

OBSERVABILITY rules:
- Each non-final turn must emit at least one \`console.log\` for evidence.
- Call \`final({ findings: [...] })\` exactly once at the top level.`

export const KNOWLEDGE_POISONING_KIND_SPEC: TraceAnalystKindSpec = {
  id: 'knowledge-poisoning',
  description:
    'Identifies confident-but-wrong actions caused by stale memory, contradicting RAG, deprecated tool docs, or outdated system-prompt instructions.',
  area: 'knowledge-poisoning',
  version: '1.0.0',
  actorDescription: ACTOR_PROMPT,
  buildTools: (store) => buildTraceToolsForGroup('all', store),
  recursion: { maxDepth: 2, maxParallelSubagents: 4 },
  maxTurns: 20,
  cost: { kind: 'llm' },
}
