import { z } from 'zod'
import { compareCodeUnits, type LedgerHash } from '../ledger-core/canonical'
import { FileLedgerJournal, type LedgerJournalCodec } from '../ledger-core/journal'

const identity = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const reservationSchema = z
  .object({
    requestId: identity,
    claimDigest: digest,
    populationId: identity,
    inputDigest: digest,
    unitIds: z.array(identity).min(1),
  })
  .strict()

/** One final dataset reserved for one adaptive decision, across processes and campaigns. */
export type FinalEvidenceReservation = z.infer<typeof reservationSchema>

const measurementSchema = z
  .object({
    evaluatorDigest: digest,
    candidateDigests: z.array(digest).min(1),
  })
  .strict()

export type FinalEvidenceMeasurement = z.infer<typeof measurementSchema>

const eventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reserved'),
      eventId: identity,
      reservation: reservationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('exposed'),
      eventId: identity,
      requestId: identity,
      measurement: measurementSchema,
    })
    .strict(),
])

type Event = z.infer<typeof eventSchema>
const schema = 'agent-eval.final-evidence.v1' as const
const entrySchema = z
  .object({
    schema: z.literal(schema),
    sequence: z.number().int().nonnegative(),
    previousHash: digest.nullable(),
    event: eventSchema,
    entryHash: digest,
  })
  .strict()

export interface FinalEvidenceRecord {
  reservation: FinalEvidenceReservation
  reservationHash: LedgerHash
  exposure: { measurement: FinalEvidenceMeasurement; entryHash: LedgerHash } | null
}

export type FinalEvidenceOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: { kind: 'conflict' | 'invalid' | 'unavailable'; message: string } }

export interface FinalEvidenceLedger {
  reserve(
    input: FinalEvidenceReservation,
  ): Promise<FinalEvidenceOutcome<{ record: FinalEvidenceRecord; replayed: boolean }>>
  expose(
    requestId: string,
    measurement: FinalEvidenceMeasurement,
  ): Promise<FinalEvidenceOutcome<{ record: FinalEvidenceRecord; replayed: boolean }>>
  read(): Promise<FinalEvidenceOutcome<FinalEvidenceRecord[]>>
}

/** Retains the distinction between invalid input, consumed evidence, and unavailable storage. */
export class FinalEvidenceError extends Error {
  constructor(
    readonly kind: 'conflict' | 'invalid' | 'unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'FinalEvidenceError'
  }
}

/** A consumed or conflicting dataset cannot authorize another adaptive decision. */
export class FinalEvidenceConflictError extends FinalEvidenceError {
  constructor(message: string) {
    super('conflict', message)
    this.name = 'FinalEvidenceConflictError'
  }
}

function invalid(message: string): Error {
  return new TypeError(`final evidence: ${message}`)
}

function normalizeReservation(input: FinalEvidenceReservation): FinalEvidenceReservation {
  const parsed = reservationSchema.parse(input)
  if (new Set(parsed.unitIds).size !== parsed.unitIds.length) {
    throw invalid('unitIds must be unique independent source identities')
  }
  return { ...parsed, unitIds: [...parsed.unitIds].sort(compareCodeUnits) }
}

function normalizeMeasurement(input: FinalEvidenceMeasurement): FinalEvidenceMeasurement {
  const parsed = measurementSchema.parse(input)
  return {
    ...parsed,
    candidateDigests: [...new Set(parsed.candidateDigests)].sort(compareCodeUnits),
  }
}

