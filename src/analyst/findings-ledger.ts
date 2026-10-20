/**
 * Findings ledger — analyst findings in the shared ledger-core journal.
 *
 * Each appended finding is one hash-chained, canonical JSON entry, fsynced and
 * pinned to a trusted head, so a later reader can prove nothing was rewritten
 * or cut from the end. A row is validated by `AnalystFindingSchema` before it
 * is written and again when it is read, so a 1.1.0 finding whose declared
 * population disagrees with its evidence never enters the record.
 *
 * Appends are idempotent per (run, finding): replaying a run's findings is a
 * no-op, and the same finding id with different content is a conflict.
 * `FindingsStore` remains the unchained JSONL store for existing consumers.
 */

import { z } from 'zod'
import type { LedgerHash } from '../ledger-core/canonical'
import { FileLedgerJournal, type LedgerJournalCodec } from '../ledger-core/journal'
import { merkleRoot } from '../ledger-core/merkle'
import { AnalystFindingSchema, type FindingLayer } from './finding-scope'
import {
  type DiffPolicy,
  diffFindings,
  type FindingsDiff,
  type PersistedFinding,
} from './findings-store'
import type { AnalystFinding } from './types'

const schema = 'agent-eval.findings-ledger.v1' as const
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const identity = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, { message: 'must not carry surrounding space' })

const eventSchema = z
  .object({
    kind: z.literal('finding'),
    eventId: identity,
    run_id: identity,
    finding: AnalystFindingSchema,
  })
  .strict()

type Event = z.infer<typeof eventSchema>

const entrySchema = z
  .object({
    schema: z.literal(schema),
    sequence: z.number().int().nonnegative(),
    previousHash: digest.nullable(),
    event: eventSchema,
    entryHash: digest,
  })
  .strict()

/** One finding as the ledger holds it. */
export interface LedgerFinding extends PersistedFinding {
  /** Position in the journal; later entries were appended later. */
  sequence: number
  entryHash: LedgerHash
}

export interface FindingsLedgerRead {
  findings: LedgerFinding[]
  /** RFC 9162 Merkle root over every entry hash, in journal order. */
  merkleRoot: LedgerHash
}

export type FindingsLedgerOutcome<T> =
  | { succeeded: true; value: T }
  | {
      succeeded: false
      error: { kind: 'invalid' | 'conflict' | 'unavailable'; message: string }
    }

export interface FindingsLedger {
  readonly path: string
  append(
    runId: string,
    findings: readonly AnalystFinding[],
  ): Promise<FindingsLedgerOutcome<{ appended: number; replayed: number }>>
  read(): Promise<FindingsLedgerOutcome<FindingsLedgerRead>>
}

class FindingsLedgerConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FindingsLedgerConflictError'
  }
}

class FindingsLedgerInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FindingsLedgerInvalidError'
  }
}

function codec(): LedgerJournalCodec<{ schema: typeof schema }, Event, LedgerFinding[]> {
  return {
    subject: 'findings ledger',
    header: { schema },
    integrityError: (message, options) => new Error(message, options),
    conflictError: (message) => new FindingsLedgerConflictError(message),
    parseEntry: (raw, context) => {
      const decoded = entrySchema.safeParse(raw)
      if (!decoded.success) {
        const issue = decoded.error.issues[0]
        throw new FindingsLedgerInvalidError(
          `findings ledger ${context.path}:${context.line} is invalid at ${(issue?.path ?? []).join('.')}: ${issue?.message}`,
        )
      }
      return {
        ...decoded.data,
        event: decoded.data.event as Event,
        previousHash: decoded.data.previousHash as LedgerHash | null,
        entryHash: decoded.data.entryHash as LedgerHash,
      }
    },
    checkEntryHeader: (entry) => {
      if (entry.schema !== schema) throw new FindingsLedgerInvalidError('unsupported ledger schema')
    },
    createProjector: () => {
      const rows: LedgerFinding[] = []
      return {
        apply: (entry) => {
          const { event } = entry
          if (event.eventId !== eventIdFor(event.run_id, event.finding.finding_id)) {
            throw new FindingsLedgerInvalidError(
              `event id ${event.eventId} does not name its finding`,
            )
          }
          rows.push({
            ...(event.finding as AnalystFinding),
            run_id: event.run_id,
            sequence: entry.sequence,
            entryHash: entry.entryHash,
          })
        },
        snapshot: () => [...rows],
      }
    },
  }
}

