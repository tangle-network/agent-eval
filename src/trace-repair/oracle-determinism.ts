/**
 * Whether a task's own grader is a function of the container state.
 *
 * A repair benchmark uses the task's held-out suite as ground truth: the suite
 * says the state before the intervention fails and the state after it passes,
 * and the difference is the measurement. That reading needs the suite to answer
 * the same way twice on the same bytes. A suite that asserts on wall clock does
 * not: the same container passes or fails by chance, so a control arm can
 * "rescue" a row nothing touched, and an intervention arm can lose a repair it
 * made.
 *
 * The check is direct. Grade the same container N times with nothing written
 * between the runs, pool the replicates by the state they graded, and read the
 * minority share.
 *
 * It reads that share per ASSERTION, not per suite, wherever the suite reports
 * assertions. A pass/fail reward is a conjunction over many assertions, so a
 * suite whose timing assertions each flip independently can still return the
 * same reward on every replicate of a state that sits far from the threshold —
 * and then return a coin flip on the states a campaign actually grades, which
 * sit near it. Per-assertion counting sees the flip at the anchor; reward
 * counting does not. A state whose replicates carried no assertion report falls
 * back to the reward and records that it did, so a coarser measurement is
 * visible rather than assumed equivalent.
 *
 * Replicates are also run under machine contention, because unanimity on an
 * idle box proves nothing about a threshold the load never approached.
 * Replicates on one state pool across both loads, so a verdict that moves when
 * the machine gets busy reads as the flip it is.
 */

import { CaptureIntegrityError, ValidationError } from '../errors'

/** A task graded a repair by something other than the state under test. */
export class NondeterministicOracleError extends CaptureIntegrityError {}

/** The two states certification produces: the published image, and that image
 *  after the task's own reference solution ran. */
export type OracleStateLabel = 'unsolved' | 'solved'

/** Machine load the replicate ran under. */
export type OracleLoad = 'idle' | 'contended'

/** The unit a whole-suite verdict is counted under when nothing finer exists. */
export const SUITE_REWARD_UNIT = 'suite-reward'

export interface OracleAssertionResult {
  /** Test identifier the suite reported, verbatim. */
  readonly id: string
  readonly passed: boolean
}

export interface OracleReplicate {
  /** 0-based index within its group. */
  readonly index: number
  /**
   * Raw reward the task's grader wrote, verbatim. `null` when it wrote none —
   * a missing reward and a zero reward are different failures, and neither is
   * folded into the other.
   */
  readonly reward: string | null
  readonly passed: boolean
  readonly wallMs: number
  /** Per-assertion verdicts the suite reported, or `null` when it reported
   *  none. Never an empty array standing in for "the suite said nothing". */
  readonly assertions: readonly OracleAssertionResult[] | null
}

export interface OracleReplicateGroup {
  readonly state: OracleStateLabel
  readonly load: OracleLoad
  /**
   * Replicates that graded one container with nothing written between them.
   * Two or more, because a single grading measures no flip.
   */
  readonly replicates: readonly OracleReplicate[]
}

export interface OracleDeterminismEvidence {
  readonly taskName: string
  /** Image the replicates ran on, by registry manifest digest. An image with no
   *  published digest, such as one loaded from an archive, records its tag; the
   *  absent `@sha256:` is what says so. */
  readonly image: string
  /**
   * Digest of the suite bytes every replicate graded against, in whatever
   * scheme the measuring tool uses. Provenance only: it identifies the suite a
   * certification is about and is never compared against a digest produced by
   * a different scheme.
   */
  readonly suiteDigest: string
  readonly groups: readonly OracleReplicateGroup[]
  readonly measuredAt: string
}

/** One thing that did not agree with itself across replicates of a state. */
export interface OracleFlippedUnit {
  /** An assertion id, or `suite-reward` when the suite reported no assertions. */
  readonly unit: string
  readonly passes: number
  readonly fails: number
  readonly flipRate: number
}

