/** Shared accounting and replay inputs for measured comparison records. */

import type { AgentImprovementMeasuredComparison } from '@tangle-network/agent-interface'
import type {
  CompareCandidateExperimentOptions,
  PairedMeasurementEvaluation,
} from './measured-comparison-types'

type ComparisonPhase = CompareCandidateExperimentOptions['preparation']

/** Keep published timing and cost accounting identical across experiment domains. */
export function comparisonEvaluation(
  options: Pick<
    CompareCandidateExperimentOptions,
    'generationsExplored' | 'preparation' | 'measurement'
  >,
  evaluation: Pick<
    PairedMeasurementEvaluation,
    'measurementWorkDurationMs' | 'measurementCost' | 'totalCost'
  >,
): AgentImprovementMeasuredComparison['evaluation'] {
  return {
    generationsExplored: options.generationsExplored ?? 0,
    preparation: options.preparation,
    measurement: {
      wallDurationMs: options.measurement.wallDurationMs,
      workDurationMs: evaluation.measurementWorkDurationMs,
      cost: evaluation.measurementCost,
    },
    total: {
      wallDurationMs: options.preparation.wallDurationMs + options.measurement.wallDurationMs,
      cost: evaluation.totalCost,
    },
  }
}

/** Replay only the original inputs; derived timing and statistics are recomputed. */
export function comparisonRecomputationInput<
  TExperiment,
  TMeasurement,
  TCandidate,
  TMetadata,
>(comparison: {
  experiment: TExperiment
  measurements: TMeasurement[]
  provenance: { runId: string }
  candidate?: TCandidate
  metadata?: TMetadata
  evaluation: {
    generationsExplored: number
    preparation: ComparisonPhase
    measurement: ComparisonPhase
  }
}) {
  return {
    experiment: comparison.experiment,
    measurements: comparison.measurements,
    runId: comparison.provenance.runId,
    ...(comparison.candidate ? { candidate: comparison.candidate } : {}),
    generationsExplored: comparison.evaluation.generationsExplored,
    preparation: comparison.evaluation.preparation,
    measurement: {
      wallDurationMs: comparison.evaluation.measurement.wallDurationMs,
      cost: comparison.evaluation.measurement.cost,
    },
    ...(comparison.metadata ? { metadata: comparison.metadata } : {}),
  }
}
