/**
 * Supervision-tree reader over a THIRD-PARTY harness: Claude Code.
 *
 * `loops-reader.ts` reads a supervisor we wrote, whose journal was designed
 * for this analysis. This reader reads a harness we do not control, whose
 * transcript was designed for replaying a chat — and recovers the same tree
 * from it. If both produce a `SupervisorRunSources`, the tree model is a
 * property of multi-agent runs, not of our journal format.
 *
 * ## Where the tree hides in a Claude Code transcript
 *
 * | Tree fact | Claude Code evidence |
 * |---|---|
 * | spawn      | assistant `tool_use` (`Agent` / `Task`), answered by a `tool_result` whose `toolUseResult.agentId` names the child |
 * | settle     | a `<task-notification>` block in a later user line: `<task-id>` = agentId, `<status>` |
 * | steer      | assistant `tool_use` (`SendMessage`) with `input.to` = agentId — mid-task, to a LIVE child |
 * | delivered  | that steer's `tool_result` carrying `success` / `resumedAgentId` |
 * | cancel     | assistant `tool_use` (`TaskStop`) targeting an agentId |
 * | brain spend| `message.usage` on the main thread's assistant lines |
 * | worker spend| `message.usage` inside `<session>/subagents/agent-<id>.jsonl` |
 * | depth      | a child transcript that itself contains `Agent` tool_use lines |
 *
 * Every one of those is read through `parseClaudeEntries` — the SAME line
 * parser `src/rollout/readers/claude-jsonl.ts` uses for solo rollouts. There
 * is no second transcript parser.
 *
 * ## What Claude Code cannot say
 *
 * It records tokens but never a price, runs no per-worker verify, and keeps no
 * per-worker patch. Those are declared once in `limits`, so the analyzer
 * reports `unavailable — <reason>` instead of the $0 / 0-accepted that summing
 * an empty field would produce. See `SourceLimits`.
 *
 * ## Metric coverage vs the loops journal
 *
 * Measured on a real 52-agent session (fixture:
 * `tests/fixtures/supervisor-run/claude-code-session-*`).
 *
 * | Metric | loops | Claude Code | Why |
 * |---|---|---|---|
 * | workersSpawned / Settled / Cancelled | full | full | spawn tool_use + task-notification + TaskStop |
 * | steers / steersDelivered / steersByWorker | full | full | `SendMessage`; delivery from its tool_result |
 * | waves / waveSizes / maxConcurrency | full | full | derived from spawn/settle instants |
 * | respawns / repeatedLabels | full | full | same derivation |
 * | delegationDepth | full | full | a child transcript's own spawn calls |
 * | timeToFirstSpawn / supervisorWall | full | full | transcript instants |
 * | idleMs / idlePct / workerUtilization | full | PARTIAL | an agent that never notifies is counted live to the end of the transcript |
 * | observeThenRespawn / respawnWithoutEvidence | full | full | ordering of spawn vs settle instants |
 * | workerEvidenceBytes | full | PARTIAL | the child's closing message; 0 for pruned transcripts |
 * | brain tokens in/out + cache | full | full | main-thread `message.usage` |
 * | worker tokens in/out + cache | via harness join | PARTIAL | only for retained subagent transcripts |
 * | perWorker wall | full | full | spawn → settle instants |
 * | accepted / rejected / emptyPass / settledVerdicts | full | NONE | no per-worker verify step exists |
 * | brain/worker/total usd, costPerAcceptedPatch | full | NONE | transcripts carry no price |
 * | patch stats, delivered, verifyPass/Rc | full | NONE | no diff is handed back |
 * | judgeResolved / Score / Passed / Total | full | NONE | no judge in the loop |
 * | driverSteerCalls, brainTruncations | full | NONE | no outer driver log, no per-call finish_reason tap |
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  type ClaudeEntry,
  parseClaudeEntries,
  transcriptFromEntries,
} from '../rollout/readers/claude-jsonl'
import type { SupervisorRunReader, SupervisorRunSources, WorkerLogSource } from './types'

/** Tool names that spawn a child agent. `Task` is the older name for `Agent`. */
export const DEFAULT_SPAWN_TOOLS = ['Agent', 'Task'] as const
/** Tool names that deliver a message to an ALREADY-RUNNING child agent. */
export const DEFAULT_STEER_TOOLS = ['SendMessage'] as const
/** Tool names that stop a running child agent. */
export const DEFAULT_CANCEL_TOOLS = ['TaskStop', 'KillAgent'] as const

