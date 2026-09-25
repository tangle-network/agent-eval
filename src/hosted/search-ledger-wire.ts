/**
 * The search-ledger wire: how a producer ships a search ledger to a hosted
 * store, and the rule a store applies to each batch.
 *
 * A producer ships three things, in this order:
 *
 *   1. Blobs: `PUT /v1/search-blobs/<sha256 hex>` with the exact bytes an
 *      entry's artifact ref names. The store re-hashes them; the call is
 *      idempotent by content.
 *   2. Head: `GET /v1/ingest/search-ledger/<searchId>/head` tells a restarted
 *      producer where the store's copy of the chain ends.
 *   3. Entries: `POST /v1/ingest/search-ledger` with canonical ledger lines,
 *      starting at `fromSequence`. The store verifies every line, links it to
 *      its stored head, and answers with its new head.
 *
 * The lines are the ledger's own bytes, so producer and store hash identical
 * input. A line below the store's head with an equal hash is a no-op; a
 * different hash is a fork (`409 chain_conflict`); a batch that starts past
 * the head is a gap (`409 sequence_gap`). Both 409s carry the store's head,
 * so a producer resends from there or stops on a fork.
 */

import { z } from 'zod'
import { parseSearchLedgerLine } from '../campaign/search-ledger'
import { SearchLedgerIntegrityError } from '../campaign/search-ledger-errors'
import type {
  SearchArtifactRef,
  SearchLedgerEntry,
  SearchLedgerEvent,
  SearchLedgerHash,
} from '../campaign/search-ledger-types'
import { HOSTED_WIRE_VERSION } from './types'

/** At most this many lines in one ingest request. */
export const SEARCH_LEDGER_BATCH_MAX_LINES = 1000
/** At most this many UTF-8 bytes across one request's lines. A single line
 * larger than this cannot be shipped. */
export const SEARCH_LEDGER_BATCH_MAX_BYTES = 1_048_576

export const SEARCH_LEDGER_INGEST_PATH = '/v1/ingest/search-ledger'

export function searchLedgerHeadPath(searchId: string): string {
  return `${SEARCH_LEDGER_INGEST_PATH}/${encodeURIComponent(searchId)}/head`
}

/** Blobs are addressed by the hex digest alone. */
export function searchBlobPath(sha256: SearchLedgerHash): string {
  return `/v1/search-blobs/${sha256.slice('sha256:'.length)}`
}

const HASH = z.custom<SearchLedgerHash>(
  (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value),
  'expected sha256:<64 lowercase hex characters>',
)
const SEARCH_ID = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, 'must not contain surrounding whitespace')
const SEQUENCE = z.number().int().nonnegative().safe()

/** What the run is for: an optimization, or an eval (a one-node search). */
export const SearchRunKindSchema = z.enum(['optimization', 'eval'])
export type SearchRunKind = z.infer<typeof SearchRunKindSchema>

/** Where a store's copy of one search's chain ends. `headHash` is null exactly
 * when the store holds no entry. */
export const SearchLedgerHeadSchema = z
  .object({ searchId: SEARCH_ID, nextSequence: SEQUENCE, headHash: HASH.nullable() })
  .strict()
  .refine((head) => (head.nextSequence === 0) === (head.headHash === null), {
    message: 'headHash must be null exactly when nextSequence is 0',
    path: ['headHash'],
  })
export type SearchLedgerHead = z.infer<typeof SearchLedgerHeadSchema>

export const IngestSearchLedgerRequestSchema = z
  .object({
    wireVersion: z.literal(HOSTED_WIRE_VERSION),
    searchId: SEARCH_ID,
    runKind: SearchRunKindSchema,
    fromSequence: SEQUENCE,
    lines: z.array(z.string().min(1)).min(1).max(SEARCH_LEDGER_BATCH_MAX_LINES),
  })
  .strict()
  .superRefine((request, ctx) => {
    const bytes = searchLedgerLinesByteLength(request.lines)
    if (bytes > SEARCH_LEDGER_BATCH_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines'],
        message: `lines hold ${bytes} bytes; at most ${SEARCH_LEDGER_BATCH_MAX_BYTES} per request`,
      })
    }
  })
export type IngestSearchLedgerRequest = z.infer<typeof IngestSearchLedgerRequestSchema>

/** The body of a `409`: a fork or a gap, with the store's head. */
export const SearchLedgerConflictSchema = z
  .object({
    error: z.enum(['chain_conflict', 'sequence_gap']),
    message: z.string().min(1),
    head: SearchLedgerHeadSchema,
  })
  .strict()
export type SearchLedgerConflict = z.infer<typeof SearchLedgerConflictSchema>

/** What a store kept of one blob. `masked` and `withheld` come from the
 * store's own redaction scan or the tenant's content posture. */
