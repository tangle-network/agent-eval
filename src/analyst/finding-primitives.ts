import { z } from 'zod'

const nonEmpty = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must be a non-empty string' })
const finite = z.number().refine(Number.isFinite, { message: 'must be finite' })
const unitRate = finite.refine((value) => value >= 0 && value <= 1, { message: 'must be in [0,1]' })

/** Shared validation for every independently scored finding method. */
export const findingCalibrationSchema = z
  .object({
    gold_n: z.number().int().positive(),
    agreement: unitRate,
    kappa: finite.refine((value) => value >= -1 && value <= 1, {
      message: 'must be in [-1,1]',
    }),
  })
  .strict()

/** Evidence references have one shape on definitions and stored findings. */
export const findingEvidenceRefSchema = z
  .object({
    kind: z.enum(['span', 'event', 'artifact', 'finding', 'metric']),
    uri: nonEmpty,
    excerpt: z.string().optional(),
  })
  .strict()
