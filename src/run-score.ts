export interface RunScore {
  success: number
  goalProgress: number
  repoGroundedness: number
  driftPenalty: number
  toolUseQuality: number
  patchQuality: number
  testReality: number
  finalGate: number
  reviewerBlockers: number
  costUsd: number
  wallSeconds: number
  notes?: string[]
}

export interface RunScoreWeights {
  success: number
  goalProgress: number
  repoGroundedness: number
  driftPenalty: number
  toolUseQuality: number
  patchQuality: number
  testReality: number
  finalGate: number
  reviewerBlockers: number
  costUsd: number
  wallSeconds: number
}

export const DEFAULT_RUN_SCORE_WEIGHTS: RunScoreWeights = {
  success: 4,
  goalProgress: 2,
  repoGroundedness: 1.5,
  driftPenalty: -1.5,
  toolUseQuality: 1,
  patchQuality: 1.25,
  testReality: 1.5,
  finalGate: 3,
  reviewerBlockers: -2,
  costUsd: -0.2,
  wallSeconds: -0.1,
}

export function aggregateRunScore(
  score: RunScore,
  weights: Partial<RunScoreWeights> = {},
): number {
  const w = { ...DEFAULT_RUN_SCORE_WEIGHTS, ...weights }
  return (
    w.success * clamp01(score.success) +
    w.goalProgress * clamp01(score.goalProgress) +
    w.repoGroundedness * clamp01(score.repoGroundedness) +
    w.driftPenalty * clamp01(score.driftPenalty) +
    w.toolUseQuality * clamp01(score.toolUseQuality) +
    w.patchQuality * clamp01(score.patchQuality) +
    w.testReality * clamp01(score.testReality) +
    w.finalGate * clamp01(score.finalGate) +
    w.reviewerBlockers * clamp01(score.reviewerBlockers) +
    w.costUsd * Math.max(0, finiteOrZero(score.costUsd)) +
    w.wallSeconds * Math.max(0, finiteOrZero(score.wallSeconds) / 60)
  )
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0
}
