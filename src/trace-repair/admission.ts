/**
 * The TB-Repair admission pre-pass: decide which corpus rows may enter a
 * campaign, before any analyst reads one.
 *
 * A repair benchmark reports `Delta-repair = P(pass | intervention) - P(pass |
 * no-fix control)`. That number is only honest if the row set it averages over
 * was fixed by something the analyst cannot influence. An analyst that declines
 * the rows it cannot solve shrinks its own denominator and raises its own
 * score, so admission runs first, records every row it saw, and publishes the
 * reason each excluded row left.
 *
 * A row is admitted only when all four conditions hold:
 *
 *   1. the recorded prefix replays with divergence at or below the threshold,
 *   2. the task's held-out tests fail on the recorded end state,
 *   3. the no-fix control fails every rollout under the pinned policy,
 *   4. the no-op control fails every rollout under the pinned policy.
 *
 * Conditions 3 and 4 delete rows the continuation policy rescues on its own and
 * rows whose task grades flakily. Both would otherwise be counted as repair.
 *
 * Rows are stratified before anything samples them, and the report exposes
 * admitted rows per stratum only: pooling a population a single command can
 * repair with one it cannot requires an explicit concatenation at the call
 * site.
 *
 * The three external boundaries — prefix replay, the task's test oracle, and
 * the control rollouts — are injected. Each carries an `id` that lands in the
 * artifact, so a report produced against fakes cannot be read as one produced
 * against real containers.
 */

import type { CostProvenance } from '../cost-ledger'
import { ValidationError } from '../errors'
import { contentHash } from '../verdict-cache'
import {
  ADMISSION_STRATA,
  type AdmissionCheckRecord,
  type AdmissionControlArm,
  AdmissionDenominatorError,
  type AdmissionExclusionReason,
  type AdmissionNoOpInjection,
  type AdmissionRolloutSummary,
  type AdmissionRow,
  type AdmissionRowVerdict,
  type AdmissionStratum,
  assertAnalystIndependent,
  buildDenominatorChain,
  type DenominatorChainArtifact,
  stratumOf,
} from './admission-records'
import {
  assertArmSymmetry,
  continuationPolicyDigest,
  type PinnedContinuationPolicy,
} from './continuation-policy'
import type { ContinuationRollout } from './continuation-records'
import {
  assertControlCalibrated,
  CONTROL_SCREENING_MODES,
  type ControlScreening,
} from './control-policy'
import type { TaskOracleRegistry } from './oracle-determinism'

// ── Injected boundaries ──────────────────────────────────────────────

/**
 * Result of an external call. Callers read `succeeded` before `value`: a
 * boundary failure is an exclusion with its own reason, never a false verdict.
 */
export type AdmissionOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: string }

export interface AdmissionDivergence {
  /** 1-based recorded step. */
  step: number
  expectedReturncode: number | null
  actualExit: number
}

export interface AdmissionPrefixReplay {
  /** Recorded steps the replay actually executed. */
  prefixExecuted: number
  /** Steps whose replayed exit differs from the recorded return code. */
  prefixDivergences: readonly AdmissionDivergence[]
}

export interface AdmissionPrefixReplayer {
  /** Lands in the artifact. A fake and a container replayer must not share one. */
  id: string
  /** Replay the recorded prefix in the task's pinned image and report divergence. */
  replay(row: AdmissionRow): Promise<AdmissionOutcome<AdmissionPrefixReplay>>
}

export interface AdmissionTestVerdict {
  passed: boolean
  /** Reward the task's own grader reported. `null` when it reported none. */
  reward: number | null
}

export interface AdmissionEndStateOracle {
  id: string
  /** Run the task's held-out tests against the recorded end state. */
  grade(row: AdmissionRow): Promise<AdmissionOutcome<AdmissionTestVerdict>>
}

export interface AdmissionControlRequest {
  row: AdmissionRow
  arm: AdmissionControlArm
  /** 0-based rollout index within the arm. */
  rolloutIndex: number
  /** Present for `no-op-control` only; `null` for `no-fix-control`. */
  injection: AdmissionNoOpInjection | null
}

export interface AdmissionControlObservation {
  /** The task's held-out tests, run after the continuation stopped. */
  tests: AdmissionTestVerdict
  /** The rollout the pinned policy produced. Its digest and seed prove symmetry. */
  rollout: ContinuationRollout
}

