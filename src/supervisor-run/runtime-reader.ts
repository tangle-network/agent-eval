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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertFailureRecord,
  assertResultMatchesJournal,
  FAILURE_FILE,
  isFile,
  JOURNAL_FILE,
  OBSERVER_FILE,
  parseOptionalRecord,
  RESULT_FILE,
  ROOT_STREAM_FILE,
  readMaybe,
  record,
  runtimeBeginState,
  sourceLimits,
} from './runtime-artifacts'
import { parseEnvelopeJournal } from './runtime-journal'
import { nativeTraceSummary, nodeTranscripts } from './runtime-transcripts'
import { nonEmptyString } from './source-facts'
import {
  NO_SOURCE_LIMITS,
  type SupervisorRunReader,
  type SupervisorRunSources,
  type WorkerLogSource,
} from './types'

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
