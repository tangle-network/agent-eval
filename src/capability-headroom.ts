/**
 * Capability-headroom gate — "can this task set even SEE the capability
 * you're about to A/B?"
 *
 * A capability A/B (grant one arm a tool, a skill, extra context — anything)
 * can only detect the capability on tasks the capability-ABSENT baseline
 * FAILS. A task the baseline already passes is saturated: the treatment arm
 * has no headroom to demonstrate anything, and averaging saturated tasks into
 * the comparison dilutes a real effect toward a false null. Calibrate before
 * measuring: run the baseline arm first, classify every task's headroom, and
 * refuse to run the comparison when no task has a gap.
 *
 * Fail-closed on unknown outcomes: a baseline run whose outcome could not be
 * determined (infra loss, unverified, missing) NEVER counts as a failure —
 * treating "couldn't tell" as "failed" would manufacture headroom out of
 * telemetry gaps and launder infra noise into a treatment effect.
 *
 * Domain-free by construction: the capability under test never appears here.
 * Callers decide what the baseline arm lacks; this module only classifies
 * baseline outcomes per task.
 */

import { ValidationError } from './errors'

/** One baseline-arm (capability-absent) observation of one task. */
export interface HeadroomInput {
  /** Stable task identity; multiple rows per task are multiple baseline reps. */
  taskId: string
  /** Baseline outcome. 'unknown' = the outcome could not be determined —
   *  distinct from 'fail' and never counted as one. */
  baselineOutcome: 'pass' | 'fail' | 'unknown'
}

/** Headroom classification for one task.
 *  - 'gap': the baseline fails it — the comparison can see the capability here.
 *  - 'saturated': the baseline already passes it — no headroom.
 *  - 'unknown': every baseline outcome is unknown — fail-closed, not a gap. */
export type HeadroomClass = 'gap' | 'saturated' | 'unknown'

export interface TaskHeadroom {
  taskId: string
  /** Total baseline observations for this task (known + unknown). */
  n: number
  /** Observations with a known ('pass' | 'fail') outcome — the evidence the
   *  classification actually rests on. A large `n` with a small `nKnown`
   *  means the headroom verdict is thin, not well-replicated. */
  nKnown: number
  /** Pass rate over KNOWN outcomes only; NaN when every outcome is unknown
   *  (no data ≠ measured zero). */
  baselinePassRate: number
  headroom: HeadroomClass
}

export interface CapabilityHeadroomOptions {
  /** A task counts as 'gap' when its baseline pass rate is ≤ this. Default 0
   *  (the baseline must fail every known rep). Must be in [0, 1) — a
   *  threshold of 1 would classify a fully-saturated task as a gap. */
  keepThreshold?: number
}

export interface CapabilityHeadroomResult {
  /** Per-task classification, sorted by `taskId`. */
  tasks: TaskHeadroom[]
  summary: {
    tasksWithGap: number
    tasksSaturated: number
    tasksUnknown: number
    /** Total unknown-outcome reps across ALL tasks (including tasks that
     *  still classified via their known reps) — the size of the telemetry
     *  hole behind the classifications. */
    repsUnknown: number
  }
}

/**
 * Classify every task's baseline headroom from capability-absent baseline
 * outcomes.
 *
 * A task is 'gap' when it has ≥ 1 known outcome and its pass rate over known
 * outcomes is ≤ `keepThreshold`; 'saturated' when the rate exceeds the
 * threshold; 'unknown' when every outcome is unknown. Unknown reps never
 * count toward the rate in either direction (fail-closed — see the module
 * doc), and evidence strength stays visible: each task reports `nKnown`
 * alongside `n`, and the summary totals the unknown reps in `repsUnknown`.
 * Throws on empty input, an out-of-range `keepThreshold`, or an
 * unrecognized outcome value (rows are often projected from untyped records).
 */
