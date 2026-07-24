/**
 * The supervision tree as `tangle.rollout.v1` rows.
 *
 * A supervisor run IS a tree of rollouts, so its nodes are not a new shape:
 * the root becomes one `RolloutLine` with `role: 'supervisor'`, every spawned
 * worker becomes a `RolloutLine` with `role: 'worker'` and
 * `parent_rollout_id` pointing at its spawner. The rows append to the same
 * ledger as solo-agent rollouts and join to them with the same keys.
 *
 * What the journal CANNOT supply is the transcript: a worker's messages live
 * in its harness store (opencode sqlite, Claude Code jsonl), which the
 * `src/rollout/readers/*` intake readers own. Rows minted here are therefore
 * GAP lines (`messages: []`, `provenance.gap` set) carrying identity,
 * structure, outcome and cost; hydrating them with messages is the readers'
 * job, keyed on `artifacts.transcript_ref`.
 *
 * Timing lives in `outcome.metrics` (`spawned_at` / `settled_at` / `wall_ms`)
 * rather than a schema field: `tangle.rollout.v1` describes ONE invocation,
 * and the inter-invocation event timeline — which is what waves, concurrency,
 * idle and utilization are computed from — is a property of the journal, not
 * of any single row. The analyzer reads that timeline; these rows carry the
 * per-node facts.
 */

import {
  isRolloutLine,
  ROLLOUT_SCHEMA,
  type RolloutLine,
  type RolloutSplit,
} from '../rollout/schema'
import { asRecord, parseJson, parseSupervisorTree } from './analyze'
import type { SupervisorRunSources, SupervisorRunTree } from './types'

export interface SupervisorRolloutOptions {
  /** Benchmark/suite id for `task.suite`. Defaults to `'supervisor-run'`. */
  readonly suite?: string
  /** `task.split`. Defaults to `'search'` (the trainable pool). */
  readonly split?: RolloutSplit
  /** Replicate index. Defaults to 0. */
  readonly rep?: number
  /** Sampling seed the campaign pinned. Defaults to null (not recorded). */
  readonly seed?: number | null
  /** `run_id` for every node. Defaults to the supervisor root id, else `runRef`. */
  readonly runId?: string
  /** Harness that drove the supervisor. */
  readonly supervisorHarness?: string | null
  /** Harness that drove the workers. */
  readonly workerHarness?: string | null
  /** Model the supervisor ran on. */
  readonly supervisorModel?: string | null
  /** Model the workers ran on. */
  readonly workerModel?: string | null
  readonly experimentId?: string | null
  readonly candidateId?: string | null
  readonly generation?: number | null
  readonly candidateIndex?: number | null
  /** Pins `provenance.captured_at`; defaults to now. */
  readonly capturedAt?: string
}

const EMPTY_COST = {
  usd: null,
  tokens_in: null,
  tokens_out: null,
  tokens_reasoning: null,
  cache_read: null,
  cache_write: null,
  wall_s: null,
} as const

/**
 * Mint the supervision tree as rollout rows. Returns the rows plus the gaps
 * that made any of them incomplete — same unavailable-vs-zero discipline as
 * the report: a row with no transcript says WHY, it never pretends to be empty.
 */