export interface AdmissionControlRunner {
  id: string
  /**
   * Restore the row's post-trajectory state, apply the arm's treatment, run the
   * pinned continuation policy forward, then grade the container it left.
   */
  run(request: AdmissionControlRequest): Promise<AdmissionOutcome<AdmissionControlObservation>>
}

// ── Configuration ────────────────────────────────────────────────────

export interface AdmissionConfigInput {
  /** Share of replayed prefix steps allowed to diverge. Default 0.10. */
  maxPrefixDivergence?: number
  /** Rollouts each control arm must fail. Default 3. */
  controlRollouts?: number
  /**
   * Strata a campaign accepts. The default omits `signal-kill`, because
   * substituting one command does not address a timeout. The excluded count
   * stays visible in the chain instead of disappearing.
   */
  admitStrata?: readonly AdmissionStratum[]
  /** Shell action the no-op control substitutes. Default `true`. */
  inertAction?: string
  /**
   * How a control pass is read. Default `enforced`, which requires a control
   * that can act; `resolveAdmissionConfig` refuses the pairing that cannot.
   */
  controlScreening?: ControlScreening
  /** Rows processed at once. Output order always follows input order. Default 1. */
  concurrency?: number
}

export interface AdmissionConfig {
  readonly maxPrefixDivergence: number
  readonly controlRollouts: number
  readonly admitStrata: readonly AdmissionStratum[]
  readonly inertAction: string
  readonly controlScreening: ControlScreening
  readonly concurrency: number
}

export const ADMISSION_CONFIG_DEFAULTS: AdmissionConfig = Object.freeze({
  maxPrefixDivergence: 0.1,
  controlRollouts: 3,
  admitStrata: Object.freeze(['clean-exit', 'command-error']) as readonly AdmissionStratum[],
  inertAction: 'true',
  controlScreening: 'enforced' as ControlScreening,
  concurrency: 1,
})

export function resolveAdmissionConfig(input: AdmissionConfigInput = {}): AdmissionConfig {
  const config: AdmissionConfig = { ...ADMISSION_CONFIG_DEFAULTS, ...input }
  if (!Number.isFinite(config.maxPrefixDivergence)) {
    throw new ValidationError(
      `admission maxPrefixDivergence must be a number, got ${config.maxPrefixDivergence}`,
    )
  }
  if (config.maxPrefixDivergence < 0 || config.maxPrefixDivergence > 1) {
    throw new ValidationError(
      `admission maxPrefixDivergence must be a share between 0 and 1, got ${config.maxPrefixDivergence}`,
    )
  }
  requirePositiveInteger(config.controlRollouts, 'controlRollouts')
  requirePositiveInteger(config.concurrency, 'concurrency')
  if (config.admitStrata.length === 0) {
    throw new ValidationError('admission admitStrata must name at least one stratum')
  }
  for (const stratum of config.admitStrata) {
    if (!ADMISSION_STRATA.includes(stratum)) {
      throw new ValidationError(`admission admitStrata holds an unknown stratum: ${stratum}`)
    }
  }
  if (config.inertAction.trim().length === 0) {
    throw new ValidationError('admission inertAction must be a non-empty command')
  }
  if (!CONTROL_SCREENING_MODES.includes(config.controlScreening)) {
    throw new ValidationError(
      `admission controlScreening must be one of ${CONTROL_SCREENING_MODES.join(', ')}, got ${config.controlScreening}`,
    )
  }
  return Object.freeze({ ...config, admitStrata: Object.freeze([...config.admitStrata]) })
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`admission ${field} must be a positive integer, got ${value}`)
  }
}

/**
 * The recorded command the no-op control replaces, drawn per rollout.
 *
 * The draw reads the policy seed, the row, and the rollout index, so it is
 * reproducible from the artifact and cannot depend on when the pre-pass ran.
 */
export function noOpInjectionStep(
  policySeed: number,
  rowId: string,
  rolloutIndex: number,
  recordedCommands: number,
): number {
  requirePositiveInteger(recordedCommands, 'recordedCommands')
  const input = `no-op:${policySeed}:${rowId}:${rolloutIndex}`
  // 32-bit FNV-1a over raw UTF-16 code units. Frozen: it derives the per-row
  // no-op injection seed, so a change replays admitted rows differently and
  // breaks the reproduction of results already recorded.
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return ((hash >>> 1) % recordedCommands) + 1
}

