import type {
  ReferenceReplayCaseRun,
  ReferenceReplayRun,
  ReferenceReplayScenarioScore,
} from './reference-replay'
import type { RunScore } from './run-score'
import type { SteeringBundle } from './steering'
import type { SteeringOptimizationRow } from './steering-optimizer'

export interface ReferenceReplaySteeringRowsOptions<Input = unknown> {
  bundleForRun?: (run: ReferenceReplayRun<Input>) => SteeringBundle
  scoreForCase?: (
    caseRun: ReferenceReplayCaseRun<Input>,
    run: ReferenceReplayRun<Input>,
  ) => RunScore
}

export function referenceReplayRunsToSteeringRows<Input = unknown>(
  runs: ReferenceReplayRun<Input>[],
  options: ReferenceReplaySteeringRowsOptions<Input> = {},
): SteeringOptimizationRow[] {
  const rows: SteeringOptimizationRow[] = []
  for (const run of runs) {
    const variantId = run.variantId ?? run.id
    const bundle = options.bundleForRun?.(run) ?? {
      id: variantId,
      metadata: run.metadata,
    }

    for (const caseRun of run.cases) {
      rows.push({
        variantId,
        scenarioId: caseRun.caseId,
        bundle,
        score:
          options.scoreForCase?.(caseRun, run) ??
          referenceReplayScenarioToRunScore(caseRun.score, caseRun.durationMs),
        metadata: {
          runId: run.id,
          split: caseRun.split,
          task: caseRun.metadata?.task ?? caseRun.metadata?.repo ?? caseRun.caseId,
          referenceCount: caseRun.references.length,
          candidateCount: caseRun.candidates.length,
          matched: caseRun.score.matched,
          total: caseRun.score.total,
          falsePositives: caseRun.score.falsePositives,
          precision: caseRun.score.precision,
          recall: caseRun.score.recall,
          f1: caseRun.score.f1,
          error: caseRun.error,
          ...(caseRun.metadata ?? {}),
        },
      })
    }
  }
  return rows
}

export function referenceReplayScenarioToRunScore(
  scenarioScore: ReferenceReplayScenarioScore,
  durationMs = 0,
): RunScore {
  const success = scenarioScore.f1
  const recall = scenarioScore.recall
  const precision = scenarioScore.precision
  const failed = scenarioScore.total > 0 && scenarioScore.matched === 0

  return {
    success,
    goalProgress: recall,
    repoGroundedness: precision,
    driftPenalty: 1 - precision,
    toolUseQuality: precision,
    patchQuality: 0,
    testReality: scenarioScore.total > 0 ? 1 : 0,
    finalGate: success,
    reviewerBlockers: failed ? 1 : 0,
    costUsd: 0,
    wallSeconds: Math.max(0, durationMs / 1000),
    notes: [
      `reference-replay matched ${scenarioScore.matched}/${scenarioScore.total}`,
      `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} f1=${success.toFixed(3)}`,
    ],
  }
}
