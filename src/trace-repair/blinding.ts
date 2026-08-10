/**
 * What the analyst is shown.
 *
 * A blinded trajectory prefix: the task the agent was given and the actions
 * and observations it produced, and nothing about how the run was judged. No
 * held-out suite, no suite digest, no control rates, no end-state result, no
 * label.
 *
 * The blinding is by construction rather than by redaction. The returned
 * object is assembled field by field from an admitted row, so a field added to
 * `AdmittedRow` later cannot leak into an analyst prompt by default — it has
 * to be copied here on purpose.
 *
 * Requiring an `AdmittedRow` is the other half of the guarantee: a row cannot
 * be shown to an analyst before the four admission checks have executed and
 * passed.
 */

import { ValidationError } from '../errors'
import type { AdmittedRow } from './admission'

export interface BlindedStep {
  readonly step_id: number
  readonly action: string
  readonly observation: string | null
}

export interface BlindedTrajectoryPrefix {
  readonly rowId: string
  /** The task statement the recorded agent was given. */
  readonly taskStatement: string
  readonly steps: readonly BlindedStep[]
  /** Steps the recording holds. Equal to `steps.length` unless the prefix was
   *  deliberately truncated. */
  readonly recordedSteps: number
  /** Largest k the analyst may name for this prefix. */
  readonly maxK: number
}

export interface BlindTrajectoryOptions {
  /** Truncate the prefix after this 1-based step. Defaults to the whole
   *  recording, which is what the recorded agent itself saw before it stopped. */
  readonly throughStep?: number
}

export function blindTrajectory(
  row: AdmittedRow,
  options: BlindTrajectoryOptions = {},
): BlindedTrajectoryPrefix {
  const through = options.throughStep ?? row.steps.length
  if (!Number.isInteger(through) || through < 1 || through > row.steps.length) {
    throw new ValidationError(
      `blindTrajectory throughStep must be within [1, ${row.steps.length}], got ${through}`,
    )
  }
  const steps = row.steps.slice(0, through).map((step) => ({
    step_id: step.step_id,
    action: step.action,
    observation: step.observation,
  }))
  return {
    rowId: row.rowId,
    taskStatement: row.taskStatement,
    steps,
    recordedSteps: row.steps.length,
    maxK: through,
  }
}

/**
 * Fields an analyst prompt must never carry. Exported so a consumer that
 * builds its own prompt can assert against the same list this module honours.
 */
export const BLINDED_FIELDS: readonly string[] = Object.freeze([
  'criteria',
  'controlRate',
  'controlRollouts',
  'suiteDigest',
  'policyDigest',
  'prefixDivergenceRatio',
  'image',
  'cwd',
])
