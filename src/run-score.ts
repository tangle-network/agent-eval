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

export type RunScoreWeights = Omit<RunScore, 'notes'>

const DEFAULT_RUN_SCORE_WEIGHTS: RunScoreWeights = {
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

export function aggregateRunScore(score: RunScore, weights: Partial<RunScoreWeights> = {}): number {
  const w = { ...DEFAULT_RUN_SCORE_WEIGHTS, ...weights }
  return (Object.keys(DEFAULT_RUN_SCORE_WEIGHTS) as Array<keyof RunScoreWeights>)
    .map(
      (key) =>
        w[key] *
        (key === 'costUsd' || key === 'wallSeconds'
          ? Math.max(0, finiteOrZero(score[key]) / (key === 'wallSeconds' ? 60 : 1))
          : clamp01(score[key])),
    )
    .reduce((sum, term) => sum + term)
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finiteOrZero(value)))
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0
}
