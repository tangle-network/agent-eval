/**
 * Engine-neutral structured output for trace-analyst findings.
 *
 * Every recursive engine returns this shape. The TypeScript boundary validates
 * it before a finding can enter a registry or benchmark.
 */

import { z } from 'zod'
import { parseFindingSubject } from './finding-subject'
import { coerceJson } from './parse-tolerant'
import type { EvidenceRef } from './types'

export const ANALYST_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const

export const RawAnalystEvidenceSchema = z
  .object({
    uri: z.string().trim().min(1).max(2000),
    excerpt: z.string().max(2000).optional(),
  })
  .strict()

export type RawAnalystEvidence = z.infer<typeof RawAnalystEvidenceSchema>

const RawAnalystFindingBaseShape = {
  severity: z.enum(ANALYST_SEVERITIES),
  claim: z.string().min(1).max(2000),
  subject: z
    .string()
    .max(400)
    .refine((subject) => parseFindingSubject(subject) !== null, {
      message: 'subject does not match the finding-subject grammar',
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(4000).optional(),
  recommended_action: z.string().max(2000).optional(),
  // Measured cost in agent turns, as the model emits it. The unit definition
  // lives on `AnalystFinding.wasted_turns` in ./types and governs both shapes.
  // The floor is 1, not 0: the half-open count over a finding's two cited
  // boundary turns cannot be 0, so a 0 means the model counted strictly between
  // the boundaries instead. Rejecting the finding costs one finding; admitting
  // it mixes two off-by-one conventions inside a single ranked list.
  wasted_turns: z.number().int().min(1).optional(),
}

export const RawAnalystFindingSchema = z
  .object({
    ...RawAnalystFindingBaseShape,
    evidence: z.array(RawAnalystEvidenceSchema).min(1),
  })
  .strict()

export type RawAnalystFinding = z.infer<typeof RawAnalystFindingSchema>

/**
 * Description embedded into the actor prompt so the LLM knows what
 * shape to emit. Kept here so kinds share one source of truth rather
 * than restating the schema in every prompt.
 */
export const RAW_FINDING_SCHEMA_PROMPT = `Each finding MUST be a strict JSON object with:
  - severity: "critical" | "high" | "medium" | "low" | "info"
  - claim: one-sentence statement (max 2000 chars)
  - subject?: one exact subject form listed by this kind; omit rather than guess
  - evidence: REQUIRED non-empty array of {"uri": string, "excerpt"?: string}. Use trace://<URL-encoded-trace-id>/span/<URL-encoded-span-id> for trace evidence or finding://<finding-id> for supplied prior findings. URL encoding means percent encoding, never base64. Include a short exact quote in excerpt when available. If nothing is citable, do not emit the finding.
  - confidence: number 0..1 (0.9+ exact evidence; 0.6-0.8 inferred pattern; <0.5 speculative)
  - rationale?: one or two reasoning sentences
  - recommended_action?: concrete imperative change; omit for descriptive findings
  - wasted_turns?: integer >= 1 — agent turns thrown away, counted from the first turn already off-track (the diverging turn, the erroring turn) up to but NOT including the turn that corrected or recovered. A correction landing on the very next turn is 1, never 0. Count model-driven turns only; tool calls nested inside a turn are not turns. Never a wall-clock, token, dollar, or occurrence count, and never a sum across clustered instances — report the one instance your two cited spans bound. Omit it entirely unless you measured it against those two citations; a guessed cost is worse than no cost.

Unknown fields are rejected. Do not emit area; the factory assigns it. Emit [] when there are no findings. Never fabricate evidence.`

/** Convert raw citations into the public finding evidence envelope. */
export function evidenceRefsFromRawFinding(finding: RawAnalystFinding): EvidenceRef[] {
  return finding.evidence.map(({ uri, excerpt }) => ({
    kind: evidenceKindFromUri(uri),
    uri,
    excerpt,
  }))
}

export function parseRawFinding(
  row: unknown,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): RawAnalystFinding | null {
  return parseFindingWithSchema(RawAnalystFindingSchema, row, log)
}

function parseFindingWithSchema<T>(
  schema: z.ZodType<T>,
  row: unknown,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): T | null {
  const result = schema.safeParse(row)
  if (result.success) return result.data
  // A schema-correct finding in an unusable wrapper (a JSON string, a fenced
  // block) should be repaired, not dropped. Coerce the shape and retry ONCE.
  if (typeof row === 'string') {
    const coerced = coerceJson(row)
    if (coerced !== undefined) {
      const retry = schema.safeParse(coerced)
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

function evidenceKindFromUri(uri: string): EvidenceRef['kind'] {
  if (parseTraceSpanEvidenceUri(uri)) return 'span'
  if (uri.startsWith('finding://')) return 'finding'
  return 'artifact'
}

export function parseTraceSpanEvidenceUri(uri: string): { traceId: string; spanId: string } | null {
  const match = /^trace:\/\/([^/]+)\/span\/([^/]+)$/.exec(uri)
  if (!match) return null
  try {
    const traceId = decodeURIComponent(match[1]!)
    const spanId = decodeURIComponent(match[2]!)
    return traceId && spanId ? { traceId, spanId } : null
  } catch {
    return null
  }
}
