/** Candidate execution and paired measurement input/output contracts. */

import type {
  AgentCandidateBenchmarkCellRef,
  AgentCandidateBenchmarkTask,
  AgentCandidateBundle,
  AgentCandidateEvaluationPolicy,
  AgentCandidateExperiment,
  AgentCandidateExperimentMeasurement,
  AgentImprovementCost,
  AgentImprovementMeasuredComparison,
  CandidateExecutionEvidence,
} from '@tangle-network/agent-interface'
import type { CostLedgerHandle } from '../cost-ledger'

export interface SealCandidateBenchmarkSuiteOptions {
  tasks: [AgentCandidateBenchmarkTask, ...AgentCandidateBenchmarkTask[]]
  reps: number
  seeds: [number, ...number[]]
}

export interface CandidateExperimentExecutionInput {
  experiment: AgentCandidateExperiment
  arm: 'baseline' | 'candidate'
  bundle: AgentCandidateBundle
  task: AgentCandidateBenchmarkTask
  benchmarkCell: AgentCandidateBenchmarkCellRef
  seed: number
  signal?: AbortSignal
}

export interface RunCandidateExperimentOptions {
  experiment: AgentCandidateExperiment
  execute(input: CandidateExperimentExecutionInput): Promise<CandidateExecutionEvidence>
  /** Maximum number of simultaneous execute calls across both arms. */
  maxConcurrency?: number
  /** Shared run budget that also accounts for analysis and candidate search. */
  costLedger?: CostLedgerHandle
  signal?: AbortSignal
}

export interface CandidateExperimentRun {
  measurements: AgentCandidateExperimentMeasurement[]
  measurement: {
    wallDurationMs: number
    cost: AgentImprovementCost
  }
}

export interface CompareCandidateExperimentOptions {
  experiment: AgentCandidateExperiment
  measurements: AgentCandidateExperimentMeasurement[]
  preparation: {
    wallDurationMs: number
    cost: AgentImprovementCost
  }
  measurement: CandidateExperimentRun['measurement']
  runId: string
  candidate?: AgentImprovementMeasuredComparison['candidate']
  generationsExplored?: number
  metadata?: AgentImprovementMeasuredComparison['metadata']
}

/** One exact baseline/candidate observation of the same held-out cell. */
export interface PairedMeasurement<TRun> {
  cellId: string
  baseline: TRun
  candidate: TRun
}

/** Maps a product-owned run receipt into the measurements required for a fair paired decision. */
export interface PairedMeasurementAdapter<TRun> {
  score(run: TRun): number
  dimensions(run: TRun): readonly { name: string; score: number }[]
  costUsd(run: TRun): number
  costProvenance(run: TRun): AgentImprovementCost['provenance']
  latencyMs(run: TRun): number
  completed(run: TRun): boolean
  passed(run: TRun): boolean
}

export interface EvaluatePairedMeasurementsOptions<TRun> {
  measurements: readonly PairedMeasurement<TRun>[]
  policy: AgentCandidateEvaluationPolicy
  adapter: PairedMeasurementAdapter<TRun>
  /** Whether both arms use the same scorer family as the promotion decision. */
  sharedScorerChannel: boolean
  /** Analysis and candidate-search spend that belongs to the same frozen budget. */
  preparationCost?: AgentImprovementCost
  /** Settled aggregate receipt for this exact paired suite, when an executor provides one. */
  measurementCost?: AgentImprovementCost
}

/** Statistical and operational result derived from complete paired receipts. */
export type PairedMeasurementEvaluation = Pick<
  AgentImprovementMeasuredComparison,
  'overall' | 'objectives' | 'decision' | 'power'
> & {
  measurementCost: AgentImprovementCost
  totalCost: AgentImprovementCost
  measurementWorkDurationMs: number
}