const SPEND_UNPRICED =
  'Claude Code transcripts record token usage but never a price — usd is not in the store'
const NO_VERDICTS =
  'Claude Code runs no per-worker verify step — a subagent reports prose, not pass/fail'
const NO_DELIVERABLES =
  'Claude Code retains no per-worker patch — subagents commit to git, they do not hand back a diff'

export interface ClaudeCodeReaderOptions {
  /** The main session transcript: `~/.claude/projects/<slug>/<sessionId>.jsonl`. */
  readonly transcriptPath: string
  /**
   * Directory of child transcripts. Defaults to `<transcript-dir>/<sessionId>/subagents`.
   * `null` skips the join, and every per-worker token count becomes unavailable.
   */
  readonly subagentsDir?: string | null
  readonly runRef?: string
  readonly instanceId?: string | null
  readonly arm?: string | null
  readonly spawnTools?: readonly string[]
  readonly steerTools?: readonly string[]
  readonly cancelTools?: readonly string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

interface ToolUse {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
  readonly at: string | null
}

interface ToolResult {
  readonly id: string
  readonly at: string | null
  readonly structured: unknown
  readonly text: string
}

/** Every tool call and tool result on one thread, in order, with instants. */
interface ThreadCalls {
  readonly uses: ToolUse[]
  readonly results: Map<string, ToolResult>
  readonly notifications: TaskNotification[]
  readonly firstAt: string | null
  readonly lastAt: string | null
}

interface TaskNotification {
  readonly taskId: string
  readonly toolUseId: string | null
  readonly status: string
  readonly summary: string | null
  readonly at: string | null
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m === null ? null : (m[1] as string)
}

/**
 * Task notifications are the settle instants. A notification fires each time an
 * agent stops, so a resumed agent produces several — they are kept in order and
 * the LAST one is the settle the analyzer sees, with the earlier ones acting as
 * the intermediate stops they actually were.
 */
function parseNotifications(text: string, at: string | null): TaskNotification[] {
  const out: TaskNotification[] = []
  for (const m of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const xml = m[0]
    const taskId = tag(xml, 'task-id')
    if (taskId === null) continue
    out.push({
      taskId: taskId.trim(),
      toolUseId: tag(xml, 'tool-use-id')?.trim() ?? null,
      status: tag(xml, 'status')?.trim() ?? 'unknown',
      summary: tag(xml, 'summary')?.trim() ?? null,
      at,
    })
  }
  return out
}

/** Project entries of ONE thread (main or a single sidechain) into tool traffic. */
function threadCalls(entries: readonly ClaudeEntry[]): ThreadCalls {
  const uses: ToolUse[] = []
  const results = new Map<string, ToolResult>()
  const notifications: TaskNotification[] = []
  let firstAt: string | null = null
  let lastAt: string | null = null

  for (const entry of entries) {
    if (entry.timestamp !== null) {
      if (firstAt === null) firstAt = entry.timestamp
      lastAt = entry.timestamp
    }
    const content = entry.message.content
    if (entry.type === 'assistant') {
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue
        const id = str(block.id)
        const name = str(block.name)
        if (id === null || name === null) continue
        uses.push({
          id,
          name,
          input: isRecord(block.input) ? block.input : {},
          at: entry.timestamp,
        })
      }
      continue
    }
    if (typeof content === 'string') {
      notifications.push(...parseNotifications(content, entry.timestamp))
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, {
          id: block.tool_use_id,
          at: entry.timestamp,
          structured: entry.toolUseResult,
          text: blockText(block.content),
        })
      } else if (block.type === 'text' && typeof block.text === 'string') {
        notifications.push(...parseNotifications(block.text, entry.timestamp))
      }
    }
  }
  return { uses, results, notifications, firstAt, lastAt }
}

