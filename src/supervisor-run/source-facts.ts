import type { SupervisorRunNodeRole, SupervisorRunSources } from './types'

// ---------------------------------------------------------------------------
// Journal shapes — structurally parsed. The journal is the contract, not the type.
// ---------------------------------------------------------------------------

interface JournalEvent {
  kind?: unknown
  id?: unknown
  parent?: unknown
  label?: unknown
  role?: unknown
  profileDigest?: unknown
  runtime?: unknown
  status?: unknown
  verdict?: unknown
  reason?: unknown
  infra?: unknown
  seq?: unknown
  at?: unknown
  spend?: unknown
  spent?: unknown
}

interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** False when the event carried no cache counters at all — not "zero cached". */
  hasCache: boolean
}

interface SpendLike {
  tokens: Tokens
  usd: number
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function readSpend(v: unknown): SpendLike {
  const rec = asRecord(v)
  const tok = asRecord(rec.tokens)
  const cacheRead = tok.cacheRead ?? tok.cache_read
  const cacheWrite = tok.cacheWrite ?? tok.cache_write
  return {
    tokens: {
      input: num(tok.input),
      output: num(tok.output),
      cacheRead: num(cacheRead),
      cacheWrite: num(cacheWrite),
      hasCache: cacheRead !== undefined || cacheWrite !== undefined,
    },
    usd: num(rec.usd),
  }
}

export function parseJsonl(text: string | null): Record<string, unknown>[] {
  return parseJsonlWithDiagnostics(text).rows
}

interface ParsedJsonl {
  readonly rows: Record<string, unknown>[]
  readonly invalidRows: number
}

function parseJsonlWithDiagnostics(text: string | null): ParsedJsonl {
  if (text === null) return { rows: [], invalidRows: 0 }
  const out: Record<string, unknown>[] = []
  let invalidRows = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>)
      } else {
        invalidRows += 1
      }
    } catch {
      invalidRows += 1
    }
  }
  return { rows: out, invalidRows }
}

export function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function ms(at: unknown): number | null {
  if (typeof at !== 'string') return null
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : null
}

// ---------------------------------------------------------------------------
// The supervision tree, as parsed from the journal event stream.
// ---------------------------------------------------------------------------

export interface SpawnRow {
  /** Zero-based row among parsed journal objects. */
  sourceRow: number
  id: string
  parent: string | null
  label: string
  /** Null when the source did not explicitly record a role. */
  role: SupervisorRunNodeRole | null
  /** Exact canonical AgentProfile digest, when the source recorded one. */
  profileDigest: string | null
  /** Exact execution runtime tag, when the source recorded one. */
  runtime: string | null
  at: number | null
  /** False when identity, parentage, label, or role was malformed. */
  valid: boolean
  invalidFields: readonly string[]
}

export interface CloseRow {
  id: string
  kind: 'settled' | 'cancelled'
  status: string | null
  /** String verdict from legacy journals, or valid/invalid for a structured verdict. */
  verdict: string | null
  /** Structured verdict validity, when recorded. */
  valid: boolean | null
  /** Structured verdict score, preserved without boolean coercion. */
  score: number | null
  /** The verdict exactly as the journal carried it. */
  rawVerdict: unknown | null
  /** Terminal failure detail exactly as recorded. */
  reason: string | null
  /** Whether Runtime classified the failure as infrastructure-caused. */
  infra: boolean | null
  at: number | null
  spend: SpendLike
  /** False when the close event carried no spend object — not "spent nothing". */
  hasSpend: boolean
}

export interface WorkerLogFacts {
  /** Position in `SupervisorRunSources.workers`, retained for exact evidence paths. */
  sourceIndex: number
  workerId: string | null
  label: string
  /** `false` means the artifact was missing; a captured empty artifact is `true`. */
  inboxCaptured: boolean
  eventsCaptured: boolean
  inboxInvalidRows: number
  eventsInvalidRows: number
  started: number | null
  /** True once a `finished` event was seen — independent of whether its `at` parsed. */
  finished: boolean
  finishedAt: number | null
  passed: boolean | null
  /** Numeric score exactly as the finished event recorded it. */
  score: number | null
  /** `patchBytes` as reported by the finished event (not the patch file's size). */
  finishedPatchBytes: number | null
  evidenceBytes: number
  /** Unique queued request ids, or null when exact accounting is unavailable. */
  steersQueued: number | null
  /** Unique matched request ids acknowledged as delivered, or null when unavailable. */
  steersDelivered: number | null
  steersQueuedUnavailable: string | null
  steersDeliveredUnavailable: string | null
  questions: number
  steerRequests: SteerRequestFact[]
  steerAcknowledgements: SteerAcknowledgementFact[]
}