function eventIdFor(runId: string, findingId: string): string {
  return `finding:${runId}:${findingId}`
}

async function outcome<T>(operation: () => Promise<T>): Promise<FindingsLedgerOutcome<T>> {
  try {
    return { succeeded: true, value: await operation() }
  } catch (error) {
    return {
      succeeded: false,
      error: {
        kind:
          error instanceof FindingsLedgerConflictError
            ? 'conflict'
            : error instanceof FindingsLedgerInvalidError || error instanceof z.ZodError
              ? 'invalid'
              : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/** Open (or create on first append) the findings journal at `path`; every reopen requires its pin. */
export function openFindingsLedger(options: { path: string }): FindingsLedger {
  if (!options.path.trim()) throw new TypeError('findings ledger: path is empty')
  const journal = new FileLedgerJournal(options.path, codec(), { requireTrustedHead: true })
  return {
    path: journal.path,
    append: (runId, findings) =>
      outcome(async () => {
        identity.parse(runId)
        let appended = 0
        let replayed = 0
        for (const finding of findings) {
          const parsed = AnalystFindingSchema.safeParse(finding)
          if (!parsed.success) {
            const issue = parsed.error.issues[0]
            throw new FindingsLedgerInvalidError(
              `finding ${finding.finding_id} is invalid at ${(issue?.path ?? []).join('.')}: ${issue?.message}`,
            )
          }
          const result = await journal.append(
            {
              kind: 'finding',
              eventId: eventIdFor(runId, finding.finding_id),
              run_id: runId,
              finding: parsed.data,
            },
            { pinHead: true },
          )
          if (result.appended) appended += 1
          else replayed += 1
        }
        return { appended, replayed }
      }),
    read: () =>
      outcome(async () => {
        const findings = await journal.replay()
        return { findings, merkleRoot: merkleRoot(findings.map((row) => row.entryHash)) }
      }),
  }
}

// ── Queries ──────────────────────────────────────────────────────────

export interface FindingsQuery {
  layer?: FindingLayer | readonly FindingLayer[]
  subject?: string
  analystId?: string
  runId?: string
  claimId?: string
  /**
   * Findings whose `scope.domain_path` starts with this path. A finding with no
   * domain path never matches, so a path query cannot return unscoped findings.
   */
  domainPath?: readonly string[]
}

/** Filter ledger rows. Every set criterion must hold; 1.0.0 rows have no layer and never match one. */
export function queryFindings<T extends AnalystFinding & { run_id?: string }>(
  rows: readonly T[],
  query: FindingsQuery,
): T[] {
  const layers =
    query.layer === undefined
      ? null
      : new Set(typeof query.layer === 'string' ? [query.layer] : query.layer)
  return rows.filter((row) => {
    if (layers && (row.layer === undefined || !layers.has(row.layer))) return false
    if (query.subject !== undefined && row.subject !== query.subject) return false
    if (query.analystId !== undefined && row.analyst_id !== query.analystId) return false
    if (query.runId !== undefined && row.run_id !== query.runId) return false
    if (query.claimId !== undefined && row.claim_id !== query.claimId) return false
    if (query.domainPath !== undefined) {
      const path = row.scope?.domain_path
      if (!path || path.length < query.domainPath.length) return false
      if (query.domainPath.some((id, index) => path[index] !== id)) return false
    }
    return true
  })
}

export interface FindingsTimeStep {
  previous_run_id: string
  run_id: string
  diff: FindingsDiff
}

/**
 * Diff each run against the run before it, in the order runs first entered
 * the ledger. Uses `diffFindings`, so `appeared`, `disappeared`, `persisted`
 * and `changed` mean exactly what they mean for two runs.
 */
export function diffFindingsOverTime(
  rows: readonly LedgerFinding[],
  policy: DiffPolicy = {},
): FindingsTimeStep[] {
  const runs: string[] = []
  const byRun = new Map<string, PersistedFinding[]>()
  for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
    const list = byRun.get(row.run_id)
    if (list) list.push(row)
    else {
      runs.push(row.run_id)
      byRun.set(row.run_id, [row])
    }
  }
  return runs.slice(1).map((runId, index) => ({
    previous_run_id: runs[index]!,
    run_id: runId,
    diff: diffFindings(byRun.get(runs[index]!)!, byRun.get(runId)!, policy),
  }))
}
