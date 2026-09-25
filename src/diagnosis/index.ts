/**
 * Agent-failure diagnosis: one engine from flat spans plus context to a
 * findings document that validates against diagnosis-findings-v1.
 */

export type {
  PrimeBridgeTransport,
  PrimeBridgeTransportRequest,
  PrimeBridgeTransportResult,
} from '../analyst/prime-bridge-transport'
export { nodeHttpPrimeBridgeTransport } from '../analyst/prime-bridge-transport'
export type { ExecutionFacts } from './deterministic'
export type {
  DiagnosisContext,
  DiagnosisOptions,
  DiagnosisResult,
  DiagnosisUsage,
} from './engine'
export { DEFAULT_MAX_MODEL_TRACES, diagnoseSpans } from './engine'
export type {
  DiagnosisCapability,
  DiagnosisConfidence,
  DiagnosisFinding,
  DiagnosisFindingsDocument,
  DiagnosisMeasure,
  DiagnosisRedaction,
  DiagnosisSeverity,
  DiagnosisSkippedAnalysis,
} from './findings'
export { DIAGNOSIS_FINDINGS_SCHEMA_ID, validateDiagnosisFindings } from './findings'
export type {
  FirstFailure,
  FirstFailureAmbiguous,
  FirstFailureFound,
  FirstFailureNone,
  FirstFailureStage,
} from './first-failure'
export { MAX_FIRST_FAILURE_IDS, rankFirstFailure } from './first-failure'
export type {
  DiagnosisModelOptions,
  ModelQuestion,
  ModelRejection,
  ModelRowNote,
  ModelRunRecord,
} from './model-pass'
export type { DiagnosisSpan, IngestReport } from './spans'
export { epochMillis, ingestSpans, isContentAttribute } from './spans'
