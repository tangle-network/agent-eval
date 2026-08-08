import type {
  ExternalOptimizerModelCall,
  ExternalOptimizerModelExecutionObservation,
  ExternalOptimizerRunnerCommand,
} from '../campaign/external-optimizer-contracts'
import type { CostLedgerHandle, CustomTokenPricing } from '../cost-ledger'
import type { AnalystBenchmarkCase } from './benchmark'
import type { VerificationArtifactManifest } from './benchmark-verification-artifacts'
import type { AnalystRunInputs } from './types'

export type PublicAnalystBenchmarkDataset = 'agentrx' | 'codetracebench'

/**
 * Caller-supplied replacement for the recursive runner's analyst instructions.
 * Only the `dspy-rlm` runner accepts one; the direct runner rejects it, and the
 * recursive runner's abstention fallback keeps the stock direct prompt. Every
 * recorded protocol digest for an override run binds the stock protocol digest
 * to `sha256`, so an override run is never confusable with a stock run.
 */
export interface AnalystInstructionsOverride {
  /** Complete instruction text used instead of the shipped RLM instructions. */
  readonly text: string
  /** SHA-256 hex digest of `text`. */
  readonly sha256: string
}

/** Model execution supplied by the package that owns credentials and provider policy. */
export interface PublicAnalystBenchmarkModelOwner {
  call: ExternalOptimizerModelCall
  callRef: string
  recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
  /** Exact rates when the selected model is absent from Agent Eval's catalog. */
  pricing?: CustomTokenPricing
}

export interface PublicAnalystBenchmarkModelConfig {
  /** Caller-owned execution path. Agent Eval never receives provider credentials. */
  call: ExternalOptimizerModelCall
  /** Stable public identity for the caller-owned execution path. */
  callRef: string
  /** Persist every finite execution record returned by the caller-owned path. */
  recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
  model: string
  maxOutputTokens: number
  timeoutMs: number
  /** Model request bytes per call. Default: 16 MiB. */
  maxModelRequestBytes?: number
  /** Model response bytes per call. Default: 4 MiB. */
  maxModelResponseBytes?: number
  /** Reasoning tokens billed beyond completion tokens. Default: four times output. */
  maxReasoningTokens?: number
  /** Deadline for one caller-owned model invocation. Default: timeoutMs. */
  modelRequestTimeoutMs?: number
  /** Required when the model is absent from agent-eval's pricing table. */
  pricing?: CustomTokenPricing
  /** Independent per-case recursive-engine spend limit. Default: 1 USD. */
  maxCostUsdPerAnalysis?: number
  /** Replaces the shipped RLM instructions. `dspy-rlm` runner only. */
  instructionsOverride?: AnalystInstructionsOverride
  dspyRlm?: {
    runner?: ExternalOptimizerRunnerCommand
    maxIterations?: number
    maxLlmCalls?: number
    maxToolCalls?: number
    maxOutputChars?: number
    maxModelRequests?: number
    traceToolRequestBytes?: number
    traceToolResponseBytes?: number
    traceToolTimeoutMs?: number
    /**
     * Independent engine runs per case. Above 1 (CodeTraceBench only), the
     * runner scores the step-level majority consensus across all runs instead
     * of a single draw. Default: 1.
     */
    samples?: number
  }
  costLedger?: CostLedgerHandle
  durability?: {
    runIdentitySha256: string
    responseCacheDir: string
  }
}

/**
 * Model settings the benchmark command records in the run identity. The
 * owner-call pair is present exactly when a model-owner module executes the
 * provider calls (`dspy-rlm` and `direct`); the `prime` analyst owns its own
 * cli-bridge transport and never receives an owner call path.
 */
export type PublicAnalystBenchmarkModelSettings = Omit<
  PublicAnalystBenchmarkModelConfig,
  'call' | 'recordExecution'
> &
  Partial<Pick<PublicAnalystBenchmarkModelConfig, 'call' | 'recordExecution'>>

export interface PreparedPublicAnalystBenchmark {
  cases: AnalystBenchmarkCase<AnalystRunInputs>[]
  sourceRowCount: number
  selectedCaseIds: string[]
  labelsSha256: string
  traceFiles: Array<{
    traceId: string
    relativePath: string
    sha256: string
  }>
  verificationArtifacts: VerificationArtifactManifest[]
  selection: PublicBenchmarkSelectionReport
}

export interface PublicBenchmarkValueDistribution {
  total: number
  missing: number
  counts: Record<string, number>
}

export interface PublicBenchmarkDistributions {
  class: PublicBenchmarkValueDistribution
  agent: PublicBenchmarkValueDistribution
  model: PublicBenchmarkValueDistribution
  difficulty: PublicBenchmarkValueDistribution
  solved: PublicBenchmarkValueDistribution
}

export interface PublicBenchmarkSelectionReport {
  method: 'census' | 'deterministic-hash'
  seed: number
  sourceCount: number
  selectedCount: number
  stratified: false
  representativeOfInput: boolean
  source: PublicBenchmarkDistributions
  selected: PublicBenchmarkDistributions
}

export function requiredString(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new TypeError(`${field} must be a non-empty string`)
  return trimmed
}

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

export function safeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} must be a safe integer`)
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
