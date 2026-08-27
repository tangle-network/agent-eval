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

/** Original public schema retained for stored rows and callback contracts. */
export const RawAnalystFindingSchema = z
  .object({
    ...RawAnalystFindingBaseShape,
    evidence_uri: z
      .string()
      .min(1)
      .max(2000)
      .refine((uri) => uri.trim().length > 0, { message: 'evidence_uri must not be blank' }),
    evidence_excerpt: z.string().max(2000).optional(),
  })
  .strict()

export type RawAnalystFinding = z.infer<typeof RawAnalystFindingSchema>

const CanonicalRawAnalystFindingObjectSchema = z
  .object({
    ...RawAnalystFindingBaseShape,
    evidence: z.array(RawAnalystEvidenceSchema).min(1),
  })
  .strict()

/**
 * Canonical plural-evidence contract. The preprocessor accepts the original
 * `evidence_uri` / `evidence_excerpt` pair and normalizes it into one evidence
 * item so persisted rows and older model fixtures remain readable. New output
 * always receives the plural shape.
 */
export const CanonicalRawAnalystFindingSchema = z.preprocess(
  normalizeLegacySingleCitation,
  CanonicalRawAnalystFindingObjectSchema,
)

export type CanonicalRawAnalystFinding = z.infer<typeof CanonicalRawAnalystFindingSchema>

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

/** Convert canonical raw citations into the public finding evidence envelope. */
export function evidenceRefsFromRawFinding(finding: CanonicalRawAnalystFinding): EvidenceRef[] {
  return finding.evidence.map(({ uri, excerpt }) => ({
    kind: evidenceKindFromUri(uri),
    uri,
    excerpt,
  }))
}

/**
 * Validate the original singular-evidence shape. This public parser retains
 * its pre-canonicalization result type so existing callback code and stored
 * rows continue to receive exactly the object accepted by
 * {@link RawAnalystFindingSchema}.
 */
export function parseRawFinding(
  row: unknown,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): RawAnalystFinding | null {
  return parseFindingWithSchema(RawAnalystFindingSchema, row, log)
}

/** Validate model output and normalize original singular citations. */
export function parseCanonicalRawFinding(
  row: unknown,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): CanonicalRawAnalystFinding | null {
  return parseFindingWithSchema(CanonicalRawAnalystFindingSchema, row, log)
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

function normalizeLegacySingleCitation(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const row = value as Record<string, unknown>
  if ('evidence' in row) {
    if (!('evidence_uri' in row) || !Array.isArray(row.evidence)) return value
    const { evidence, evidence_uri: uri, evidence_excerpt: excerpt, ...rest } = row
    let alreadyPresent = false
    const mergedEvidence = evidence.map((citation) => {
      if (
        citation === null ||
        typeof citation !== 'object' ||
        Array.isArray(citation) ||
        (citation as Record<string, unknown>).uri !== uri
      ) {
        return citation
      }
      alreadyPresent = true
      const current = citation as Record<string, unknown>
      return excerpt === undefined || current.excerpt !== undefined
        ? citation
        : { ...current, excerpt }
    })
    return {
      ...rest,
      evidence: alreadyPresent
        ? mergedEvidence
        : [...evidence, { uri, ...(excerpt === undefined ? {} : { excerpt }) }],
    }
  }
  if (!('evidence_uri' in row)) return value
  const { evidence_uri: uri, evidence_excerpt: excerpt, ...rest } = row
  return {
    ...rest,
    evidence: [{ uri, ...(excerpt === undefined ? {} : { excerpt }) }],
  }
}

/** Present a canonical finding to callbacks compiled against the original API. */
export function toLegacyRawAnalystFinding(finding: CanonicalRawAnalystFinding): RawAnalystFinding {
  const primaryEvidence = finding.evidence[0]
  if (!primaryEvidence) {
    throw new TypeError('Canonical raw analyst findings require at least one evidence citation')
  }
  const { evidence: _evidence, ...rest } = finding
  return {
    ...rest,
    evidence_uri: primaryEvidence.uri,
    ...(primaryEvidence.excerpt === undefined ? {} : { evidence_excerpt: primaryEvidence.excerpt }),
  }
}

/**
 * Run an original callback without discarding additional canonical citations.
 * A callback can replace the primary citation; the remaining evidence is kept
 * because the old shape cannot inspect or intentionally remove it.
 */
export function applyLegacyRawFindingCallback(
  finding: CanonicalRawAnalystFinding,
  callback: (row: RawAnalystFinding) => RawAnalystFinding | null,
  log?: (msg: string, fields?: Record<string, unknown>) => void,
): CanonicalRawAnalystFinding | null {
  const callbackResult = callback(toLegacyRawAnalystFinding(finding))
  if (callbackResult === null) return null
  const parsed = parseCanonicalRawFinding(callbackResult, log)
  if (!parsed) return null
  const primaryEvidence = parsed.evidence[0]
  if (!primaryEvidence) {
    throw new TypeError('Canonical raw analyst findings require at least one evidence citation')
  }
  const remainingEvidence = finding.evidence
    .slice(1)
    .filter((citation) => citation.uri !== primaryEvidence.uri)
  return {
    ...parsed,
    evidence: [primaryEvidence, ...remainingEvidence],
  }
}

function evidenceKindFromUri(uri: string): EvidenceRef['kind'] {
  if (uri.startsWith('span://')) return 'span'
  if (uri.startsWith('event://')) return 'event'
  if (uri.startsWith('finding://')) return 'finding'
  if (uri.startsWith('metric://')) return 'metric'
  return 'artifact'
}
