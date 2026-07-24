import {
  type ExternalOptimizerResumeMode,
  type ExternalTextCandidate,
  isExternalTextCandidate,
} from './external-optimizer-process'
import type {
  ExternalOptimizationExample,
  ExternalTextEvaluationResponse,
} from './external-text-evaluation'
import type { OptimizationPackageSource } from './presets/compare-optimization-methods'
import type { CampaignCostMeter, Scenario } from './types'

export interface ExternalTextOptimizerContext {
  readonly runId: string
  readonly name: string
  readonly objective: string
  readonly evaluationId: string
  readonly background?: string
  readonly seedCandidate: ExternalTextCandidate
  readonly trainSet: readonly ExternalOptimizationExample[]
  readonly selectionSet: readonly ExternalOptimizationExample[]
  readonly maxEvaluations: number
  readonly seed: number
  /** Stable directory for optimizer checkpoints from compatible attempts. */
  readonly stateDir: string
  readonly restoreRequested: boolean
  readonly artifactDir: string
  readonly signal: AbortSignal
  /** Record every optimizer-owned paid call through this attributed account. */
  readonly cost: CampaignCostMeter
  readonly evaluate: (
    request: import('./external-optimizer-process').ExternalTextEvaluationRequest,
  ) => Promise<ExternalTextEvaluationResponse>
}

export interface ExternalTextOptimizerResult {
  bestCandidate: ExternalTextCandidate
  resumed: boolean
  costAccounting:
    | { kind: 'metered' }
    | { kind: 'no-paid-work' }
    | { kind: 'external'; reason: string }
}

export interface ExternalOptimizerRunManifest {
  readonly status: 'partial' | 'completed'
  readonly attemptId: string
  readonly revision: number
}

export interface ExternalOptimizerRunManifestEvent {
  readonly runId: string
  readonly attemptId: string
  readonly status: 'partial' | 'completed'
}

/**
 * Configuration for adapting another text optimizer.
 *
 * `run` owns search. Agent Eval owns split isolation, bounded candidate
 * evaluation, exact cost collection, provenance, and final comparison.
 */
export interface ExternalTextOptimizationMethodConfig<
  TScenario extends Scenario,
  TArtifact = unknown,
