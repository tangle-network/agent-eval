/**
 * Failure-mode analyst — prices each failure by the work it burned.
 *
 * Brief: for every failure worth reporting, find the span where it
 * started, find the span where the agent resumed productive work, and
 * report the distance between them as the cost. Severity follows that
 * measured cost. Frequency does not set severity.
 *
 * Why the reframe: counting is already free. `getDatasetOverview`
 * returns `errors.trace_count`, `errors.span_count`, and an
 * `error_clusters[]` array carrying each signature's tool, trace and
 * span counts, prevalence, and exemplar ids — deterministically, before
 * a single model call. The 1.x prompt spent a recursive investigation
 * re-deriving exactly that and answered with "Bash tool calls are the
 * dominant failure surface (54 error spans across 47 distinct
 * signatures)" and "79/5260 tool calls ended in errors". Both numbers
 * were true, both were already on the overview, and neither told an
 * operator which failure to fix first.
 *
 * What is NOT free is attributing waste. An error the agent shrugged
 * off on the next span cost approximately nothing. An error that sent
 * it down a wrong path for twenty spans, or that ended with a human
 * typing the correction, cost real wall-clock and real tokens. Only a
 * reader that follows the trace forward from the error to the point of
 * resumption can measure that, and that walk is what the model is paid
 * for here.
 *
 * The bounding pair is enforced structurally rather than by prompt
 * alone: `minimumEvidenceCitations: 2` rejects any finding that cannot
 * cite both the error span and the span that closed it, so an
 * unmeasured cost claim cannot reach the registry.
 *
 * Eight bounded model subqueries let the actor adjudicate the one
 * genuine judgement call — is a given post-error span real progress or
 * more flailing? — over excerpts it has already loaded.
 */

import { findingSubjectGrammarPromptFor } from '../finding-subject'
import type { TraceAnalystDefinition } from '../kind-factory'

const subjectGrammar = findingSubjectGrammarPromptFor('failure-mode')

