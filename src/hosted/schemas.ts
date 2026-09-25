import { z } from 'zod'
import type {
  IngestResponse,
  IngestTracesRequest,
  TraceSpanEvent,
  UnixNanoTimestamp,
} from './types'
import { HOSTED_WIRE_VERSION } from './types'

const finiteNumber = z.number().finite()
const nonNegativeInteger = z.number().int().nonnegative()
const nonEmptyString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'must not be blank')
const attributeValue = z.union([z.string(), finiteNumber, z.boolean()])
const attributes = z.record(z.string(), attributeValue)
const UINT64_MAX = 18_446_744_073_709_551_615n

export const UnixNanoTimestampSchema: z.ZodType<UnixNanoTimestamp> = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'expected an unsigned base-10 integer string')
  .refine((value) => BigInt(value) <= UINT64_MAX, 'must fit in an unsigned 64-bit integer')

const TraceSpanEventEntrySchema = z
  .object({
    timeUnixNano: UnixNanoTimestampSchema,
    name: nonEmptyString,
    attributes: attributes.optional(),
  })
  .strict()

export const TraceSpanEventSchema: z.ZodType<TraceSpanEvent> = z
  .object({
    traceId: nonEmptyString,
    spanId: nonEmptyString,
    parentSpanId: nonEmptyString.optional(),
    name: nonEmptyString,
    startTimeUnixNano: UnixNanoTimestampSchema,
    endTimeUnixNano: UnixNanoTimestampSchema,
    attributes,
    events: z.array(TraceSpanEventEntrySchema).optional(),
    status: z
      .object({
        code: z.enum(['OK', 'ERROR', 'UNSET']),
        message: z.string().optional(),
      })
      .strict()
      .optional(),
    'tangle.runId': nonEmptyString.optional(),
    'tangle.generation': nonNegativeInteger.optional(),
    'tangle.cellId': nonEmptyString.optional(),
    'tangle.scenarioId': nonEmptyString.optional(),
  })
  .strict()
  .refine((span) => BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano), {
    path: ['endTimeUnixNano'],
    message: 'endTimeUnixNano must be greater than or equal to startTimeUnixNano',
  })

export const IngestTracesEnvelopeSchema = z
  .object({
    wireVersion: z.literal(HOSTED_WIRE_VERSION),
    spans: z.array(z.unknown()),
  })
  .strict()

export const IngestTracesRequestSchema: z.ZodType<IngestTracesRequest> = z
  .object({
    wireVersion: z.literal(HOSTED_WIRE_VERSION),
    spans: z.array(TraceSpanEventSchema),
  })
  .strict()

export const IngestResponseSchema: z.ZodType<IngestResponse> = z
  .object({
    accepted: nonNegativeInteger,
    rejected: z.array(
      z
        .object({
          index: nonNegativeInteger,
          reason: nonEmptyString,
        })
        .strict(),
    ),
  })
  .strict()