> {
  name: string
  source: Omit<OptimizationPackageSource, 'evidence'>
  objective: string
  evaluationId: string
  background?: string
  maxEvaluations: number
  /** Hard limit for calls made through `context.cost`. Use 0 for no paid work. */
  maxOptimizerCostUsd: number
  /** Abort `context.signal` after this duration. Default: 30 minutes. */
  timeoutMs?: number
  /** Default: `never`. Compatible runs reuse one state directory. */
  resume?: ExternalOptimizerResumeMode
  maxCandidateChars?: number
  maxEvidenceChars?: number
  describeScenario?: (scenario: TScenario) => unknown
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
  run: (context: ExternalTextOptimizerContext) => Promise<ExternalTextOptimizerResult>
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

export function assertExternalTextOptimizationConfig<TScenario extends Scenario, TArtifact>(
  config: ExternalTextOptimizationMethodConfig<TScenario, TArtifact>,
): void {
  for (const [field, value] of [
    ['name', config.name],
    ['objective', config.objective],
    ['evaluationId', config.evaluationId],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error(`externalTextOptimizationMethod: ${field} must be trimmed and non-empty`)
    }
  }
  if (config.timeoutMs !== undefined && config.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `externalTextOptimizationMethod: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (
    config.background !== undefined &&
    (typeof config.background !== 'string' ||
      !config.background.trim() ||
      config.background.trim() !== config.background)
  ) {
    throw new Error('externalTextOptimizationMethod: background must be trimmed and non-empty')
  }
  if (typeof config.run !== 'function') {
    throw new Error('externalTextOptimizationMethod: run must be a function')
  }
  if (
    config.resume !== undefined &&
    config.resume !== 'never' &&
    config.resume !== 'if-compatible' &&
    config.resume !== 'required'
  ) {
    throw new Error(
      "externalTextOptimizationMethod: resume must be 'never', 'if-compatible', or 'required'",
    )
  }
  for (const [field, value] of [
    ['maxEvaluations', config.maxEvaluations],
    ['timeoutMs', config.timeoutMs],
    ['maxCandidateChars', config.maxCandidateChars],
    ['maxEvidenceChars', config.maxEvidenceChars],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`externalTextOptimizationMethod: ${field} must be a positive safe integer`)
    }
  }
  if (!Number.isFinite(config.maxOptimizerCostUsd) || config.maxOptimizerCostUsd < 0) {
    throw new Error(
      'externalTextOptimizationMethod: maxOptimizerCostUsd must be finite and non-negative',
    )
  }
  if (
    !config.source ||
    config.source.kind !== 'package' ||
    typeof config.source.package !== 'string' ||
    !config.source.package.trim() ||
    config.source.package.trim() !== config.source.package ||
    typeof config.source.version !== 'string' ||
    !config.source.version.trim() ||
    config.source.version.trim() !== config.source.version
  ) {
    throw new Error('externalTextOptimizationMethod: source must identify a package and version')
  }
  for (const [field, value] of [
    ['sourceUrl', config.source.sourceUrl],
    ['revision', config.source.revision],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== 'string' || !value.trim() || value.trim() !== value)
    ) {
      throw new Error(`externalTextOptimizationMethod: source.${field} must be trimmed`)
    }
  }
}

export function snapshotExternalTextOptimizationConfig<TScenario extends Scenario, TArtifact>(
  config: ExternalTextOptimizationMethodConfig<TScenario, TArtifact>,
): ExternalTextOptimizationMethodConfig<TScenario, TArtifact> {
  return {
    ...config,
    source: { ...config.source },
  }
}

export function assertExternalTextOptimizerResult(
  result: unknown,
  name: string,
  maxCandidateChars: number,
  expectsComponents: boolean,
): asserts result is ExternalTextOptimizerResult {
  if (!result || typeof result !== 'object') {
    throw new Error(`${name}: optimizer returned no result`)
  }
  const value = result as Partial<ExternalTextOptimizerResult>
  if (!isExternalTextCandidate(value.bestCandidate)) {
    throw new Error(`${name}: optimizer returned an invalid bestCandidate`)
  }
  const candidateChars =
    typeof value.bestCandidate === 'string'
      ? value.bestCandidate.length
      : JSON.stringify(value.bestCandidate).length
  if (candidateChars > maxCandidateChars) {
    throw new Error(`${name}: optimizer bestCandidate exceeds maxCandidateChars`)
  }
  if (expectsComponents !== (typeof value.bestCandidate !== 'string')) {
    throw new Error(`${name}: optimizer changed the surface kind`)
  }
  if (typeof value.resumed !== 'boolean') {
    throw new Error(`${name}: optimizer returned an invalid resumed flag`)
  }
  assertExternalCostAccounting(value.costAccounting, undefined, name)
}

export function readExternalOptimizerRunManifest(
  text: string | undefined,
  exists: boolean,
  path: string,
  expectedRunId: string,
): ExternalOptimizerRunManifest | undefined {
  if (text === undefined) {
    if (exists) throw new Error(`${path} exists but cannot be read`)
    return undefined
  }
  if (!text?.endsWith('\n')) {
    throw new Error(`${path} is invalid`)
  }

  let current: Omit<ExternalOptimizerRunManifest, 'revision'> | undefined
  const attempts = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (cause) {
      throw new Error(`${path} is invalid`, { cause })
    }
    assertExternalOptimizerRunManifestEvent(value, path, expectedRunId)
    if (value.status === 'partial') {
      if (attempts.has(value.attemptId)) {
        throw new Error(`${path} repeats attempt '${value.attemptId}'`)
      }
      attempts.add(value.attemptId)
      current = { status: value.status, attemptId: value.attemptId }
      continue
    }
    if (current?.status !== 'partial' || current.attemptId !== value.attemptId) {
      throw new Error(`${path} completes an attempt that is not active`)
    }
    current = { status: value.status, attemptId: value.attemptId }
  }
  if (!current) throw new Error(`${path} is invalid`)
  return {
    ...current,
    revision: new TextEncoder().encode(text).byteLength,
  }
}

function assertExternalOptimizerRunManifestEvent(
  value: unknown,
  path: string,
  expectedRunId: string,
): asserts value is ExternalOptimizerRunManifestEvent {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'attemptId,runId,status'
  ) {
    throw new Error(`${path} is invalid`)
  }
  const event = value as Partial<ExternalOptimizerRunManifestEvent>
  if (
    event.runId !== expectedRunId ||
    typeof event.attemptId !== 'string' ||
    !event.attemptId.trim() ||
    event.attemptId.trim() !== event.attemptId ||
    (event.status !== 'partial' && event.status !== 'completed')
  ) {
    throw new Error(`${path} does not match the compatible run`)
  }
}

export function assertExternalCostAccounting(
  value: unknown,
  calls: number | undefined,
  name: string,
): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`${name}: optimizer returned no costAccounting`)
  }
  const accounting = value as Partial<ExternalTextOptimizerResult['costAccounting']>
  if (accounting.kind === 'metered') {
    if (calls === 0) throw new Error(`${name}: metered optimizer recorded no paid calls`)
    return
  }
  if (accounting.kind === 'no-paid-work') {
    if (calls !== undefined && calls > 0) {
      throw new Error(`${name}: no-paid-work optimizer recorded paid calls`)
    }
    return
  }
  if (
    accounting.kind !== 'external' ||
    typeof accounting.reason !== 'string' ||
    !accounting.reason.trim() ||
    accounting.reason.trim() !== accounting.reason
  ) {
    throw new Error(`${name}: optimizer returned invalid costAccounting`)
  }
}
