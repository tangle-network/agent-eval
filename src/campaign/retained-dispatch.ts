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
type Event = z.infer<typeof eventSchema>

export type RetainedDispatchOutcome<T> =
  | {
      succeeded: true
      value: T
      dispatchId: LedgerHash
      receiptDigest: LedgerHash
      replayed: boolean
    }
  | { succeeded: false; reason: 'outcome_unknown' | 'allowance_exhausted'; dispatchId: LedgerHash }

/** One logical run owns this directory. Callers bind authority and execution/decoder revisions in scope. */
export interface RetainedDispatchOptions<Lane extends string, T> {
  runDir: string
  scope: unknown
  /** Reserved allowances: one lane cannot spend another lane's calls. */
  limits: Readonly<Record<Lane, number>>
  /** Validate the complete retained result, including explicit failed/unknown execution outcomes. */
  parse: (value: unknown) => T
  storage?: CampaignStorage
}

/**
 * Persist dispatch intent before an external call and its validated result afterward.
 * Replays settled calls; never repeats an uncertain call or refunds its allowance.
 * This wraps a campaign's dispatch; runEval still owns scheduling, judging and reports.
 * Uses CampaignStorage's existing compare-and-append, not another database or scheduler.
 */
export function createRetainedDispatch<Lane extends string, T>(
  options: RetainedDispatchOptions<Lane, T>,
) {
  if (!options.runDir.trim())
    throw new ValidationError('retained dispatch requires a run directory')
  const storage = options.storage ?? fsCampaignStorage()
  const parse = options.parse
  const header = headerSchema.parse({
    kind: 'retained-dispatch-v1',
    scope: hashCanonical(options.scope),
    limits: Object.entries(options.limits).sort(([a], [b]) => compareCodeUnits(a, b)),
  })
  if (!header.limits.length)
    throw new ValidationError('retained dispatch requires named allowances')
  const limits = new Map(header.limits)
  const counts = new Map<string, number>()
  const calls = new Map<string, { lane: string; receipt?: string }>()
  const active = new Map<string, Promise<RetainedDispatchOutcome<T>>>()
  const indexPath = join(options.runDir, 'dispatches.jsonl')
  const receiptsDir = join(options.runDir, 'dispatch-results')
  storage.ensureDir(options.runDir)
  storage.ensureDir(receiptsDir)
  let retainedText = ''
  let revision = 0
  let opened = false
  const fail = (message: string): never => {
    throw new ValidationError(`retained dispatch: ${message}`)
  }
  const apply = (event: Event) => {
    const existing = calls.get(event.id)
    if (event.kind === 'started') {
      const limit = limits.get(event.lane)
      const count = counts.get(event.lane) ?? 0
      if (existing || limit === undefined || count >= limit)
        fail('invalid or over-budget dispatch history')
      calls.set(event.id, { lane: event.lane })
      counts.set(event.lane, count + 1)
    } else {
      if (!existing || existing.receipt) return fail('settlement has no unique pending dispatch')
      existing.receipt = event.receipt
    }
  }
  const refresh = () => {
    const stored = storage.read(indexPath)
    if (stored === undefined && storage.exists(indexPath)) fail('cannot read existing history')
    const text = stored ?? ''
    if (!text.startsWith(retainedText) || (text && !text.endsWith('\n')))
      fail('history was truncated, replaced or torn')
    for (const line of text.slice(retainedText.length).split('\n').filter(Boolean)) {
      const value: unknown = JSON.parse(line)
      if (!opened) {
        if (hashCanonical(headerSchema.parse(value)) !== hashCanonical(header))
          fail('resume changed its scope or allowances')
        opened = true
      } else apply(eventSchema.parse(value))
    }
    retainedText = text
    revision = Buffer.byteLength(text)
  }
  const append = (event: typeof header | Event): boolean => {
    const line = `${canonicalString(event)}\n`
    const next = storage.append(indexPath, line, revision)
    if (next === undefined) {
      refresh()
      return false
    }
    if (next !== revision + Buffer.byteLength(line))
      fail('storage returned an invalid append revision')
    retainedText += line
    revision = next
    if (event.kind === 'retained-dispatch-v1') opened = true
    else apply(event)
    return true
  }
  refresh()
  if (!opened && !append(header) && !opened)
    fail('history is busy; retry with the same run directory')
  const load = (id: LedgerHash, receipt: string): RetainedDispatchOutcome<T> => {
    const content = storage.read(join(receiptsDir, `${receipt.slice(7)}.json`))
    if (content === undefined) return fail('settled result is missing')
    const decoded: unknown = JSON.parse(content)
    if (hashCanonical(decoded) !== receipt) return fail('settled result digest mismatch')
    return {
      succeeded: true,
      value: parse(decoded),
      dispatchId: id,
      receiptDigest: receipt as LedgerHash,
      replayed: true,
    }
  }

  return {
    /** The input binds all behavior-affecting request material, not just a caller-selected nonce. */
    run(request: {
      lane: Lane
      input: unknown
      dispatch: () => Promise<T>
      signal?: AbortSignal
    }): Promise<RetainedDispatchOutcome<T>> {
      const id = hashCanonical([header.scope, request.lane, request.input])
      const pending = active.get(id)
      if (pending) return pending
      const work = async (): Promise<RetainedDispatchOutcome<T>> => {
        if (!limits.has(request.lane)) return fail('unknown allowance lane')
        // Re-read an uncertain call: another process may have retained its result since our last read.
        if (calls.has(id) && !calls.get(id)!.receipt) refresh()
        while (true) {
          const existing = calls.get(id)
          if (existing)
            return existing.receipt
              ? load(id, existing.receipt)
              : { succeeded: false, reason: 'outcome_unknown', dispatchId: id }
          request.signal?.throwIfAborted()
          if ((counts.get(request.lane) ?? 0) >= limits.get(request.lane)!) {
            return { succeeded: false, reason: 'allowance_exhausted', dispatchId: id }
          }
          const previousRevision = revision
          if (append({ kind: 'started', id, lane: request.lane })) break
          if (revision === previousRevision)
            return fail('history is busy; retry with the same input')
        }
        // A throw, process death or lost result deliberately leaves the committed intent in doubt.
        request.signal?.throwIfAborted()
        const value = parse(await request.dispatch())
        const encoded = canonicalString(value)
        const decoded: unknown = JSON.parse(encoded)
        const retainedValue = parse(decoded)
        if (canonicalString(retainedValue) !== encoded)
          return fail('result decoder is not stable across serialization')
        const receipt = hashCanonical(decoded)
        const file = join(receiptsDir, `${receipt.slice(7)}.json`)
        if (storage.append(file, encoded, 0) === undefined && storage.read(file) !== encoded)
          fail('cannot retain dispatch result')
        // The receipt is durable before the settlement event can make it reusable.
        while (true) {
          const previousRevision = revision
          if (append({ kind: 'settled', id, receipt })) break
          if (revision === previousRevision)
            return fail('settlement is busy; retained result awaits reconciliation')
        }
        return {
          succeeded: true,
          value: retainedValue,
          dispatchId: id,
          receiptDigest: receipt,
          replayed: false,
        }
      }
      const promise = work()
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
      refresh()
      return new Map(header.limits.map(([lane]) => [lane as Lane, counts.get(lane) ?? 0]))
    },
  }
}
