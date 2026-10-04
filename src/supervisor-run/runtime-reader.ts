/**
 * Reader for agent-runtime's file-backed supervision context.
 *
 * Runtime stores multiple recursive trees in one `spawn-journal.jsonl`.
 * Each line is an envelope whose `root` identifies the local tree. A journal
 * can connect a nested tree with `spawned.ownedTreeRoot`. It can also use the
 * spawned child id as the nested root when no owned tree is recorded. Either
 * way the nested tree may repeat its owner's spawn as a parentless marker: the
 * owner's id, not the tree key, identifies it (an owned tree's key is a path
 * such as `root/root:s0`). Descendant spawns must occur in the tree their
 * parent owns. This reader removes a duplicate marker and preserves the other
 * envelopes for the supervisor-run analyzer. Runtime stores profile
 * identity below `identity` and does not emit Eval's role field. This boundary
 * projects those fields without changing Runtime's dialect.
 *
 * Transcripts come from Runtime's own records too: `root-stream.jsonl` is the root's, each
 * worker's turn outputs and native-session receipt are read from the journal, and every blob
 * a record names is checked on disk (see `nodeTranscripts`).
 *
 * The run's terminal record is Runtime's own: `result.json` is the
 * `SupervisedResult` that `supervise()` returned, verbatim, and its `kind`
 * (`winner`, `no-winner`, or whatever a later arm is called) is the status.
 * `failure.json` (`{ runId, pursuitId, at, error: { name, message } }`) is the
 * record Runtime writes when `supervise()` threw before a result landed. Both
 * pass through as bytes; `terminal-record.ts` reads them. The reader does not
 * decide which kinds count: a kind it refuses is a run that recorded its
 * outcome and got reported as having none. The reader does not synthesize status fields. The analyzer names the Runtime
 * record that supplied a status, so status provenance cannot be mislabelled.
 *
 * `usdKnown: false` / `tokensKnown: false` on ONE record is not a limit of this
 * store. The store recorded every other record completely, so the flags travel
 * through to the analyzer per record, which reports the measured nodes and
 * names the unreported ones.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashCanonical } from '../ledger-core/canonical'
import type { RolloutWorkspaceCapture } from '../rollout/schema'
import {
  NO_SOURCE_LIMITS,
  type SourceLimits,
  type SupervisorRunReader,
  type SupervisorRunSources,
  type WorkerLogSource,
  type WorkerNativeSession,
} from './types'

const JOURNAL_FILE = 'spawn-journal.jsonl'
const OBSERVER_FILE = 'observer.jsonl'
const ROOT_STREAM_FILE = 'root-stream.jsonl'
const BLOB_DIR = 'blobs'
const RESULT_FILE = 'result.json'
const FAILURE_FILE = 'failure.json'

/**
 * The files only Runtime's durable layer writes. Any one of them marks a
 * Runtime run directory: `supervise()` opens the spawn journal on its first
 * event, and `supervisePursuit` appends the observer's `before` event and, on
 * a throw, the failure record before any spawn.
 *
 * Measured motive (discovery-lab recursive smoke r1, 2026-09-06): the first
 * attempt threw on a caller input error 16 minutes before the corrected attempt
 * opened the spawn journal. At that instant the directory held `observer.jsonl`
 * (2 records) and the failure record and no journal, so a journal-only test
 * routed it to an unrelated reader, which reads neither file, and the recorded
 * throw was reported as no run at all.
 */
const RUNTIME_RUN_DIR_MARKERS: readonly string[] = [JOURNAL_FILE, OBSERVER_FILE, FAILURE_FILE]

interface BeginRecord {
  readonly root: string
  readonly at: string
  readonly line: number
}

interface EventRecord {
  readonly root: string
  readonly event: Record<string, unknown>
  readonly line: number
}

interface NormalizedRuntimeJournal {
  readonly root: string
  readonly startedAt: string
  readonly journal: string
  readonly events: readonly Record<string, unknown>[]
}

