/**
 * Typed Ax output for analyst findings.
 *
 * Ax binds the field as `findings:json[]` so the provider emits native
 * structured output. At the kind-factory boundary every row is validated
 * before it becomes an `AnalystFinding`.
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
  - evidence: REQUIRED non-empty array of {"uri": string, "excerpt"?: string}. Use real identifiers with span://, event://, artifact://, metric://, or finding://. Include a short exact quote in excerpt when available. If nothing is citable, do not emit the finding.
  - confidence: number 0..1 (0.9+ exact evidence; 0.6-0.8 inferred pattern; <0.5 speculative)
  - rationale?: one or two reasoning sentences
  - recommended_action?: concrete imperative change; omit for descriptive findings

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
  if (uri.startsWith('span://')) return 'span'
  if (/^trace:\/\/[^/]+\/span\/[^/]+$/.test(uri)) return 'span'
  if (uri.startsWith('event://')) return 'event'
  if (uri.startsWith('finding://')) return 'finding'
  if (uri.startsWith('metric://')) return 'metric'
  return 'artifact'
}
