/** Format-specific training admission over the canonical rollout, with observable exclusions. */

import { isLicenseEligible, type LicenseClass } from './license'
import { assertRewardGate, type RolloutLine, type RolloutSplit } from './schema'
import { unresolvedNativeCaptures } from './transcript'

export type TrainingPurpose = 'imitation' | 'preference' | 'reward'
export type TrainingExclusionReason =
  | 'split'
  | 'lossy-capture'
  | 'incomplete'
  | 'truncated'
  | 'execution-error'
  | 'unscored'
  | 'realness-gated'
  | 'quality'
  | 'license'
  | 'no-target'
  | 'missing-tool-definitions'

export interface TrainingAdmission {
  rollout_id: string
  run_id: string
  split: RolloutSplit
  purpose: TrainingPurpose
  /** Null means eligible; an exclusion preserves the source identity and reason. */
  reason: TrainingExclusionReason | null
}

export interface TrainingExportOptions {
  /** Include held-out evidence only by an explicit caller decision. Default false. */
  allowHeldOutTrainingData?: boolean
  /** Imitation requires reward strictly above this value. Default 0. */
  minimumQualityExclusive?: number
  /** Explicit selection for a deliberately named non-training slice. */
  splitFilter?: RolloutSplit[]
  /** Default: all license classes. */
  allowLicenseClasses?: readonly LicenseClass[]
  /** Called for every considered invocation, including exclusions. */
  onAdmission?: (decision: TrainingAdmission) => void
}

/** Search trains by default; held-out requires opt-in, and an explicit slice is auditable. */
export function isSplitEligible(
  line: RolloutLine,
  options: Pick<TrainingExportOptions, 'allowHeldOutTrainingData' | 'splitFilter'>,
): boolean {
  if (options.splitFilter !== undefined) return options.splitFilter.includes(line.task.split)
  if (line.task.split === 'search') return true
  return line.task.split === 'holdout' && options.allowHeldOutTrainingData === true
}

/**
 * Imitation admits clean positive completions; preferences retain completed honest
 * failures; reward training also retains screened gaming at its cleared reward.
 * Missing or partial capture is never interchangeable with a completed failure.
 */
export function trainingAdmission(
  line: RolloutLine,
  purpose: TrainingPurpose,
  options: TrainingExportOptions = {},
): TrainingAdmission {
  assertRewardGate(line, `${purpose} training admission`)
  const floor = options.minimumQualityExclusive ?? 0
  if (!Number.isFinite(floor)) throw new Error('minimumQualityExclusive must be finite')
  const reward = line.outcome.reward
  if (reward !== null && !Number.isFinite(reward))
    throw new Error(`training reward for rollout "${line.rollout_id}" must be finite`)
  let reason: TrainingExclusionReason | null = null
  if (!isSplitEligible(line, options)) reason = 'split'
  else if (
    line.provenance.lossy_projection === true ||
    (line.provenance.native_captures !== undefined &&
      (line.provenance.native_captures.length === 0 ||
        unresolvedNativeCaptures(line.provenance.native_captures).length > 0)) ||
    line.provenance.attempts?.some((attempt) => attempt.missingReasons.length > 0)
  )
    reason = 'lossy-capture'
  else if (line.outcome.is_truncated) reason = 'truncated'
  else if (!line.outcome.is_completed) reason = 'incomplete'
  else if (reward === null) reason = 'unscored'
  else if (line.outcome.realness_gated && purpose !== 'reward') reason = 'realness-gated'
  else if (line.outcome.error !== null && (purpose === 'imitation' || reward > 0))
    reason = 'execution-error'
  else if (purpose === 'imitation' && reward <= floor) reason = 'quality'
  else if (
    purpose === 'imitation' &&
    (line.provenance.tool_definitions_gap !== undefined ||
      line.messages.some((message) =>
        message.tool_calls?.some(
          (call) =>
            !line.tool_defs.some(
              (definition) =>
                definition.type === 'function' &&
                definition.function.name === call.function.name &&
                typeof definition.function.parameters === 'object' &&
                definition.function.parameters !== null &&
                !Array.isArray(definition.function.parameters),
            ),
        ),
      ))
  )
    reason = 'missing-tool-definitions'
  else if (!isLicenseEligible(line, options.allowLicenseClasses)) reason = 'license'
  else if (
    purpose === 'imitation' &&
    line.messages.length > 0 &&
    !line.messages.some(
      (message) => message.role === 'assistant' && message.is_copied_context !== true,
    )
  )
    reason = 'no-target'
  const decision = {
    rollout_id: line.rollout_id,
    run_id: line.run_id,
    split: line.task.split,
    purpose,
    reason,
  }
  options.onAdmission?.(decision)
  return decision
}
