/**
 * Project retained Runtime records to canonical rollout rows without changing source files.
 * Preserve structured inputs, harness-scoped child lineage and attempt-bound native capture.
 * The owner verifies complete transcript families; unreadable evidence references remain gaps.
 */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HarnessSession } from '@tangle-network/harness-sessions'
import { sandboxEventsSession, toChatMessages, toOtlpSpans } from '@tangle-network/harness-sessions'
import { hashCanonical, jsonDocument } from '../ledger-core/canonical'
import { licenseClassOfName } from '../rollout/license'
import {
  harnessSessionRolloutLine,
  harnessSessionToolInventory,
} from '../rollout/readers/harness-session-lines'
import { screenedRewardFields, unscreenedRewardFields } from '../rollout/reward'
import type { RolloutLine, RolloutNativeCapture, RolloutSplit } from '../rollout/schema'
import { sameNativeCaptureIdentity, unresolvedNativeCaptures } from '../rollout/transcript'
import { expandJournalEventGroup } from './journal-event-group'
import { supervisorRunRolloutLinesFromFacts } from './rollout-nodes'
import { readRuntimeSupervisorRun } from './runtime-reader'
import { parseJsonl, parseSupervisorTree, recordOrNull as record } from './source-facts'
import type { SupervisorRunTreeGap } from './types'

interface Execution {
  taskRef?: string
  outRef?: string
  at?: string
  captures: Array<{ ref: string; attemptId?: string }>
}

interface NodeFacts {
  roots: Set<string>
  model?: string
  taskRef?: string
  outRef?: string
  attemptId?: string
  unansweredSince?: string
  executions: Execution[]
}

/** The loader verifies archive hashes, exact attempt binding, and the entire native family. */
export interface RuntimeNativeTranscriptRequest {
  runDir: string
  nodeId: string
  rootId: string
  attemptId: string
  taskRef?: string
  resultRef?: string
  receipt: unknown
}

export interface RuntimeRunRolloutOptions {
  suite?: string
  instanceId?: string
  split?: RolloutSplit
  capturedAt?: string
  verdict?: RunVerdict | null
  /** Runtime's verified reader can be injected without making Eval depend on Runtime. */
  readNativeTranscript?: (
    request: RuntimeNativeTranscriptRequest,
  ) => Promise<
    | { succeeded: true; value: { sessions: readonly HarnessSession[] } }
    | { succeeded: false; error: string }
  >
}

/** `opencode/zai-coding-plan/glm-5.3` → harness, provider, model. */
function producerOf(id: string): Record<'harness' | 'provider' | 'model', string | null> {
  const parts = id.split('/')
  if (parts.length >= 3) {
    return { harness: parts[0]!, provider: parts[1]!, model: parts.slice(2).join('/') }
  }
  if (parts.length === 2) return { harness: null, provider: parts[0]!, model: parts[1]! }
  return { harness: null, provider: null, model: id }
}