async function readMaybe(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function profileDigest(event: Record<string, unknown>): string | null {
  const direct = nonEmptyString(event.profileDigest)
  if (direct !== null) return direct
  const identity = record(event.identity)
  return identity === null ? null : nonEmptyString(identity.profileDigest)
}

function formatError(path: string, line: number, detail: string): Error {
  return new Error(`${path}:${line}: invalid Runtime spawn journal: ${detail}`)
}

function parseEnvelopeJournal(text: string, path: string): NormalizedRuntimeJournal {
  const begins: BeginRecord[] = []
  const events: EventRecord[] = []
  const begun = new Map<string, BeginRecord>()

  for (const [index, sourceLine] of text.split('\n').entries()) {
    const line = index + 1
    const trimmed = sourceLine.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw formatError(path, line, 'line is not JSON')
    }
    const envelope = record(parsed)
    if (envelope === null) throw formatError(path, line, 'line is not an object')
    const kind = nonEmptyString(envelope.kind)
    const root = nonEmptyString(envelope.root)
    if (root === null) throw formatError(path, line, 'root must be a non-empty string')

    if (kind === 'begin') {
      const at = nonEmptyString(envelope.at)
      if (at === null || !Number.isFinite(Date.parse(at))) {
        throw formatError(path, line, 'begin.at must be an ISO timestamp')
      }
      if (begun.has(root)) throw formatError(path, line, `tree ${JSON.stringify(root)} began twice`)
      const begin = { root, at, line }
      begun.set(root, begin)
      begins.push(begin)
      continue
    }

    if (kind !== 'event') {
      throw formatError(path, line, "kind must be 'begin' or 'event'")
    }
    if (!begun.has(root)) {
      throw formatError(path, line, `event for tree ${JSON.stringify(root)} precedes begin`)
    }
    const event = record(envelope.event)
    if (event === null) throw formatError(path, line, 'event must be an object')
    if (nonEmptyString(event.kind) === null) {
      throw formatError(path, line, 'event.kind must be a non-empty string')
    }
    events.push({ root, event: { ...event }, line })
  }

  if (begins.length === 0) throw formatError(path, 1, 'no begin record')

  const parentSpawnsById = new Map<string, EventRecord[]>()
  const parentSpawnsByOwnedTreeRoot = new Map<string, EventRecord[]>()
  for (const entry of events) {
    if (entry.event.kind !== 'spawned') continue
    const id = nonEmptyString(entry.event.id)
    if (id === null) continue
    if (nonEmptyString(entry.event.parent) !== null) {
      const ownedTreeRoot = nonEmptyString(entry.event.ownedTreeRoot)
      if (ownedTreeRoot !== null) {
        const owners = parentSpawnsByOwnedTreeRoot.get(ownedTreeRoot) ?? []
        owners.push(entry)
        parentSpawnsByOwnedTreeRoot.set(ownedTreeRoot, owners)
      } else {
        const matches = parentSpawnsById.get(id) ?? []
        matches.push(entry)
        parentSpawnsById.set(id, matches)
      }
    }
  }

  const nestedRoots = new Set<string>()
  const nestedParentSpawns = new Map<string, EventRecord>()
  for (const begin of begins) {
    const parentSpawns = [
      ...new Set([
        ...(parentSpawnsByOwnedTreeRoot.get(begin.root) ?? []),
        ...(parentSpawnsById.get(begin.root) ?? []),
      ]),
    ].filter((entry) => entry.root !== begin.root)
    if (parentSpawns.length > 1) {
      throw formatError(
        path,
        begin.line,
        `tree ${JSON.stringify(begin.root)} has ${parentSpawns.length} parent spawns`,
      )
    }
    if (parentSpawns.length === 1) {
      nestedRoots.add(begin.root)
      nestedParentSpawns.set(begin.root, parentSpawns[0] as EventRecord)
    }
  }

  const topRoots = begins.filter((begin) => !nestedRoots.has(begin.root))
  if (topRoots.length !== 1) {
    throw formatError(
      path,
      topRoots[0]?.line ?? 1,
      `expected one top-level tree, found ${topRoots.length}`,
    )
  }
  const top = topRoots[0] as BeginRecord

  // A tree's root marker is a parentless spawn of the node that owns the tree: the top root
  // itself, or the parent spawn that owns a nested tree. An owned tree's key is a path, so
  // the owner's id is compared, never the tree key.
  const ownerIdByTree = new Map<string, string>([[top.root, top.root]])
  for (const [nestedRoot, parentSpawn] of nestedParentSpawns) {
    const ownerId = nonEmptyString(parentSpawn.event.id)
    if (ownerId !== null) ownerIdByTree.set(nestedRoot, ownerId)
  }
  const isRootMarker = (entry: EventRecord): boolean =>
    entry.event.kind === 'spawned' &&
    (entry.event.parent === undefined || entry.event.parent === null) &&
    nonEmptyString(entry.event.id) !== null &&
    entry.event.id === ownerIdByTree.get(entry.root)
  const rootMarkersByTree = new Map<string, EventRecord[]>()
  for (const entry of events) {
    if (!isRootMarker(entry)) continue
    const markers = rootMarkersByTree.get(entry.root) ?? []
    markers.push(entry)
    rootMarkersByTree.set(entry.root, markers)
  }

  for (const nestedRoot of nestedRoots) {
    const markers = rootMarkersByTree.get(nestedRoot) ?? []
    if (markers.length > 1) {
      throw formatError(
        path,
        begun.get(nestedRoot)?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} contains ${markers.length} root markers`,
      )
    }
    const parentSpawn = nestedParentSpawns.get(nestedRoot)
    if (parentSpawn === undefined) {
      throw formatError(
        path,
        begun.get(nestedRoot)?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} has no parent spawn`,
      )
    }
    const markerDigest = profileDigest(markers[0]?.event ?? {})
    const parentDigest = profileDigest(parentSpawn.event)
    if (markerDigest !== null && parentDigest !== null && markerDigest !== parentDigest) {
      throw formatError(
        path,
        markers[0]?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} disagrees with its parent profile digest`,
      )
    }
    if (parentDigest === null && markerDigest !== null) {
      parentSpawn.event.profileDigest = markerDigest
    }
  }

  const ownedTreeBySupervisorId = new Map<string, string>([[top.root, top.root]])
  for (const [nestedRoot, parentSpawn] of nestedParentSpawns) {
    const supervisorId = nonEmptyString(parentSpawn.event.id)
    if (supervisorId === null) continue
    const priorTree = ownedTreeBySupervisorId.get(supervisorId)
    if (priorTree !== undefined && priorTree !== nestedRoot) {
      throw formatError(
        path,
        parentSpawn.line,
        `spawn ${JSON.stringify(supervisorId)} owns both ${JSON.stringify(priorTree)} and ${JSON.stringify(nestedRoot)}`,
      )
    }
    ownedTreeBySupervisorId.set(supervisorId, nestedRoot)
  }
  for (const entry of events) {
    if (entry.event.kind !== 'spawned') continue
    const parentId = nonEmptyString(entry.event.parent)
    if (parentId === null) continue
    const parentTree = ownedTreeBySupervisorId.get(parentId)
    if (parentTree === undefined) {
      throw formatError(
        path,
        entry.line,
        `spawn ${JSON.stringify(entry.event.id)} names parent ${JSON.stringify(parentId)}, which owns no journal tree`,
      )
    }
    if (entry.root !== parentTree) {
      throw formatError(
        path,
        entry.line,
        `spawn ${JSON.stringify(entry.event.id)} is in tree ${JSON.stringify(entry.root)}, but parent ${JSON.stringify(parentId)} owns tree ${JSON.stringify(parentTree)}`,
      )
    }
  }

  // Runtime's recursive atom has no supervisor/worker role field. A tree root
  // is a supervisor; a child without its own tree is a worker.
  const supervisorIds = new Set([
    top.root,
    ...[...nestedParentSpawns.values()]
      .map((entry) => nonEmptyString(entry.event.id))
      .filter((id): id is string => id !== null),
  ])
  const normalized = events
    .filter((entry) => !(nestedRoots.has(entry.root) && isRootMarker(entry)))
    .map((entry) => {
      const event = { ...entry.event }
      if (event.kind === 'spawned') {
        const digest = profileDigest(event)
        if (event.profileDigest === undefined && digest !== null) {
          event.profileDigest = digest
        }
        if (event.role === undefined) {
          event.role = supervisorIds.has(nonEmptyString(event.id) ?? '') ? 'supervisor' : 'worker'
        }
      }
      return { root: entry.root, event }
    })

  const rootMarkers = rootMarkersByTree.get(top.root) ?? []
  if (rootMarkers.length !== 1) {
    throw formatError(
      path,
      top.line,
      `top-level tree ${JSON.stringify(top.root)} must contain one root marker`,
    )
  }

  return {
    root: top.root,
    startedAt: top.at,
    // Keep Runtime's event envelope intact. The pure source parser uses the envelope to
    // distinguish an understood-but-unmodeled Runtime event from an unreadable flat record.
    journal: `${normalized
      .map((entry) => JSON.stringify({ kind: 'event', root: entry.root, event: entry.event }))
      .join('\n')}\n`,
    events: normalized.map((entry) => entry.event),
  }
}

function parseOptionalRecord(text: string | null, path: string): Record<string, unknown> | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path}: invalid JSON`)
  }
  const value = record(parsed)
  if (value === null) throw new Error(`${path}: expected a JSON object`)
  return value
}

