import { join } from 'node:path'
import { z } from 'zod'
import { ValidationError } from '../errors'
import {
  canonicalString,
  compareCodeUnits,
  hashCanonical,
  type LedgerHash,
} from '../ledger-core/canonical'
import { type CampaignStorage, fsCampaignStorage } from './storage'

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const headerSchema = z
  .object({
    kind: z.literal('retained-dispatch-v1'),
    scope: digest,
    limits: z.array(z.tuple([z.string().min(1), z.number().int().nonnegative()])),
  })
  .strict()
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), id: digest, lane: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('settled'), id: digest, receipt: digest }).strict(),
])
const resultSchema = z
  .object({
    kind: z.literal('retained-dispatch-result-v1'),
    id: digest,
    receipt: digest,
    value: z.unknown(),
  })
  .strict()
/** The committed byte length and cumulative digest of retained dispatch history. */
const anchorEntrySchema = z
  .object({
    kind: z.literal('retained-dispatch-anchor-v1'),
    scope: digest,
    bytes: z.number().int().positive(),
    digest,
  })
  .strict()
type Event = z.infer<typeof eventSchema>
type AnchorEntry = z.infer<typeof anchorEntrySchema>

export type RetainedDispatchOutcome<T> =
  | {
      succeeded: true
      value: T
      dispatchId: LedgerHash
      receiptDigest: LedgerHash
      replayed: boolean
    }
  | { succeeded: false; reason: 'outcome_unknown'; dispatchId: LedgerHash; diagnostic?: string }
  | { succeeded: false; reason: 'allowance_exhausted'; dispatchId: LedgerHash }

/** One logical run owns this directory. Callers bind authority and execution/decoder revisions in scope. */
export interface RetainedDispatchOptions<Lane extends string, T> {
  runDir: string
  scope: unknown
  /** Reserved allowances: one lane cannot spend another lane's calls. */
  limits: Readonly<Record<Lane, number>>
  /** Validate the complete retained result, including explicit failed/unknown execution outcomes. */
  parse: (value: unknown) => T
  storage?: CampaignStorage
  /** The owning durable Run has started this scope; missing history must not issue another allowance. */
  requireExisting?: boolean
}

type Header = z.infer<typeof headerSchema>

/** The loaded journal of one retained-dispatch scope: its paths, accounting and verified history. */
interface DispatchJournal<T> {
  storage: CampaignStorage
  parse: (value: unknown) => T
  header: Header
  limits: Map<string, number>
  counts: Map<string, number>
  calls: Map<string, { lane: string; receipt?: string }>
  indexPath: string
  scopePath: string
  anchorPath: string
  receiptsDir: string
  scopeText: string
  scopeDigest: LedgerHash
  /** The journal text already applied, its byte length, cumulative digest, and whether the header is in it. */
  retainedText: string
  revision: number
  chain: LedgerHash | null
  opened: boolean
}

type DispatchRequest<Lane extends string, T> = {
  lane: Lane
  input: unknown
  dispatch: () => Promise<T>
  signal?: AbortSignal
}

function fail(message: string): never {
  throw new ValidationError(`retained dispatch: ${message}`)
}

/**
 * Persist dispatch intent before an external call and its validated result afterward.
 * Replays settled calls; never repeats an uncertain call or refunds its allowance.
 * Every journal event is durably anchored before it takes effect, and history that
 * cannot be proven equal to its durable anchor fails closed.
 * This wraps a campaign's dispatch; runEval still owns scheduling, judging and reports.
 * Uses CampaignStorage's existing compare-and-append, not another database or scheduler.
 */
export function createRetainedDispatch<Lane extends string, T>(
  options: RetainedDispatchOptions<Lane, T>,
) {
  if (!options.runDir.trim())
    throw new ValidationError('retained dispatch requires a run directory')
  const storage = options.storage ?? fsCampaignStorage()
  const header = headerSchema.parse({
    kind: 'retained-dispatch-v1',
    scope: hashCanonical(options.scope),
    limits: Object.entries(options.limits).sort(([a], [b]) => compareCodeUnits(a, b)),
  })
  if (!header.limits.length)
    throw new ValidationError('retained dispatch requires named allowances')
  const journal: DispatchJournal<T> = {
    storage,
    parse: options.parse,
    header,
    limits: new Map(header.limits),
    counts: new Map<string, number>(),
    calls: new Map<string, { lane: string; receipt?: string }>(),
    indexPath: join(options.runDir, 'dispatches.jsonl'),
    scopePath: join(options.runDir, 'dispatch-scope.json'),
    anchorPath: join(options.runDir, 'dispatch-anchor.jsonl'),
    receiptsDir: join(options.runDir, 'dispatch-results'),
    scopeText: canonicalString(header),
    scopeDigest: hashCanonical(header),
    retainedText: '',
    revision: 0,
    chain: null,
    opened: false,
  }
  const active = new Map<string, Promise<RetainedDispatchOutcome<T>>>()
  storage.ensureDir(options.runDir)
  storage.ensureDir(journal.receiptsDir)
  openJournal(journal, options.requireExisting)

  return {
    /** The input binds all behavior-affecting request material, not just a caller-selected nonce. */
    run(request: DispatchRequest<Lane, T>): Promise<RetainedDispatchOutcome<T>> {
      const id = hashCanonical([header.scope, request.lane, request.input])
      const pending = active.get(id)
      if (pending) return pending
      const promise = dispatchOnce(journal, id, request)
      active.set(id, promise)
      void promise
        .finally(() => {
          active.delete(id)
        })
        .catch(() => {})
      return promise
    },
    /** Counts include uncertain dispatches, which keep their reservation. No pricing is inferred. */
    committed(): ReadonlyMap<Lane, number> {
      refreshJournal(journal)
      return new Map(header.limits.map(([lane]) => [lane as Lane, journal.counts.get(lane) ?? 0]))
    },
  }
}