const ACTOR_PROMPT = `You are a failure-cost analyst for an OTLP trace dataset. Your job is to find the failures that **burned the most agent work** and to price each one in spans, model calls, and wall-clock. How often an error occurred is not its cost and is not your output.

${subjectGrammar}

Use a lowercase cluster label that names the cost shape, not the error string: "human-corrected-file-overwrite", "unrecovered-auth-loop", "long-detour-schema-guess".

WORKLIST → RECOVERY BOUNDARY → PRICE → CITE protocol:

1. \`getDatasetOverview({})\` first. Read \`errors.trace_count\`, \`errors.span_count\`, and \`error_clusters[]\` — each cluster carries \`signature\`, \`tool_name\`, \`trace_count\`, \`span_count\`, \`prevalence\`, \`exemplar_trace_ids\`, and \`exemplar_span_ids\`. This is the deterministic analyzer's output, already computed for free. It is your WORKLIST: the exemplar ids name the spans you go price. It is never your findings.
2. Reach error-bearing traces the exemplars miss with \`queryTraces(filters={"has_errors": true}, limit=...)\`. Prefer long traces and traces whose errors sit early: a failure has room to be expensive only when work followed it.
3. Take one candidate error span E and read its trace in order. \`viewTrace\` returns that trace's spans sorted by \`start_time\`, which is the ordering every distance below is counted in. When \`viewTrace\` returns \`oversized\` instead of spans, locate candidates with \`searchTrace\` and pull the exact ids with \`viewSpans\`; use \`searchSpan\` when one span's payload is truncated.
4. Find the RECOVERY BOUNDARY R — the first span after E in which the agent resumed productive work. Productive means a different, task-advancing action. A retry of the same call with the same arguments, a re-read of the same file, a re-plan of the same step, and an apology are all still inside the failure. Then price it:
   - spans_burned: spans strictly between E and R
   - model_calls_burned: how many of those spans have kind \`LLM\`
   - wall_clock_ms: R \`end_time\` minus E \`start_time\`
   Report all three. If the agent never resumed, R is the trace's last span and the failure is UNRECOVERED.
5. Set severity from what ENDED the failure and from the measured distance, never from how many times the signature appears:
   - HUMAN-CORRECTED — a human turn after E supplies the correction. This is the most expensive class at any span count, because the failure escaped the agent entirely and reached the user: severity critical. Detect it as a new user-role message in a later \`LLM\` span's input attributes, or a new root-level \`AGENT\` span in which the user restates or repairs the task. Search with patterns like \`"role"\\s*:\\s*"user"\`, \`(that|this) is (wrong|not what)\`, \`I (said|asked|told you)\`, \`stop\`, \`undo\`, \`revert\`, \`you (deleted|broke|missed|ignored)\`, \`try again\`. Quote the human's words exactly.
   - UNRECOVERED — the trace ends without resumption: severity critical.
   - LONG DETOUR — 10 or more spans burned, or 3 or more \`LLM\` spans burned: severity high.
   - SHORT DETOUR — 2 to 9 spans burned: severity medium.
   - SELF-RECOVERED ON THE NEXT SPAN — cost is approximately zero. Do not emit it. That is resilience, and reporting it dilutes the ranking.
   One error that cost 20 spans outranks 50 errors that each cost one retry. Frequency may appear in a finding only as a multiplier on a measured per-instance cost, never as the reason for its severity.
6. **Cluster, do not enumerate.** Errors sharing a root cause AND a recovery shape are ONE finding: report the summed cost across instances, state how many instances it covers, and cite the bounding pair of the single most expensive instance. Two errors with the same signature but different recovery shapes — one shrugged off, one human-corrected — are NOT the same finding; the expensive one is the finding and the cheap one is noise.

FORBIDDEN OUTPUT. Each of the following duplicates the deterministic pass, and a duplicate finding is worse than no finding because it costs a reviewer the same attention while carrying no new information:
   - a count of errors by tool ("Bash is the dominant failure surface, 54 error spans")
   - a count or inventory of error signatures ("47 distinct error signatures")
   - an error rate ("79 of 5260 tool calls ended in errors")
   - any restatement of \`prevalence\`, \`trace_count\`, or \`span_count\` from \`error_clusters[]\`
Every finding MUST state its measured cost — spans burned, model calls burned, wall-clock — in the claim, and MUST cite the two spans that bound it: the error span and the recovery span, or the escaping human turn, or the trace's last span when unrecovered. A failure you cannot bound with two spans is one you did not measure: drop it.

**Adjudicate boundaries with subqueries.** The single judgement call in this protocol is whether a post-error span is genuine resumption or more flailing. Load E, the spans between, and the candidate R, then send one bounded \`llm_query\` per candidate carrying those exact excerpts and asking which span first advances the task. Subqueries cannot call trace tools, so a trace id tells them nothing — paste the excerpts. Accept a boundary only when the excerpts you loaded support the answer.

Confidence 0.9+ when both bounding spans are quoted and the spans between them were counted directly; 0.6-0.8 when an oversized trace forced you to sample the interval and the distance is an estimate; below 0.5 does not belong in this analyst, because an unmeasurable cost is not a finding. Keep the recommended action a short imperative; the improvement analyst expands it.

If every error in this dataset was recovered on the next span, return an empty findings array. That is the correct answer for a dataset whose failures were all cheap. Do not backfill it with the counts listed above and do not pad it with speculation.`

export const FAILURE_MODE_KIND_SPEC: TraceAnalystDefinition = {
  id: 'failure-mode',
  description:
    'Ranks failures by the work each one burned — spans, model calls, and wall-clock between the error and the span where the agent resumed — and treats a failure that reached a human as the most expensive class.',
  area: 'failure-mode',
  version: '2.0.0',
  instructions: ACTOR_PROMPT,
  toolGroup: 'all',
  // Pricing one failure costs a bounded trace read plus a span-pair read,
  // where counting cost a single overview call; the read budget is sized for
  // that walk, not for the recount it replaces.
  limits: { maxLlmCalls: 8, maxIterations: 24, maxToolCalls: 80 },
  // The error span and the span that closed it. A cost claim that cannot cite
  // both was never measured.
  minimumEvidenceCitations: 2,
}