function spendRecord(value: unknown): Record<string, unknown> | null {
  const spend = record(value)
  if (spend === null) return null
  const tokens = record(spend.tokens)
  if (
    tokens === null ||
    typeof tokens.input !== 'number' ||
    !Number.isFinite(tokens.input) ||
    tokens.input < 0 ||
    typeof tokens.output !== 'number' ||
    !Number.isFinite(tokens.output) ||
    tokens.output < 0 ||
    typeof spend.usd !== 'number' ||
    !Number.isFinite(spend.usd) ||
    spend.usd < 0 ||
    (spend.usdKnown !== undefined && typeof spend.usdKnown !== 'boolean')
  ) {
    return null
  }
  return spend
}

function sourceLimits(
  root: string,
  events: readonly Record<string, unknown>[],
  workerIds: ReadonlySet<string>,
): SourceLimits {
  const rootMeters = events.filter((event) => event.kind === 'metered' && event.id === root)
  const invalidRootMeters = rootMeters.filter((event) => spendRecord(event.spend) === null)
  const rootMeterReason =
    rootMeters.length === 0
      ? 'Runtime journal has no root metered event'
      : invalidRootMeters.length > 0
        ? `${invalidRootMeters.length} root metered event(s) lack complete spend`
        : null
  const closes = events.filter(
    (event) =>
      workerIds.has(nonEmptyString(event.id) ?? '') &&
      (event.kind === 'settled' || event.kind === 'cancelled'),
  )
  const settledById = new Map<string, Record<string, unknown>[]>()
  for (const event of closes) {
    const id = nonEmptyString(event.id)
    if (id === null) continue
    const matches = settledById.get(id) ?? []
    matches.push(event)
    settledById.set(id, matches)
  }
  const incompleteWorkers = [...workerIds].filter((id) => {
    const terminal = settledById.get(id)
    return (
      terminal?.length !== 1 ||
      terminal[0]?.kind !== 'settled' ||
      spendRecord(terminal[0]?.spent) === null
    )
  })
  const missingVerdicts = [...workerIds].filter((id) => {
    const terminal = settledById.get(id)?.[0]
    if (terminal?.kind !== 'settled') return true
    const verdict = record(terminal.verdict)
    return typeof verdict?.valid !== 'boolean'
  })

  return {
    managerTokens: rootMeterReason,
    workerTokens:
      incompleteWorkers.length === 0
        ? null
        : `${incompleteWorkers.length}/${workerIds.size} child invocation(s) lack one settled spend record`,
    // `usdKnown: false` on ONE record is not a limit of this store: the store priced every
    // other record, and a limit here discards them all. The analyzer folds the flag per
    // record instead, and reports a partial total with the unpriced nodes named.
    spendUsd:
      rootMeterReason !== null
        ? rootMeterReason
        : incompleteWorkers.length > 0
          ? 'at least one child invocation lacks a settled spend record'
          : null,
    workerVerdicts:
      missingVerdicts.length === 0
        ? null
        : `${missingVerdicts.length}/${workerIds.size} child invocation(s) lack a structured validity verdict`,
    deliverables:
      workerIds.size === 0
        ? null
        : 'Runtime FileRunContext does not retain per-child delivered patches',
  }
}

