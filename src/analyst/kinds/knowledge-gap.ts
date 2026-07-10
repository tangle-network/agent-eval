/**
 * Knowledge-gap analyst — what did the agent NOT know that it needed?
 *
 * Brief: find moments in the trace where the agent had to guess, ask
 * the user to fill in context, recover from a wrong assumption, or
 * loop on a retrieval. Each finding names a *missing or outdated piece
 * of knowledge* the agent's curated knowledge base should have held —
 * or a downstream lookup (web, docs, tool description) that surfaced
 * stale or outdated information.
 *
 * The primary expected store is `@tangle-network/agent-knowledge`: a
 * Karpathy-style wiki the agent maintains with raw ↔ curated pages,
 * source anchors, and claim/relation triples. A gap is anything the
 * agent had to discover at run-time that should already have lived
 * there. Secondary loci: web-search results that returned outdated
 * pages, tool descriptions that omitted critical behavior, system-
 * prompt sections that didn't cover the case.
 *
 * Distinct from failure-mode: failure-mode classifies *how* it broke;
 * knowledge-gap names the *information* whose absence (or staleness)
 * caused the break. One failure-mode often maps to several gaps.
 *
 * Recursion (`maxDepth: 2`) is enough to fan out one subagent per
 * candidate gap-source layer; each subagent runs a focused detection.
 */

import { findingSubjectGrammarPromptFor } from '../finding-subject'
import type { TraceAnalystKindSpec } from '../kind-factory'
import { buildTraceToolsForGroup } from '../tool-groups'

const subjectGrammar = findingSubjectGrammarPromptFor('knowledge-gap')

const ACTOR_PROMPT = `You are a knowledge-gap analyst for an OTLP trace dataset. Your job is to identify the **specific pieces of information the agent lacked, or that were stale**, that caused poor decisions.

The agent under analysis maintains a curated knowledge base via \`@tangle-network/agent-knowledge\` — a wiki of \`KnowledgePage\`s with raw source anchors, claims, and relations. The primary expected store of agent-knowable facts IS that wiki. A "knowledge gap" is anything the agent had to discover or guess at run-time that the wiki should have held — or an outdated/contradictory fact the agent picked up from a non-wiki source.

${subjectGrammar}

DISCOVERY → ATTRIBUTE-TO-LAYER → CITE protocol:

1. \`traces.getDatasetOverview({})\` first. Note which agents, tools, and models appear.
2. Pull traces where the agent shows gap signals. The strongest signals are:
   - Self-correction turns ("I assumed X but…", "let me re-check", "actually,")
   - Clarifying-question turns where the agent asked the user something the runtime should have surfaced
   - Repeated retrieval / lookup calls for the same artifact with slightly varied queries
   - Tool errors that name a missing argument or unknown resource
   - Web-search calls returning pages dated before a known cutoff for content that changes (versioned APIs, schemas, policies)
   - Agent quoting a tool's docs / system prompt incorrectly because the actual text was insufficient
   - Fabricated identifiers that don't appear in dataset \`sample_trace_ids\`
   Use \`traces.searchTrace\` with patterns like \`I (don.?t|do not) know\`, \`assumed\`, \`unclear\`, \`could you (clarify|tell me|provide)\`, \`not found\`, \`undefined\`, \`unknown\`, \`null\`, dates older than the analysis window, or the agent's specific clarification phrases.
3. For each gap, identify the **layer of the runtime that should have prevented it** and use its exact locus from the subject grammar above.
4. For each gap you can defend with evidence, emit ONE finding with:
   - \`area\` = "knowledge-gap"
   - \`subject\` = one exact locus form from the subject grammar above
   - \`claim\` = a sentence naming the missing or stale knowledge ("wiki has no page on invoice line-item shape, agent had to re-derive it from raw spans")
   - \`severity\` = "high" when the gap caused a failure or a clarifying question; "medium" when it caused unnecessary turns; "low" when it caused minor inefficiency
   - \`evidence_uri\` = \`span://<trace_id>/<span_id>\` of the moment the gap surfaced (the question, the self-correction, the retrieval miss, the stale web result)
   - \`evidence_excerpt\` = exact quote where the agent showed the gap
   - \`confidence\` = 0.85+ when the agent itself articulated the gap; 0.6-0.8 when inferred from behavior
   - \`recommended_action\` = phrased as a wiki edit when the locus is \`agent-knowledge:*\` ("Create wiki page \`invoice-line-items\` with claims: ..."), or as a prompt/tool-doc edit otherwise

**Delegate per layer.** After your first scan, you should have candidates spread across \`agent-knowledge:*\`, \`websearch:outdated\`, \`tool-doc:*\`, \`system-prompt:*\`, and \`memory:*\`. Spawn one \`llmQuery\` per layer in parallel — each subagent runs a focused detection (e.g. the \`agent-knowledge\` subagent looks for both missing-pages AND stale-pages; the \`websearch\` subagent looks specifically for date staleness signals; the \`tool-doc\` subagent looks for tool-call argument errors a fuller description would have prevented). Subagents return findings; you merge and emit one \`final({ findings })\` at the top.

Do NOT report a gap that the agent later recovered from cleanly within the same turn — that's resilience, not a gap. Cite the *non-recovery* version when both exist.

OBSERVABILITY rules:
- Each non-final turn must emit at least one \`console.log\` for evidence.
- Call \`final({ findings: [...] })\` exactly once at the top level.`

export const KNOWLEDGE_GAP_KIND_SPEC: TraceAnalystKindSpec = {
  id: 'knowledge-gap',
  description:
    'Identifies missing or stale pieces of knowledge — primarily against the agent-knowledge wiki — and attributes each to the runtime layer (wiki page, claim, raw source, websearch, tool-doc, system-prompt, memory) that should have held it.',
  area: 'knowledge-gap',
  version: '1.0.0',
  actorDescription: ACTOR_PROMPT,
  buildTools: (store) => buildTraceToolsForGroup('discoveryAndSearch', store),
  recursion: { maxDepth: 2, maxParallelSubagents: 4 },
  maxTurns: 18,
  cost: { kind: 'llm' },
}
