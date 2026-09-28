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
type Event = z.infer<typeof eventSchema>

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
  const scopePath = join(options.runDir, 'dispatch-scope.json')
  const scopeText = canonicalString(header)
  const receiptsDir = join(options.runDir, 'dispatch-results')
  const resultPath = (id: LedgerHash) => join(receiptsDir, `${id.slice(7)}.json`)
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
    if (storage.read(scopePath) !== scopeText) fail('scope anchor is missing or changed')
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
  // The immutable anchor distinguishes a new scope from a lost journal on restart.
  // A half-initialized scope is held for reconciliation, never guessed to be unused.
  if (options.requireExisting && (!storage.exists(scopePath) || !storage.exists(indexPath)))
    fail('required retained history is missing')
  if (storage.exists(scopePath)) {
    if (storage.read(scopePath) !== scopeText) fail('resume changed its scope or allowances')
    if (!storage.read(indexPath)?.trim()) fail('dispatch history is missing or empty')
  } else {
    if (storage.exists(indexPath))
      fail('legacy history has no scope anchor; reconcile before migration')
    const created = storage.append(scopePath, scopeText, 0)
    if (created === undefined) {
      if (storage.read(scopePath) !== scopeText || !storage.read(indexPath)?.trim())
        fail('scope initialization is busy; retry the same scope')
    } else if (created !== Buffer.byteLength(scopeText)) {
      fail('storage returned an invalid scope revision')
    }
  }
  refresh()
  if (!opened && !append(header) && !opened)
    fail('history is busy; retry with the same run directory')
  const readResult = (id: LedgerHash) => {
    const content = storage.read(resultPath(id))
    if (content === undefined) return undefined
    const result = resultSchema.parse(JSON.parse(content))
    if (result.id !== id) return fail('retained result dispatch id mismatch')
    if (hashCanonical(result.value) !== result.receipt)
      return fail('retained result digest mismatch')
    const value = parse(result.value)
    if (canonicalString(value) !== canonicalString(result.value))
      return fail('result decoder changed retained output')
    return { value, receipt: result.receipt as LedgerHash }
  }
  const settle = (id: LedgerHash, receipt: LedgerHash) => {
    while (true) {
      const existing = calls.get(id)
      if (existing?.receipt) {
        if (existing.receipt !== receipt) fail('settled result digest mismatch')
        return
      }
      if (!existing) fail('settlement has no pending dispatch')
      const previousRevision = revision
      if (append({ kind: 'settled', id, receipt })) return
      if (revision === previousRevision)
        fail('settlement is busy; retained result awaits reconciliation')
    }
  }
  const load = (id: LedgerHash, receipt: string): RetainedDispatchOutcome<T> => {
    const result = readResult(id)
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

  return {
    /** The input binds all behavior-affecting request material, not just a caller-selected nonce. */
    run(request: {
      lane: Lane
      input: unknown
      dispatch: () => Promise<T>
      signal?: AbortSignal
    }): Promise<RetainedDispatchOutcome<T>> {
      const { lane, dispatch, signal } = request
      const id = hashCanonical([header.scope, lane, request.input])
      const pending = active.get(id)
      if (pending) return pending
      const work = async (): Promise<RetainedDispatchOutcome<T>> => {
        if (!limits.has(lane)) return fail('unknown allowance lane')
        // Replay must also validate retained history, not trust a stale in-memory result.
        refresh()
        while (true) {
          const existing = calls.get(id)
          if (existing) {
            if (existing.receipt) return load(id, existing.receipt)
            const result = readResult(id)
            if (!result) return { succeeded: false, reason: 'outcome_unknown', dispatchId: id }
            settle(id, result.receipt)
            return {
              succeeded: true,
              value: result.value,
              dispatchId: id,
              receiptDigest: result.receipt,
              replayed: true,
            }
          }
          signal?.throwIfAborted()
          if ((counts.get(lane) ?? 0) >= limits.get(lane)!) {
            return { succeeded: false, reason: 'allowance_exhausted', dispatchId: id }
          }
          const previousRevision = revision
          if (append({ kind: 'started', id, lane: lane })) break
          if (revision === previousRevision)
            return fail('history is busy; retry with the same input')
        }
        // A rejection leaves the committed intent in doubt, so return its diagnostic without settling it.
        let value: T
        try {
          signal?.throwIfAborted()
          value = parse(await dispatch())
        } catch (error) {
          return {
            succeeded: false,
            reason: 'outcome_unknown',
            dispatchId: id,
            diagnostic: error instanceof Error ? error.message : String(error),
          }
        }
        const encoded = canonicalString(value)
        const decoded: unknown = JSON.parse(encoded)
        const retainedValue = parse(decoded)
        if (canonicalString(retainedValue) !== encoded)
          return fail('result decoder is not stable across serialization')
        const receipt = hashCanonical(decoded)
        const retainedResult = canonicalString({
          kind: 'retained-dispatch-result-v1',
          id,
          receipt,
          value: decoded,
        })
        const file = resultPath(id)
        if (
          storage.append(file, retainedResult, 0) === undefined &&
          storage.read(file) !== retainedResult
        )
          fail('cannot retain dispatch result')
        // The receipt is durable before the settlement event can make it reusable.
        settle(id, receipt)
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
