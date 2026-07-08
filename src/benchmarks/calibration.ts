import type { BenchmarkAdapter, BenchmarkDatasetItem, BenchmarkEvaluation } from './types'

export interface BenchmarkMetricCalibrationOptions<TPayload = unknown, TArtifact = string> {
  adapter: BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, TArtifact>
  item: BenchmarkDatasetItem<TPayload>
  weakArtifact: TArtifact
  strongArtifact: TArtifact
  maxWeakScore?: number
  minStrongScore?: number
  minGap?: number
}

export interface BenchmarkMetricCalibrationResult {
  passed: boolean
  weak: BenchmarkEvaluation
  strong: BenchmarkEvaluation
  weakScore: number
  strongScore: number
  gap: number
  reasons: string[]
}

export async function calibrateBenchmarkMetric<TPayload = unknown, TArtifact = string>(
  options: BenchmarkMetricCalibrationOptions<TPayload, TArtifact>,
): Promise<BenchmarkMetricCalibrationResult> {
  const weak = await options.adapter.evaluate(options.item, options.weakArtifact)
  const strong = await options.adapter.evaluate(options.item, options.strongArtifact)
  const weakScore = clamp01(weak.score)
  const strongScore = clamp01(strong.score)
  const maxWeakScore = options.maxWeakScore ?? 0.3
  const minStrongScore = options.minStrongScore ?? 0.7
  const minGap = options.minGap ?? 0.4
  const gap = strongScore - weakScore
  const reasons = [
    weakScore <= maxWeakScore
      ? undefined
      : `weak score ${weakScore.toFixed(3)} exceeds max ${maxWeakScore.toFixed(3)}`,
    strongScore >= minStrongScore
      ? undefined
      : `strong score ${strongScore.toFixed(3)} below min ${minStrongScore.toFixed(3)}`,
    gap >= minGap ? undefined : `gap ${gap.toFixed(3)} below min ${minGap.toFixed(3)}`,
  ].filter((reason): reason is string => Boolean(reason))

  return {
    passed: reasons.length === 0,
    weak,
    strong,
    weakScore,
    strongScore,
    gap,
    reasons,
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