export interface OracleStateVerdict {
  readonly state: OracleStateLabel
  readonly replicates: number
  /** Replicates whose whole-suite reward passed. */
  readonly passes: number
  readonly fails: number
  /** What the flip rate was counted over. `reward` is the coarser reading. */
  readonly granularity: 'per-assertion' | 'reward'
  /** Largest minority share over the counted units. */
  readonly flipRate: number
  readonly flipped: readonly OracleFlippedUnit[]
  /** Assertion ids some replicates reported and others did not. The suite's
   *  own shape moved, which is a flip in itself. */
  readonly assertionSetUnstable: readonly string[]
  /** Loads whose whole-suite pass rate on this state differed. */
  readonly loadSensitive: boolean
  /** Every distinct raw reward the grader wrote, sorted. */
  readonly rewardsObserved: readonly string[]
}

export interface OracleDeterminismVerdict {
  readonly taskName: string
  readonly image: string
  readonly suiteDigest: string
  /** True only when every counted unit agreed with itself on every state. */
  readonly stable: boolean
  readonly replicates: number
  /** Largest per-unit minority share over every state. Zero on a stable task. */
  readonly flipRate: number
  readonly byState: readonly OracleStateVerdict[]
  readonly measuredAt: string
  /** One line naming what was measured, for an artifact a human reads. */
  readonly detail: string
}

/** Replicates one group needs before a flip is measurable at all. */
const MIN_ORACLE_REPLICATES = 2

/**
 * Reduce measured replicates to a verdict.
 *
 * Pure: it opens no container. The tool that runs the replicates hands the
 * counts here, so the rule that decides stability is one rule and a reviewer
 * can re-derive any verdict from the recorded replicates.
 */
export function oracleDeterminism(evidence: OracleDeterminismEvidence): OracleDeterminismVerdict {
  if (evidence.groups.length === 0) {
    throw new ValidationError(
      `oracle determinism for ${evidence.taskName} received no replicate group`,
    )
  }
  for (const group of evidence.groups) {
    if (group.replicates.length < MIN_ORACLE_REPLICATES) {
      throw new ValidationError(
        `oracle determinism for ${evidence.taskName} received ${group.replicates.length} ` +
          `${group.load} replicate(s) on the ${group.state} state; ${MIN_ORACLE_REPLICATES} are ` +
          'needed before a flip can be observed',
      )
    }
  }

  const byState: OracleStateVerdict[] = []
  for (const state of ['unsolved', 'solved'] as const) {
    const groups = evidence.groups.filter((group) => group.state === state)
    if (groups.length === 0) continue
    byState.push(stateVerdict(state, groups))
  }

  const flipRate = byState.reduce((worst, state) => Math.max(worst, state.flipRate), 0)
  const replicates = byState.reduce((total, state) => total + state.replicates, 0)
  return {
    taskName: evidence.taskName,
    image: evidence.image,
    suiteDigest: evidence.suiteDigest,
    stable: flipRate === 0,
    replicates,
    flipRate,
    byState,
    measuredAt: evidence.measuredAt,
    detail: byState.map(describeState).join('; '),
  }
}

function stateVerdict(
  state: OracleStateLabel,
  groups: readonly OracleReplicateGroup[],
): OracleStateVerdict {
  const replicates = groups.flatMap((group) => [...group.replicates])
  const passes = replicates.filter((replicate) => replicate.passed).length
  const rates = groups.map(
    (group) => group.replicates.filter((r) => r.passed).length / group.replicates.length,
  )

  // Per-assertion counting needs every replicate to have reported assertions.
  // One replicate that did not makes the finer reading unavailable for this
  // state, and the coarser one is recorded as coarser rather than substituted.
  const perAssertion = replicates.every((replicate) => replicate.assertions !== null)
  const flipped: OracleFlippedUnit[] = []
  const assertionSetUnstable: string[] = []

  if (perAssertion) {
    const outcomes = new Map<string, boolean[]>()
    for (const replicate of replicates) {
      for (const assertion of replicate.assertions ?? []) {
        const seen = outcomes.get(assertion.id)
        if (seen) seen.push(assertion.passed)
        else outcomes.set(assertion.id, [assertion.passed])
      }
    }
    for (const [id, results] of [...outcomes].sort(([a], [b]) => a.localeCompare(b))) {
      if (results.length !== replicates.length) assertionSetUnstable.push(id)
      const unitPasses = results.filter(Boolean).length
      const unitFails = results.length - unitPasses
      const minority = Math.min(unitPasses, unitFails)
      // A unit missing from some replicates is a flip of the suite's shape, and
      // the replicates that did not report it count against it.
      const absent = replicates.length - results.length
      if (minority + absent > 0) {
        flipped.push({
          unit: id,
          passes: unitPasses,
          fails: unitFails + absent,
          flipRate: (minority + absent) / replicates.length,
        })
      }
    }
  } else {
    const minority = Math.min(passes, replicates.length - passes)
    if (minority > 0) {
      flipped.push({
        unit: SUITE_REWARD_UNIT,
        passes,
        fails: replicates.length - passes,
        flipRate: minority / replicates.length,
      })
    }
  }

  return {
    state,
    replicates: replicates.length,
    passes,
    fails: replicates.length - passes,
    granularity: perAssertion ? 'per-assertion' : 'reward',
    flipRate: flipped.reduce((worst, unit) => Math.max(worst, unit.flipRate), 0),
    flipped,
    assertionSetUnstable,
    loadSensitive: new Set(rates).size > 1,
    rewardsObserved: [...new Set(replicates.map((r) => r.reward ?? 'NO_REWARD_FILE'))].sort(),
  }
}

