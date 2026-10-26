/**
 * Native harness sessions (OpenCode, Kimi, Claude Code, Codex, Pi, Factory) as
 * `tangle.rollout.v1` rows, through @tangle-network/harness-sessions — the one
 * reader of those stores. A session carries no task verdict, so its reward is
 * null and `provenance.gap` says so; a later labeler supplies the reward.
 *
 * The producer comes from the models that answered (`servedModels`), never from
 * the request, and the license class from that model and the harness.
 */

import { stat } from 'node:fs/promises'
import {
  claudeCodeRefForFile,
  codexRefForFile,
  type HarnessSession,
  kimiRefForFile,
  listReaders,
  opencodeSessionsInStore,
  piRefForFile,
  readerFor,
  type SessionRef,
  toChatMessages,
} from '@tangle-network/harness-sessions'
import { licenseClassOf } from '../license'
import { ROLLOUT_SCHEMA, type RolloutLine } from '../schema'

export interface HarnessSessionImportOptions {
  /** Read only this harness (`opencode`, `kimi-code`, `claude-code`, `codex`, …). */
  harness?: string
  /** Only sessions whose store file changed at or after this time (epoch ms). */
  sinceMs?: number
  capturedAt?: string
}

const REF_FOR_FILE: Record<string, (path: string) => SessionRef> = {
  'claude-code': (path) => claudeCodeRefForFile(path, null),
  codex: codexRefForFile,
  'kimi-code': kimiRefForFile,
  pi: piRefForFile,
}

/** Session refs under a HOME or store directory, or in one session file / OpenCode store. */
export async function harnessSessionRefs(
  target: string,
  options: HarnessSessionImportOptions = {},
): Promise<SessionRef[]> {
  const entry = await stat(target)
  let refs: SessionRef[]
  if (entry.isDirectory()) {
    const readers = options.harness ? [readerFor(options.harness)] : listReaders()
    refs = []
    const locate = options.sinceMs === undefined ? {} : { sinceMs: options.sinceMs }
    for (const reader of readers) refs.push(...(await reader.locate(target, locate)))
  } else if (/\.db$/u.test(target)) {
    refs = await opencodeSessionsInStore(target, null, {})
  } else {
    const refFor = options.harness ? REF_FOR_FILE[options.harness] : undefined
    if (refFor === undefined) {
      throw new Error(
        `${target}: pass --harness (${Object.keys(REF_FOR_FILE).join('|')}) for a file`,
      )
    }
    refs = [refFor(target)]
  }
  return options.sinceMs === undefined
    ? refs
    : refs.filter((ref) => ref.mtimeMs >= (options.sinceMs as number))
}

/** The model that answered most calls, split into provider and model. */
function producer(session: HarnessSession): { provider: string | null; model: string | null } {
  const [top] = Object.entries(session.servedModels).sort((a, b) => b[1] - a[1])
  if (top === undefined) return { provider: null, model: null }
  const call = session.modelCalls.find(
    (c) => c.servedModel !== null && top[0].endsWith(c.servedModel),
  )
  const provider = call?.provider ?? null
  const model = call?.servedModel ?? top[0]
  return { provider, model }
}

const sum = (values: Array<number | null>): number | null =>
  values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null

/** One normalized session as a rollout row. */
export function harnessSessionRolloutLine(
  session: HarnessSession,
  ref: SessionRef,
  capturedAt: string = new Date().toISOString(),
): RolloutLine {
  const { provider, model } = producer(session)
  const id = `${session.harness}:${session.nativeSessionId}`
  const startedMs = session.startedAt === null ? null : Date.parse(session.startedAt)
  const endedMs = session.endedAt === null ? null : Date.parse(session.endedAt)
  const line: RolloutLine = {
    schema: ROLLOUT_SCHEMA,
    rollout_id: id,
    parent_rollout_id:
      session.parentNativeSessionId === null
        ? null
        : `${session.harness}:${session.parentNativeSessionId}`,
    run_id: id,
    experiment_id: null,
    candidate_id: null,
    generation: null,
    candidate_index: null,
    role: 'agent',
    task: {
      suite: `harness/${session.harness}`,
      instance_id: session.nativeSessionId,
      split: 'search',
      seed: null,
      rep: 0,
    },
    policy: {
      harness: session.harness,
      harness_version: null,
      model,
      provider,
      profile_commit: null,
      sampling: null,
    },
    messages: toChatMessages(session),
    tool_defs: [],
    outcome: {
      reward: null,
      reward_source: null,
      verdict: null,
      metrics: {
        ending: session.ending.status,
        model_calls: session.modelCalls.length,
        tool_calls: session.toolCalls.length,
        served_models: session.servedModels,
      },
      is_completed: session.ending.status === 'completed',
      is_truncated: ref.truncated === true,
      error: session.ending.error?.message ?? null,
      realness_gated: false,
    },
    cost: {
      usd: sum(session.modelCalls.map((c) => c.costUsd)),
      tokens_in: session.usage?.input ?? null,
      tokens_out: session.usage?.output ?? null,
      tokens_reasoning: session.usage?.reasoning ?? null,
      cache_read: session.usage?.cacheRead ?? null,
      cache_write: session.usage?.cacheWrite ?? null,
      wall_s:
        startedMs !== null && endedMs !== null && endedMs >= startedMs
          ? (endedMs - startedMs) / 1000
          : null,
      llm_call_count: session.modelCalls.length,
    },
    artifacts: { patch_path: null, run_dir: session.cwd, transcript_ref: ref.path },
    provenance: {
      captured_at: capturedAt,
      capture: 'backfill',
      gap: 'imported harness session: no task verdict',
    },
  }
  const license = licenseClassOf(line)
  if (license !== null) line.policy.license_class = license
  return line
}

/** Read each ref in turn; a session its reader refuses is reported, never guessed. */
export async function* harnessSessionRolloutLines(
  refs: readonly SessionRef[],
  capturedAt?: string,
): AsyncGenerator<{ ref: SessionRef; line?: RolloutLine; error?: string }> {
  for (const ref of refs) {
    try {
      const session = await readerFor(ref.harness).read(ref)
      yield { ref, line: harnessSessionRolloutLine(session, ref, capturedAt) }
    } catch (error) {
      yield { ref, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
