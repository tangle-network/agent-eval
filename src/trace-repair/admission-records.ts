/**
 * The vocabulary of the TB-Repair admission pre-pass: what a corpus row is,
 * which failure population it belongs to, why it can leave the funnel, and the
 * denominator chain those exclusions add up to.
 *
 * Pure data and pure functions. The gate that spends containers on these types
 * lives in `admission.ts`, and the artifact that publishes them lives in
 * `admission-report.ts`.
 */

import { CaptureIntegrityError } from '../errors'
import type { ContinuationRollout } from './continuation-records'

/** A campaign scored rows the pre-pass did not admit, or dropped rows it did. */
export class AdmissionDenominatorError extends CaptureIntegrityError {}

/** A row handed to the pre-pass carried a field only an analyst could produce. */
export class AdmissionIndependenceError extends CaptureIntegrityError {}

// ── Rows ─────────────────────────────────────────────────────────────

/**
 * One corpus row, described by what the recording holds and nothing else.
 *
 * The field list is closed on purpose: `assertAnalystIndependent` rejects any
 * extra key, which is what stops a finding, a step index, or a proposed
 * intervention from reaching the gate that fixes the denominator.
 */
export interface AdmissionRow {
  /** Stable identifier for the recorded trajectory. Duplicates are rejected. */
  rowId: string
  /** Terminal-Bench-2 task the trajectory ran. */
  taskName: string
  /** Model that produced the recorded trajectory. */
  recordedModel: string
  /**
   * Recorded shell commands. An action can be substituted at any one of them,
   * and a replay must execute all of them to reach the recorded end state.
   */
  recordedCommands: number
  /**
   * Return code of the trajectory's last recorded observation. Negative values
   * are signal kills and are real. `null` means the recording did not parse,
   * which excludes the row instead of defaulting it.
   */
  finalReturncode: number | null
}

export const ADMISSION_ROW_KEYS: readonly string[] = [
  'rowId',
  'taskName',
  'recordedModel',
  'recordedCommands',
  'finalReturncode',
]

/**
 * Reject rows that carry anything beyond the recording.
 *
 * The check is a closed key list rather than a list of known analyst field
 * names, because the failure to catch is "some new analyst output leaked into
 * the gate", and only a closed shape catches the fields nobody thought of.
 */
export function assertAnalystIndependent(rows: readonly AdmissionRow[]): void {
  const allowed = new Set(ADMISSION_ROW_KEYS)
  for (const row of rows) {
    const extra = Object.keys(row).filter((key) => !allowed.has(key))
    if (extra.length > 0) {
      throw new AdmissionIndependenceError(
        `admission row ${String(row.rowId)} carries analyst-side fields: ${extra.sort().join(', ')}`,
      )
    }
  }
}

// ── Strata ───────────────────────────────────────────────────────────

/**
 * Failure population a row belongs to.
 *
 * - `clean-exit` — the last command exited 0 and the tests still fail, so the
 *   agent stopped believing it was done. The assay measured 87.13% of admitted
 *   failures here.
 * - `command-error` — the last command exited non-zero.
 * - `signal-kill` — the last command was killed by a signal, recorded as a
 *   negative return code. Substituting one command does not address a timeout,
 *   so this population stays separate from the other two.
 */
export type AdmissionStratum = 'clean-exit' | 'command-error' | 'signal-kill'

export const ADMISSION_STRATA: readonly AdmissionStratum[] = [
  'clean-exit',
  'command-error',
  'signal-kill',
]

/** `null` when the recording holds no parseable final return code. */
export function stratumOf(finalReturncode: number | null): AdmissionStratum | null {
  if (finalReturncode === null || !Number.isInteger(finalReturncode)) return null
  if (finalReturncode === 0) return 'clean-exit'
  return finalReturncode < 0 ? 'signal-kill' : 'command-error'
}

// ── Exclusion reasons ────────────────────────────────────────────────

/**
 * Why a row left the funnel.
 *
 * `ADMISSION_EXCLUSION_ORDER` is the order the gate applies the checks, and it
 * is cost-ordered: everything decidable from the recording runs before the
 * first container, and the control rollouts run last.
 */