export interface SteerRequestFact {
  /** Durable inbox request id; null when the row did not retain one. */
  requestId: string | null
  row: number
}

export interface SteerAcknowledgementFact {
  /** Worker event request id; null when the event cannot be correlated. */
  requestId: string | null
  /** `null` means the acknowledgement omitted delivery status. */
  delivered: boolean | null
  row: number
}

/**
 * The tree + timeline the report is computed from, exposed because the rollout-row
 * minter needs exactly the same parse (one parser, two consumers).
 */
export interface SupervisorTreeFacts {
  readonly rootId: string | null
  readonly spawns: readonly SpawnRow[]
  readonly closes: readonly CloseRow[]
  readonly workerSpawns: readonly SpawnRow[]
  readonly workerCloses: readonly CloseRow[]
  readonly brain: {
    tokensIn: number
    tokensOut: number
    cacheRead: number
    cacheWrite: number
    /** False when no metered event carried cache counters — not "nothing cached". */
    hasCache: boolean
    usd: number
    meteredCount: number
  }
  readonly workerLogs: ReadonlyMap<string, WorkerLogFacts>
  /** Every worker source row, including duplicate identities that a map cannot retain. */
  readonly workerLogRows: readonly WorkerLogFacts[]
  /** Non-empty journal lines that were not JSON objects. */
  readonly journalInvalidRows: number
  /** Parsed once with the journal and worker artifacts. */
  readonly state: Record<string, unknown> | null
  readonly startedAt: number | null
  readonly completedAt: number | null
}

interface VerdictFacts {
  label: string | null
  valid: boolean | null
  score: number | null
  raw: unknown | null
}

function readVerdict(v: unknown): VerdictFacts {
  if (typeof v === 'string') return { label: v, valid: null, score: null, raw: v }
  if (typeof v !== 'object' || v === null) {
    return { label: null, valid: null, score: null, raw: null }
  }
  const rec = v as Record<string, unknown>
  const valid = typeof rec.valid === 'boolean' ? rec.valid : null
  return {
    label: valid === null ? null : valid ? 'valid' : 'invalid',
    valid,
    score: typeof rec.score === 'number' && Number.isFinite(rec.score) ? rec.score : null,
    raw: v,
  }
}

export function workerSourceKey(
  worker: NonNullable<SupervisorRunSources['workers']>[number],
): string {
  return worker.workerId ?? worker.label
}