export function capabilityHeadroom(
  rows: readonly HeadroomInput[],
  opts: CapabilityHeadroomOptions = {},
): CapabilityHeadroomResult {
  const keepThreshold = opts.keepThreshold ?? 0
  if (!Number.isFinite(keepThreshold) || keepThreshold < 0 || keepThreshold >= 1) {
    throw new ValidationError(
      `capabilityHeadroom: keepThreshold must be in [0, 1), got ${keepThreshold}`,
    )
  }
  if (rows.length === 0) {
    throw new ValidationError(
      'capabilityHeadroom: no baseline rows supplied — run the capability-absent baseline arm first',
    )
  }

  // taskId → { n, passes, known }
  const byTask = new Map<string, { n: number; passes: number; known: number }>()
  for (const row of rows) {
    if (
      row.baselineOutcome !== 'pass' &&
      row.baselineOutcome !== 'fail' &&
      row.baselineOutcome !== 'unknown'
    ) {
      throw new ValidationError(
        `capabilityHeadroom: unrecognized baselineOutcome '${row.baselineOutcome}' for task '${row.taskId}' (expected 'pass' | 'fail' | 'unknown')`,
      )
    }
    const agg = byTask.get(row.taskId) ?? { n: 0, passes: 0, known: 0 }
    agg.n++
    if (row.baselineOutcome !== 'unknown') {
      agg.known++
      if (row.baselineOutcome === 'pass') agg.passes++
    }
    byTask.set(row.taskId, agg)
  }

  const tasks: TaskHeadroom[] = [...byTask.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([taskId, agg]) => {
      if (agg.known === 0) {
        return {
          taskId,
          n: agg.n,
          nKnown: 0,
          baselinePassRate: Number.NaN,
          headroom: 'unknown' as const,
        }
      }
      const baselinePassRate = agg.passes / agg.known
      return {
        taskId,
        n: agg.n,
        nKnown: agg.known,
        baselinePassRate,
        headroom: baselinePassRate <= keepThreshold ? ('gap' as const) : ('saturated' as const),
      }
    })

  const summary = {
    tasksWithGap: tasks.filter((t) => t.headroom === 'gap').length,
    tasksSaturated: tasks.filter((t) => t.headroom === 'saturated').length,
    tasksUnknown: tasks.filter((t) => t.headroom === 'unknown').length,
    repsUnknown: tasks.reduce((sum, t) => sum + (t.n - t.nKnown), 0),
  }
  return { tasks, summary }
}

export interface AssertCapabilityHeadroomOptions {
  /** Minimum tasks classified 'gap' for the comparison to proceed. Default 1. */
  minTasksWithGap?: number
}

/**
 * The go/no-go guard: throws when fewer than `minTasksWithGap` tasks have
 * baseline headroom — i.e. the benchmark cannot see the capability, so any
 * comparison run on it would measure noise. Call between the baseline
 * calibration run and the treatment run.
 */
export function assertCapabilityHeadroom(
  result: CapabilityHeadroomResult,
  opts: AssertCapabilityHeadroomOptions = {},
): void {
  const minTasksWithGap = opts.minTasksWithGap ?? 1
  if (!Number.isInteger(minTasksWithGap) || minTasksWithGap < 1) {
    throw new ValidationError(
      `assertCapabilityHeadroom: minTasksWithGap must be an integer ≥ 1, got ${minTasksWithGap}`,
    )
  }
  const { tasksWithGap, tasksSaturated, tasksUnknown } = result.summary
  if (tasksWithGap < minTasksWithGap) {
    const total = result.tasks.length
    throw new ValidationError(
      `assertCapabilityHeadroom: only ${tasksWithGap} of ${total} task(s) have baseline headroom ` +
        `(need ≥ ${minTasksWithGap}). ${tasksSaturated} saturated (baseline already passes), ` +
        `${tasksUnknown} unknown (no determinable baseline outcome). A capability A/B on this ` +
        `task set cannot detect the capability — add tasks the baseline fails, or fix baseline ` +
        `outcome capture, before measuring.`,
    )
  }
}