export type AdmissionExclusionReason =
  | 'no-recorded-commands'
  | 'unparseable-final-returncode'
  | 'stratum-not-admitted'
  | 'prefix-replay-error'
  | 'prefix-replay-empty'
  | 'prefix-replay-truncated'
  | 'prefix-divergence-above-threshold'
  | 'end-state-oracle-error'
  | 'end-state-tests-pass'
  | 'no-fix-control-error'
  | 'no-fix-control-rescued'
  | 'no-op-control-error'
  | 'no-op-control-rescued'

export const ADMISSION_EXCLUSION_ORDER: readonly AdmissionExclusionReason[] = [
  'no-recorded-commands',
  'unparseable-final-returncode',
  'stratum-not-admitted',
  'prefix-replay-error',
  'prefix-replay-empty',
  'prefix-replay-truncated',
  'prefix-divergence-above-threshold',
  'end-state-oracle-error',
  'end-state-tests-pass',
  'no-fix-control-error',
  'no-fix-control-rescued',
  'no-op-control-error',
  'no-op-control-rescued',
]

/** Reasons decided from the recording alone, before a row can be stratified. */
const PRE_STRATUM_REASONS: readonly AdmissionExclusionReason[] = [
  'no-recorded-commands',
  'unparseable-final-returncode',
]

export function isPreStratumReason(reason: AdmissionExclusionReason): boolean {
  return PRE_STRATUM_REASONS.includes(reason)
}

/** One line of prose per reason, for the rendered chain. */
export const ADMISSION_EXCLUSION_MEANING: Readonly<Record<AdmissionExclusionReason, string>> =
  Object.freeze({
    'no-recorded-commands': 'the recording holds no command to substitute',
    'unparseable-final-returncode': 'the last observation carries no return code',
    'stratum-not-admitted': 'the row belongs to a population this campaign excluded',
    'prefix-replay-error': 'the replay boundary failed, so divergence is unmeasured',
    'prefix-replay-empty': 'the replay executed no recorded step',
    'prefix-replay-truncated': 'the replay stopped short of the recorded end state',
    'prefix-divergence-above-threshold': 'replaying the prefix did not reproduce the recording',
    'end-state-oracle-error': 'the task grader failed, so the end state is unjudged',
    'end-state-tests-pass': 'the task tests pass on the recorded end state, so nothing failed',
    'no-fix-control-error': 'a no-fix rollout failed to run, so the control is unmeasured',
    'no-fix-control-rescued': 'the continuation policy passes the task with no intervention',
    'no-op-control-error': 'a no-op rollout failed to run, so the control is unmeasured',
    'no-op-control-rescued': 'an inert action plus continuation passes the task',
  })

// ── Per-row verdict ──────────────────────────────────────────────────

export type AdmissionControlArm = 'no-fix-control' | 'no-op-control'

/** The inert action the no-op control substitutes, and where it goes. */
export interface AdmissionNoOpInjection {
  /** 1-based recorded command the inert action replaces. */
  step: number
  action: string
}

export type AdmissionCheckRecord =
  | { check: 'stratum'; stratum: AdmissionStratum }
  | {
      check: 'prefix-replay'
      prefixExecuted: number
      divergences: number
      divergenceRatio: number
    }
  | { check: 'end-state-tests'; passed: boolean; reward: number | null }
  | {
      check: 'control'
      arm: AdmissionControlArm
      rolloutsRun: number
      passes: number
      injections: AdmissionNoOpInjection[]
    }

/** What one control rollout did, small enough to serialize for every row. */
export interface AdmissionRolloutSummary {
  arm: AdmissionControlArm
  index: number
  seed: number
  policyDigest: string
  exitStatus: ContinuationRollout['exitStatus']
  testsPassed: boolean
  /** `null` when the rollout carried an unpriced model call. */
  costUsd: number | null
}

export interface AdmissionRowVerdict {
  rowId: string
  taskName: string
  recordedModel: string
  recordedCommands: number
  finalReturncode: number | null
  /** `null` only together with a pre-stratum exclusion reason. */
  stratum: AdmissionStratum | null
  admitted: boolean
  /** `null` when the row is admitted. */
  excludedBy: AdmissionExclusionReason | null
  /** Message from the boundary that failed, on the four `*-error` reasons. */
  errorDetail: string | null
  /** Checks that ran, in order. A check never reached is absent, not zero. */
  checks: AdmissionCheckRecord[]
  rollouts: AdmissionRolloutSummary[]
}

// ── Denominator chain ────────────────────────────────────────────────