/** Fold one journal event into the per-lane counts and pending-call map. */
function applyEvent<T>(journal: DispatchJournal<T>, event: Event): void {
  const existing = journal.calls.get(event.id)
  if (event.kind === 'started') {
    const limit = journal.limits.get(event.lane)
    const count = journal.counts.get(event.lane) ?? 0
    if (existing || limit === undefined || count >= limit)
      fail('invalid or over-budget dispatch history')
    journal.calls.set(event.id, { lane: event.lane })
    journal.counts.set(event.lane, count + 1)
  } else {
    if (!existing || existing.receipt) fail('settlement has no unique pending dispatch')
    existing.receipt = event.receipt
  }
}

/** Read the durable anchor file, refusing a torn, empty-record, foreign-scope or non-monotonic one. */
function readAnchor<T>(journal: DispatchJournal<T>): { text: string; entries: AnchorEntry[] } {
  const { storage, anchorPath } = journal
  const content = storage.read(anchorPath)
  if (content === undefined && storage.exists(anchorPath)) fail('cannot read durable anchor')
  const text = content ?? ''
  if (text && !text.endsWith('\n')) fail('durable anchor is torn')
  const entries: AnchorEntry[] = []
  let previous = 0
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.some((line) => !line)) fail('durable anchor contains an empty record')
  for (const line of lines) {
    const entry = anchorEntrySchema.parse(JSON.parse(line) as unknown)
    if (entry.scope !== journal.scopeDigest) fail('durable anchor scope changed')
    if (entry.bytes <= previous) fail('durable anchor is not append-only')
    previous = entry.bytes
    entries.push(entry)
  }
  return { text, entries }
}

/** Re-read the journal, prove it extends what was applied and matches its anchor, and apply the new events. */
function refreshJournal<T>(journal: DispatchJournal<T>): void {
  const { storage } = journal
  if (storage.read(journal.scopePath) !== journal.scopeText)
    fail('scope anchor is missing or changed')
  const stored = storage.read(journal.indexPath)
  if (stored === undefined && storage.exists(journal.indexPath))
    fail('cannot read existing history')
  const text = stored ?? ''
  if (!text.startsWith(journal.retainedText) || (text && !text.endsWith('\n')))
    fail('history was truncated, replaced or torn')
  const { entries } = readAnchor(journal)
  const bytes = Buffer.byteLength(text)
  const applied = Buffer.byteLength(journal.retainedText)
  if (text && !entries.length) fail('durable anchor is missing')
  const highWater = entries[entries.length - 1]
  if (highWater && bytes !== highWater.bytes) {
    // Bytes beyond the durable anchor are never trusted, shortened or synthesized.
    if (bytes < highWater.bytes) fail('history was truncated below its durable anchor')
    fail('history extends beyond its durable anchor')
  }
  let offset = 0
  let running: LedgerHash | null = null
  let entryIndex = 0
  let seenHeader = journal.opened
  for (const line of text.split('\n')) {
    if (!line) continue
    running = hashCanonical([running, line])
    offset += Buffer.byteLength(line) + 1
    while (entryIndex < entries.length && entries[entryIndex]!.bytes === offset) {
      if (entries[entryIndex]!.digest !== running) fail('history diverges from its durable anchor')
      entryIndex += 1
    }
    if (offset <= applied) continue
    if (!seenHeader) {
      const value: unknown = JSON.parse(line)
      if (hashCanonical(headerSchema.parse(value)) !== hashCanonical(journal.header))
        fail('resume changed its scope or allowances')
      seenHeader = true
    } else applyEvent(journal, eventSchema.parse(JSON.parse(line) as unknown))
  }
  if (entries.length && entryIndex !== entries.length)
    fail('history diverges from its durable anchor')
  journal.chain = running
  journal.retainedText = text
  journal.revision = bytes
  journal.opened = seenHeader
}