export function supervisorRunRolloutLines(
  src: SupervisorRunSources,
  opts: SupervisorRolloutOptions = {},
): SupervisorRunTree {
  const gaps: string[] = []
  const tree = parseSupervisorTree(src)
  if (src.journal === null) {
    gaps.push(
      `tree: ${src.supRunDir === null ? 'no supervisor run dir' : 'journal absent'} — no nodes recoverable`,
    )
    return { rootId: null, nodes: [], gaps }
  }

  const state = parseJson(src.state)
  const result = parseJson(src.result)
  const judge = parseJson(src.judge)
  const stateResult = asRecord(state?.result)

  const rootId = tree.rootId
  const runId = opts.runId ?? rootId ?? src.runRef
  const suite = opts.suite ?? 'supervisor-run'
  const instanceId = src.instanceId ?? src.runRef
  const split: RolloutSplit = opts.split ?? 'search'
  const capturedAt = opts.capturedAt ?? new Date().toISOString()

  const base = {
    schema: ROLLOUT_SCHEMA,
    run_id: runId,
    experiment_id: opts.experimentId ?? null,
    candidate_id: opts.candidateId ?? null,
    generation: opts.generation ?? null,
    candidate_index: opts.candidateIndex ?? null,
    task: {
      suite,
      instance_id: instanceId,
      split,
      seed: opts.seed ?? null,
      rep: opts.rep ?? 0,
    },
    messages: [] as RolloutLine['messages'],
    tool_defs: [] as RolloutLine['tool_defs'],
  } satisfies Partial<RolloutLine> & Record<string, unknown>

  const nodes: RolloutLine[] = []

  // ── root: the supervisor invocation ────────────────────────────────────
  if (rootId !== null) {
    const judgeResolved = typeof judge?.resolved === 'boolean' ? judge.resolved : null
    const judgeScore = typeof judge?.score === 'number' ? judge.score : null
    const reward = judgeScore ?? (judgeResolved === null ? null : judgeResolved ? 1 : 0)
    if (reward === null) gaps.push('root.outcome.reward: no judge verdict for this run')
    const wallMs =
      tree.startedAt !== null && tree.completedAt !== null && tree.completedAt >= tree.startedAt
        ? tree.completedAt - tree.startedAt
        : null
    nodes.push({
      ...base,
      rollout_id: rootId,
      parent_rollout_id: null,
      role: 'supervisor',
      policy: {
        harness: opts.supervisorHarness ?? null,
        harness_version: null,
        model: opts.supervisorModel ?? null,
        provider: null,
        profile_commit: null,
        sampling: null,
      },
      outcome: {
        reward,
        reward_source: src.judgeSource,
        verdict: judge ?? null,
        metrics: {
          arm: src.arm,
          sup_status: typeof state?.status === 'string' ? state.status : null,
          sup_verdict: typeof state?.verdict === 'string' ? state.verdict : null,
          delivered: typeof stateResult.delivered === 'boolean' ? stateResult.delivered : null,
          verify_pass: typeof result?.verify_pass === 'boolean' ? result.verify_pass : null,
          started_at: tree.startedAt,
          completed_at: tree.completedAt,
          workers_spawned: tree.workerSpawns.length,
          brain_metered_events: tree.brain.meteredCount,
        },
        is_completed: state?.status === 'completed',
        is_truncated: false,
        error: null,
      },
      cost: {
        ...EMPTY_COST,
        usd: typeof stateResult.spentUsd === 'number' ? stateResult.spentUsd : tree.brain.usd,
        tokens_in: tree.brain.tokensIn,
        tokens_out: tree.brain.tokensOut,
        wall_s: wallMs === null ? null : wallMs / 1000,
      },
      artifacts: {
        patch_path: typeof result?.patchPath === 'string' ? result.patchPath : null,
        run_dir: src.supRunDir,
        transcript_ref: src.supRunDir === null ? null : `${src.supRunDir}/journal.jsonl`,
      },
      provenance: {
        captured_at: capturedAt,
        capture: 'backfill',
        gap: 'supervision journal carries structure and spend, not the brain transcript',
      },
    })
  } else {
    gaps.push('tree.root: no parentless `spawned` event in the journal')
  }

  // ── workers: one node per spawn, keyed to its spawner ───────────────────
  const closeById = new Map(tree.closes.map((c) => [c.id, c]))
  // Worker logs are keyed by label, the journal by id — the label is the only
  // join available. A repeated label is a literal retry of the same subtask, so
  // both attempts see the same log facts; the journal ids keep them distinct
  // rows and `outcome.metrics.spawned_at` separates the attempts.
  for (const spawn of tree.workerSpawns) {
    const close = closeById.get(spawn.id) ?? null
    const facts = tree.workerLogs.get(spawn.label) ?? null
    const wallMs =
      facts?.started != null && facts.finishedAt != null ? facts.finishedAt - facts.started : null
    const reward = facts?.passed === null || facts === null ? null : facts.passed ? 1 : 0
    if (reward === null) {
      gaps.push(`worker ${spawn.label}: no verify verdict (worker logs absent or unfinished)`)
    }
    nodes.push({
      ...base,
      rollout_id: spawn.id,
      parent_rollout_id: spawn.parent,
      role: 'worker',
      policy: {
        harness: opts.workerHarness ?? null,
        harness_version: null,
        model: opts.workerModel ?? null,
        provider: null,
        profile_commit: null,
        sampling: null,
      },
      outcome: {
        reward,
        reward_source: reward === null ? null : 'worker-self-verify',
        verdict:
          close === null
            ? null
            : { kind: close.kind, status: close.status, verdict: close.verdict },
        metrics: {
          label: spawn.label,
          spawned_at: spawn.at,
          settled_at: close?.at ?? null,
          started_at: facts?.started ?? null,
          finished_at: facts?.finishedAt ?? null,
          wall_ms: wallMs,
          patch_bytes: facts?.finishedPatchBytes ?? null,
          evidence_bytes: facts?.evidenceBytes ?? null,
          steers_queued: facts?.steersQueued ?? null,
          steers_delivered: facts?.steersDelivered ?? null,
          questions: facts?.questions ?? null,
        },
        is_completed: close?.kind === 'settled',
        is_truncated: close?.kind === 'cancelled',
        error: close?.kind === 'cancelled' ? (close.verdict ?? 'cancelled') : null,
      },
      cost: {
        ...EMPTY_COST,
        usd: close?.spend.usd ?? null,
        tokens_in: close?.spend.tokens.input ?? null,
        tokens_out: close?.spend.tokens.output ?? null,
        wall_s: wallMs === null ? null : wallMs / 1000,
      },
      artifacts: {
        patch_path: src.supRunDir === null ? null : `${src.supRunDir}/workers/${spawn.label}.patch`,
        run_dir: src.supRunDir,
        transcript_ref:
          src.supRunDir === null ? null : `${src.supRunDir}/workers/${spawn.label}.ndjson`,
      },
      provenance: {
        captured_at: capturedAt,
        capture: 'backfill',
        gap: 'worker transcript lives in the harness session store — hydrate via src/rollout/readers',
      },
    })
  }

  const invalid = nodes.filter((n) => !isRolloutLine(n))
  if (invalid.length > 0) {
    gaps.push(`${invalid.length} node(s) failed tangle.rollout.v1 validation`)
  }
  return { rootId, nodes, gaps }
}