/**
 * The agent id a spawn produced. Claude Code puts it in the structured
 * `toolUseResult`; the same id is echoed in the result text for transcripts
 * written before that field existed, so both are tried before giving up.
 */
function spawnedAgentId(result: ToolResult | undefined): string | null {
  if (result === undefined) return null
  if (isRecord(result.structured)) {
    const id = str(result.structured.agentId)
    if (id !== null) return id
  }
  return result.text.match(/agentId:\s*([A-Za-z0-9_-]+)/)?.[1] ?? null
}

interface ChildTranscript {
  readonly agentId: string
  readonly path: string
  readonly description: string | null
  readonly spawnToolUseId: string | null
  readonly spawnDepth: number | null
  readonly entries: ClaudeEntry[]
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly firstAt: string | null
  readonly lastAt: string | null
  readonly model: string | null
  /**
   * The child's closing assistant message — what it actually handed back. This
   * is the Claude Code analogue of a worker's `evidence` blob.
   */
  readonly finalReport: string | null
}

async function readChildren(dir: string): Promise<ChildTranscript[]> {
  const names = await readdir(dir).catch(() => null)
  if (names === null) return []
  const out: ChildTranscript[] = []
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    const path = join(dir, name)
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (raw === null) continue
    const entries = parseClaudeEntries(raw)
    // A subagent transcript is sidechain end to end — that flag is what marks it
    // a separate invocation rather than a turn of the parent.
    const projected = transcriptFromEntries(entries, { includeSidechain: true })
    const metaRaw = await readFile(path.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(() => null)
    let meta: Record<string, unknown> = {}
    if (metaRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(metaRaw)
        if (isRecord(parsed)) meta = parsed
      } catch {
        meta = {}
      }
    }
    const agentId =
      entries.find((e) => e.agentId !== null)?.agentId ??
      name.replace(/^agent-/, '').replace(/\.jsonl$/, '')
    out.push({
      agentId,
      path,
      description: str(meta.description),
      spawnToolUseId: str(meta.toolUseId),
      spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
      entries,
      tokensIn: projected.usage.tokensIn,
      tokensOut: projected.usage.tokensOut,
      cacheRead: projected.usage.cacheRead,
      cacheWrite: projected.usage.cacheWrite,
      firstAt: projected.startedAt,
      lastAt: projected.endedAt,
      model: projected.model,
      finalReport:
        [...projected.messages]
          .reverse()
          .find((m) => m.role === 'assistant' && typeof m.content === 'string')?.content ?? null,
    })
  }
  return out
}

interface SpawnFact {
  readonly agentId: string
  readonly parentId: string
  readonly label: string
  readonly at: string | null
  readonly model: string | null
}

/** A journal line in the dialect `parseSupervisorTree` reads. */
const line = (obj: Record<string, unknown>): string => JSON.stringify(obj)

/**
 * Read a Claude Code session (plus its subagent transcripts) as supervision-tree
 * source bytes. Never throws on a missing artifact.
 */
