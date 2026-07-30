/**
 * The supervision tree as `tangle.rollout.v1` rows.
 *
 * A supervisor run IS a tree of rollouts, so its nodes are not a new shape:
 * the root becomes one `RolloutLine` with `role: 'supervisor'`, and every
 * spawned invocation keeps its explicit supervisor/worker role with
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

import { unscreenedRewardFields } from '../rollout/reward'
import {
  isRolloutLine,
  ROLLOUT_SCHEMA,
  type RolloutLine,
  type RolloutSplit,
} from '../rollout/schema'
import { asRecord, parseJson, parseSupervisorTree, type SupervisorTreeFacts } from './source-facts'
import type {
  SupervisorRunSources,
  SupervisorRunTree,
  SupervisorRunTreeGap,
  WorkerLogSource,
} from './types'

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

function hasWorkerId(
  worker: WorkerLogSource,
): worker is WorkerLogSource & { readonly workerId: string } {
  return worker.workerId !== undefined
}

/**
 * Mint the supervision tree as rollout rows. Returns the rows plus the gaps
 * that made any of them incomplete — same unavailable-vs-zero discipline as
 * the report: a row with no transcript says WHY, it never pretends to be empty.
 */
export function supervisorRunRolloutLines(
  src: SupervisorRunSources,
  opts: SupervisorRolloutOptions = {},
): SupervisorRunTree {
  return supervisorRunRolloutLinesFromFacts(src, parseSupervisorTree(src), opts)
}

