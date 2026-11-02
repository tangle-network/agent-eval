/**
 * A Discovery run directory as `tangle.rollout.v1` rows: the supervision tree
 * `supervisorRunRolloutLines` mints, plus what only a Discovery run records.
 *
 *   - Producer: each node's `materialized` receipt names the model it ran on
 *     (`opencode/zai-coding-plan/glm-5.3` → harness, provider, model), and the
 *     root's `root-segment` names the root's. The license class follows.
 *   - Episode: each execution's input (`execution-input.taskRef`) and result
 *     (`execution-result.outRef`, a `{content, events}` blob), read as Sandbox
 *     sessions in order, so a node steered twice keeps both turns and every tool
 *     call. A node with no event stream stays a lossy projection.
 *   - A node respawned under the same id (a reopened run) is one row.
 *   - Reward: the run's newest known play-check verdict on the root row
 *     (`solved` → 1, a staged `SCORE` → stages passed / stages), and each
 *     agent's own commits on its `workers/<label>` branch of `deliverables.git`.
 *   - Screen: the calibration frozen in the run's receipt, where a fake fixture
 *     failed every stage of the check, and the goal audit, whose `contradiction`
 *     gates the reward. A check nothing calibrated stays unscreened.
 *
 * Every read is of files the run already wrote; nothing in the run dir is changed.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HarnessSession } from '@tangle-network/harness-sessions'
import { sandboxEventsSession, toChatMessages, toOtlpSpans } from '@tangle-network/harness-sessions'
import { promisify } from 'node:util'
import { licenseClassOfName } from '../rollout/license'
import { screenedRewardFields, unscreenedRewardFields } from '../rollout/reward'
import type { RolloutLine } from '../rollout/schema'
import { expandJournalEventGroup } from './journal-event-group'
import { supervisorRunRolloutLinesFromFacts } from './rollout-nodes'
import { readRuntimeSupervisorRun } from './runtime-reader'
import { parseJsonl, parseSupervisorTree } from './source-facts'
import type { SupervisorRunTreeGap } from './types'

const run = promisify(execFile)

/** A run's pursuit: its directory name without the `-YYYYMMDD<letter>` date suffix. */
export function discoveryPursuitOf(runDir: string): string {
  return basename(runDir).replace(/-20\d{6}[a-z0-9]*$/u, '')
}

interface NodeFacts {
  model?: string
  taskRef?: string
  outRef?: string
  /** The node's newest input, which the next result answers. */
  inputRef?: string
  executions?: Array<{ taskRef?: string; outRef: string }>
}

interface Producer {
  harness: string | null
  provider: string | null
  model: string | null
}