export async function readClaudeCodeSupervisorRun(
  opts: ClaudeCodeReaderOptions,
): Promise<SupervisorRunSources> {
  const spawnTools = new Set(opts.spawnTools ?? DEFAULT_SPAWN_TOOLS)
  const steerTools = new Set(opts.steerTools ?? DEFAULT_STEER_TOOLS)
  const cancelTools = new Set(opts.cancelTools ?? DEFAULT_CANCEL_TOOLS)

  const raw = await readFile(opts.transcriptPath, 'utf8').catch(() => null)
  const sessionId = basename(opts.transcriptPath).replace(/\.jsonl$/, '')
  const runRef = opts.runRef ?? opts.transcriptPath
  const limits = { spendUsd: SPEND_UNPRICED, workerVerdicts: NO_VERDICTS, deliverables: null }
  const traceCommand = `npx --yes @tangle-network/traces@latest analyze --harness claude-code --session ${sessionId}`

  if (raw === null) {
    return {
      runRef,
      instanceId: opts.instanceId ?? sessionId,
      arm: opts.arm ?? null,
      supRunDir: null,
      journal: null,
      brainLog: null,
      state: null,
      progress: null,
      workers: null,
      workersMissingReason: `session transcript unreadable at ${opts.transcriptPath}`,
      result: null,
      judge: null,
      judgeSource: null,
      patch: null,
      driverLog: null,
      harnessWorkerTokens: null,
      harnessMissingReason: `session transcript unreadable at ${opts.transcriptPath}`,
      limits: { ...limits, deliverables: NO_DELIVERABLES },
      traceCommand,
    }
  }

  const allEntries = parseClaudeEntries(raw)
  const main = threadCalls(allEntries.filter((e) => !e.isSidechain))
  const mainTranscript = transcriptFromEntries(allEntries)

  const subagentsDir =
    opts.subagentsDir === undefined
      ? join(dirname(opts.transcriptPath), sessionId, 'subagents')
      : opts.subagentsDir
  const children = subagentsDir === null ? [] : await readChildren(subagentsDir)
  const childByAgentId = new Map(children.map((c) => [c.agentId, c]))
  const childBySpawnToolUseId = new Map(
    children.filter((c) => c.spawnToolUseId !== null).map((c) => [c.spawnToolUseId as string, c]),
  )

  // Every thread that can spawn: the session itself, plus each child transcript
  // (a child that calls the spawn tool is a second delegation level).
  const threads: Array<{ id: string; calls: ThreadCalls }> = [{ id: sessionId, calls: main }]
  for (const child of children) {
    threads.push({ id: child.agentId, calls: threadCalls(child.entries) })
  }

  const spawns: SpawnFact[] = []
  const steersByTarget = new Map<string, Array<{ at: string | null; delivered: boolean }>>()
  const cancels: Array<{ agentId: string; at: string | null }> = []
  const settles: TaskNotification[] = []

  for (const thread of threads) {
    for (const use of thread.calls.uses) {
      if (spawnTools.has(use.name)) {
        const result = thread.calls.results.get(use.id)
        const agentId = spawnedAgentId(result) ?? childBySpawnToolUseId.get(use.id)?.agentId ?? null
        if (agentId === null) continue
        const label =
          str(use.input.description) ?? childByAgentId.get(agentId)?.description ?? agentId
        spawns.push({
          agentId,
          parentId: thread.id,
          label,
          // The spawn is complete when the launch call is answered; the tool_use
          // instant is the fallback for a call that never got a result line.
          at: result?.at ?? use.at,
          model: isRecord(result?.structured) ? str(result.structured.resolvedModel) : null,
        })
        continue
      }
      if (steerTools.has(use.name)) {
        const target = str(use.input.to) ?? str(use.input.recipient)
        if (target === null) continue
        const result = thread.calls.results.get(use.id)
        const structured = isRecord(result?.structured) ? result.structured : null
        // `success` is the harness confirming the message reached a live agent;
        // absent, the steer is counted queued but not delivered.
        const delivered = structured?.success === true || str(structured?.resumedAgentId) === target
        const rows = steersByTarget.get(target) ?? []
        rows.push({ at: use.at, delivered })
        steersByTarget.set(target, rows)
        continue
      }
      if (cancelTools.has(use.name)) {
        const target = str(use.input.agentId) ?? str(use.input.to) ?? str(use.input.taskId)
        if (target !== null) cancels.push({ agentId: target, at: use.at })
      }
    }
    settles.push(...thread.calls.notifications)
  }

  const spawnedIds = new Set(spawns.map((s) => s.agentId))
  const cancelledIds = new Set(
    cancels.filter((c) => spawnedIds.has(c.agentId)).map((c) => c.agentId),
  )
  const startedAt = main.firstAt
  const completedAt = main.lastAt

  const journalLines: string[] = [
    line({
      kind: 'spawned',
      id: sessionId,
      parent: null,
      label: `session:${sessionId}`,
      at: startedAt,
    }),
  ]
  for (const s of spawns) {
    journalLines.push(
      line({ kind: 'spawned', id: s.agentId, parent: s.parentId, label: s.label, at: s.at }),
    )
  }

  // Only the LAST notification per agent is its settle; an earlier one is a stop
  // the supervisor resumed from, which the steer count already records.
  const lastNotification = new Map<string, TaskNotification>()
  for (const n of settles) {
    if (!spawnedIds.has(n.taskId)) continue
    lastNotification.set(n.taskId, n)
  }
  for (const [agentId, n] of lastNotification) {
    if (cancelledIds.has(agentId)) continue
    journalLines.push(
      line({
        kind: 'settled',
        id: agentId,
        status: n.status,
        verdict: n.summary,
        at: n.at,
        // No `spent` key: Claude Code prices nothing, and a zeroed spend object
        // would read as a $0 worker. `limits.spendUsd` carries the reason.
      }),
    )
  }
  // One cancel per agent: Claude Code can emit a stop then a retry-stop for the
  // same agentId, and each raw entry would otherwise mint a duplicate `cancelled`
  // line that double-counts in `workersCancelled`. Keep the last, mirroring the
  // last-notification dedup the settle path already does.
  const lastCancel = new Map<string, { agentId: string; at: string | null }>()
  for (const c of cancels) {
    if (!spawnedIds.has(c.agentId)) continue
    lastCancel.set(c.agentId, c)
  }
  for (const c of lastCancel.values()) {
    journalLines.push(
      line({ kind: 'cancelled', id: c.agentId, reason: 'stopped by supervisor', at: c.at }),
    )
  }
  // `metered` carries the brain's own inference. The token counts are real; the
  // usd stays absent and `limits.spendUsd` explains why.
  journalLines.push(
    line({
      kind: 'metered',
      id: sessionId,
      spend: {
        tokens: {
          input: mainTranscript.usage.tokensIn,
          output: mainTranscript.usage.tokensOut,
          cacheRead: mainTranscript.usage.cacheRead,
          cacheWrite: mainTranscript.usage.cacheWrite,
        },
      },
      at: completedAt,
    }),
  )

  const settleAtByAgent = new Map(
    [...lastNotification.entries()].map(([id, n]) => [id, n.at] as const),
  )
  const spawnAtByAgent = new Map(spawns.map((s) => [s.agentId, s.at] as const))

  // Worker logs are keyed by LABEL (the analyzer's join), so agents that share a
  // description merge — the same collision loops has for a retried subtask.
  const byLabel = new Map<string, string[]>()
  for (const s of spawns) {
    const ids = byLabel.get(s.label) ?? []
    ids.push(s.agentId)
    byLabel.set(s.label, ids)
  }

  const workers: WorkerLogSource[] = []
  for (const [label, agentIds] of byLabel) {
    const events: string[] = []
    const inbox: string[] = []
    let tokensIn: number | null = null
    let tokensOut: number | null = null
    let cacheRead: number | null = null
    let cacheWrite: number | null = null
    let transcriptRef: string | null = null
    for (const agentId of agentIds) {
      const child = childByAgentId.get(agentId) ?? null
      const startAt = child?.firstAt ?? spawnAtByAgent.get(agentId) ?? null
      const endAt = settleAtByAgent.get(agentId) ?? child?.lastAt ?? null
      if (startAt !== null) events.push(line({ kind: 'started', label, at: startAt, agentId }))
      for (const steer of steersByTarget.get(agentId) ?? []) {
        inbox.push(
          line({ id: `${agentId}:${steer.at}`, at: steer.at, worker: label, message: 'steer' }),
        )
        events.push(
          line({
            kind: 'message',
            label,
            direction: 'down',
            at: steer.at,
            requestId: `${agentId}:${steer.at}`,
            delivered: steer.delivered,
          }),
        )
      }
      if (endAt !== null) {
        events.push(
          line({
            kind: 'finished',
            label,
            at: endAt,
            agentId,
            // No `passed` / `patchBytes`: this harness has neither. Emitting
            // `passed: false` here would invent a failed worker.
            // `evidence` is the child's closing message — what it handed back.
            ...(child?.finalReport === null || child?.finalReport === undefined
              ? {}
              : { evidence: child.finalReport }),
          }),
        )
      }
      if (child !== null) {
        tokensIn = (tokensIn ?? 0) + child.tokensIn
        tokensOut = (tokensOut ?? 0) + child.tokensOut
        cacheRead = (cacheRead ?? 0) + child.cacheRead
        cacheWrite = (cacheWrite ?? 0) + child.cacheWrite
        transcriptRef = child.path
      }
    }
    workers.push({
      label,
      events: events.length === 0 ? null : `${events.join('\n')}\n`,
      inbox: inbox.length === 0 ? null : `${inbox.join('\n')}\n`,
      patchBytes: null,
      transcriptRef,
      patchPath: null,
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
    })
  }

  const joined = children.length
  const harnessWorkerTokens =
    joined === 0
      ? null
      : {
          store: 'claude-code subagent transcripts',
          sessions: joined,
          input: children.reduce((a, c) => a + c.tokensIn, 0),
          output: children.reduce((a, c) => a + c.tokensOut, 0),
          cacheRead: children.reduce((a, c) => a + c.cacheRead, 0),
          cacheWrite: children.reduce((a, c) => a + c.cacheWrite, 0),
        }

  const missingChildren = spawns.filter((s) => !childByAgentId.has(s.agentId)).length
  const harnessMissingReason =
    subagentsDir === null
      ? 'subagent transcript join disabled'
      : joined === 0
        ? `no subagent transcripts under ${subagentsDir}`
        : missingChildren === 0
          ? null
          : `${missingChildren}/${spawns.length} spawned agents have no retained transcript under ${subagentsDir} (Claude Code prunes them; their tokens are unrecoverable)`

  const liveWorkers = spawns.filter(
    (s) => !lastNotification.has(s.agentId) && !cancelledIds.has(s.agentId),
  ).length
  const state = JSON.stringify({
    id: sessionId,
    // Derived, not asserted: a spawned agent with no notification and no stop
    // is still running, which is exactly what a live transcript looks like.
    status: liveWorkers > 0 ? 'running' : 'idle',
    startedAt,
    completedAt,
    result: { delivered: null },
  })

  return {
    runRef,
    instanceId: opts.instanceId ?? sessionId,
    arm: opts.arm ?? null,
    supRunDir: subagentsDir,
    journal: `${journalLines.join('\n')}\n`,
    brainLog: null,
    state,
    progress: null,
    workers,
    workersMissingReason: null,
    result: null,
    judge: null,
    judgeSource: null,
    patch: null,
    driverLog: null,
    harnessWorkerTokens,
    harnessMissingReason,
    limits: { ...limits, deliverables: NO_DELIVERABLES },
    rootTranscriptRef: opts.transcriptPath,
    traceCommand,
  }
}

/** A `SupervisorRunReader` over a Claude Code session — the same contract loops implements. */
export function claudeCodeSupervisorRunReader(opts: ClaudeCodeReaderOptions): SupervisorRunReader {
  return {
    runRef: opts.runRef ?? opts.transcriptPath,
    read: () => readClaudeCodeSupervisorRun(opts),
  }
}