function describeState(state: OracleStateVerdict): string {
  const base =
    `${state.state}: ${state.passes}/${state.replicates} suite pass, ` +
    `${state.granularity} counting`
  if (state.flipped.length === 0) return `${base}, no flip`
  const worst = state.flipped.reduce((a, b) => (b.flipRate > a.flipRate ? b : a))
  return (
    `${base}, ${state.flipped.length} unit(s) flipped, worst ${worst.unit} ` +
    `${worst.passes}/${worst.passes + worst.fails} pass` +
    (state.loadSensitive ? ' (load-sensitive)' : '')
  )
}

/**
 * Certified verdicts by task name.
 *
 * A task with no entry is uncertified, which is not the same as unstable: one
 * says the check has not run, the other says it ran and the task failed it.
 * Both stop a row, with different reasons.
 */
export type TaskOracleRegistry = ReadonlyMap<string, OracleDeterminismVerdict>

/**
 * What a checked-in certification file holds.
 *
 * It stores the measured replicates, not the verdicts they imply. The verdict
 * is re-derived on read by the same rule a campaign enforces, so a file cannot
 * declare a task stable — only the replicates can, and a reviewer can recount
 * them.
 */
export interface TaskOracleRegistryDocument {
  readonly version: 1
  readonly measurements: readonly OracleDeterminismEvidence[]
}

export function parseTaskOracleRegistry(document: unknown): TaskOracleRegistry {
  if (typeof document !== 'object' || document === null) {
    throw new ValidationError('task oracle registry must be an object')
  }
  const { version, measurements } = document as Partial<TaskOracleRegistryDocument>
  if (version !== 1) {
    throw new ValidationError(`task oracle registry version must be 1, got ${String(version)}`)
  }
  if (!Array.isArray(measurements)) {
    throw new ValidationError('task oracle registry needs a measurements array')
  }
  return taskOracleRegistry(measurements.map((evidence) => oracleDeterminism(evidence)))
}

export function taskOracleRegistry(
  verdicts: readonly OracleDeterminismVerdict[],
): TaskOracleRegistry {
  const registry = new Map<string, OracleDeterminismVerdict>()
  for (const verdict of verdicts) {
    if (registry.has(verdict.taskName)) {
      throw new ValidationError(
        `task oracle registry received ${verdict.taskName} twice; a task has one certification`,
      )
    }
    registry.set(verdict.taskName, verdict)
  }
  return registry
}

/** Throws unless the task graded the same bytes the same way every replicate. */
export function assertDeterministicOracle(verdict: OracleDeterminismVerdict): void {
  if (verdict.stable) return
  throw new NondeterministicOracleError(
    `task ${verdict.taskName} graded byte-identical state inconsistently: flip rate ` +
      `${(verdict.flipRate * 100).toFixed(1)} % over ${verdict.replicates} replicates ` +
      `(${verdict.detail}). Its verdict is not a function of the state, so it cannot carry ` +
      'ground truth for an intervention study.',
  )
}
