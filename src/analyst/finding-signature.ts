/**
 * Typed Ax output for analyst findings.
 *
 * Replaces the legacy `findings:string[]` pattern (where every bullet
 * became a flat-severity `AnalystFinding`) with a structured object
 * array. Ax binds the field as `findings:json[]` so the provider emits
 * native structured output; at the kind-factory boundary we Zod-validate
 * each emitted finding so malformed rows fail loud instead of being
 * silently lifted with default severity.
 *
 * Why not `f.object().array()` directly in the signature? The Ax
 * signature string `question:string -> findings:json[]` already lets
 * the provider emit JSON arrays. A Zod boundary is required either
 * way (the provider can return any JSON), and Zod gives us a single
 * validation surface independent of which Ax version is installed.
 */

import { z } from 'zod'
import { parseFindingSubject } from './finding-subject'
import { coerceJson } from './parse-tolerant'

export const ANALYST_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const

export const RawAnalystFindingSchema = z
  .object({
    severity: z.enum(ANALYST_SEVERITIES),
    claim: z.string().min(1).max(2000),
    /**
     * Subject locus the finding is about. Validated at parse time
     * against the documented grammar (`finding-subject.ts`). Findings
     * with a malformed subject are rejected — they would have been
     * silently skipped by every downstream adapter, so failing loud at
     * parse time turns a hidden no-op into a kind-prompt audit signal.
     *
     * Optional because purely descriptive findings (no actionable
     * locus) are legitimate; they just don't route through the
     * KnowledgeAdapter / ImprovementAdapter.
     */
    subject: z
      .string()
      .max(400)
      .refine((s) => parseFindingSubject(s) !== null, {
        message: 'subject does not match the finding-subject grammar',
      })
      .optional(),
    evidence_uri: z.string().min(1).max(2000),
    evidence_excerpt: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().max(4000).optional(),
    recommended_action: z.string().max(2000).optional(),
  })
  .strict()

export type RawAnalystFinding = z.infer<typeof RawAnalystFindingSchema>

/**
 * Description embedded into the actor prompt so the LLM knows what
 * shape to emit. Kept here so kinds share one source of truth rather
 * than restating the schema in every prompt.
 */
export const RAW_FINDING_SCHEMA_PROMPT = `Each finding MUST be a JSON object with these fields:
  - severity: one of "critical" | "high" | "medium" | "low" | "info"
  - claim: one-sentence statement (max 2000 chars)
  - subject?: the leaf id, agent id, span id, tool name, or noun phrase the finding is about
  - evidence_uri: "span://<trace_id>/<span_id>" for trace evidence, "artifact://<relative-path>" for files, "metric://<name>" for named scalars — ALWAYS cite a real id surfaced by the tools
  - evidence_excerpt?: short quote (<=2000 chars) from the cited span/artifact
  - confidence: number 0..1 — 0.9+ when backed by exact quotes, 0.6-0.8 for inferred patterns, <0.5 for speculative
  - rationale?: one or two sentences explaining the reasoning
  - recommended_action?: concrete change phrased as an imperative ("Add ...", "Replace ...", "Stop ...") — omit when the finding is purely descriptive

Emit an empty array when the question has no findings to report. Do not fabricate evidence.`

/**
 * Validate one row emitted by the LLM. Returns the typed finding on
 * success; returns `null` and logs the reason on failure so the kind
 * factory can skip-and-count rather than abort the whole analyst run.
 */
export function parseRawFinding(
  row: unknown,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): RawAnalystFinding | null {
  const result = RawAnalystFindingSchema.safeParse(row)
  if (result.success) return result.data
  // A schema-correct finding in an unusable wrapper (a JSON string, a fenced
  // block) should be repaired, not dropped. Coerce the shape and retry ONCE.
  if (typeof row === 'string') {
    const coerced = coerceJson(row)
    if (coerced !== undefined) {
      const retry = RawAnalystFindingSchema.safeParse(coerced)
      if (retry.success) return retry.data
    }
  }
  log?.('finding rejected: schema failure', {
    issues: result.error.issues.map((i) => ({
      path: i.path.join('.'),
      code: i.code,
      message: i.message,
    })),
  })
  return null
}