export function parseSupervisorTree(src: SupervisorRunSources): SupervisorTreeFacts {
  const parsedJournal = parseJsonlWithDiagnostics(src.journal)
  const events = parsedJournal.rows
  const state = parseJson(src.state)

  const spawns: SpawnRow[] = []
  const closes: CloseRow[] = []
  let brainIn = 0
  let brainOut = 0
  let brainCacheRead = 0
  let brainCacheWrite = 0
  let brainHasCache = false
  let brainUsd = 0
  let meteredCount = 0
  let rootId: string | null = null
  const meteredRows: Array<{ id: string; spend: SpendLike }> = []
  for (const [sourceRow, ev] of (events as JournalEvent[]).entries()) {
    const kind = typeof ev.kind === 'string' ? ev.kind : ''
    const id = typeof ev.id === 'string' ? ev.id : ''
    if (kind === 'spawned') {
      const parent = typeof ev.parent === 'string' && ev.parent.length > 0 ? ev.parent : null
      const label = typeof ev.label === 'string' ? ev.label : ''
      const invalidFields: string[] = []
      if (id.length === 0) invalidFields.push('id')
      const parentOmittedForFirstRoot = ev.parent === undefined && rootId === null
      if (
        ev.parent !== null &&
        !parentOmittedForFirstRoot &&
        !(typeof ev.parent === 'string' && ev.parent.length > 0)
      ) {
        invalidFields.push('parent')
      }
      if (label.length === 0) invalidFields.push('label')
      if (ev.role !== undefined && ev.role !== 'supervisor' && ev.role !== 'worker') {
        invalidFields.push('role')
      }
      if (
        ev.profileDigest !== undefined &&
        !(typeof ev.profileDigest === 'string' && ev.profileDigest.length > 0)
      ) {
        invalidFields.push('profileDigest')
      }
      if (ev.runtime !== undefined && !(typeof ev.runtime === 'string' && ev.runtime.length > 0)) {
        invalidFields.push('runtime')
      }
      const role: SupervisorRunNodeRole | null =
        ev.role === 'supervisor' || ev.role === 'worker' ? ev.role : null
      const valid = invalidFields.length === 0
      if (valid && parent === null && rootId === null) rootId = id
      spawns.push({
        sourceRow,
        id,
        parent,
        label,
        role,
        profileDigest:
          typeof ev.profileDigest === 'string' && ev.profileDigest.length > 0
            ? ev.profileDigest
            : null,
        runtime: typeof ev.runtime === 'string' && ev.runtime.length > 0 ? ev.runtime : null,
        at: ms(ev.at),
        valid,
        invalidFields,
      })
    } else if (kind === 'settled') {
      const verdict = readVerdict(ev.verdict)
      closes.push({
        id,
        kind: 'settled',
        status: typeof ev.status === 'string' ? ev.status : null,
        verdict: verdict.label,
        valid: verdict.valid,
        score: verdict.score,
        rawVerdict: verdict.raw,
        reason: typeof ev.reason === 'string' ? ev.reason : null,
        infra: typeof ev.infra === 'boolean' ? ev.infra : null,
        at: ms(ev.at),
        spend: readSpend(ev.spent),
        hasSpend: asRecord(ev.spent).tokens !== undefined,
      })
    } else if (kind === 'cancelled') {
      closes.push({
        id,
        kind: 'cancelled',
        status: 'cancelled',
        verdict: typeof ev.reason === 'string' ? ev.reason : null,
        valid: null,
        score: null,
        rawVerdict: typeof ev.reason === 'string' ? ev.reason : null,
        reason: typeof ev.reason === 'string' ? ev.reason : null,
        infra: null,
        at: ms(ev.at),
        spend: {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hasCache: false },
          usd: 0,
        },
        hasSpend: false,
      })
    } else if (kind === 'metered') {
      meteredRows.push({ id, spend: readSpend(ev.spend) })
    }
  }

  for (const row of meteredRows) {
    if (rootId === null || row.id !== rootId) continue
    brainIn += row.spend.tokens.input
    brainOut += row.spend.tokens.output
    brainCacheRead += row.spend.tokens.cacheRead
    brainCacheWrite += row.spend.tokens.cacheWrite
    brainHasCache = brainHasCache || row.spend.tokens.hasCache
    brainUsd += row.spend.usd
    meteredCount += 1
  }

  const workerSpawns = spawns.filter((s) => s.valid && s.id !== rootId)
  const workerIds = new Set(workerSpawns.map((s) => s.id))
  const workerCloses = closes.filter((c) => workerIds.has(c.id))

  const workerLogs = new Map<string, WorkerLogFacts>()
  const workerLogRows: WorkerLogFacts[] = []
  for (const [sourceIndex, w] of (src.workers ?? []).entries()) {
    const facts: WorkerLogFacts = {
      sourceIndex,
      workerId: w.workerId ?? null,
      label: w.label,
      inboxCaptured: w.inbox !== null,
      eventsCaptured: w.events !== null,
      inboxInvalidRows: 0,
      eventsInvalidRows: 0,
      started: null,
      finished: false,
      finishedAt: null,
      passed: null,
      score: null,
      finishedPatchBytes: null,
      evidenceBytes: 0,
      steersQueued: null,
      steersDelivered: null,
      steersQueuedUnavailable: null,
      steersDeliveredUnavailable: null,
      questions: 0,
      steerRequests: [],
      steerAcknowledgements: [],
    }
    const parsedInbox = parseJsonlWithDiagnostics(w.inbox)
    const parsedEvents = parseJsonlWithDiagnostics(w.events)
    facts.inboxInvalidRows = parsedInbox.invalidRows
    facts.eventsInvalidRows = parsedEvents.invalidRows
    for (const [row, req] of parsedInbox.rows.entries()) {
      if (typeof req.message !== 'string' || req.message.trim().length === 0) continue
      facts.steerRequests.push({
        requestId: typeof req.id === 'string' && req.id.length > 0 ? req.id : null,
        row,
      })
    }
    for (const [row, ev] of parsedEvents.rows.entries()) {
      const kind = ev.kind
      if (kind === 'message') {
        if (ev.direction === 'up') {
          facts.questions += 1
          continue
        }
        facts.steerAcknowledgements.push({
          requestId:
            typeof ev.requestId === 'string' && ev.requestId.length > 0 ? ev.requestId : null,
          delivered: typeof ev.delivered === 'boolean' ? ev.delivered : null,
          row,
        })
      } else if (kind === 'started') {
        facts.started = ms(ev.at)
      } else if (kind === 'finished') {
        facts.finished = true
        facts.finishedAt = ms(ev.at)
        facts.passed = typeof ev.passed === 'boolean' ? ev.passed : null
        facts.score = typeof ev.score === 'number' && Number.isFinite(ev.score) ? ev.score : null
        facts.finishedPatchBytes = typeof ev.patchBytes === 'number' ? ev.patchBytes : null
        facts.evidenceBytes = typeof ev.evidence === 'string' ? ev.evidence.length : 0
      }
    }
    const requestsById = new Map<string, number>()
    for (const request of facts.steerRequests) {
      if (request.requestId === null) continue
      requestsById.set(request.requestId, (requestsById.get(request.requestId) ?? 0) + 1)
    }
    const acknowledgementsById = new Map<string, SteerAcknowledgementFact[]>()
    for (const acknowledgement of facts.steerAcknowledgements) {
      if (acknowledgement.requestId === null) continue
      const matches = acknowledgementsById.get(acknowledgement.requestId) ?? []
      matches.push(acknowledgement)
      acknowledgementsById.set(acknowledgement.requestId, matches)
    }
    const queueProblems: string[] = []
    if (!facts.inboxCaptured) queueProblems.push('inbox absent')
    if (!facts.eventsCaptured) queueProblems.push('events absent')
    if (facts.inboxInvalidRows > 0) queueProblems.push('inbox contains malformed rows')
    if (facts.eventsInvalidRows > 0) queueProblems.push('events contain malformed rows')
    if (facts.steerRequests.some((request) => request.requestId === null)) {
      queueProblems.push('queued request id missing')
    }
    if ([...requestsById.values()].some((count) => count > 1)) {
      queueProblems.push('queued request id duplicated')
    }
    if (facts.steerAcknowledgements.some((acknowledgement) => acknowledgement.requestId === null)) {
      queueProblems.push('acknowledgement request id missing')
    }
    if ([...acknowledgementsById.keys()].some((id) => !requestsById.has(id))) {
      queueProblems.push('acknowledgement has no queued request')
    }
    if (queueProblems.length === 0) {
      facts.steersQueued = requestsById.size
    } else {
      facts.steersQueuedUnavailable = [...new Set(queueProblems)].join('; ')
    }

    const deliveryProblems = [...queueProblems]
    if ([...acknowledgementsById.values()].some((rows) => rows.length > 1)) {
      deliveryProblems.push('acknowledgement request id duplicated')
    }
    if (facts.steerAcknowledgements.some((acknowledgement) => acknowledgement.delivered === null)) {
      deliveryProblems.push('acknowledgement delivery status missing')
    }
    if (deliveryProblems.length === 0) {
      facts.steersDelivered = [...requestsById.keys()].filter((id) => {
        const acknowledgement = acknowledgementsById.get(id)
        return acknowledgement?.length === 1 && acknowledgement[0]?.delivered === true
      }).length
    } else {
      facts.steersDeliveredUnavailable = [...new Set(deliveryProblems)].join('; ')
    }
    workerLogRows.push(facts)
    workerLogs.set(workerSourceKey(w), facts)
  }

  const startedAt = ms(state?.startedAt) ?? spawns[0]?.at ?? null
  const rootClose = rootId === null ? null : closes.find((close) => close.id === rootId)
  const completedAt = ms(state?.completedAt) ?? rootClose?.at ?? null

  return {
    rootId,
    spawns,
    closes,
    workerSpawns,
    workerCloses,
    brain: {
      tokensIn: brainIn,
      tokensOut: brainOut,
      cacheRead: brainCacheRead,
      cacheWrite: brainCacheWrite,
      hasCache: brainHasCache,
      usd: brainUsd,
      meteredCount,
    },
    workerLogs,
    workerLogRows,
    journalInvalidRows: parsedJournal.invalidRows,
    state,
    startedAt,
    completedAt,
  }
}
