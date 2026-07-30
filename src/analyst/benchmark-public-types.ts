import type { CostLedgerHandle } from '../cost-ledger'
import type { AnalystBenchmarkCase } from './benchmark'
import type { VerificationArtifactManifest } from './benchmark-verification-artifacts'
import type { AnalystRunInputs } from './types'

export type PublicAnalystBenchmarkDataset = 'agentrx' | 'codetracebench'

export interface PublicAnalystBenchmarkModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens: number
  timeoutMs: number
  costLedger?: CostLedgerHandle
  durability?: {
    runIdentitySha256: string
    responseCacheDir: string
  }
  /** Test-only transport injection. */
  fetchImpl?: typeof fetch
}

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