export interface DenominatorStage {
  reason: AdmissionExclusionReason
  entering: number
  excluded: number
  remaining: number
}

export interface DenominatorChain {
  /** `all` counts every input row; a stratum chain starts after stratification. */
  scope: 'all' | AdmissionStratum
  input: number
  stages: DenominatorStage[]
  admitted: number
}

export interface DenominatorChainArtifact {
  version: 1
  overall: DenominatorChain
  byStratum: DenominatorChain[]
  reasonTotals: Record<AdmissionExclusionReason, number>
  /** Rows excluded before a stratum could be assigned. */
  unstratified: number
  /** Strata this run admitted. Others can only reach `stratum-not-admitted`. */
  admitStrata: readonly AdmissionStratum[]
}

/**
 * Build the funnel every campaign report publishes.
 *
 * Each stage names the reason, the rows that reached it, the rows it removed,
 * and the rows that survived, so `input = admitted + sum(excluded)` can be read
 * off the table instead of trusted.
 */
export function buildDenominatorChain(
  verdicts: readonly AdmissionRowVerdict[],
  admitStrata: readonly AdmissionStratum[],
): DenominatorChainArtifact {
  const reasonTotals = emptyReasonTotals()
  for (const verdict of verdicts) {
    if (verdict.excludedBy !== null) reasonTotals[verdict.excludedBy] += 1
  }
  const stratumReasons = ADMISSION_EXCLUSION_ORDER.filter((reason) => !isPreStratumReason(reason))
  const artifact: DenominatorChainArtifact = {
    version: 1,
    overall: chainOf('all', verdicts, ADMISSION_EXCLUSION_ORDER),
    byStratum: ADMISSION_STRATA.filter((stratum) =>
      verdicts.some((verdict) => verdict.stratum === stratum),
    ).map((stratum) =>
      chainOf(
        stratum,
        verdicts.filter((verdict) => verdict.stratum === stratum),
        stratumReasons,
      ),
    ),
    reasonTotals,
    unstratified: verdicts.filter((verdict) => verdict.stratum === null).length,
    admitStrata: [...admitStrata],
  }
  assertChainReconciles(artifact)
  return artifact
}

function chainOf(
  scope: 'all' | AdmissionStratum,
  verdicts: readonly AdmissionRowVerdict[],
  reasons: readonly AdmissionExclusionReason[],
): DenominatorChain {
  let remaining = verdicts.length
  const stages: DenominatorStage[] = []
  for (const reason of reasons) {
    const excluded = verdicts.filter((verdict) => verdict.excludedBy === reason).length
    const entering = remaining
    remaining -= excluded
    stages.push({ reason, entering, excluded, remaining })
  }
  return {
    scope,
    input: verdicts.length,
    stages,
    admitted: verdicts.filter((verdict) => verdict.admitted).length,
  }
}

function emptyReasonTotals(): Record<AdmissionExclusionReason, number> {
  const totals = {} as Record<AdmissionExclusionReason, number>
  for (const reason of ADMISSION_EXCLUSION_ORDER) totals[reason] = 0
  return totals
}

/** A chain that does not add up is a broken denominator, so this throws. */
export function assertChainReconciles(artifact: DenominatorChainArtifact): void {
  for (const chain of [artifact.overall, ...artifact.byStratum]) {
    const excluded = chain.stages.reduce((total, stage) => total + stage.excluded, 0)
    if (chain.input !== chain.admitted + excluded) {
      throw new AdmissionDenominatorError(
        `denominator chain (${chain.scope}) does not reconcile: input ${chain.input} != admitted ${chain.admitted} + excluded ${excluded}`,
      )
    }
    const last = chain.stages[chain.stages.length - 1]
    if (last && last.remaining !== chain.admitted) {
      throw new AdmissionDenominatorError(
        `denominator chain (${chain.scope}) ends at ${last.remaining} rows but reports ${chain.admitted} admitted`,
      )
    }
  }
  const stratumInputs = artifact.byStratum.reduce((total, chain) => total + chain.input, 0)
  if (stratumInputs + artifact.unstratified !== artifact.overall.input) {
    throw new AdmissionDenominatorError(
      `stratum inputs ${stratumInputs} plus ${artifact.unstratified} unstratified do not cover ${artifact.overall.input} input rows`,
    )
  }
}