/** Only the transcript projection gap is discharged; independent workspace gaps remain. */
function wholeEpisode({ lossy_projection: _, gap, ...kept }: RolloutLine['provenance']) {
  const workspace = gap?.match(/workspace capture evidence \w+/u)?.[0]
  return workspace === undefined ? kept : { ...kept, gap: workspace }
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

async function journalFacts(runDir: string): Promise<Map<string, NodeFacts>> {
  const facts = new Map<string, NodeFacts>()
  const raw = await readFile(join(runDir, 'spawn-journal.jsonl'), 'utf8').catch(() => '')
  const node = (id: string): NodeFacts => {
    const fact = facts.get(id) ?? { executions: [], roots: new Set<string>() }
    facts.set(id, fact)
    return fact
  }
  for (const row of parseJsonl(raw)) {
    const expanded = expandJournalEventGroup(row)
    if (!expanded.succeeded) continue
    for (const entry of expanded.value) {
      const event = record(entry.event)
      const id = text(event?.id)
      if (event === null || id === undefined) continue
      if (event.kind === 'spawned') {
        for (const root of [text(entry.root), text(event.ownedTreeRoot)])
          if (root !== undefined) node(id).roots.add(root)
        node(id).taskRef ??= text(record(event.identity)?.taskDigest)
      } else if (event.kind === 'materialized') {
        const model = record(record(event.receipt)?.model)
        if (model?.status === 'known' && text(model.id)) node(id).model = text(model.id)
      } else if (event.kind === 'root-segment') {
        const to = record(event.to)
        const model = text(to?.model)
        if (model) node(id).model = [text(to?.harness), text(to?.provider), model].join('/')
      } else if (event.kind === 'execution-bound') {
        node(id).attemptId = text(record(event.binding)?.attemptId)
      } else if (event.kind === 'settled' && text(event.outRef)) {
        node(id).outRef = text(event.outRef)
      } else if (event.kind === 'execution-input') {
        const fact = node(id)
        const at = text(event.at)
        fact.executions.push({ taskRef: text(event.taskRef), at, captures: [] })
        fact.unansweredSince ??= at
      } else if (event.kind === 'execution-result' && text(event.outRef)) {
        const fact = node(id)
        let execution = fact.executions.at(-1)
        if (execution === undefined || execution.outRef !== undefined) {
          execution = { taskRef: fact.taskRef, captures: [] }
          fact.executions.push(execution)
        }
        execution.outRef = text(event.outRef)
        fact.unansweredSince = fact.executions.find((item) => item.outRef === undefined)?.at
      } else if (event.kind === 'execution-evidence' && text(event.outRef)) {
        const fact = node(id)
        let execution = fact.executions.at(-1)
        if (execution === undefined) {
          execution = { taskRef: fact.taskRef, captures: [] }
          fact.executions.push(execution)
        }
        if (
          !fact.executions.some((item) =>
            item.captures.some((capture) => capture.ref === event.outRef),
          )
        ) {
          execution.captures.push({ ref: event.outRef as string, attemptId: fact.attemptId })
        }
      }
    }
  }
  return facts
}

const readJson = (path: string): Promise<unknown> =>
  readFile(path, 'utf8')
    .then(JSON.parse)
    .catch(() => undefined)

async function blobValue(runDir: string, ref: string | undefined): Promise<unknown> {
  if (ref === undefined || !/^sha256:[0-9a-f]{64}$/u.test(ref)) return undefined
  return readJson(join(runDir, 'blobs', `${ref.replace(':', '-')}.json`))
}

/** Verify generic evidence before classifying it; unreadable bytes cannot identify their kind. */
async function executionEvidenceValue(runDir: string, ref: string): Promise<unknown> {
  const value = await blobValue(runDir, ref)
  try {
    return value !== undefined && hashCanonical(jsonDocument(value)) === ref ? value : undefined
  } catch {
    return undefined
  }
}

/** Keep a structured task whole. Picking only `instruction` would discard its conditioning. */
function taskText(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  return input === undefined || input === null ? undefined : JSON.stringify(input)
}

interface NodeSessions {
  sessions: HarnessSession[]
  native: HarnessSession[]
  captures: RolloutNativeCapture[]
  gaps: string[]
}

/** A cumulative capture cannot rewrite or remove already-retained conversation or child identity. */
function extendsSession(previous: HarnessSession, next: HarnessSession): boolean {
  if (previous.parentNativeSessionId !== next.parentNativeSessionId) return false
  const before = toChatMessages(previous)
  const after = toChatMessages(next)
  const calls = new Map(next.modelCalls.map((call) => [call.id, call]))
  const snapshots = new Map((next.toolDefinitionSnapshots ?? []).map((item) => [item.id, item]))
  if (
    calls.size !== next.modelCalls.length ||
    snapshots.size !== (next.toolDefinitionSnapshots?.length ?? 0) ||
    new Set(next.messages.map((message) => message.id)).size !== next.messages.length
  )
    return false
  return (
    after.length >= before.length &&
    hashCanonical(jsonDocument(before)) ===
      hashCanonical(jsonDocument(after.slice(0, before.length))) &&
    previous.messages.every(
      (message, index) =>
        next.messages[index]?.id === message.id &&
        next.messages[index]?.modelCallId === message.modelCallId,
    ) &&
    previous.modelCalls.every(
      (call) =>
        calls.has(call.id) &&
        calls.get(call.id)!.toolDefinitionSnapshotId === call.toolDefinitionSnapshotId &&
        calls.get(call.id)!.provider === call.provider &&
        calls.get(call.id)!.servedModel === call.servedModel &&
        calls.get(call.id)!.requestedModel === call.requestedModel,
    ) &&
    (previous.toolDefinitionSnapshots ?? []).every(
      (snapshot) =>
        snapshots.has(snapshot.id) &&
        hashCanonical(jsonDocument(snapshots.get(snapshot.id))) ===
          hashCanonical(jsonDocument(snapshot)),
    ) &&
    previous.children.every((child) =>
      next.children.some(
        (item) =>
          item.nativeSessionId === child.nativeSessionId && item.toolCallId === child.toolCallId,
      ),
    )
  )
}

/** Verify every attempt, retaining partial executions as audit evidence. */
async function nodeSessions(
  runDir: string,
  harness: string,
  id: string,
  fact: NodeFacts,
  options: RuntimeRunRolloutOptions,
): Promise<NodeSessions> {
  const executions =
    fact.executions.length > 0
      ? fact.executions
      : [{ taskRef: fact.taskRef, outRef: fact.outRef, captures: [] }]
  const sessions: HarnessSession[] = []
  const native = new Map<string, HarnessSession>()
  const nativePositions = new Map<string, number>()
  const captures: RolloutNativeCapture[] = []
  const recoverable = new Set<string>()
  const gaps: string[] = []
  for (const [index, execution] of executions.entries()) {
    let verified = false
    let hasNativeMessages = false
    let foundCapture = false
    for (const capture of execution.captures) {
      const value = await executionEvidenceValue(runDir, capture.ref)
      const wrapper = record(value)
      if (value !== undefined && wrapper?.kind !== 'harness-transcript') continue
      foundCapture = true
      const binding = record(wrapper?.node)
      const rootId = text(binding?.rootId)
      const attemptId = text(binding?.attemptId)
      const receipt = record(wrapper?.harnessTranscript)
      const taskRef = text(wrapper?.taskRef)
      const resultRef = text(wrapper?.outRef)
      let reason: string | null = null
      let read: readonly HarnessSession[] = []
      if (value === undefined)
        reason = 'execution evidence blob unavailable, malformed or failed content verification'
      else if (wrapper?.schemaVersion !== 1)
        reason = 'native evidence wrapper failed content verification'
      else if (
        !rootId ||
        !attemptId ||
        binding?.nodeId !== id ||
        capture.attemptId !== attemptId ||
        !fact.roots.has(rootId)
      )
        reason = 'native evidence has no matching execution-bound attempt or spawn root'
      else if (execution.taskRef !== undefined && taskRef !== execution.taskRef)
        reason = 'native evidence task does not match execution input'
      else if (execution.outRef !== undefined && resultRef !== execution.outRef)
        reason = 'native evidence result does not match execution output'
      else if (receipt?.status === 'unavailable') {
        reason = text(receipt.reason) ?? 'native capture unavailable'
        recoverable.add(capture.ref)
      } else if (!options.readNativeTranscript)
        reason = 'verified native transcript loader unavailable'
      else {
        try {
          const loaded = await options.readNativeTranscript({
            runDir,
            nodeId: id,
            rootId,
            attemptId,
            taskRef,
            resultRef,
            receipt,
          })
          if (!loaded.succeeded) reason = loaded.error
          else {
            read = loaded.value.sessions
            if (read.length === 0) reason = 'native transcript family is empty'
            else if (!read.some((session) => session.parentNativeSessionId === null))
              reason = 'native transcript forest has no root'
            else if (
              read.some(
                (session) =>
                  session.integrity.truncated ||
                  session.integrity.unparsedRecords > 0 ||
                  session.integrity.gaps.length > 0,
              )
            )
              reason = 'native transcript family has capture gaps'
            else if (
              read.some(
                (session) =>
                  session.ending.status === 'open' || session.ending.status === 'aborted',
              )
            )
              reason = 'native transcript family has an unfinished session'
          }
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error)
        }
      }
      if (
        reason === null &&
        read.some((session) => {
          const previous = native.get(`${session.harness}:${session.nativeSessionId}`)
          return previous !== undefined && !extendsSession(previous, session)
        })
      )
        reason = 'native cumulative snapshot conflicts with retained conversation or child identity'
      const projected: RolloutNativeCapture = {
        execution_index: index,
        evidence_ref: capture.ref,
        root_id: rootId ?? null,
        attempt_id: attemptId ?? null,
        task_ref: taskRef ?? null,
        result_ref: resultRef ?? null,
        transcript_ref: text(receipt?.transcriptRef) ?? null,
        verified: reason === null,
        gap: reason,
        native_session_ids: read.map((session) => session.nativeSessionId),
      }
      if (projected.verified) {
        for (const prior of captures) {
          if (recoverable.has(prior.evidence_ref) && sameNativeCaptureIdentity(prior, projected))
            prior.resolved_by = projected.evidence_ref
        }
        verified = true
      }
      captures.push(projected)
      // Cumulative snapshots replace the same session, never duplicate its prefix.
      for (const session of read) {
        const key = `${session.harness}:${session.nativeSessionId}`
        const previous = native.get(key)
        if (previous !== undefined && !extendsSession(previous, session)) {
          if (session.parentNativeSessionId === null) hasNativeMessages = true
          continue
        }
        native.set(key, session)
        if (session.parentNativeSessionId !== null) continue
        hasNativeMessages = true
        const position = nativePositions.get(key)
        if (position === undefined) {
          nativePositions.set(key, sessions.length)
          sessions.push(session)
        } else sessions[position] = session
      }
      execution.taskRef ??= taskRef
      execution.outRef ??= resultRef
    }
    if (!foundCapture) gaps.push(`execution ${index}: no attempt-bound native transcript evidence`)
    if (execution.outRef === undefined)
      gaps.push(`execution ${index}: execution result unavailable`)
    if (verified || hasNativeMessages) continue
    const [input, result] = await Promise.all([
      blobValue(runDir, execution.taskRef),
      blobValue(runDir, execution.outRef),
    ])
    const task = taskText(input)
    const answer = text(result) ?? text(record(result)?.content)
    const stream = record(result)?.events
    const events = Array.isArray(stream) ? stream : []
    if (task === undefined) gaps.push(`execution ${index}: execution input unavailable`)
    if (result === undefined) gaps.push(`execution ${index}: execution output blob unavailable`)
    if (task !== undefined || answer !== undefined || events.length > 0) {
      const session = sandboxEventsSession({
        harness,
        nativeSessionId: `${id}:${index}`,
        task: task ?? '',
        answer: answer ?? '',
        events,
      })
      if (task === undefined)
        session.messages = session.messages.filter(
          (message) => message.id !== `${id}:${index}:task`,
        )
      sessions.push(session)
    }
  }
  // Children remain separate invocations. Only roots contribute to the node's own conversation.
  const nativeSessions = [...native.values()]
  const keys = new Set(
    nativeSessions.map((session) => `${session.harness}:${session.nativeSessionId}`),
  )
  for (const session of nativeSessions) {
    if (
      session.parentNativeSessionId !== null &&
      !keys.has(`${session.harness}:${session.parentNativeSessionId}`)
    )
      gaps.push(`native parent ${session.parentNativeSessionId} unavailable`)
    for (const child of session.children) {
      if (!keys.has(`${session.harness}:${child.nativeSessionId}`))
        gaps.push(`native child ${child.nativeSessionId} unavailable`)
    }
  }
  for (const capture of unresolvedNativeCaptures(captures))
    gaps.push(`execution ${capture.execution_index}: ${capture.gap}`)
  return { sessions, native: nativeSessions, captures, gaps }
}