// ── Report ───────────────────────────────────────────────────────────

export interface AdmissionProvenance {
  replayerId: string
  oracleId: string
  controlRunnerId: string
  policyId: string
  policyModel: string
  policySeed: number
  policyDigest: string
  /** Model calls a control rollout may make. Zero cannot screen anything, and
   *  `resolveAdmissionConfig` refuses that pairing before a container opens. */
  policyStepBudget: number
  controlScreening: ControlScreening
  /** Tasks whose oracle carried a determinism certification, and their
   *  measured flip rates. */
  certifiedTasks: Readonly<Record<string, number>>
}

export interface AdmissionReport {
  config: AdmissionConfig
  provenance: AdmissionProvenance
  /** Every input row, in input order, admitted or not. */
  rows: readonly AdmissionRowVerdict[]
  /** Admitted row ids per stratum. There is no pooled list; pooling is explicit. */
  strata: Readonly<Record<AdmissionStratum, readonly string[]>>
  chain: DenominatorChainArtifact
  /** Model cost of the control rollouts. One unpriced rollout makes it uncaptured. */
  controlCost: CostProvenance
  /** Hash over the admitted ids, the config, and the provenance. */
  digest: string
  generatedAt: string
}

export interface RunAdmissionOptions {
  rows: readonly AdmissionRow[]
  /** The policy the campaign's arms run under. Its seed drives the no-op draw. */
  policy: PinnedContinuationPolicy
  replayer: AdmissionPrefixReplayer
  oracle: AdmissionEndStateOracle
  controls: AdmissionControlRunner
  /**
   * Determinism certifications by task name. Required: every check below reads
   * the task's own suite, so a suite whose verdict is not a function of the
   * state makes each of them a coin flip. A task with no entry is excluded as
   * uncertified rather than assumed stable.
   */
  taskOracles: TaskOracleRegistry
  config?: AdmissionConfigInput
  /** Epoch milliseconds. Injected so a report can be compared exactly in a test. */
  clock?: () => number
}

/**
 * Run the pre-pass over every row and publish the denominator it produced.
 *
 * Nothing here reads an analyst output. The report is frozen, and a campaign
 * proves it measured this denominator by passing the report back to
 * `assertDenominatorIntact`.
 */
export async function runAdmission(options: RunAdmissionOptions): Promise<AdmissionReport> {
  const { rows, policy, replayer, oracle, controls, taskOracles } = options
  const config = resolveAdmissionConfig(options.config)
  const clock = options.clock ?? Date.now
  assertAnalystIndependent(rows)
  assertUniqueRowIds(rows)
  const policyDigest = continuationPolicyDigest(policy)
  // Both admission paths check the same rule against the same shape, so the
  // pure contract and this pre-pass cannot drift about what a control that can
  // screen looks like.
  assertControlCalibrated(
    { id: policy.id, digest: policyDigest, stepBudget: policy.stepBudget },
    config.controlScreening,
  )

  const verdicts = await mapOrdered(rows, config.concurrency, (row) =>
    admitRow({ row, policy, policyDigest, replayer, oracle, controls, taskOracles, config }),
  )

  const strata = groupAdmittedByStratum(verdicts)
  const provenance: AdmissionProvenance = {
    replayerId: replayer.id,
    oracleId: oracle.id,
    controlRunnerId: controls.id,
    policyId: policy.id,
    policyModel: policy.model,
    policySeed: policy.seed,
    policyDigest,
    policyStepBudget: policy.stepBudget,
    controlScreening: config.controlScreening,
    certifiedTasks: Object.freeze(
      Object.fromEntries([...taskOracles].map(([task, verdict]) => [task, verdict.flipRate])),
    ),
  }
  return Object.freeze({
    config,
    provenance,
    rows: Object.freeze(verdicts),
    strata,
    chain: buildDenominatorChain(verdicts, config.admitStrata),
    controlCost: summarizeControlCost(verdicts),
    digest: contentHash({
      config,
      provenance,
      admitted: ADMISSION_STRATA.map((stratum) => ({ stratum, rowIds: strata[stratum] })),
    }),
    generatedAt: new Date(clock()).toISOString(),
  })
}

