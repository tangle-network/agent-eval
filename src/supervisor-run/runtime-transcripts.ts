import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashCanonical } from '../ledger-core/canonical'
import type { RolloutWorkspaceCapture } from '../rollout/schema'
import { readMaybe } from './coordination-reader'
import { BLOB_DIR, isFile, record } from './runtime-artifacts'
import { nonEmptyString } from './source-facts'
import type { WorkerLogSource, WorkerNativeSession } from './types'

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
export function nativeTraceSummary(
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
export async function nodeTranscripts(
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
