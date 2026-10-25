/**
 * `beelink-gate` receipts (`~/.local/state/beelink-gate/receipts.jsonl`) as
 * verifiable labels: one `judge` row per gated (repo, head SHA, command), with
 * reward 1 for exit 0 and 0 for any other recorded exit. A gate that did not
 * run its command to a verdict — exit 75 (TEMPFAIL), a timeout, the watchdog —
 * labels nothing and is skipped. The row carries no transcript; it labels the
 * commit, and joins to the sessions that produced it by `task.instance_id`.
 */

import { readFile } from 'node:fs/promises'
import { ROLLOUT_SCHEMA, type RolloutLine } from '../schema'

const TEMPFAIL = 75

export async function gateReceiptRolloutLines(
  path: string,
  capturedAt: string = new Date().toISOString(),
): Promise<{ lines: RolloutLine[]; skipped: number }> {
  const lines: RolloutLine[] = []
  let skipped = 0
  for (const raw of (await readFile(path, 'utf8')).split('\n')) {
    if (!raw.trim()) continue
    let r: Record<string, unknown>
    try {
      r = JSON.parse(raw)
    } catch {
      skipped += 1
      continue
    }
    const { repo, sha, exit, gate_id: gateId } = r
    if (
      typeof repo !== 'string' ||
      typeof sha !== 'string' ||
      !/^[0-9a-f]{40}$/u.test(sha) ||
      typeof exit !== 'number' ||
      exit === TEMPFAIL ||
      r.timed_out === true ||
      r.watchdog === true
    ) {
      skipped += 1
      continue
    }
    const id = typeof gateId === 'string' ? `beelink-gate:${gateId}` : `beelink-gate:${sha}:${r.at}`
    lines.push({
      schema: ROLLOUT_SCHEMA,
      rollout_id: id,
      parent_rollout_id: null,
      run_id: id,
      experiment_id: null,
      candidate_id: null,
      generation: null,
      candidate_index: null,
      role: 'judge',
      task: {
        suite: `beelink-gate/${repo}`,
        instance_id: sha,
        split: 'search',
        seed: null,
        rep: 0,
      },
      policy: {
        harness: 'beelink-gate',
        harness_version: null,
        model: null,
        provider: null,
        profile_commit: sha,
        sampling: null,
      },
      messages: [],
      tool_defs: [],
      outcome: {
        reward: exit === 0 ? 1 : 0,
        reward_source: 'beelink-gate/exit',
        verdict: {
          exit,
          command: r.command ?? null,
          mode: r.mode ?? null,
          class: r.class ?? null,
          pr_number: r.pr_number ?? null,
          base_sha: r.base_sha ?? null,
          lane: r.lane ?? null,
          host: r.host ?? null,
          at: r.at ?? null,
        },
        metrics: {},
        is_completed: true,
        is_truncated: false,
        error: null,
        realness_gated: false,
        realness_screened: false,
      },
      cost: {
        usd: null,
        tokens_in: null,
        tokens_out: null,
        tokens_reasoning: null,
        cache_read: null,
        cache_write: null,
        wall_s: typeof r.ran_s === 'number' ? r.ran_s : null,
      },
      artifacts: { patch_path: null, run_dir: null, transcript_ref: null },
      provenance: {
        captured_at: capturedAt,
        capture: 'backfill',
        gap: `gate receipt: verifiable label for ${repo}@${sha}; no transcript`,
      },
    })
  }
  return { lines, skipped }
}
