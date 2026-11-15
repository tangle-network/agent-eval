import { ValidationError } from '../errors'
import { modelHasSnapshot } from '../run-record'
import { modelSnapshotIdentity } from './served-model'

/** Declare model changes as part of the treatment; each arm must serve this exact build. */
export interface ModelTreatment {
  baseline: string
  candidate: string
}

export interface ModelComparisonPair {
  id: string
  baseline: readonly string[]
  candidate: readonly string[]
}

export interface ModelComparison {
  policy: 'matched' | 'treatment'
  treatment?: ModelTreatment
  eligible: boolean
  checkedPairs: number
  /** Both arms reported no agent model. Deterministic campaigns may have no model calls. */
  unreportedPairs: number
  issues: Array<ModelComparisonPair & { reason: string }>
}

/** Capture a declared treatment before search; a floating alias cannot name an experimental arm. */
export function captureModelTreatment(
  treatment: ModelTreatment | undefined,
): ModelTreatment | undefined {
  if (treatment === undefined) return undefined
  if (!modelHasSnapshot(treatment.baseline) || !modelHasSnapshot(treatment.candidate))
    throw new ValidationError('model treatment requires pinned baseline and candidate models')
  return Object.freeze({ baseline: treatment.baseline, candidate: treatment.candidate })
}

/** Compare actual paired identities without dropping the confounded observations. */
export function compareModelIdentities(
  pairs: readonly ModelComparisonPair[],
  treatment?: ModelTreatment,
  requireReported = false,
): ModelComparison {
  treatment = captureModelTreatment(treatment)
  const issues: ModelComparison['issues'] = []
  let unreportedPairs = 0
  for (const pair of pairs) {
    if (
      pair.baseline.length === 0 &&
      pair.candidate.length === 0 &&
      treatment === undefined &&
      !requireReported
    ) {
      unreportedPairs++
      continue
    }
    const baseline = [...new Set(pair.baseline.map(modelSnapshotIdentity))]
    const candidate = [...new Set(pair.candidate.map(modelSnapshotIdentity))]
    // A matched cell may call several models; a declared treatment names one model per arm.
    const reason =
      baseline.length === 0 ||
      candidate.length === 0 ||
      (treatment !== undefined && (baseline.length !== 1 || candidate.length !== 1))
        ? 'each arm needs one unambiguous served model'
        : [...pair.baseline, ...pair.candidate].some((model) => !modelHasSnapshot(model))
          ? 'each served model needs a snapshot identity'
          : treatment !== undefined
            ? baseline[0] === modelSnapshotIdentity(treatment.baseline) &&
              candidate[0] === modelSnapshotIdentity(treatment.candidate)
              ? undefined
              : 'served models differ from the declared model treatment'
            : baseline.sort().join('\n') !== candidate.sort().join('\n')
              ? 'baseline and candidate served different model snapshots'
              : undefined
    if (reason !== undefined) issues.push({ ...pair, reason })
  }
  return {
    policy: treatment === undefined ? 'matched' : 'treatment',
    ...(treatment === undefined ? {} : { treatment }),
    eligible: issues.length === 0,
    checkedPairs: pairs.length - unreportedPairs,
    unreportedPairs,
    issues,
  }
}