/**
 * Refuse a `result.json` that belongs to another run. Runtime's result carries
 * its own `tree.root`; a settled record with a different root is a copied or
 * misplaced file, and reading its status onto this journal misreports the run.
 */
function assertResultMatchesJournal(
  root: string,
  result: Record<string, unknown> | null,
  resultPath: string,
): void {
  const resultKind = result === null ? null : nonEmptyString(result.kind)
  if (resultKind === null || result === null) return
  const resultRoot = nonEmptyString(record(result.tree)?.root)
  if (resultRoot === null) {
    throw new Error(`${resultPath}: Runtime ${resultKind} result has no tree.root`)
  }
  if (resultRoot !== root) {
    throw new Error(
      `${resultPath}: root ${JSON.stringify(resultRoot)} does not match journal root ${JSON.stringify(root)}`,
    )
  }
}

/**
 * Refuse a `failure.json` that is not a failure record. Runtime writes
 * `{ runId, pursuitId, at, error: { name, message } }`; a document without an
 * `error` object is not one, and reading it as a failure invents a terminal
 * state the run never recorded. The record carries no tree root, so its
 * identity is not checked against the journal.
 */
function assertFailureRecord(failure: Record<string, unknown> | null, failurePath: string): void {
  if (failure === null) return
  if (record(failure.error) === null) {
    throw new Error(`${failurePath}: Runtime failure record has no error object`)
  }
}

/**
 * The journal's begin stamp in the analyzer's state-document shape. It carries
 * the run identity and start instant only; the terminal status lives in
 * Runtime's own `result.json` / `failure.json`, which the analyzer reads by
 * name, so no synthetic status field is fabricated here.
 */
function runtimeBeginState(root: string, startedAt: string): string {
  return JSON.stringify({ id: root, startedAt })
}

/**
 * The file Runtime's `FileResultBlobStore` writes for one content address
 * (`sha256:<hex>` → `blobs/sha256-<hex>.json`), or null for anything that is not one.
 */
function blobFile(runDir: string, ref: unknown): string | null {
  return typeof ref === 'string' && /^sha256:[0-9a-f]{64}$/u.test(ref)
    ? join(runDir, BLOB_DIR, `${ref.replace(':', '-')}.json`)
    : null
}

type NodeTranscript = Pick<
  WorkerLogSource,
  'transcriptRef' | 'turns' | 'nativeSession' | 'workspaceCaptures'
>

interface NodeTranscriptFacts {
  dispatched: number
  readonly outputRefs: { value: unknown; turn: boolean }[]
  readonly outputPositions: Map<string, number>
  receipt: Record<string, unknown> | null
}