export const SearchBlobPutResponseSchema = z
  .object({
    sha256: HASH,
    byteLength: SEQUENCE,
    state: z.enum(['stored', 'masked', 'withheld']),
  })
  .strict()
export type SearchBlobPutResponse = z.infer<typeof SearchBlobPutResponseSchema>

const UTF8 = new TextEncoder()

export function searchLedgerLinesByteLength(lines: readonly string[]): number {
  let bytes = 0
  for (const line of lines) bytes += UTF8.encode(line).byteLength
  return bytes
}

/** Every blob an event names, once each. Ship these before the event. */
export function searchLedgerArtifactRefs(event: SearchLedgerEvent): SearchArtifactRef[] {
  const refs: SearchArtifactRef[] = [...event.artifacts]
  switch (event.kind) {
    case 'node-registered':
      refs.push(event.artifact, ...event.surfaces.map((surface) => surface.artifact))
      break
    case 'edge-recorded':
      for (const ref of [event.rationale, ...event.diffs]) if ('uri' in ref) refs.push(ref)
      break
    case 'cell-settled':
      for (const evidence of event.surfaceEvidence) refs.push(...evidence.evidence)
      break
    default:
      break
  }
  const unique = new Map<string, SearchArtifactRef>()
  for (const ref of refs) if (!unique.has(ref.sha256)) unique.set(ref.sha256, ref)
  return [...unique.values()]
}

export type SearchLedgerBatchAdmission =
  | {
      status: 'accepted'
      /** Entries past the stored head, in order, with their exact lines. */
      entries: SearchLedgerEntry[]
      lines: string[]
      /** The head after storing `entries`. */
      head: SearchLedgerHead
    }
  | { status: 'conflict'; conflict: SearchLedgerConflict }

export interface AdmitSearchLedgerBatchInput {
  request: IngestSearchLedgerRequest
  /** The store's head for `request.searchId` before this batch. */
  head: SearchLedgerHead
  /** The stored hash at a sequence below the head. */
  storedEntryHash(sequence: number): SearchLedgerHash | undefined
}

/**
 * Apply the wire's chain rule to one batch. Each line is verified in isolation
 * (`parseSearchLedgerLine`) and linked to the stored head. A malformed line
 * throws `SearchLedgerIntegrityError`, which a store answers with 422; the
 * state machine (`SearchState`) runs after admission, on `entries`.
 */
export function admitSearchLedgerBatch(
  input: AdmitSearchLedgerBatchInput,
): SearchLedgerBatchAdmission {
  const { request, head } = input
  if (request.searchId !== head.searchId) {
    throw new Error(`head is for search ${head.searchId}, request is for ${request.searchId}`)
  }
  if (request.fromSequence > head.nextSequence) {
    return conflict(
      'sequence_gap',
      `batch starts at sequence ${request.fromSequence}; the store expects ${head.nextSequence}`,
      head,
    )
  }
  const entries: SearchLedgerEntry[] = []
  const lines: string[] = []
  let previousHash = head.headHash
  for (let index = 0; index < request.lines.length; index++) {
    const sequence = request.fromSequence + index
    const line = request.lines[index]!
    const entry = parseSearchLedgerLine(line, request.searchId, {
      path: `search ${request.searchId}`,
      line: sequence + 1,
    })
    if (entry.sequence !== sequence) {
      throw new SearchLedgerIntegrityError(
        `line ${index} of the batch holds sequence ${entry.sequence}, expected ${sequence}`,
      )
    }
    if (sequence < head.nextSequence) {
      if (input.storedEntryHash(sequence) !== entry.entryHash) {
        return conflict(
          'chain_conflict',
          `sequence ${sequence} differs from the stored entry; the ledger forked`,
          head,
        )
      }
      continue
    }
    if (entry.previousHash !== previousHash) {
      if (sequence === head.nextSequence) {
        return conflict(
          'chain_conflict',
          `sequence ${sequence} does not extend the stored head; the ledger forked`,
          head,
        )
      }
      throw new SearchLedgerIntegrityError(
        `sequence ${sequence} does not extend sequence ${sequence - 1} in the same batch`,
      )
    }
    entries.push(entry)
    lines.push(line)
    previousHash = entry.entryHash
  }
  const last = entries.at(-1)
  return {
    status: 'accepted',
    entries,
    lines,
    head: last
      ? { searchId: head.searchId, nextSequence: last.sequence + 1, headHash: last.entryHash }
      : head,
  }
}

function conflict(
  error: SearchLedgerConflict['error'],
  message: string,
  head: SearchLedgerHead,
): SearchLedgerBatchAdmission {
  return { status: 'conflict', conflict: { error, message, head } }
}