function assertUniqueRowIds(rows: readonly AdmissionRow[]): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row.rowId !== 'string' || row.rowId.length === 0) {
      throw new ValidationError('admission row requires a non-empty rowId')
    }
    if (seen.has(row.rowId)) {
      throw new ValidationError(`admission received rowId ${row.rowId} twice`)
    }
    seen.add(row.rowId)
  }
}

interface AdmitRowInput {
  row: AdmissionRow
  policy: PinnedContinuationPolicy
  policyDigest: string
  replayer: AdmissionPrefixReplayer
  oracle: AdmissionEndStateOracle
  controls: AdmissionControlRunner
  taskOracles: TaskOracleRegistry
  config: AdmissionConfig
}

async function admitRow(input: AdmitRowInput): Promise<AdmissionRowVerdict> {
  const { row, config } = input
  const checks: AdmissionCheckRecord[] = []
  const rollouts: ContinuationRollout[] = []
  const summaries: AdmissionRolloutSummary[] = []
  const certification = input.taskOracles.get(row.taskName) ?? null
  const base = {
    rowId: row.rowId,
    taskName: row.taskName,
    recordedModel: row.recordedModel,
    recordedCommands: row.recordedCommands,
    finalReturncode: row.finalReturncode,
    controlPolicyDigest: input.policyDigest,
    controlScreening: config.controlScreening,
    oracleFlipRate: certification === null ? null : certification.flipRate,
  }
  const finish = (
    stratum: AdmissionStratum | null,
    reason: AdmissionExclusionReason | null,
    errorDetail: string | null = null,
  ): AdmissionRowVerdict => ({
    ...base,
    stratum,
    admitted: reason === null,
    excludedBy: reason,
    errorDetail,
    checks,
    rollouts: summaries,
  })

  if (!Number.isInteger(row.recordedCommands) || row.recordedCommands < 1) {
    return finish(null, 'no-recorded-commands')
  }
  const stratum = stratumOf(row.finalReturncode)
  if (stratum === null) return finish(null, 'unparseable-final-returncode')
  checks.push({ check: 'stratum', stratum })
  if (!config.admitStrata.includes(stratum)) return finish(stratum, 'stratum-not-admitted')

  // Ahead of the first container: every check below reads this task's suite, so
  // a suite that answers differently about identical bytes turns each of them
  // into a draw. An absent certification is its own reason — the check has not
  // run, which is not the same as having run and failed.
  if (certification === null) return finish(stratum, 'task-oracle-uncertified')
  checks.push({
    check: 'task-oracle',
    stable: certification.stable,
    flipRate: certification.flipRate,
    replicates: certification.replicates,
  })
  if (!certification.stable) {
    return finish(stratum, 'task-oracle-nondeterministic', certification.detail)
  }

  const replay = await input.replayer.replay(row)
  if (!replay.succeeded) return finish(stratum, 'prefix-replay-error', replay.error)
  const { prefixExecuted, prefixDivergences } = replay.value
  if (!Number.isInteger(prefixExecuted) || prefixExecuted < 1) {
    return finish(stratum, 'prefix-replay-empty')
  }
  // A replay that stopped early would compute divergence over the steps it did
  // reach, so a truncated run could report a low ratio and admit a row that
  // never reproduced its end state.
  if (prefixExecuted < row.recordedCommands) return finish(stratum, 'prefix-replay-truncated')
  const divergenceRatio = prefixDivergences.length / prefixExecuted
  checks.push({
    check: 'prefix-replay',
    prefixExecuted,
    divergences: prefixDivergences.length,
    divergenceRatio,
  })
  if (divergenceRatio > config.maxPrefixDivergence) {
    return finish(stratum, 'prefix-divergence-above-threshold')
  }

  const endState = await input.oracle.grade(row)
  if (!endState.succeeded) return finish(stratum, 'end-state-oracle-error', endState.error)
  checks.push({
    check: 'end-state-tests',
    passed: endState.value.passed,
    reward: endState.value.reward,
  })
  if (endState.value.passed) return finish(stratum, 'end-state-tests-pass')

  for (const arm of CONTROL_ARMS) {
    const control = await runControlArm({ ...input, arm })
    checks.push(control.record)
    rollouts.push(...control.rollouts)
    summaries.push(...control.summaries)
    if (control.outcome === 'error') {
      return finish(stratum, CONTROL_EXCLUSIONS[arm].error, control.error)
    }
    if (control.outcome === 'rescued') return finish(stratum, CONTROL_EXCLUSIONS[arm].rescued)
  }

  // Both arms ran the full rollout count, so a policy or seed that differs
  // between them is a wiring fault in the runner, not a property of the row.
  assertArmSymmetry(rollouts)
  return finish(stratum, null)
}