/** A later receipt replaces an earlier one, except that an absence never replaces an available one. */
function keepReceipt(fact: NodeTranscriptFacts, receipt: Record<string, unknown> | null): void {
  if (receipt === null) return
  if (fact.receipt?.status === 'available' && receipt.status !== 'available') return
  fact.receipt = receipt
}

/**
 * The files each harness writes its conversation to. A receipt can be available and complete
 * while holding none of them: on the 2026-10-04 trace proof a Pi worker that never wrote a session
 * stored only `.pi/agent/models-store.json`, and this summary counted it as a transcript.
 */
const HARNESS_SESSION_FILE: Readonly<Record<string, RegExp>> = {
  'claude-code': /(^|\/)\.claude\/projects\/.+\.jsonl$/u,
  codex: /(^|\/)\.codex\/sessions\/.+\.jsonl$/u,
  pi: /(^|\/)\.pi\/agent\/sessions\/.+\.jsonl$/u,
  opencode:
    /(^|\/)(\.local\/share\/opencode\/(opencode\.db|storage\/session\/.+\.json|export\/.+\.json)|\.opencode\/sessions\/.+)$/u,
}

/** Session files the receipt's transcript blob lists, or undefined when it cannot say. */
async function receiptSessionFiles(file: string): Promise<number | undefined> {
  let descriptor: unknown
  try {
    descriptor = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
  const harness = record(descriptor)?.harness
  const files = record(descriptor)?.files
  const pattern = typeof harness === 'string' ? HARNESS_SESSION_FILE[harness] : undefined
  if (pattern === undefined || !Array.isArray(files)) return undefined
  return files.filter((entry) => {
    const path = record(entry)?.path
    return typeof path === 'string' && pattern.test(path)
  }).length
}

type NativeSessionState = 'complete' | 'partial' | 'no-session-file' | 'unavailable' | 'none'

function nativeSessionState(session: WorkerNativeSession | null | undefined): NativeSessionState {
  if (session === null || session === undefined) return 'none'
  if (session.status !== 'available') return 'unavailable'
  if (session.coverageComplete === false) return 'partial'
  if (session.sessionFiles === 0) return 'no-session-file'
  return 'complete'
}

/**
 * What this reader can say about harness-session traces. Every spawned worker counts, including
 * one that recorded nothing; the root is reported apart because its receipt lives in result.json
 * (`rootHarnessTranscript`), not on a worker. Runtime records the session identity on each
 * receipt, so the sessions are read per node, not through one command. A receipt counts as a
 * session only when its copy is complete and holds a file the harness writes its conversation to.
 */
function nativeTraceSummary(
  workers: readonly WorkerLogSource[],
  root: NodeTranscript | undefined,
): string {
  const states = workers.map((worker) => nativeSessionState(worker.nativeSession))
  const count = (state: NativeSessionState): number => states.filter((s) => s === state).length
  const rootSession = root?.nativeSession ?? null
  const rootState = nativeSessionState(rootSession)
  const rootText =
    rootSession === null
      ? 'no receipt'
      : rootSession.status === 'unavailable'
        ? `unavailable (${rootSession.reason})`
        : rootState === 'complete'
          ? 'complete'
          : rootState === 'partial'
            ? 'partial copy'
            : 'no session file'
  if (rootSession === null && states.every((state) => state === 'none'))
    return 'unavailable — no node carries a Runtime harness transcript receipt'
  const gaps = [
    count('partial') > 0 ? `${count('partial')} only a partial copy` : null,
    count('no-session-file') > 0
      ? `${count('no-session-file')} a receipt with no session file`
      : null,
  ].filter((gap): gap is string => gap !== null)
  return `per node — ${count('complete')} of ${workers.length} workers carry a complete native session receipt (workers[].nativeSession)${gaps.length > 0 ? `; ${gaps.join('; ')}` : ''}; root: ${rootText} (result.json rootHarnessTranscript)`
}

async function workspaceCapturesFromOutput(
  runDir: string,
  ref: unknown,
): Promise<RolloutWorkspaceCapture[]> {
  const outRef = typeof ref === 'string' ? ref : null
  const blobPath = blobFile(runDir, ref)
  const missing = (projectionGap: string): RolloutWorkspaceCapture => ({
    outRef,
    blobPath,
    receiptPointer: null,
    receipt: null,
    attempts: null,
    coverageComplete: null,
    incompleteReason: null,
    projectionGap,
  })
  if (blobPath === null) return [missing('Runtime output has no valid content address')]
  if (!(await isFile(blobPath))) return [missing('Runtime output blob is missing or not a file')]
  const raw = await readMaybe(blobPath)
  if (raw === null) return [missing('Runtime output blob is missing')]
  let output: unknown
  try {
    output = JSON.parse(raw)
  } catch {
    return [missing('Runtime output blob is not JSON')]
  }
  let addressGap: string | null = null
  try {
    if (hashCanonical(output) !== outRef) {
      addressGap = 'Runtime output content address does not match output blob'
    }
  } catch {
    addressGap = 'Runtime output cannot be canonically hashed'
  }
  const project = (rawReceipt: unknown, receiptPointer: string | null): RolloutWorkspaceCapture => {
    const receipt = record(rawReceipt)
    if (receipt === null) {
      return {
        ...missing(
          `workspaceCapture receipt is absent or malformed${addressGap === null ? '' : `; ${addressGap}`}`,
        ),
        receiptPointer,
        receipt: rawReceipt,
      }
    }
    const provenance = record(receipt.provenance)
    const attempts = Array.isArray(provenance?.attempts) ? provenance.attempts : null
    const coverageComplete =
      typeof receipt.coverageComplete === 'boolean' ? receipt.coverageComplete : null
    const incompleteReason =
      typeof receipt.incompleteReason === 'string' ? receipt.incompleteReason : null
    const gaps: string[] = []
    if (addressGap !== null) gaps.push(addressGap)
    if (coverageComplete === null) gaps.push('workspaceCapture.coverageComplete is absent')
    if (record(receipt.snapshot) === null) gaps.push('workspaceCapture.snapshot is absent')
    if (provenance === null) gaps.push('workspaceCapture.provenance is absent')
    if (attempts === null) gaps.push('workspaceCapture.provenance.attempts is absent')
    else if (attempts.length === 0 || attempts.some((attempt) => record(attempt) === null)) {
      gaps.push('workspaceCapture.provenance.attempts is empty or malformed')
    }
    return {
      outRef,
      blobPath,
      receiptPointer,
      receipt,
      attempts,
      coverageComplete,
      incompleteReason,
      projectionGap: gaps.length > 0 ? gaps.join('; ') : null,
    }
  }
  const result = record(output)
  const captures: RolloutWorkspaceCapture[] = []
  // Use the record's field order and each array's order so every retained source stays ordered.
  for (const key of Object.keys(result ?? {})) {
    if (key === 'workspaceCapture') {
      captures.push(project(result?.[key], '/workspaceCapture'))
    } else if (key === 'workspaceCaptures') {
      const receipts = result?.[key]
      if (Array.isArray(receipts) && receipts.length > 0) {
        for (const [index, receipt] of receipts.entries()) {
          captures.push(project(receipt, `/workspaceCaptures/${index}`))
        }
      } else {
        captures.push({
          ...missing(
            `workspaceCaptures is empty or malformed${addressGap === null ? '' : `; ${addressGap}`}`,
          ),
          receiptPointer: '/workspaceCaptures',
          receipt: receipts ?? null,
        })
      }
    }
  }
  return captures.length > 0 ? captures : [project(null, null)]
}

/**
 * What Runtime retained of each node's decisions, from its own records.
 *
 * - A turn is one `execution-admitted` event in the `dispatched` phase. Its `execution-result`
 *   names an output blob holding that turn's provider event stream (reasoning, tool calls and
 *   results as the harness reported them). A dispatched turn with no retained output lost its
 *   record, which is how a worker that went down mid-turn shows up.
 * - Every event's `outRef` enters the same collector, once per node and address. Terminal
 *   records retain ordinary and steerable results; they are not counted as dispatched turns.
 * - The terminal event's `harnessTranscript` receipt covers the harness's native session files.
 *   Those are the only record of the harness's own subagents, so an unavailable receipt is a
 *   separate gap from a missing turn, and its reason is Runtime's, verbatim. `settled`,
 *   `cancelled` and `reconciled` all carry one; an available receipt is never replaced by a later
 *   absence. The root has no terminal event, so its receipt is the settle record's
 *   `rootHarnessTranscript`.
 *
 * Blob files are checked on disk: a receipt that names a blob the directory no longer holds is
 * not a retained transcript.
 */
async function nodeTranscripts(
  runDir: string,
  events: readonly Record<string, unknown>[],
  nodeIds: ReadonlySet<string>,
  root?: { readonly id: string; readonly receipt: Record<string, unknown> | null },
): Promise<Map<string, NodeTranscript>> {
  const facts = new Map<string, NodeTranscriptFacts>()
  const entry = (id: string): NodeTranscriptFacts => {
    let found = facts.get(id)
    if (found === undefined) {
      found = { dispatched: 0, outputRefs: [], outputPositions: new Map(), receipt: null }
      facts.set(id, found)
    }
    return found
  }
  for (const event of events) {
    const id = nonEmptyString(event.id)
    if (id === null || !nodeIds.has(id)) continue
    if (Object.hasOwn(event, 'outRef')) {
      const fact = entry(id)
      const ref = event.outRef
      const position = typeof ref === 'string' ? fact.outputPositions.get(ref) : undefined
      if (position !== undefined) {
        if (event.kind === 'execution-result') fact.outputRefs[position]!.turn = true
      } else {
        if (typeof ref === 'string') fact.outputPositions.set(ref, fact.outputRefs.length)
        fact.outputRefs.push({ value: ref, turn: event.kind === 'execution-result' })
      }
    }
    if (event.kind === 'execution-admitted' && record(event.admission)?.phase === 'dispatched') {
      entry(id).dispatched += 1
    } else if (
      event.kind === 'settled' ||
      event.kind === 'cancelled' ||
      event.kind === 'reconciled'
    ) {
      // A reconciled node carries its receipt on `reconciled`, which 15 available transcripts of
      // the 2026-10-04 Discovery archives did and this reader once skipped.
      keepReceipt(entry(id), record(event.harnessTranscript))
    }
  }
  if (root !== undefined && nodeIds.has(root.id)) keepReceipt(entry(root.id), root.receipt)
  const out = new Map<string, NodeTranscript>()
  for (const [id, fact] of facts) {
    const retained: string[] = []
    let retainedTurns = 0
    const workspaceCaptures: RolloutWorkspaceCapture[] = []
    for (const { value: ref, turn } of fact.outputRefs) {
      const file = blobFile(runDir, ref)
      if (file !== null && (await isFile(file))) {
        retained.push(file)
        if (turn) retainedTurns += 1
      }
      workspaceCaptures.push(...(await workspaceCapturesFromOutput(runDir, ref)))
    }
    let nativeSession: WorkerNativeSession | null = null
    if (fact.receipt !== null) {
      if (fact.receipt.status === 'available') {
        const file = blobFile(runDir, fact.receipt.transcriptRef)
        if (file !== null && (await isFile(file))) {
          const sessionFiles = await receiptSessionFiles(file)
          const coverageComplete = fact.receipt.coverageComplete
          nativeSession = {
            status: 'available',
            ref: file,
            ...(typeof coverageComplete === 'boolean' ? { coverageComplete } : {}),
            ...(sessionFiles === undefined ? {} : { sessionFiles }),
          }
        } else {
          nativeSession = { status: 'unavailable', reason: 'receipt-blob-missing' }
        }
      } else {
        nativeSession = {
          status: 'unavailable',
          reason: nonEmptyString(fact.receipt.reason) ?? 'unavailable',
        }
      }
    }
    out.set(id, {
      // The native session is the fuller record; the newest turn output is the next best.
      transcriptRef:
        nativeSession?.status === 'available' ? nativeSession.ref : (retained.at(-1) ?? null),
      turns: { dispatched: fact.dispatched, retained: retainedTurns },
      nativeSession,
      workspaceCaptures: workspaceCaptures.length > 0 ? workspaceCaptures : null,
    })
  }
  return out
}

export interface RuntimeReaderOptions {
  /**
   * Throw on a missing spawn journal instead of returning absent-shaped
   * sources. The default (false) models a journal-less run dir — a
   * pre-supervise death, a backfilled zombie — as a readable absence.
   */
  readonly strict?: boolean
}

/**
 * Sources for a run dir whose spawn journal does not exist. Mirrors the
 * absent shape the reader returns for a missing store: every
 * journal-dependent metric downstream reads `unavailable`, never 0.
 */
/**
 * The run identity a terminal record names when no journal exists yet: the
 * settle record's `tree.root`, else the failure record's `runId`. Both are
 * Runtime's own `runId`, so the report names the run the record is about
 * instead of `?`.
 */
function recordedRunId(
  result: Record<string, unknown> | null,
  failure: Record<string, unknown> | null,
): string | null {
  return nonEmptyString(record(result?.tree)?.root) ?? nonEmptyString(failure?.runId)
}

function absentRuntimeSupervisorRun(
  runDir: string,
  resultText: string | null,
  failureText: string | null,
  instanceId: string | null,
): SupervisorRunSources {
  const reason = `no Runtime spawn journal (${JOURNAL_FILE}) under ${runDir}`
  return {
    runRef: runDir,
    instanceId,
    arm: null,
    supRunDir: null,
    journal: null,
    journalMissingReason: reason,
    brainLog: null,
    brainLogMissingReason:
      'Runtime FileRunContext records spend but not model completion finish reasons',
    state: null,
    progress: null,
    workers: null,
    workersMissingReason: reason,
    result: resultText,
    failure: failureText,
    judge: null,
    judgeSource: null,
    patch: null,
    driverLog: null,
    harnessWorkerTokens: null,
    harnessMissingReason: 'Runtime FileRunContext has no external worker-token join',
    limits: NO_SOURCE_LIMITS,
    rootTranscriptRef: null,
    rootWorkspaceCaptures: null,
    traceCommand: 'unavailable — Runtime FileRunContext records no provider-session trace identity',
  }
}

/**
 * Read one agent-runtime `createFileRunContext(dir)` directory.
 *
 * A run dir without `spawn-journal.jsonl` returns the same absent-shaped
 * sources the reader returns for a missing store: `journal` and
 * `workers` null, each with its reason, so every dependent metric reads
 * `unavailable` — never 0 and never a throw. Its `result.json` and
 * `failure.json` are still read, so a run that died before its first spawn
 * reports the failure Runtime recorded. Pass `strict: true` to throw on the
 * missing journal instead. A journal, result, or failure document that exists
 * but cannot be parsed always throws: a corrupt record is a defect, not an
 * absence.
 *
 * The reader translates storage envelopes only. It does not assign research
 * roles, interpret artifacts, or turn process completion into a quality
 * verdict.
 */
export async function readRuntimeSupervisorRun(
  runDir: string,
  opts: RuntimeReaderOptions = {},
): Promise<SupervisorRunSources> {
  const journalPath = join(runDir, JOURNAL_FILE)
  const rawJournal =
    opts.strict === true ? await readFile(journalPath, 'utf8') : await readMaybe(journalPath)
  const resultPath = join(runDir, RESULT_FILE)
  const failurePath = join(runDir, FAILURE_FILE)
  const resultText = await readMaybe(resultPath)
  const failureText = await readMaybe(failurePath)
  const failure = parseOptionalRecord(failureText, failurePath)
  assertFailureRecord(failure, failurePath)
  const result = parseOptionalRecord(resultText, resultPath)
  if (rawJournal === null) {
    return absentRuntimeSupervisorRun(
      runDir,
      resultText,
      failureText,
      recordedRunId(result, failure),
    )
  }
  const normalized = parseEnvelopeJournal(rawJournal, journalPath)
  assertResultMatchesJournal(normalized.root, result, resultPath)

  const spawns = normalized.events.filter(
    (event) => event.kind === 'spawned' && nonEmptyString(event.id) !== null,
  )
  const childSpawns = spawns.filter((event) => event.id !== normalized.root)
  const workerIds = new Set(
    childSpawns.map((event) => nonEmptyString(event.id)).filter((id): id is string => id !== null),
  )
  const transcripts = await nodeTranscripts(
    runDir,
    normalized.events,
    new Set([normalized.root, ...workerIds]),
    { id: normalized.root, receipt: record(result?.rootHarnessTranscript) },
  )
  const workers: WorkerLogSource[] = childSpawns.map((event) => {
    const workerId = nonEmptyString(event.id) as string
    const transcript = transcripts.get(workerId)
    return {
      workerId,
      label: nonEmptyString(event.label) ?? String(event.id),
      events: null,
      inbox: null,
      patchBytes: null,
      transcriptRef: transcript?.transcriptRef ?? null,
      turns: transcript?.turns ?? { dispatched: 0, retained: 0 },
      nativeSession: transcript?.nativeSession ?? null,
      workspaceCaptures: transcript?.workspaceCaptures ?? null,
      patchPath: null,
    }
  })
  // Runtime appends every root provider event to the root stream as it arrives.
  const rootStream = join(runDir, ROOT_STREAM_FILE)

  return {
    runRef: runDir,
    instanceId: normalized.root,
    arm: null,
    supRunDir: runDir,
    journal: normalized.journal,
    brainLog: null,
    brainLogMissingReason:
      'Runtime FileRunContext records spend but not model completion finish reasons',
    state: runtimeBeginState(normalized.root, normalized.startedAt),
    progress: null,
    workers,
    workersMissingReason: null,
    result: resultText,
    failure: failureText,
    judge: null,
    judgeSource: null,
    patch: null,
    driverLog: null,
    harnessWorkerTokens: null,
    harnessMissingReason: 'Runtime FileRunContext has no external worker-token join',
    limits: sourceLimits(normalized.root, normalized.events, workerIds),
    rootTranscriptRef: (await isFile(rootStream)) ? rootStream : null,
    rootWorkspaceCaptures: transcripts.get(normalized.root)?.workspaceCaptures ?? null,
    traceCommand: nativeTraceSummary(workers, transcripts.get(normalized.root)),
  }
}

/** The agent-runtime file-backed layout as a `SupervisorRunReader`. */
export function runtimeSupervisorRunReader(
  runDir: string,
  opts: RuntimeReaderOptions = {},
): SupervisorRunReader {
  return { runRef: runDir, read: () => readRuntimeSupervisorRun(runDir, opts) }
}

/**
 * True when a directory holds any file only Runtime's durable layer writes:
 * the spawn journal, the observer journal, or the failure record. A run that
 * threw before its first spawn has no journal yet and is still a Runtime run.
 */
export async function isRuntimeSupervisorRunDir(runDir: string): Promise<boolean> {
  for (const marker of RUNTIME_RUN_DIR_MARKERS) {
    if (await isFile(join(runDir, marker))) return true
  }
  return false
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((entry) => entry.isFile())
    .catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ((error as { code: unknown }).code === 'ENOENT' ||
          (error as { code: unknown }).code === 'ENOTDIR')
      ) {
        return false
      }
      throw error
    })
}
