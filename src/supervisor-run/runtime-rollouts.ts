/**
 * A Runtime run directory as `tangle.rollout.v1` rows: the supervision tree
 * `supervisorRunRolloutLines` mints, with each node's whole episode.
 *
 *   - Producer: each node's `materialized` receipt names the model it ran on
 *     (`opencode/zai-coding-plan/glm-5.3` → harness, provider, model), and the
 *     root's `root-segment` names the root's. The license class follows.
 *   - Episode: each execution's input (`execution-input.taskRef`) and result
 *     (`execution-result.outRef`, a `{content, events}` blob), read as Sandbox
 *     sessions in order, so a node steered twice keeps both turns and every tool
 *     call. A node with no event stream stays a lossy projection.
 *   - A node respawned under the same id (a reopened run) is one row.
 *   - Reward: the caller's `RunVerdict` on the root row. The caller owns what
 *     its check means; this reader owns how a reward is screened and when a
 *     stopped episode is whole.
 *
 * Every read is of files Runtime already wrote; nothing in the run dir is changed.
 */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HarnessSession } from '@tangle-network/harness-sessions'
import { sandboxEventsSession, toChatMessages, toOtlpSpans } from '@tangle-network/harness-sessions'
import { licenseClassOfName } from '../rollout/license'
import { screenedRewardFields, unscreenedRewardFields } from '../rollout/reward'
import type { RolloutLine } from '../rollout/schema'
import { expandJournalEventGroup } from './journal-event-group'
import { supervisorRunRolloutLinesFromFacts } from './rollout-nodes'
import { readRuntimeSupervisorRun } from './runtime-reader'
import { parseJsonl, parseSupervisorTree, recordOrNull as record } from './source-facts'
import type { SupervisorRunTreeGap } from './types'

interface NodeFacts {
  model?: string
  taskRef?: string
  outRef?: string
  /** The node's newest input, which the next result answers. */
  inputRef?: string
  unansweredSince?: string
  executions?: Array<{ taskRef?: string; outRef: string }>
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

/** A row holding the agent's whole stream is no longer lossy; a workspace capture gap still stands. */
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
    const fact = facts.get(id) ?? {}
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
        node(id).taskRef ??= text(record(event.identity)?.taskDigest)
      } else if (event.kind === 'materialized') {
        const model = record(record(event.receipt)?.model)
        if (model?.status === 'known' && text(model.id)) node(id).model = text(model.id)
      } else if (event.kind === 'root-segment') {
        const to = record(event.to)
        const model = text(to?.model)
        if (model) node(id).model = [text(to?.harness), text(to?.provider), model].join('/')
      } else if (event.kind === 'settled' && text(event.outRef)) {
        node(id).outRef = text(event.outRef)
      } else if (event.kind === 'execution-input') {
        const fact = node(id)
        fact.inputRef = text(event.taskRef)
        fact.unansweredSince ??= text(event.at)
      } else if (event.kind === 'execution-result' && text(event.outRef)) {
        const fact = node(id)
        fact.unansweredSince = undefined
        const taskRef = fact.inputRef ?? fact.taskRef
        ;(fact.executions ??= []).push({ taskRef, outRef: event.outRef as string })
      }
    }
  }
  return facts
}

const readJson = (path: string): Promise<unknown> =>
  readFile(path, 'utf8').then(JSON.parse).catch(() => undefined)

async function blobValue(runDir: string, ref: string | undefined): Promise<unknown> {
  if (ref === undefined || !/^sha256:[0-9a-f]{64}$/u.test(ref)) return undefined
  return readJson(join(runDir, 'blobs', `${ref.replace(':', '-')}.json`))
}

/** One Sandbox session per execution, oldest first; older runs keep only the settled result. */
async function nodeSessions(runDir: string, harness: string, id: string, fact: NodeFacts) {
  const executions = fact.executions ?? [{ taskRef: fact.taskRef, outRef: fact.outRef }]
  const sessions: HarnessSession[] = []
  for (const [index, { taskRef, outRef }] of executions.entries()) {
    const [input, result] = await Promise.all([blobValue(runDir, taskRef), blobValue(runDir, outRef)])
    const task = text(input) ?? text(record(input)?.prompt) ?? text(record(input)?.instruction)
    const answer = text(result) ?? text(record(result)?.content)
    const stream = record(result)?.events
    const events = Array.isArray(stream) ? stream : []
    if (task === undefined || (answer === undefined && events.length === 0)) continue
    const nativeSessionId = `${id}:${index}`
    sessions.push(sandboxEventsSession({ harness, nativeSessionId, task, answer: answer ?? '', events }))
  }
  return sessions
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
  options: { suite?: string; capturedAt?: string; verdict?: RunVerdict | null } = {},
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
  for (const node of tree.nodes) {
    const fact = facts.get(node.rollout_id) ?? {}
    const producer = fact.model === undefined ? null : producerOf(fact.model)
    const license = licenseClassOfName(producer?.model) ?? licenseClassOfName(producer?.harness)
    const harness = producer?.harness ?? node.policy.harness ?? 'sandbox'
    const sessions = await nodeSessions(runDir, harness, node.rollout_id, fact)
    const messages = sessions.flatMap((session) => toChatMessages(session))
    // A session with no stream has only its root span, which `traces` rightly calls unread.
    const spans = sessions.map((session) => toOtlpSpans(session)).filter((s) => s.length > 1).flat()
    otlp.set(node.rollout_id, spans.map((span) => `${JSON.stringify(span)}\n`).join(''))
    lines.push({
      ...node,
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
      provenance: messages.some((m) => m.role === 'tool') ? wholeEpisode(node.provenance) : node.provenance,
      outcome: judged(node, verdict, fact.unansweredSince),
    })
  }
  // The verdict is the root's reward, so the tree's "no judge verdict" gap no longer holds.
  const gaps = tree.gaps.filter((gap) => verdict === null || gap.code !== 'root-reward-unavailable')
  return { runDir, lines, gaps, otlp }
}