function codec(): LedgerJournalCodec<{ schema: typeof schema }, Event, FinalEvidenceRecord[]> {
  return {
    subject: 'final evidence ledger',
    header: { schema },
    integrityError: (message, options) => new Error(message, options),
    conflictError: (message) => new FinalEvidenceConflictError(message),
    parseEntry: (raw, context) => {
      const decoded = entrySchema.safeParse(raw)
      if (!decoded.success)
        throw new Error(
          `final evidence ledger ${context.path}:${context.line} is invalid: ${decoded.error.message}`,
        )
      const parsed = decoded.data
      return {
        ...parsed,
        previousHash: parsed.previousHash as LedgerHash | null,
        entryHash: parsed.entryHash as LedgerHash,
      }
    },
    checkEntryHeader: (entry) => {
      if (entry.schema !== schema) throw invalid('unsupported ledger schema')
    },
    createProjector: () => {
      const records = new Map<string, FinalEvidenceRecord>()
      const owners = new Map<string, string>()
      const inputOwners = new Map<string, string>()
      return {
        apply: (entry) => {
          const event = entry.event
          if (event.kind === 'reserved') {
            const reservation = normalizeReservation(event.reservation)
            if (
              event.eventId !== `reserve:${reservation.requestId}` ||
              records.has(reservation.requestId)
            ) {
              throw invalid('invalid or duplicate reservation identity')
            }
            const inputOwner = inputOwners.get(reservation.inputDigest)
            if (inputOwner !== undefined) {
              throw new FinalEvidenceConflictError(
                `final input is already reserved by '${inputOwner}'`,
              )
            }
            for (const unitId of reservation.unitIds) {
              const owner = owners.get(unitId)
              if (owner !== undefined) {
                throw new FinalEvidenceConflictError(
                  `final unit '${unitId}' is already reserved by '${owner}'`,
                )
              }
              owners.set(unitId, reservation.requestId)
            }
            inputOwners.set(reservation.inputDigest, reservation.requestId)
            records.set(reservation.requestId, {
              reservation,
              reservationHash: entry.entryHash,
              exposure: null,
            })
          } else {
            const record = records.get(event.requestId)
            if (
              event.eventId !== `expose:${event.requestId}` ||
              !record ||
              record.exposure !== null
            ) {
              throw invalid('exposure requires one unexposed reservation')
            }
            record.exposure = {
              measurement: normalizeMeasurement(event.measurement),
              entryHash: entry.entryHash,
            }
          }
        },
        // Records are copied because a later exposure replaces a field of the
        // live record, and a returned projection must not change under its reader.
        snapshot: () => [...records.values()].map((record) => ({ ...record })),
      }
    },
  }
}

async function outcome<T>(operation: () => Promise<T>): Promise<FinalEvidenceOutcome<T>> {
  try {
    return { succeeded: true, value: await operation() }
  } catch (error) {
    return {
      succeeded: false,
      error: {
        kind:
          error instanceof FinalEvidenceConflictError
            ? 'conflict'
            : error instanceof TypeError || error instanceof z.ZodError
              ? 'invalid'
              : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/** Uses the shared locked journal and requires its trusted head on every reopen. */
export function openFinalEvidenceLedger(options: { path: string }): FinalEvidenceLedger {
  if (!options.path.trim()) throw invalid('path is empty')
  const journal = new FileLedgerJournal(options.path, codec(), { requireTrustedHead: true })
  return {
    reserve: (input) =>
      outcome(async () => {
        const reservation = normalizeReservation(input)
        const result = await journal.append(
          {
            kind: 'reserved',
            eventId: `reserve:${reservation.requestId}`,
            reservation,
          },
          { pinHead: true },
        )
        const record = result.projection.find(
          (item) => item.reservation.requestId === reservation.requestId,
        )
        if (!record) throw invalid('reserved record is missing after append')
        return { record, replayed: !result.appended }
      }),
    expose: (requestId, input) =>
      outcome(async () => {
        identity.parse(requestId)
        const measurement = normalizeMeasurement(input)
        const result = await journal.append(
          {
            kind: 'exposed',
            eventId: `expose:${requestId}`,
            requestId,
            measurement,
          },
          { pinHead: true },
        )
        const record = result.projection.find((item) => item.reservation.requestId === requestId)
        if (!record) throw invalid('exposed record is missing after append')
        return { record, replayed: !result.appended }
      }),
    read: () => outcome(() => journal.replay()),
  }
}
