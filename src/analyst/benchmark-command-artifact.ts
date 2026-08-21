import type { CustomTokenPricing } from '../cost-ledger'
import { canonicalString, hashCanonical, jsonDocument } from '../ledger-core/canonical'
import type { AnalystBenchmarkObservation, AnalystBenchmarkResult } from './benchmark'
import type { AgentRxCalibrationSummary } from './benchmark-agentrx-calibration'
import type { AnalystRunnerComparison } from './benchmark-comparison'
import type { CodeTraceCalibrationSummary } from './benchmark-public-calibration'
import type {
  PublicAnalystBenchmarkDataset,
  PublicBenchmarkSelectionReport,
} from './benchmark-real-model'
import type { VerificationArtifactManifest } from './benchmark-verification-artifacts'

export { assertAnalystBenchmarkObservation } from './benchmark-command-validation'

export interface AnalystBenchmarkArtifact {
  kind: 'agent-eval/analyst-benchmark-result'
  runIdentitySha256: string
  inputs: {
    dataset: PublicAnalystBenchmarkDataset
    datasetRevision: string
    datasetSplit: string
    labelsSha256: string
    sourceRowCount: number
    traceFiles: Array<{ traceId: string; relativePath: string; sha256: string }>
    verificationArtifacts: VerificationArtifactManifest[]
    verificationAvailability: VerificationAvailabilitySummary
    selection: {
      limit: number
      seed: number
      selectedCaseIds: string[]
      report: PublicBenchmarkSelectionReport
    }
    execution: {
      repetitions: number
      concurrency: number
      /** Absent on artifacts produced before consensus sampling existed. */
      rlmSamples?: number
      model: string
      /** These fields are absent only on immutable evidence produced before model owners existed. */
      modelOwnerCallRef?: string
      maxOutputTokens: number
      maxReasoningTokens?: number
      maxModelRequestBytes?: number
      maxModelResponseBytes?: number
      modelRequestTimeoutMs?: number
      timeoutMs: number
      pricing?: CustomTokenPricing
      recursiveLimits?: {
        maxIterations: number
        maxLlmCalls: number
        maxToolCalls: number
        maxOutputChars: number
        maxModelRequests: number | null
        traceToolRequestBytes: number
        traceToolResponseBytes: number
        traceToolTimeoutMs: number
      }
      processLimits?: {
        maxInputBytes: number
        maxResultBytes: number
        maxOutputChars: number
      }
      maxCostUsd: number
      maxArtifactBytes: number
      analystProtocolSha256: string
      /** Present only when the run replaced the recursive analyst instructions. */
      instructionsOverrideSha256?: string
      implementationSha256: string
      dependencyLockSha256: string
    }
  }
  result: AnalystBenchmarkResult
  comparisons: AnalystRunnerComparison[]
  codeTraceCalibration?: CodeTraceCalibrationSummary
  agentRxCalibration?: AgentRxCalibrationSummary
}

export interface VerificationAvailabilitySummary {
  cases: number
  resultFilesPresent: number
  resultFilesMissing: number
  outcomes: {
    passed: number
    failed: number
    unavailable: number
  }
}

export interface AnalystBenchmarkRunIdentity {
  config: {
    dataset: PublicAnalystBenchmarkDataset
    datasetRevision: string
    datasetSplit: string
    model: {
      id: string
      ownerCallRef: string
      maxOutputTokens: number
      maxReasoningTokens: number
      maxRequestBytes: number
      maxResponseBytes: number
      requestTimeoutMs: number
      timeoutMs: number
      pricing: CustomTokenPricing
      recursiveLimits: {
        maxIterations: number
        maxLlmCalls: number
        maxToolCalls: number
        maxOutputChars: number
        maxModelRequests: number | null
        traceToolRequestBytes: number
        traceToolResponseBytes: number
        traceToolTimeoutMs: number
      }
      processLimits: {
        maxInputBytes: number
        maxResultBytes: number
        maxOutputChars: number
      }
    }
    limit: number
    seed: number
    concurrency: number
    repetitions: number
    /** Absent on manifests written before consensus sampling existed. */
    rlmSamples?: number
    maxCostUsd: number
    maxArtifactBytes: number
    analystProtocolSha256: string
    /** Present only when the run replaced the recursive analyst instructions. */
    instructionsOverrideSha256?: string
    implementationSha256: string
    dependencyLockSha256: string
    runnerIds: readonly ['empty', string]
  }
  inputs: {
    labelsSha256: string
    sourceRowCount: number
    selectedCaseIds: string[]
    traceFiles: Array<{ traceId: string; relativePath: string; sha256: string }>
    verificationArtifactsSha256: string
    caseDefinitionsSha256: string
  }
}

export interface AnalystBenchmarkRunManifest {
  kind: 'agent-eval/analyst-benchmark-run'
  createdAt: string
  identitySha256: string
  localIdentitySha256: string
  identity: AnalystBenchmarkRunIdentity
}

export interface AnalystBenchmarkLocalRunReceipt {
  kind: 'agent-eval/analyst-benchmark-local-run'
  runIdentitySha256: string
  localIdentitySha256: string
  local: {
    labelsPath: string
    traceDir: string
    artifactDir?: string
    outputDir: string
    /** Absent when the analyst owns its own transport (`prime`). */
    modelOwnerModule?: string
  }
  command: string
  environment: {
    node: string
    platform: string
    arch: string
  }
  files: {
    manifest: string
    observations: string
    costLedger: string
    modelResponses: string
    result: string
    report: string
  }
}

export interface AnalystBenchmarkProgressRow {
  sequence: number
  runIdentitySha256: string
  previousRowSha256: string | null
  observation: AnalystBenchmarkObservation
  rowSha256: string
}

export const ANALYST_BENCHMARK_MANIFEST_FILE = 'manifest.json'
export const ANALYST_BENCHMARK_OBSERVATIONS_FILE = 'observations.jsonl'
export const ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE = 'run.local.json'
export const ANALYST_BENCHMARK_COST_LEDGER_FILE = 'cost-ledger.jsonl'

export function observationKey(observation: {
  runnerId: string
  caseId: string
  repetition: number
}): string {
  return `${observation.runnerId}\u0000${observation.caseId}\u0000${observation.repetition}`
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`invalid JSON in ${source}`)
  }
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed)
  const optionalSet = new Set(optional)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${context} contains unknown field '${key}'`)
  }
  for (const key of allowed) {
    if (!optionalSet.has(key) && !(key in value)) {
      throw new TypeError(`${context} is missing field '${key}'`)
    }
  }
}

/**
 * Digest a benchmark receipt as the artifact file will carry it. Receipts are
 * digested before they are written and re-digested when they are read back, so
 * the digest covers the JSON document form (see {@link jsonDocument}); every
 * other ambiguous value is still refused.
 */
export function digestCanonical(value: unknown): string {
  return hashCanonical(jsonDocument(value)).slice('sha256:'.length)
}

/** RFC 8785 canonical JSON of the value's JSON document form — the byte form
 *  the receipt digests and compares against. */
export function canonicalJson(value: unknown): string {
  return canonicalString(jsonDocument(value))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

export function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
