import type { EvidenceRef } from './types'

export type ExternalId = string | number

export interface AgentRxFailure {
  failure_id: ExternalId
  step_number: number
  step_reason: string
  failure_category: string
  category_reason?: string
  failed_agent?: string
}

export interface AgentRxRow {
  trajectory_id: ExternalId
  failures: readonly AgentRxFailure[]
  root_cause?: { failure_id: ExternalId; reason_for_root_cause?: string }
  root_cause_failure_id?: ExternalId
  root_cause_reason?: string
  failure_summary?: string
  num_failures?: number
}

export interface AgentRxPrediction {
  task_id?: ExternalId
  failure_case: number | string
  step_number: number
  description?: string
  checklist_reasoning?: string | null
}

export interface AgentRxPredictionReport {
  task_id?: ExternalId
  failures: readonly AgentRxPrediction[]
  num_judges?: number
  trajectory_length?: number
  most_common_failure?: number | string
  modes?: readonly (number | string)[]
  step_mean?: number
}

export interface CodeTraceStageAnnotation {
  stage_id: number
  incorrect_step_ids?: readonly number[]
  unuseful_step_ids?: readonly number[]
  reasoning?: string
}

export interface CodeTracerStepLabel {
  step_id: number
  stage?: string | number
  stage_name?: string | number
  stage_id?: string | number
  label: 'incorrect' | 'unuseful'
  rationale?: string
  reason?: string
  note?: string
  comment?: string
}

export interface CodeTracerLabelGroup {
  stage?: string | number
  stage_name?: string | number
  stage_id?: string | number
  labels: readonly CodeTracerStepLabel[]
}

export type CodeTracerPredictions =
  | string
  | readonly CodeTraceStageAnnotation[]
  | readonly CodeTracerStepLabel[]
  | readonly CodeTracerLabelGroup[]

export interface CodeTraceBenchRow {
  traj_id: string
  agent: string
  model: string
  task_name: string
  /** Native artifact extraction path in the public CodeTraceBench manifest. */
  source_relpath?: string
  difficulty?: string
  category?: string
  tags?: string | readonly string[]
  solved?: boolean | null
  step_count: number
  incorrect_stages: string | readonly CodeTraceStageAnnotation[]
}

export interface StepLabelAdapterOptions {
  evidenceKind?: EvidenceRef['kind']
  stepUri?: (trajectoryId: string, step: number) => string
}

export type CodeTraceBenchLabelSet = 'incorrect-only' | 'incorrect-and-unuseful'

export interface CodeTraceBenchLabelOptions {
  /**
   * CodeTraceBench's published metric scores incorrect steps only.
   * Include unuseful steps only for an explicitly combined experiment.
   */
  labelSet?: CodeTraceBenchLabelSet
}

export interface CodeTraceBenchCaseOptions
  extends StepLabelAdapterOptions,
    CodeTraceBenchLabelOptions {}

export interface AgentRxBenchmarkCaseOptions extends StepLabelAdapterOptions {
  stepCount?: number
  /** AgentRx's published task is root-cause localization. */
  target?: 'root-cause' | 'all-failures'
}

export interface UpstreamPredictionAdapterOptions extends StepLabelAdapterOptions {
  analystId?: string
  producedAt?: string
  confidence?: number
  stepCount?: number
}

export interface CodeTracerPredictionAdapterOptions
  extends UpstreamPredictionAdapterOptions,
    CodeTraceBenchLabelOptions {}