/** Compare-and-append one event; a lost race refreshes the journal and returns false. */
function appendEvent<T>(journal: DispatchJournal<T>, event: Header | Event): boolean {
  const encoded = canonicalString(event)
  const line = `${encoded}\n`
  const next = journal.storage.append(journal.indexPath, line, journal.revision)
  if (next === undefined) {
    refreshJournal(journal)
    return false
  }
  if (next !== journal.revision + Buffer.byteLength(line))
    fail('storage returned an invalid append revision')
  journal.chain = hashCanonical([journal.chain, encoded])
  journal.retainedText += line
  journal.revision = next
  if (event.kind === 'retained-dispatch-v1') journal.opened = true
  else applyEvent(journal, event)
  return true
}

/** Record the journal's current length and digest in the durable anchor. */
function advanceAnchor<T>(journal: DispatchJournal<T>): void {
  const currentChain = journal.chain ?? fail('cannot anchor an empty history')
  if (journal.revision <= 0) fail('cannot anchor an empty history')
  const { text, entries } = readAnchor(journal)
  const last = entries[entries.length - 1]
  if (last) {
    if (last.bytes > journal.revision) fail('history is behind its durable anchor')
    if (last.bytes === journal.revision) {
      if (last.digest !== currentChain) fail('history diverges from its durable anchor')
      return
    }
  }
  const line = `${canonicalString({
    kind: 'retained-dispatch-anchor-v1',
    scope: journal.scopeDigest,
    bytes: journal.revision,
    digest: currentChain,
  } satisfies AnchorEntry)}\n`
  const next = journal.storage.append(journal.anchorPath, line, Buffer.byteLength(text))
  if (next === undefined) {
    const concurrent = readAnchor(journal).entries.at(-1)
    if (concurrent?.bytes === journal.revision && concurrent.digest === journal.chain) return
    fail('durable anchor append is busy; retry with the same run directory')
  }
  if (next !== Buffer.byteLength(text) + Buffer.byteLength(line))
    fail('storage returned an invalid durable anchor revision')
}

/** An event takes effect only after both its journal append and its anchor entry are durable. */
function commitEvent<T>(journal: DispatchJournal<T>, event: Header | Event): boolean {
  if (!appendEvent(journal, event)) return false
  advanceAnchor(journal)
  return true
}

/** Create or verify the scope anchor, load existing history, and commit the header on a fresh journal. */
function openJournal<T>(journal: DispatchJournal<T>, requireExisting: boolean | undefined): void {
  const { storage, scopePath, indexPath, anchorPath, scopeText } = journal
  // The immutable scope and append-only history anchor distinguish fresh runs from lost journals.
  // A half-initialized scope is held for reconciliation, never guessed to be unused.
  if (
    requireExisting &&
    (!storage.exists(scopePath) || !storage.exists(indexPath) || !storage.exists(anchorPath))
  )
    fail('required retained history is missing')
  if (storage.exists(scopePath)) {
    if (storage.read(scopePath) !== scopeText) fail('resume changed its scope or allowances')
    if (!storage.read(indexPath)?.trim()) fail('dispatch history is missing or empty')
    // A history without its committed high-water mark is never treated as unused.
    if (!storage.read(anchorPath)?.trim()) fail('durable anchor is missing')
  } else {
    if (storage.exists(indexPath) || storage.exists(anchorPath))
      fail('legacy history has no scope anchor; reconcile before migration')
    const created = storage.append(scopePath, scopeText, 0)
    if (created === undefined) {
      if (storage.read(scopePath) !== scopeText || !storage.read(indexPath)?.trim())
        fail('scope initialization is busy; retry the same scope')
    } else if (created !== Buffer.byteLength(scopeText)) {
      fail('storage returned an invalid scope revision')
    }
  }
  refreshJournal(journal)
  if (!journal.opened && !commitEvent(journal, journal.header) && !journal.opened)
    fail('history is busy; retry with the same run directory')
}

/** Read and verify a retained result file, or undefined when none was written. */
function readResult<T>(
  journal: DispatchJournal<T>,
  id: LedgerHash,
): { value: T; receipt: LedgerHash } | undefined {
  const content = journal.storage.read(resultPath(journal, id))
  if (content === undefined) return undefined
  const result = resultSchema.parse(JSON.parse(content))
  if (result.id !== id) return fail('retained result dispatch id mismatch')
  if (hashCanonical(result.value) !== result.receipt) return fail('retained result digest mismatch')
  const value = journal.parse(result.value)
  if (hashCanonical(value) !== result.receipt) return fail('result decoder changed retained output')
  return { value, receipt: result.receipt as LedgerHash }
}

