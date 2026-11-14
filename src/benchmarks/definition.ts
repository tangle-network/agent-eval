import { z } from 'zod'
import { hashCanonical } from '../ledger-core/canonical'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import type { CheckerIdentity, VerificationStrategySource } from '../verification-strategy'
import { VERIFICATION_STRATEGY_SOURCES } from '../verification-strategy'
import type { BenchmarkSource } from './types'

/** A planned measurement contract. It is not evidence that its checker executed. */
export interface BenchmarkDefinition {
  schemaVersion: 1
  id: string
  source: BenchmarkSource & { revision: string }
  /** The exact roster, including an explicitly selected subset when applicable. */
  taskIds: string[]
  metric: {
    name: string
    unit: string
    direction: 'higher' | 'lower'
    /** Native aggregation rule; a description does not implement that rule. */
    aggregation: string
    /** Native bounds, when the metric has them. Unbounded metrics omit this field. */
    range?: [number, number]
    /** Explicit policy/ref for projecting the native measurement into an Eval score in [0, 1]. */
    normalization: string
  }
  verification: {
    strategy: VerificationStrategySource
    checker: CheckerIdentity
    assumptions: string[]
  }
}

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'must not be blank')
const source = z
  .object({
    name: text.optional(),
    url: text.optional(),
    version: text.optional(),
    revision: text,
    license: text.optional(),
    citation: text.optional(),
    rules: text.optional(),
    contamination: z.enum(['unknown', 'none-known', 'suspected', 'confirmed']).optional(),
  })
  .strict()
const schema = z
  .object({
    schemaVersion: z.literal(1),
    id: text,
    source,
    taskIds: z
      .array(text)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, 'duplicate task ids'),
    metric: z
      .object({
        name: text,
        unit: text,
        direction: z.enum(['higher', 'lower']),
        aggregation: text,
        range: z
          .tuple([z.number().finite(), z.number().finite()])
          .refine(([low, high]) => low < high, 'range must have lower < upper')
          .optional(),
        normalization: text,
      })
      .strict(),
    verification: z
      .object({
        strategy: z.enum(
          VERIFICATION_STRATEGY_SOURCES as [
            VerificationStrategySource,
            ...VerificationStrategySource[],
          ],
        ),
        checker: z
          .object({ name: text, version: text, pins: z.record(text, text).optional() })
          .strict(),
        assumptions: z.array(text),
      })
      .strict(),
  })
  .strict()

/** Synchronous validation for JSON play/manifests; reject lossy or unrecognized identity fields. */
export function defineBenchmark(input: unknown): BenchmarkDefinition {
  hashCanonical(input)
  return deepFreezeCanonicalJson(schema.parse(input))
}

/** Uses the stack's canonical JSON owner; changing metric, roster or checker changes identity. */
export function benchmarkDefinitionDigest(input: unknown): string {
  return hashCanonical(defineBenchmark(input))
}