/** A caller's verdict on a run, applied to its root row. */
export interface RunVerdict {
  /** In [0, 1]; 1 is full success. */
  reward: number
  /** The check behind the reward was validated (a fixture that must fail it did). */
  screened: boolean
  /** An independent review contradicted the reward, so it trains nothing. */
  gated?: boolean
  /** Who produced the reward, such as `my-suite/check`. */
  source: string
  /** When a controller stopped the run on this verdict. */
  stoppedAt?: string
  at?: string
  commit?: string | null
  detail?: string
}

/**
 * The root's outcome under the caller's verdict. A run stopped on its success reads `cancelled`;
 * its episode is whole if no input was pending when it was stopped.
 */
function judged(node: RolloutLine, verdict: RunVerdict | null, pending: string | undefined) {
  if (verdict === null || node.parent_rollout_id !== null) return node.outcome
  const { reward, screened, gated = false, source, stoppedAt = '', commit = null } = verdict
  const ended = reward === 1 && !gated && (!pending || Date.parse(stoppedAt) <= Date.parse(pending))
  return {
    ...node.outcome,
    ...(screened || gated ? screenedRewardFields(reward, gated) : unscreenedRewardFields(reward)),
    ...(ended ? { is_completed: true, error: null } : {}),
    reward_source: source,
    verdict: { at: verdict.at ?? '', commit, detail: (verdict.detail ?? '').slice(0, 500) },
  }
}

