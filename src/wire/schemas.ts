/**
 * Wire-protocol schemas.
 *
 * These Zod schemas are the contract between the agent-eval runtime and
 * any non-TypeScript client (Python, Rust, Go, …). They get rendered to
 * OpenAPI by `wire/openapi.ts` and code-generators consume that spec to
 * produce typed clients in other languages.
 *
 * Rule: if it's not in this file, it isn't on the wire. Keep names and
 * shapes self-explanatory — every field has a `.describe()` so the
 * generated docs are useful without reading the source.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

// ── Building blocks ─────────────────────────────────────────────────

export const RubricDimensionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .describe('Short stable id like "buyer_quality" — used as the key in scoring output.'),
    description: z
      .string()
      .min(1)
      .describe('One-line plain-English meaning. Read by humans reviewing low scores.'),
    weight: z
      .number()
      .min(0)
      .default(1)
      .describe('Relative weight in the composite score. Default 1; 0 disables.'),
    min: z.number().default(0).describe('Lower bound of valid score for this dimension.'),
    max: z.number().default(1).describe('Upper bound of valid score for this dimension.'),
  })
  .openapi('RubricDimension')

export const FailureModeSchema = z
  .object({
    id: z.string().min(1).describe('Short stable id like "ai-cadence" — used in detection lists.'),
    description: z.string().min(1).describe('Plain-English description of the failure pattern.'),
  })
  .openapi('FailureMode')

// ── Rubric ──────────────────────────────────────────────────────────

export const RubricSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .describe('Stable name like "anti-slop" — used by clients to invoke this rubric.'),
    description: z
      .string()
      .min(1)
      .describe('What this rubric measures. Shown in /v1/rubrics listing.'),
    systemPrompt: z
      .string()
      .min(1)
      .describe(
        'Instructs the judging LLM. Should explain the persona (e.g. "senior engineer reviewing voice"), what to score on, and what to return.',
      ),
    dimensions: z
      .array(RubricDimensionSchema)
      .min(1)
      .describe('Scoring axes. The composite score is a weighted sum of these.'),
    failureModes: z
      .array(FailureModeSchema)
      .default([])
      .describe('Patterns to detect; each detected mode appears in the result.failureModes list.'),
    wins: z
      .array(FailureModeSchema)
      .default([])
      .describe('Positive patterns; each detected one appears in the result.wins list.'),
  })
  .openapi('Rubric')

// ── Judge call ──────────────────────────────────────────────────────

export const JudgeRequestSchema = z
  .object({
    rubricName: z
      .string()
      .optional()
      .describe('Use a built-in rubric by name. Mutually exclusive with `rubric`.'),
    rubric: RubricSchema.optional().describe(
      'Inline rubric definition. Mutually exclusive with `rubricName`.',
    ),
    content: z
      .string()
      .min(1)
      .describe('The text being judged — a tweet, a blog post, a code snippet, anything stringly.'),
    context: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Free-form metadata for the rubric to use — analytics, source URL, author, etc. Surfaced to the LLM.',
      ),
    model: z
      .string()
      .optional()
      .describe('Override the judge model (default routes via tcloud). e.g. "claude-opus-4-7".'),
  })
  .refine((v) => Boolean(v.rubricName) !== Boolean(v.rubric), {
    message: 'Provide exactly one of `rubricName` or `rubric`.',
  })
  .openapi('JudgeRequest')

export const JudgeResultSchema = z
  .object({
    composite: z
      .number()
      .min(0)
      .max(1)
      .describe('Weighted combination of dimension scores in 0..1. The single number to gate on.'),
    dimensions: z
      .record(z.string(), z.number())
      .describe('Per-dimension score, keyed by RubricDimension.id.'),
    failureModes: z
      .array(z.string())
      .default([])
      .describe('Failure-mode ids detected in the content (subset of rubric.failureModes ids).'),
    wins: z
      .array(z.string())
      .default([])
      .describe('Win ids detected in the content (subset of rubric.wins ids).'),
    rationale: z
      .string()
      .describe('Plain-English explanation of the score. Surfaced to the human reviewer.'),
    rubricVersion: z
      .string()
      .describe(
        'Stable hash of the rubric used. Scores are only comparable across runs when this matches.',
      ),
    model: z.string().describe('Model that produced the judgement, for reproducibility.'),
    durationMs: z.number().int().nonnegative().describe('End-to-end wall time for this call.'),
  })
  .openapi('JudgeResult')

// ── Rubric listing ──────────────────────────────────────────────────

export const RubricInfoSchema = z
  .object({
    name: z.string().describe('Pass this to /v1/judge as `rubricName`.'),
    description: z.string().describe('What this rubric measures.'),
    dimensions: z
      .array(z.object({ id: z.string(), description: z.string(), weight: z.number() }))
      .describe('The scoring axes this rubric uses, with weights.'),
    failureModes: z.array(z.string()).default([]).describe('Failure-mode ids this rubric detects.'),
    rubricVersion: z.string().describe('Stable hash — match this to compare scores across runs.'),
  })
  .openapi('RubricInfo')

export const ListRubricsResponseSchema = z
  .object({
    rubrics: z.array(RubricInfoSchema),
  })
  .openapi('ListRubricsResponse')

// ── Version / health ────────────────────────────────────────────────

export const VersionResponseSchema = z
  .object({
    package: z.string().describe('Package name (always "@tangle-network/agent-eval").'),
    version: z.string().describe('Semver of the running server. Match your client to this.'),
    wireVersion: z
      .string()
      .describe(
        'Wire-protocol semver. Bumps separately from package version when the schema changes.',
      ),
    apiSurface: z.array(z.string()).describe('List of supported method names.'),
  })
  .openapi('VersionResponse')

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    uptimeSec: z.number(),
  })
  .openapi('HealthResponse')

// ── Errors ──────────────────────────────────────────────────────────

export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z
          .string()
          .describe('Machine-readable code: "validation_error", "rubric_not_found", "judge_error".'),
        message: z.string().describe('Human-readable message.'),
        details: z.unknown().optional().describe('Optional structured detail.'),
      })
      .describe('Errors are always wrapped in this shape across all endpoints.'),
  })
  .openapi('ErrorResponse')

// ── Type exports for callers in the same package ────────────────────

export type RubricDimension = z.infer<typeof RubricDimensionSchema>
export type FailureMode = z.infer<typeof FailureModeSchema>
export type Rubric = z.infer<typeof RubricSchema>
export type JudgeRequest = z.infer<typeof JudgeRequestSchema>
export type JudgeResult = z.infer<typeof JudgeResultSchema>
export type RubricInfo = z.infer<typeof RubricInfoSchema>
export type ListRubricsResponse = z.infer<typeof ListRubricsResponseSchema>
export type VersionResponse = z.infer<typeof VersionResponseSchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

// ── Wire-protocol version ───────────────────────────────────────────

/**
 * Bump on any breaking change to a request/response schema.
 * Non-breaking (additive) changes don't require a bump.
 */
export const WIRE_VERSION = '1.0.0'

/**
 * Stable hash of a rubric. Used to make scores comparable across runs:
 * if the rubricVersion matches, the rubric was identical.
 */
export function hashRubric(rubric: Rubric): string {
  // deterministic stringify (keys sorted) for stable hashing
  const stable = JSON.stringify(rubric, Object.keys(rubric).sort())
  let h = 5381
  for (let i = 0; i < stable.length; i++) {
    h = (h * 33) ^ stable.charCodeAt(i)
  }
  // Unsigned 32-bit hex, prefixed with rubric name + version slot
  return `${rubric.name}@${(h >>> 0).toString(16).padStart(8, '0')}`
}