/** Mint rollout rows from an already parsed source without reading its JSONL again. */
export function supervisorRunRolloutLinesFromFacts(
  src: SupervisorRunSources,
  tree: SupervisorTreeFacts,
  opts: SupervisorRolloutOptions = {},
): SupervisorRunTree {
  const gaps: SupervisorRunTreeGap[] = []
  if (src.journal === null) {
    gaps.push({
      code: 'journal-unavailable',
      message: `${src.supRunDir === null ? 'no supervisor run dir' : 'journal absent'}; no nodes recoverable`,
    })
    return { rootId: null, nodes: [], gaps }
  }
  const malformedSourceRows =
    tree.journalInvalidRows + tree.spawns.filter((spawn) => !spawn.valid).length
  if (malformedSourceRows > 0) {
    gaps.push({
      code: 'source-row-malformed',
      message: `${malformedSourceRows} malformed journal row(s) were excluded from the tree`,
      count: malformedSourceRows,
    })
  }

  const state = tree.state
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
    const rootSpawn = tree.spawns.find((spawn) => spawn.valid && spawn.id === rootId)
    const judgeResolved = typeof judge?.resolved === 'boolean' ? judge.resolved : null
    const judgeScore = typeof judge?.score === 'number' ? judge.score : null
    const reward = judgeScore ?? (judgeResolved === null ? null : judgeResolved ? 1 : 0)
    if (reward === null) {
      gaps.push({
        code: 'root-reward-unavailable',
        message: 'no judge verdict for this run',
        nodeId: rootId,
      })
    }
    const wallMs =
      tree.startedAt !== null && tree.completedAt !== null && tree.completedAt >= tree.startedAt
        ? tree.completedAt - tree.startedAt
        : null
    nodes.push({
      ...base,
      rollout_id: rootId,
      parent_rollout_id: null,
      role: rootSpawn?.role ?? 'supervisor',
      policy: {
        harness: opts.supervisorHarness ?? null,
        harness_version: null,
        model: opts.supervisorModel ?? null,
        provider: null,
        profile_commit: null,
        sampling: null,
      },
      outcome: {
        // `reward` and `realness_gated` are written by one call, in the module
        // that owns the gate. This is the SECOND producer of rollout rewards —
        // the judge verdict in the supervision run dir, not `mintRolloutRows` —
        // and it wrote `reward` by hand while never stating the flag, so
        // `isLineRealnessGated` was structurally false for every supervisor and
        // worker row ever emitted here. `unscreenedRewardFields` is the honest
        // name for what this producer can claim: a supervision journal carries
        // no `RunRecord.outcome.realness`, so no authenticity gate has run on
        // this score, and `realness_gated: false` states that rather than
        // implying it by omission. These rows stay plain `RolloutLine`s, so a
        // caller feeding them to a training exporter must `assertMinted` first.
        ...unscreenedRewardFields(reward),
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
        realness_gated: false,
      },
      cost: {
        ...EMPTY_COST,
        usd:
          src.limits.spendUsd !== null
            ? null
            : typeof stateResult.spentUsd === 'number'
              ? stateResult.spentUsd
              : tree.brain.usd,
        tokens_in: src.limits.managerTokens === null ? tree.brain.tokensIn : null,
        tokens_out: src.limits.managerTokens === null ? tree.brain.tokensOut : null,
        cache_read:
          src.limits.managerTokens === null && tree.brain.hasCache ? tree.brain.cacheRead : null,
        cache_write:
          src.limits.managerTokens === null && tree.brain.hasCache ? tree.brain.cacheWrite : null,
        wall_s: wallMs === null ? null : wallMs / 1000,
      },
      artifacts: {
        patch_path: typeof result?.patchPath === 'string' ? result.patchPath : null,
        run_dir: src.supRunDir,
        transcript_ref:
          src.rootTranscriptRef !== undefined
            ? src.rootTranscriptRef
            : src.supRunDir === null
              ? null
              : `${src.supRunDir}/journal.jsonl`,
      },
      provenance: {
        captured_at: capturedAt,
        capture: 'backfill',
        gap: 'supervision journal carries structure and spend, not the brain transcript',
      },
    })
  } else {
    gaps.push({
      code: 'root-spawn-unavailable',
      message: 'no parentless spawned event in the journal',
    })
  }

  // ── workers: one node per spawn, keyed to its spawner ───────────────────
  const closeById = new Map(tree.closes.map((c) => [c.id, c]))
  const sourceById = new Map(
    (src.workers ?? []).filter(hasWorkerId).map((worker) => [worker.workerId, worker]),
  )
  const fallbackSourceByLabel = new Map(
    (src.workers ?? [])
      .filter((worker) => worker.workerId === undefined)
      .map((worker) => [worker.label, worker]),
  )
  // Stable ids are authoritative. Labels are a compatibility join for stores
  // that predate workerId and are only safe when the store keeps them unique.
  for (const spawn of tree.workerSpawns) {
    const close = closeById.get(spawn.id) ?? null
    const workerSource = sourceById.get(spawn.id) ?? fallbackSourceByLabel.get(spawn.label) ?? null
    const facts =
      tree.workerLogs.get(workerSource?.workerId ?? workerSource?.label ?? spawn.label) ?? null
    const wallMs =
      facts?.started != null && facts.finishedAt != null ? facts.finishedAt - facts.started : null
    const score = close?.score ?? facts?.score ?? null
    const passed = close?.valid ?? facts?.passed ?? null
    const reward = score ?? (passed === null ? null : passed ? 1 : 0)
    if (reward === null) {
      gaps.push({
        code: 'child-reward-unavailable',
        message: `child ${JSON.stringify(spawn.label)} has no verify verdict`,
        nodeId: spawn.id,
      })
    }
    const isSupervisor = spawn.role === 'supervisor'
    nodes.push({
      ...base,
      rollout_id: spawn.id,
      parent_rollout_id: spawn.parent,
      role: spawn.role,
      policy: {
        harness: isSupervisor ? (opts.supervisorHarness ?? null) : (opts.workerHarness ?? null),
        harness_version: null,
        model: isSupervisor ? (opts.supervisorModel ?? null) : (opts.workerModel ?? null),
        provider: null,
        profile_commit: null,
        sampling: null,
      },
      outcome: {
        // Same producer, same claim: a child reward is a self-verify verdict
        // from the journal that no realness gate has seen.
        ...unscreenedRewardFields(reward),
        reward_source:
          reward === null ? null : score === null ? 'worker-self-verify' : 'worker-verdict-score',
        verdict:
          close === null
            ? null
            : {
                kind: close.kind,
                status: close.status,
                verdict: close.rawVerdict,
                valid: close.valid,
                score: close.score,
              },
        metrics: {
          label: spawn.label,
          spawned_at: spawn.at,
          settled_at: close?.at ?? null,
          started_at: facts?.started ?? null,
          finished_at: facts?.finishedAt ?? null,
          wall_ms: wallMs,
          patch_bytes: workerSource?.patchBytes ?? facts?.finishedPatchBytes ?? null,
          evidence_bytes: facts?.evidenceBytes ?? null,
          steers_queued: facts?.steersQueued ?? null,
          steers_delivered: facts?.steersDelivered ?? null,
          questions: facts?.questions ?? null,
        },
        is_completed: close?.kind === 'settled',
        is_truncated: close?.kind === 'cancelled',
        error: close?.kind === 'cancelled' ? (close.verdict ?? 'cancelled') : null,
        realness_gated: false,
      },
      // `close.spend` is only a measurement when the close event carried one;
      // a store that never priced this worker must leave null, not 0.
      cost: {
        ...EMPTY_COST,
        usd: src.limits.spendUsd !== null || !close?.hasSpend ? null : close.spend.usd,
        tokens_in: workerSource?.tokensIn ?? (close?.hasSpend ? close.spend.tokens.input : null),
        tokens_out: workerSource?.tokensOut ?? (close?.hasSpend ? close.spend.tokens.output : null),
        // Mirror the tokens_in/out journal fallback so a loops-shaped store whose
        // `settled` spend carries cache counters is not reported as null cache
        // beside real tokens. Gate on `hasCache` — a spend object without cache
        // counters must stay null, not a fabricated 0.
        cache_read:
          workerSource?.cacheRead ??
          (close?.hasSpend && close.spend.tokens.hasCache ? close.spend.tokens.cacheRead : null),
        cache_write:
          workerSource?.cacheWrite ??
          (close?.hasSpend && close.spend.tokens.hasCache ? close.spend.tokens.cacheWrite : null),
        wall_s: wallMs === null ? null : wallMs / 1000,
      },
      // A reader that knows where its worker artifacts live says so; only the
      // loops layout is derivable from `supRunDir`, so guessing it for another
      // store would mint rows pointing at paths that never existed.
      artifacts: {
        patch_path:
          workerSource?.patchPath !== undefined
            ? workerSource.patchPath
            : src.supRunDir === null
              ? null
              : `${src.supRunDir}/workers/${spawn.label}.patch`,
        run_dir: src.supRunDir,
        transcript_ref:
          workerSource?.transcriptRef !== undefined
            ? workerSource.transcriptRef
            : src.supRunDir === null
              ? null
              : `${src.supRunDir}/workers/${spawn.label}.ndjson`,
      },
      provenance: {
        captured_at: capturedAt,
        capture: 'backfill',
        gap:
          workerSource?.transcriptRef == null
            ? 'worker transcript lives in the harness session store — hydrate via src/rollout/readers'
            : 'worker transcript recorded by the harness; messages not inlined into this row',
      },
    })
  }

  const invalid = nodes.filter((n) => !isRolloutLine(n))
  if (invalid.length > 0) {
    gaps.push({
      code: 'node-schema-invalid',
      message: `${invalid.length} node(s) failed tangle.rollout.v1 validation`,
      count: invalid.length,
    })
  }
  return { rootId, nodes, gaps }
}
