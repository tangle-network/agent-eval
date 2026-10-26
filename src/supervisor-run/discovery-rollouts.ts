/**
 * A Discovery run directory as `tangle.rollout.v1` rows: the supervision tree
 * `supervisorRunRolloutLines` mints, plus what only a Discovery run records.
 *
 *   - Producer: each node's `materialized` receipt names the model it ran on
 *     (`opencode/zai-coding-plan/glm-5.3` → harness, provider, model), and the
 *     root's `root-segment` names the root's. The license class follows.
 *   - Episode text: the node's task prompt (its `taskDigest` blob) and its
 *     final answer (its `outRef` blob), when the run kept both. The tool calls
 *     between them are not inlined, so the row stays a lossy projection.
 *   - A node respawned under the same id (a reopened run) is one row.
 *   - Reward: the run's newest known play-check verdict on the root row
 *     (`solved` → 1, a staged `SCORE` → stages reached / stages), and each
 *     agent's own commits on its `workers/<label>` branch of `deliverables.git`.
 *
 * Every read is of files the run already wrote; nothing in the run dir is
 * changed. Rewards stay unscreened: no realness screen ran on a play-check.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { licenseClassOfName } from '../rollout/license'
import { unscreenedRewardFields } from '../rollout/reward'
import type { RolloutLine } from '../rollout/schema'
import { expandJournalEventGroup } from './journal-event-group'
import { supervisorRunRolloutLinesFromFacts } from './rollout-nodes'
import { readRuntimeSupervisorRun } from './runtime-reader'
import { parseSupervisorTree } from './source-facts'
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
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null
    try {
      row = record(JSON.parse(line))
    } catch {
      continue
    }
    if (row === null) continue
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
      }
    }
  }
  return facts
}

async function blobText(runDir: string, ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined || !/^sha256:[0-9a-f]{64}$/u.test(ref)) return undefined
  const raw = await readFile(join(runDir, 'blobs', `${ref.replace(':', '-')}.json`), 'utf8').catch(
    () => undefined,
  )
  if (raw === undefined) return undefined
  try {
    return text(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export interface PlayCheckReward {
  reward: number
  at: string
  commit: string | null
  detail: string
}

/**
 * The newest play-check row whose verdict is known. A staged check
 * (`SCORE {"reached": r, "of": n}`) earns r/n short of a solve.
 */
export async function discoveryPlayCheckReward(runDir: string): Promise<PlayCheckReward | null> {
  const rows: Record<string, unknown>[] = []
  const lines = await readFile(join(runDir, 'play-checks.jsonl'), 'utf8').catch(() => '')
  for (const line of lines.split('\n')) {
    try {
      const row = record(JSON.parse(line))
      if (row) rows.push(row)
    } catch {}
  }
  if (rows.length === 0) {
    const single = await readFile(join(runDir, 'play-check.json'), 'utf8').catch(() => null)
    try {
      const row = single === null ? null : record(JSON.parse(single))
      if (row) rows.push(row)
    } catch {}
  }
  const known = rows
    .filter((row) => row.known !== false && typeof row.solved === 'boolean')
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  const last = known.at(-1)
  if (last === undefined) return null
  const detail = typeof last.detail === 'string' ? last.detail : ''
  let reward = last.solved === true ? 1 : 0
  const score = /^SCORE (\{.*\})/su.exec(detail)
  if (reward === 0 && score) {
    try {
      const staged = record(JSON.parse(score[1]!))
      const reached = staged?.reached
      const of = staged?.of
      if (typeof reached === 'number' && typeof of === 'number' && of > 0) reward = reached / of
    } catch {}
  }
  return {
    reward,
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
  for (const node of tree.nodes) {
    const fact = facts.get(node.rollout_id) ?? {}
    const producer = fact.model === undefined ? null : producerOf(fact.model)
    const license = licenseClassOfName(producer?.model) ?? licenseClassOfName(producer?.harness)
    const [task, answer] = await Promise.all([
      blobText(runDir, fact.taskRef),
      blobText(runDir, fact.outRef),
    ])
    const label = typeof node.outcome.metrics.label === 'string' ? node.outcome.metrics.label : null
    const isRoot = node.parent_rollout_id === null
    const outcome =
      isRoot && check !== null
        ? {
            ...node.outcome,
            ...unscreenedRewardFields(check.reward),
            reward_source: 'discovery/play-check',
            verdict: { at: check.at, commit: check.commit, detail: check.detail },
          }
        : node.outcome
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
      messages:
        task !== undefined && answer !== undefined
          ? [
              { role: 'user', content: task },
              { role: 'assistant', content: answer },
            ]
          : node.messages,
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
  return { runDir, pursuit, lines, gaps, notes }
}