function resultPath<T>(journal: DispatchJournal<T>, id: LedgerHash): string {
  return join(journal.receiptsDir, `${id.slice(7)}.json`)
}

/** Commit the settlement of a dispatch whose result is already durable. */
function settle<T>(journal: DispatchJournal<T>, id: LedgerHash, receipt: LedgerHash): void {
  while (true) {
    const existing = journal.calls.get(id)
    if (existing?.receipt) {
      if (existing.receipt !== receipt) fail('settled result digest mismatch')
      return
    }
    if (!existing) fail('settlement has no pending dispatch')
    const previousRevision = journal.revision
    if (commitEvent(journal, { kind: 'settled', id, receipt })) return
    if (journal.revision === previousRevision)
      fail('settlement is busy; retained result awaits reconciliation')
  }
}

/** Replay a settled dispatch from its retained result. */
function loadSettled<T>(
  journal: DispatchJournal<T>,
  id: LedgerHash,
  receipt: string,
): RetainedDispatchOutcome<T> {
  const result = readResult(journal, id)
  if (!result) return fail('settled result is missing')
  if (result.receipt !== receipt) return fail('settled result digest mismatch')
  return {
    succeeded: true,
    value: result.value,
    dispatchId: id,
    receiptDigest: receipt as LedgerHash,
    replayed: true,
  }
}

/** Replay a known dispatch, or commit its started intent; returns the outcome when no call should be made. */
function claimDispatch<T>(
  journal: DispatchJournal<T>,
  id: LedgerHash,
  lane: string,
  signal: AbortSignal | undefined,
): RetainedDispatchOutcome<T> | undefined {
  while (true) {
    const existing = journal.calls.get(id)
    if (existing) {
      if (existing.receipt) return loadSettled(journal, id, existing.receipt)
      const result = readResult(journal, id)
      if (!result) return { succeeded: false, reason: 'outcome_unknown', dispatchId: id }
      settle(journal, id, result.receipt)
      return {
        succeeded: true,
        value: result.value,
        dispatchId: id,
        receiptDigest: result.receipt,
        replayed: true,
      }
    }
    signal?.throwIfAborted()
    if ((journal.counts.get(lane) ?? 0) >= journal.limits.get(lane)!) {
      return { succeeded: false, reason: 'allowance_exhausted', dispatchId: id }
    }
    const previousRevision = journal.revision
    if (commitEvent(journal, { kind: 'started', id, lane })) return undefined
    if (journal.revision === previousRevision)
      return fail('history is busy; retry with the same input')
  }
}

/** Retain a dispatched value's result file, settle it, and return the decoded outcome. */
function retainResult<T>(
  journal: DispatchJournal<T>,
  id: LedgerHash,
  value: T,
): RetainedDispatchOutcome<T> {
  const encoded = canonicalString(value)
  const decoded: unknown = JSON.parse(encoded)
  const retainedValue = journal.parse(decoded)
  if (canonicalString(retainedValue) !== encoded)
    return fail('result decoder is not stable across serialization')
  const receipt = hashCanonical(decoded)
  const retainedResult = canonicalString({
    kind: 'retained-dispatch-result-v1',
    id,
    receipt,
    value: decoded,
  })
  const file = resultPath(journal, id)
  if (
    journal.storage.append(file, retainedResult, 0) === undefined &&
    journal.storage.read(file) !== retainedResult
  )
    fail('cannot retain dispatch result')
  // The receipt is durable before the settlement event can make it reusable.
  settle(journal, id, receipt)
  return {
    succeeded: true,
    value: retainedValue,
    dispatchId: id,
    receiptDigest: receipt,
    replayed: false,
  }
}

/** Replay, claim an allowance, call the dispatch once, and retain its result. */
async function dispatchOnce<Lane extends string, T>(
  journal: DispatchJournal<T>,
  id: LedgerHash,
  request: DispatchRequest<Lane, T>,
): Promise<RetainedDispatchOutcome<T>> {
  const { lane, dispatch, signal } = request
  if (!journal.limits.has(lane)) return fail('unknown allowance lane')
  // Replay must also validate retained history, not trust a stale in-memory result.
  refreshJournal(journal)
  const claimed = claimDispatch(journal, id, lane, signal)
  if (claimed) return claimed
  // The started event is durably anchored above, so the external effect below is
  // attributable to a committed intent that survives restarts and truncation.
  // A rejection leaves the committed intent in doubt, so return its diagnostic without settling it.
  let value: T
  try {
    signal?.throwIfAborted()
    value = journal.parse(await dispatch())
  } catch (error) {
    return {
      succeeded: false,
      reason: 'outcome_unknown',
      dispatchId: id,
      diagnostic: error instanceof Error ? error.message : String(error),
    }
  }
  return retainResult(journal, id, value)
}
