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

// ── Ingestion: production traces + user feedback (0.25.0) ───────────

/**
 * Minimal `TraceEvent` shape that the production runtime emits.
 * Matches `trace/schema.ts` `TraceEvent` but is duplicated here as a
 * wire schema so non-TypeScript clients can validate without depending
 * on internal types.
 */
export const TraceEventSchema = z
  .object({
    eventId: z.string().min(1).describe('Stable id for the event. Use ULID or UUID.'),
    runId: z.string().min(1).describe('Run this event belongs to.'),
    spanId: z.string().optional().describe('Span that emitted the event, if any.'),
    kind: z
      .enum([
        'log',
        'error',
        'budget_decrement',
        'budget_breach',
        'state_mutation',
        'policy_violation',
        'redaction_applied',
        'custom',
      ])
      .describe('Coarse event category — matches the TraceSchema v1 EventKind enum.'),
    timestamp: z
      .number()
      .int()
      .nonnegative()
      .describe('Unix millis. Must be monotonically non-decreasing within a span.'),
    payload: z
      .record(z.string(), z.unknown())
      .describe('Free-form payload — the runtime owns the shape.'),
  })
  .openapi('TraceEvent')

export const TracesIngestRequestSchema = z
  .object({
    events: z
      .array(TraceEventSchema)
      .min(1)
      .max(10_000)
      .describe('Batch of events. Max 10k per call — bigger streams should be chunked.'),
  })
  .openapi('TracesIngestRequest')

export const TracesIngestResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative().describe('Number of events persisted.'),
    rejected: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of events the store refused — see `errors[]` for reasons.'),
    errors: z
      .array(
        z.object({
          eventId: z.string().describe('Event id this error applies to.'),
          message: z.string().describe('Why the event was rejected.'),
        }),
      )
      .default([]),
  })
  .openapi('TracesIngestResponse')

export const FeedbackLabelSchema = z
  .object({
    id: z.string().optional(),
    source: z.enum(['user', 'judge', 'environment', 'metric', 'policy', 'system']),
    kind: z.enum([
      'approve',
      'reject',
      'select',
      'edit',
      'rank',
      'rate',
      'comment',
      'metric_outcome',
      'policy_block',
      'revision_request',
    ]),
    value: z.unknown(),
    reason: z.string().optional(),
    severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
    createdAt: z.string().describe('ISO-8601 UTC.'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('FeedbackLabel')

export const FeedbackAttemptSchema = z
  .object({
    id: z.string().min(1),
    stepIndex: z.number().int().nonnegative(),
    artifactType: z.enum([
      'text',
      'code',
      'plan',
      'research',
      'action',
      'ui',
      'decision',
      'data',
      'other',
    ]),
    artifact: z.unknown(),
    options: z.array(z.unknown()).optional(),
    proposedAction: z
      .object({
        type: z.string(),
        risk: z.enum(['low', 'medium', 'high']).optional(),
        costUsd: z.number().optional(),
        externalSideEffect: z.boolean().optional(),
        requiresApproval: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    feedback: z.array(FeedbackLabelSchema).optional(),
    createdAt: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('FeedbackAttempt')

export const FeedbackTrajectorySchema = z
  .object({
    id: z.string().min(1).describe('Stable id; idempotency key for the trajectory.'),
    projectId: z.string().optional(),
    scenarioId: z.string().optional(),
    task: z.object({
      intent: z.string().min(1),
      context: z.unknown().optional(),
    }),
    attempts: z.array(FeedbackAttemptSchema).default([]),
    labels: z.array(FeedbackLabelSchema).default([]),
    outcome: z
      .object({
        success: z.boolean().optional(),
        score: z.number().optional(),
        metrics: z.record(z.string(), z.number()).optional(),
        costUsd: z.number().optional(),
        detail: z.string().optional(),
        observedAt: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    split: z.enum(['train', 'dev', 'test', 'holdout']).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    createdAt: z.string().describe('ISO-8601 UTC.'),
    updatedAt: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('FeedbackTrajectory')

export const FeedbackIngestResponseSchema = z
  .object({
    id: z.string().describe('Trajectory id that was persisted.'),
    persisted: z.boolean().describe('True when the trajectory was saved (idempotent on id).'),
  })
  .openapi('FeedbackIngestResponse')

export type TraceEvent = z.infer<typeof TraceEventSchema>
export type TracesIngestRequest = z.infer<typeof TracesIngestRequestSchema>
export type TracesIngestResponse = z.infer<typeof TracesIngestResponseSchema>
export type FeedbackTrajectory = z.infer<typeof FeedbackTrajectorySchema>
export type FeedbackIngestResponse = z.infer<typeof FeedbackIngestResponseSchema>

// ── Errors ──────────────────────────────────────────────────────────

export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z
          .string()
          .describe(
            'Machine-readable code: "validation_error", "rubric_not_found", "judge_error".',
          ),
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
  const stable = stableStringify(rubric)
  let h = 5381
  for (let i = 0; i < stable.length; i++) {
    h = (h * 33) ^ stable.charCodeAt(i)
  }
  // Unsigned 32-bit hex, prefixed with rubric name + version slot
  return `${rubric.name}@${(h >>> 0).toString(16).padStart(8, '0')}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}