const CONTROL_ARMS: readonly AdmissionControlArm[] = ['no-fix-control', 'no-op-control']

const CONTROL_EXCLUSIONS: Readonly<
  Record<
    AdmissionControlArm,
    { error: AdmissionExclusionReason; rescued: AdmissionExclusionReason }
  >
> = Object.freeze({
  'no-fix-control': { error: 'no-fix-control-error', rescued: 'no-fix-control-rescued' },
  'no-op-control': { error: 'no-op-control-error', rescued: 'no-op-control-rescued' },
})

interface ControlArmResult {
  outcome: 'failed-every-rollout' | 'rescued' | 'error'
  error: string | null
  record: AdmissionCheckRecord
  /** Kept whole for the symmetry assertion; the verdict stores the summaries. */
  rollouts: ContinuationRollout[]
  summaries: AdmissionRolloutSummary[]
}

/**
 * Run one control arm until it is decided.
 *
 * A rollout that passes decides the arm at once, so the remaining rollouts go
 * unpaid. A boundary failure decides it too, and as an error: counting an
 * unmeasured rollout as a failure would admit a row nobody verified.
 */
async function runControlArm(
  input: AdmitRowInput & { arm: AdmissionControlArm },
): Promise<ControlArmResult> {
  const { row, arm, config, policy } = input
  const rollouts: ContinuationRollout[] = []
  const summaries: AdmissionRolloutSummary[] = []
  const injections: AdmissionNoOpInjection[] = []
  let passes = 0
  let error: string | null = null

  for (let index = 0; index < config.controlRollouts; index += 1) {
    const injection =
      arm === 'no-op-control'
        ? {
            step: noOpInjectionStep(policy.seed, row.rowId, index, row.recordedCommands),
            action: config.inertAction,
          }
        : null
    if (injection) injections.push(injection)
    const result = await input.controls.run({ row, arm, rolloutIndex: index, injection })
    if (!result.succeeded) {
      error = result.error
      break
    }
    const { rollout, tests } = result.value
    assertRolloutMatchesRequest(rollout, { row, arm, index })
    rollouts.push(rollout)
    summaries.push({
      arm,
      index: rollout.index,
      seed: rollout.seed,
      policyDigest: rollout.policyDigest,
      exitStatus: rollout.exitStatus,
      testsPassed: tests.passed,
      costUsd: rollout.costProvenance.usd,
    })
    if (tests.passed) {
      passes += 1
      break
    }
  }

  const record: AdmissionCheckRecord = {
    check: 'control',
    arm,
    rolloutsRun: rollouts.length,
    passes,
    injections,
  }
  if (error !== null) return { outcome: 'error', error, record, rollouts, summaries }
  if (passes > 0) return { outcome: 'rescued', error: null, record, rollouts, summaries }
  return { outcome: 'failed-every-rollout', error: null, record, rollouts, summaries }
}

function assertRolloutMatchesRequest(
  rollout: ContinuationRollout,
  request: { row: AdmissionRow; arm: AdmissionControlArm; index: number },
): void {
  if (rollout.arm !== request.arm) {
    throw new AdmissionDenominatorError(
      `control runner returned a ${rollout.arm} rollout for the ${request.arm} arm`,
    )
  }
  if (rollout.rowId !== request.row.rowId) {
    throw new AdmissionDenominatorError(
      `control runner returned a rollout for row ${rollout.rowId} while deciding ${request.row.rowId}`,
    )
  }
  if (rollout.index !== request.index) {
    throw new AdmissionDenominatorError(
      `control runner returned rollout index ${rollout.index} for requested index ${request.index}`,
    )
  }
}

/**
 * Model cost of every control rollout that ran.
 *
 * One unpriced rollout makes the total uncaptured, because summing the priced
 * ones reports less than the pre-pass spent. Zero rollouts is an observed zero:
 * nothing ran, so nothing is missing.
 */
function summarizeControlCost(verdicts: readonly AdmissionRowVerdict[]): CostProvenance {
  let usd = 0
  for (const verdict of verdicts) {
    for (const rollout of verdict.rollouts) {
      if (rollout.costUsd === null) return { kind: 'uncaptured', usd: null }
      usd += rollout.costUsd
    }
  }
  return { kind: 'observed', usd }
}

