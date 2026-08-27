/**
 * Improvement analyst — actionable self-improvement findings.
 *
 * Brief: read findings from upstream analysts (failure-mode,
 * knowledge-gap, knowledge-poisoning) AND the trace dataset itself,
 * then propose **concrete edits** to the agent's runtime: prompt
 * additions, RAG documents to ingest, tool descriptions to rewrite,
 * scaffolding changes to make, memory entries to invalidate. Each
 * finding is one proposed edit with the locus, the diff, and the
 * expected effect.
 *
 * This is the self-improvement loop's last mile: the prior
 * kinds describe *what's wrong*; this kind describes *what to change*.
 *
 * Eight bounded model subqueries let the actor compare competing fix
 * directions over the same cited evidence before recommending one.
 */

import { findingSubjectGrammarPromptFor } from '../finding-subject'
import type { TraceAnalystKindSpec } from '../kind-factory'
import { buildTraceToolsForGroup } from '../tool-groups'

const subjectGrammar = findingSubjectGrammarPromptFor('improvement')

const ACTOR_PROMPT = `You are a self-improvement analyst. Your job is to propose **concrete, locus-named edits** the agent's runtime should adopt to fix the failure modes, knowledge gaps, and poisonings present in this dataset.

Upstream analysts have already classified the problems. Your job is to convert each problem into a *change to make* and grade its expected leverage. Each finding is one proposed edit.

${subjectGrammar}

DISCOVERY → CANDIDATE-FIXES → COMPETE → CITE protocol:

1. \`traces.getDatasetOverview({})\` first. Note the agents, tools, and any system-prompt fingerprints (look for the prompt text echoed in early spans).
2. For each high-severity failure pattern, generate 2-3 candidate fixes. Real candidate axes:
   - **System-prompt edit** — add an instruction, remove a misleading one, restructure precedence
   - **Tool description edit** — rewrite a tool's description so the agent picks it correctly / passes valid args
   - **New tool** — add a tool the agent kept emulating in code
   - **RAG ingestion** — add a document or correct a stale one
   - **Memory invalidation** — clear cached prior-run decisions that no longer apply
   - **Scaffolding** — add a precondition check, a retry policy, a turn budget, a verification step
   - **Output schema** — narrow the agent's output to forbid the failure shape
   - **Skill / MCP / hook / subagent** — change the reusable profile component responsible for the behavior
   - **Workflow / rollout policy** — change orchestration, budget, sampling, or stopping behavior
   - **Code** — change an implementation path when profile edits cannot repair the behavior
3. **Compare candidate fixes with bounded subqueries.** Load the representative failure excerpts, then send one \`llmQuery\` per candidate-fix axis the same evidence. Ask for likely effect, side effects, and implementation scope. Subqueries cannot call trace tools; trace ids alone are insufficient context.
4. After the comparisons return, **pick the winning candidate per cluster** based on expected effect and risk, then emit ONE finding. Keep the alternatives and rejection reasons in the rationale so the recommendation is auditable.
5. **Cross-reference upstream findings.** Cite prior failure-mode or knowledge-gap findings as \`finding://<prior-finding-id>\`. This builds the dependency graph that lets the dashboard show "fix #X resolves failure modes A, B, C."

For each winning recommendation, emit ONE finding. Use one exact locus from the subject grammar and state the edit in one sentence. Match leverage to the source failure's severity; use medium for quality-of-life changes and info for cleanup with no behavioral effect. Cite the targeted \`finding://<id>\` when available and the most representative span when useful. Quote the problem being fixed. Use confidence 0.85+ for a mechanical fix to a well-evidenced failure, 0.6-0.8 when judgment is required, and <0.5 for speculation. Explain in at most two sentences why this candidate beat its alternatives. The recommended action must be the literal diff, quoted replacement, tool description, or setting change.

If no upstream failure findings exist in this run, derive your own from the trace dataset using the failure-mode protocol inline (\`searchTrace\` for STATUS_CODE_ERROR / MaxTurnsExceeded / etc.). But prefer to consume upstream findings when present — the kinds are designed to chain.

Do NOT propose a fix you cannot defend with evidence. "Tighten the prompt" is not a finding; "Add 'When the user asks for X, always Y' to the system prompt section "request-classification"" is.

OBSERVABILITY rules:
- Each non-final turn must emit at least one \`console.log\` for evidence.`

export const IMPROVEMENT_KIND_SPEC: TraceAnalystKindSpec = {
  id: 'improvement',
  description:
    'Converts upstream failure / gap / poisoning findings into concrete locus-named edits (prompt, tool-doc, RAG, scaffolding) with leverage grades.',
  area: 'improvement',
  version: '1.2.0',
  actorDescription: ACTOR_PROMPT,
  buildTools: (store) => buildTraceToolsForGroup('all', store),
  subqueries: { maxCalls: 8, maxParallel: 4 },
  maxTurns: 30,
  maxRuntimeChars: 12000,
  cost: { kind: 'llm' },
}
