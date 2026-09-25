import { z } from 'zod'
import { ValidationError } from '../errors'
import { compareCodeUnits } from '../ledger-core/canonical'
import { type EvidenceRecord, readField } from './ast'

const nonEmpty = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value)

/** The claim's schema, shared by every record that binds a claim. */
export const evaluationClaimSchema = z
  .object({
    use: z.enum(['development', 'comparison', 'certification']),
    population: z.object({ id: nonEmpty, description: nonEmpty }).strict(),
    samplingFrame: nonEmpty,
    independentUnit: nonEmpty,
    generalization: z.enum(['fixed-roster', 'new-units']),
    minimumEffect: z.number().finite().positive().optional(),
  })
  .strict()

/** The population and independent observations a measured result can describe. */
export type EvaluationClaim = z.infer<typeof evaluationClaimSchema>

/** Validate a claim before binding it to a sealed experiment or final evidence. */
export function defineEvaluationClaim(input: EvaluationClaim): EvaluationClaim {
  const parsed = evaluationClaimSchema.safeParse(input)
  if (!parsed.success)
    throw new ValidationError(`invalid evaluation claim: ${parsed.error.message}`)
  return Object.freeze({ ...parsed.data, population: Object.freeze(parsed.data.population) })
}

export interface EvaluationUnitSummary {
  observations: number
  independentUnits: number
  units: Array<{ id: string; observations: number }>
}

/** Repetitions retain their denominator without becoming additional independent units. */
export function summarizeEvaluationUnits(
  claim: EvaluationClaim,
  rows: readonly object[],
): EvaluationUnitSummary {
  const validated = defineEvaluationClaim(claim)
  const counts = new Map<string, number>()
  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new ValidationError(`evaluation claim: row ${index} must be an object`)
    }
    const value = readField(row as EvidenceRecord, validated.independentUnit)
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new ValidationError(
        `evaluation claim: row ${index} needs a nonempty string at '${validated.independentUnit}'`,
      )
    }
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return {
    observations: rows.length,
    independentUnits: counts.size,
    units: [...counts]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([id, observations]) => ({ id, observations })),
  }
}