function groupAdmittedByStratum(
  verdicts: readonly AdmissionRowVerdict[],
): Readonly<Record<AdmissionStratum, readonly string[]>> {
  const grouped: Record<AdmissionStratum, string[]> = {
    'clean-exit': [],
    'command-error': [],
    'signal-kill': [],
  }
  for (const verdict of verdicts) {
    if (!verdict.admitted || verdict.stratum === null) continue
    grouped[verdict.stratum].push(verdict.rowId)
  }
  return Object.freeze({
    'clean-exit': Object.freeze(grouped['clean-exit']),
    'command-error': Object.freeze(grouped['command-error']),
    'signal-kill': Object.freeze(grouped['signal-kill']),
  })
}

/** Bounded worker pool that keeps results in input order. */
async function mapOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return results
}

// ── Reading the report ───────────────────────────────────────────────

/** Admitted row ids in one stratum. No call returns them pooled. */
export function admittedRowIds(
  report: AdmissionReport,
  stratum: AdmissionStratum,
): readonly string[] {
  return report.strata[stratum]
}

export function admittedCount(report: AdmissionReport): number {
  return ADMISSION_STRATA.reduce((total, stratum) => total + report.strata[stratum].length, 0)
}

export interface DenominatorIntactInput {
  report: AdmissionReport
  /** Strata the campaign drew from. Rows outside them are not expected. */
  strata: readonly AdmissionStratum[]
  /** Rows the campaign sampled from the admitted set. */
  sampled: readonly string[]
  /** Rows the campaign produced an outcome for, including `no-decisive-failure`. */
  scored: readonly string[]
}

/**
 * Prove a campaign measured the denominator admission published.
 *
 * Three ways a denominator moves after the fact, each rejected here: scoring a
 * row that was never admitted, scoring a row that was never sampled, and
 * dropping a sampled row instead of scoring it. The third is the one an analyst
 * can cause on its own — declining a row it cannot solve — so a sampled row
 * with no outcome is an error, not a smaller `n`.
 */
export function assertDenominatorIntact(input: DenominatorIntactInput): void {
  const { report, strata, sampled, scored } = input
  for (const stratum of strata) {
    if (!ADMISSION_STRATA.includes(stratum)) {
      throw new ValidationError(`unknown stratum in denominator check: ${stratum}`)
    }
  }
  assertNoDuplicates(sampled, 'sampled')
  assertNoDuplicates(scored, 'scored')
  const eligible = new Set(strata.flatMap((stratum) => [...report.strata[stratum]]))
  const notAdmitted = sampled.filter((rowId) => !eligible.has(rowId))
  if (notAdmitted.length > 0) {
    throw new AdmissionDenominatorError(
      `${notAdmitted.length} sampled row(s) are not admitted in strata ${strata.join(', ')}: ${preview(notAdmitted)}`,
    )
  }
  const sampledSet = new Set(sampled)
  const unsampled = scored.filter((rowId) => !sampledSet.has(rowId))
  if (unsampled.length > 0) {
    throw new AdmissionDenominatorError(
      `${unsampled.length} scored row(s) were never sampled: ${preview(unsampled)}`,
    )
  }
  const scoredSet = new Set(scored)
  const dropped = sampled.filter((rowId) => !scoredSet.has(rowId))
  if (dropped.length > 0) {
    throw new AdmissionDenominatorError(
      `denominator shrank by ${dropped.length} row(s): sampled but never scored: ${preview(dropped)}`,
    )
  }
}

/** A row counted twice raises `n` without measuring anything twice. */
function assertNoDuplicates(rowIds: readonly string[], field: string): void {
  const seen = new Set<string>()
  const duplicates = rowIds.filter((rowId) => {
    if (seen.has(rowId)) return true
    seen.add(rowId)
    return false
  })
  if (duplicates.length > 0) {
    throw new AdmissionDenominatorError(
      `${field} lists ${duplicates.length} duplicate row id(s): ${preview([...new Set(duplicates)])}`,
    )
  }
}

function preview(rowIds: readonly string[]): string {
  const shown = rowIds.slice(0, 5).join(', ')
  return rowIds.length > 5 ? `${shown}, +${rowIds.length - 5} more` : shown
}