/** `opencode/zai-coding-plan/glm-5.3` → harness, provider, model. */
function producerOf(id: string): Producer {
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

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
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
        node(id).inputRef = text(event.taskRef)
      } else if (event.kind === 'execution-result' && text(event.outRef)) {
        const fact = node(id)
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

const jsonlRows = async (path: string) => parseJsonl(await readFile(path, 'utf8').catch(() => null))

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

export interface PlayCheckReward {
  reward: number
  at: string
  commit: string | null
  detail: string
  /** A fake fixture failed every stage of this check, so a pass of it means something. */
  calibrated: boolean
  /** The goal audit ruled that this pass falls short of the goal. */
  contradicted: boolean
}

/**
 * The newest play-check row whose verdict is known. A staged check
 * (`SCORE {"reached": r, "of": n}`) that is not solved failed at stage r, so it
 * passed r − 1 of n: Discovery's own `stagesPassed` (runner/calibration.mjs).
 * Only the SCORE line itself is parsed; the check prints more lines after it.
 */
export async function discoveryPlayCheckReward(runDir: string): Promise<PlayCheckReward | null> {
  const rows = await jsonlRows(join(runDir, 'play-checks.jsonl'))
  const single = rows.length === 0 ? record(await readJson(join(runDir, 'play-check.json'))) : null
  if (single) rows.push(single)
  const known = rows
    .filter((row) => row.known !== false && typeof row.solved === 'boolean')
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  const last = known.at(-1)
  if (last === undefined) return null
  const detail = typeof last.detail === 'string' ? last.detail : ''
  let reward = last.solved === true ? 1 : 0
  const score = detail.split('\n').find((line) => line.startsWith('SCORE {'))
  if (reward === 0 && score !== undefined) {
    try {
      const { reached, of } = JSON.parse(score.slice('SCORE '.length))
      const whole = Number.isSafeInteger(reached) && Number.isSafeInteger(of)
      if (whole && 1 <= reached && reached <= of) reward = (reached - 1) / of
    } catch {}
  }
  const key = last.contentHash ?? last.commit ?? last.at
  const audits = await jsonlRows(join(runDir, 'goal-audits.jsonl'))
  const ruling = audits.filter((a) => a.key === key && a.verdict !== 'unavailable').at(-1)
  const receipt = record(await readJson(join(runDir, 'RECEIPT.json')))
  const calibration = record(record(receipt?.check)?.calibration)
  const stages = Object.values(record(calibration?.stages) ?? {})
  return {
    reward,
    calibrated: stages.length > 0 && stages.every((state) => state === 'calibrated'),
    contradicted: (ruling?.verdict ?? record(last.goalAudit)?.verdict) === 'contradiction',
    at: String(last.at ?? ''),
    commit: typeof last.commit === 'string' ? last.commit : null,
    detail: detail.slice(0, 500),
  }
}

/** Commits each `workers/<label>` branch holds beyond the commit every worker started from. */
async function deliverableCommits(runDir: string): Promise<Map<string, number> | null> {
  const git = (args: string[]) =>
    run('git', ['-C', join(runDir, 'deliverables.git'), ...args], { timeout: 30_000 })
  let refs: string[]
  try {
    const { stdout } = await git([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/workers',
    ])
    refs = stdout.split('\n').filter(Boolean)
  } catch {
    return null
  }
  if (refs.length === 0) return new Map()
  const base = await git(['merge-base', '--octopus', ...refs])
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
  const counts = new Map<string, number>()
  for (const ref of refs) {
    // A damaged archive (an empty object file) leaves the metric unknown; the run's other rows still import.
    const counted = await git(['rev-list', '--count', ref, ...(base ? [`^${base}`] : [])]).catch(
      () => null,
    )
    if (counted === null) return null
    counts.set(ref.slice('workers/'.length), Number(counted.stdout.trim()))
  }
  return counts
}

export interface DiscoveryRunRollouts {
  runDir: string
  pursuit: string
  lines: RolloutLine[]
  gaps: SupervisorRunTreeGap[]
  /** Discovery facts this read could not recover, one sentence each. */
  notes: string[]
  /** Each row's session as OTLP-JSONL, by rollout id. */
  otlp: Map<string, string>
}

/** Read one Discovery run directory into rollout rows. */
export async function discoveryRunRolloutLines(
  runDir: string,
  options: { capturedAt?: string } = {},
): Promise<DiscoveryRunRollouts> {
  const pursuit = discoveryPursuitOf(runDir)
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
      suite: `discovery/${pursuit}`,
      runId: basename(runDir),
      ...(options.capturedAt === undefined ? {} : { capturedAt: options.capturedAt }),
    },
  )
  const facts = await journalFacts(runDir)
  const check = await discoveryPlayCheckReward(runDir)
  const commits = await deliverableCommits(runDir)
  const lines: RolloutLine[] = []
  const otlp = new Map<string, string>()
  for (const node of tree.nodes) {
    const fact = facts.get(node.rollout_id) ?? {}
    const producer = fact.model === undefined ? null : producerOf(fact.model)
    const license = licenseClassOfName(producer?.model) ?? licenseClassOfName(producer?.harness)
    const harness = producer?.harness ?? node.policy.harness ?? 'sandbox'
    const sessions = await nodeSessions(runDir, harness, node.rollout_id, fact)
    const messages = sessions.flatMap((session) => toChatMessages(session))
    const label = typeof node.outcome.metrics.label === 'string' ? node.outcome.metrics.label : null
    const isRoot = node.parent_rollout_id === null
    const outcome =
      isRoot && check !== null
        ? {
            ...node.outcome,
            ...(check.calibrated || check.contradicted
              ? screenedRewardFields(check.reward, check.contradicted)
              : unscreenedRewardFields(check.reward)),
            reward_source: 'discovery/play-check',
            verdict: { at: check.at, commit: check.commit, detail: check.detail },
          }
        : node.outcome
    const spans = sessions.flatMap((session) => toOtlpSpans(session))
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
      outcome: {
        ...outcome,
        metrics: {
          ...outcome.metrics,
          deliverable_commits:
            commits === null ? null : (commits.get(isRoot ? 'root' : (label ?? '')) ?? 0),
        },
      },
    })
  }
  const notes = commits === null ? ['deliverables.git unreadable: deliverable_commits is null'] : []
  // The play-check is the root's reward, so the tree's "no judge verdict" gap no longer holds.
  const gaps = tree.gaps.filter((gap) => check === null || gap.code !== 'root-reward-unavailable')
  return { runDir, pursuit, lines, gaps, notes, otlp }
}
