import { z } from 'zod'
import { hashCanonical } from '../ledger-core/canonical'
import { certificationEvidenceDigest } from '../verdict'
import { VERIFICATION_STRATEGY_SOURCES } from '../verification-strategy'
import { type BenchmarkDefinition, benchmarkDefinitionDigest, defineBenchmark } from './definition'
import type { BenchmarkEvaluation } from './types'

/** A measured task result with the identities needed to join it to an accepted benchmark. */
export interface BenchmarkResult {
  schemaVersion: 1
  definitionDigest: string
  taskId: string
  /** Content digest of the produced artifact, supplied by its execution owner. */
  artifactDigest: string
  evaluation: BenchmarkEvaluation & { passed: boolean }
}

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'must not be blank')
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const schema = z
  .object({
    schemaVersion: z.literal(1),
    definitionDigest: digest,
    taskId: text,
    artifactDigest: digest,
    evaluation: z
      .object({
        score: z.number().finite().min(0).max(1),
        passed: z.boolean(),
        dimensions: z.record(z.string(), z.number().finite()).optional(),
        raw: z
          .record(z.string(), z.unknown())
          .refine((raw) => Object.keys(raw).length > 0, 'raw evidence required'),
        notes: z.string().optional(),
        certification: z
          .object({
            strategy: z.enum(VERIFICATION_STRATEGY_SOURCES),
            checker: z
              .object({ name: text, version: text, pins: z.record(text, text).optional() })
              .strict(),
            assumptions: z.array(text),
            evidenceDigest: text,
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()

/**
 * Validate retained JSON without executing a checker. With a definition, also bind the task,
 * metric and claimed checker. Validation cannot authenticate an untrusted producer's attestation.
 */
export function defineBenchmarkResult(
  input: unknown,
  definition?: BenchmarkDefinition,
): BenchmarkResult {
  hashCanonical(input)
  const result = schema.parse(input)
  if (definition) {
    const expected = defineBenchmark(definition)
    if (result.definitionDigest !== benchmarkDefinitionDigest(expected)) {
      throw new Error('benchmark result definition digest mismatch')
    }
    if (!expected.taskIds.includes(result.taskId))
      throw new Error('benchmark result task is outside the frozen roster')
    const certification = result.evaluation.certification
    if (
      certification &&
      (certification.strategy !== expected.verification.strategy ||
        hashCanonical(certification.checker) !== hashCanonical(expected.verification.checker) ||
        hashCanonical(certification.assumptions) !==
          hashCanonical(expected.verification.assumptions))
    ) {
      throw new Error('benchmark result certification checker mismatch')
    }
  }
  if (
    result.evaluation.certification &&
    result.evaluation.certification.evidenceDigest !== benchmarkResultEvidenceDigest(result)
  ) {
    throw new Error('benchmark result certification evidence digest mismatch')
  }
  return result
}

/** Bind identities and the complete measurement, excluding the certificate's own digest. */
export function benchmarkResultEvidenceDigest(result: BenchmarkResult): string {
  const { certification: _certification, ...evaluation } = result.evaluation
  return certificationEvidenceDigest({
    definitionDigest: result.definitionDigest,
    taskId: result.taskId,
    artifactDigest: result.artifactDigest,
    evaluation,
  })
}

/** Wrap an already executed evaluation; never invent a certification from a planned definition. */
export function benchmarkResult(input: {
  definition: BenchmarkDefinition
  taskId: string
  artifactDigest: string
  evaluation: BenchmarkEvaluation & { passed: boolean }
}): BenchmarkResult {
  return defineBenchmarkResult(
    {
      schemaVersion: 1,
      definitionDigest: benchmarkDefinitionDigest(input.definition),
      taskId: input.taskId,
      artifactDigest: input.artifactDigest,
      evaluation: input.evaluation,
    },
    input.definition,
  )
}
