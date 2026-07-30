import type { ExternalId } from './benchmark-dataset-types'

export function normalizeBenchmarkLabel(value: string): string {
  const normalized = nonEmpty(value, 'benchmark label')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!normalized) throw new TypeError('benchmark label must contain letters or digits')
  return normalized
}

export function predictionConfidence(value: number | undefined): number {
  const confidence = value ?? 0.5
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError('upstream prediction confidence must be between 0 and 1')
  }
  return confidence
}

export function assertStepWithinRange(
  step: number,
  stepCount: number | undefined,
  field: string,
): void {
  if (stepCount === undefined) return
  const count = positiveStep(stepCount, `${field} stepCount`)
  if (step > count) throw new RangeError(`${field} step ${step} exceeds stepCount ${count}`)
}

export function defaultStepUri(trajectoryId: string, step: number): string {
  return `trace://${encodeURIComponent(trajectoryId)}/span/step-${step}`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function positiveStep(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

export function externalId(value: ExternalId | undefined, field: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${field} must be a string or number`)
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer when numeric`)
  }
  return nonEmpty(String(value), field)
}

export function nonEmpty(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} must not be empty`)
  return value
}