export interface RuntimeRunRollouts {
  runDir: string
  lines: RolloutLine[]
  gaps: SupervisorRunTreeGap[]
  /** Each row's session as OTLP-JSONL, by rollout id. */
  otlp: Map<string, string>
}

/** Read one Runtime run directory into rollout rows; `suite` defaults to `runtime/<run>`. */
export async function runtimeRunRolloutLines(
  runDir: string,
  options: RuntimeRunRolloutOptions = {},
): Promise<RuntimeRunRollouts> {
  const verdict = options.verdict ?? null
  const src = await readRuntimeSupervisorRun(runDir)
  const facts0 = parseSupervisorTree(src)
  const seen = new Set<string>()
  const workerSpawns = facts0.workerSpawns.filter(
    (spawn) => !seen.has(spawn.id) && seen.add(spawn.id),
  )
  const tree = supervisorRunRolloutLinesFromFacts(
    src,
    { ...facts0, workerSpawns },
    {
      suite: options.suite ?? `runtime/${basename(runDir)}`,
      runId: basename(runDir),
      ...(options.capturedAt === undefined ? {} : { capturedAt: options.capturedAt }),
    },
  )
  const facts = await journalFacts(runDir)
  const lines: RolloutLine[] = []
  const otlp = new Map<string, string>()
  const captureGaps: SupervisorRunTreeGap[] = []
  for (const node of tree.nodes) {
    const fact = facts.get(node.rollout_id) ?? { executions: [], roots: new Set<string>() }
    const producer = fact.model === undefined ? null : producerOf(fact.model)
    const license = licenseClassOfName(producer?.model) ?? licenseClassOfName(producer?.harness)
    const harness = producer?.harness ?? node.policy.harness ?? 'sandbox'
    const episode = await nodeSessions(runDir, harness, node.rollout_id, fact, options)
    if (
      tree.gaps.some(
        (gap) => gap.code === 'journal-unavailable' || gap.code === 'source-row-malformed',
      )
    )
      episode.gaps.push('supervision journal has unreadable execution evidence')
    const sessions = episode.sessions
    const inventory = harnessSessionToolInventory(sessions)
    for (const message of episode.gaps)
      captureGaps.push({ code: 'transcript-capture-incomplete', nodeId: node.rollout_id, message })
    const messages = sessions.flatMap((session) => toChatMessages(session))
    // A session with no stream has only its root span, which `traces` rightly calls unread.
    const spans = sessions
      .map((session) => toOtlpSpans(session))
      .filter((s) => s.length > 1)
      .flat()
    otlp.set(node.rollout_id, spans.map((span) => `${JSON.stringify(span)}\n`).join(''))
    lines.push({
      ...node,
      task: {
        ...node.task,
        ...(options.split === undefined ? {} : { split: options.split }),
        ...(options.instanceId === undefined ? {} : { instance_id: options.instanceId }),
      },
      policy: {
        ...node.policy,
        ...(producer === null
          ? {}
          : {
              harness: producer.harness ?? node.policy.harness,
              provider: producer.provider,
              model: producer.model,
            }),
        ...(license === null ? {} : { license_class: license }),
      },
      messages: sessions.length === 0 ? node.messages : messages,
      tool_defs: inventory.tools,
      provenance: {
        ...(episode.gaps.length === 0
          ? wholeEpisode(node.provenance)
          : {
              ...node.provenance,
              lossy_projection: true as const,
              gap: [node.provenance.gap, ...episode.gaps].filter(Boolean).join('; '),
            }),
        native_captures: episode.captures,
        ...(inventory.gap === undefined ? {} : { tool_definitions_gap: inventory.gap }),
      },
      outcome: judged(node, verdict, fact.unansweredSince),
    })
    for (const session of episode.native.filter(
      (session) => session.parentNativeSessionId !== null,
    )) {
      const child = harnessSessionRolloutLine(
        session,
        {
          harness: session.harness,
          format: session.format,
          nativeSessionId: session.nativeSessionId,
          parentNativeSessionId: session.parentNativeSessionId,
          path: runDir,
          files: session.integrity.sourceFiles.map((file) => file.path),
          home: null,
          cwd: session.cwd,
          mtimeMs: 0,
          truncated: session.integrity.truncated,
        },
        node.provenance.captured_at,
      )
      const childId = (nativeId: string) =>
        `${node.rollout_id}:native:${session.harness}:${nativeId}`
      const parentIsRoot = episode.native.some(
        (parent) =>
          parent.harness === session.harness &&
          parent.nativeSessionId === session.parentNativeSessionId &&
          parent.parentNativeSessionId === null,
      )
      const line: RolloutLine = {
        ...child,
        rollout_id: childId(session.nativeSessionId),
        parent_rollout_id: parentIsRoot ? node.rollout_id : childId(session.parentNativeSessionId!),
        run_id: node.run_id,
        task: {
          ...node.task,
          ...(options.split === undefined ? {} : { split: options.split }),
          ...(options.instanceId === undefined ? {} : { instance_id: options.instanceId }),
        },
        provenance: {
          ...child.provenance,
          native_captures: episode.captures,
          ...(episode.gaps.length > 0
            ? {
                lossy_projection: true as const,
                gap: [child.provenance.gap, ...episode.gaps].join('; '),
              }
            : {}),
        },
      }
      lines.push(line)
      otlp.set(
        line.rollout_id,
        toOtlpSpans(session)
          .map((span) => `${JSON.stringify(span)}\n`)
          .join(''),
      )
    }
  }
  // The verdict is the root's reward, so the tree's "no judge verdict" gap no longer holds.
  const gaps = tree.gaps.filter((gap) => verdict === null || gap.code !== 'root-reward-unavailable')
  return { runDir, lines, gaps: [...gaps, ...captureGaps], otlp }
}
