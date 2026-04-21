/**
 * Reward-model export — the productizable wrapper around PRM training
 * data. Takes a TraceStore + PrmGrader, produces an embeddable
 * inference scorer that customers plug into their own agent stack.
 *
 * Two export forms:
 *   - `exportRewardModel(store, graders)` — serializes the (step-context,
 *     score) corpus to a framework-agnostic payload. Customer fine-tunes
 *     their own model; we ship the scaffolding.
 *   - `loadScorerFromTraces(store, grader)` — a zero-deps "reward model"
 *     that literally replays the trained rubric at inference time. Works
 *     as a reference baseline + deterministic fallback.
 */

import type { PrmGrader, PrmGradedTrace } from './prm/rubric'
import type { Trajectory } from './trajectory'
import { buildTrajectory } from './trajectory'
import { exportTrainingData, toNdjson, type PrmTrainingSample } from './prm/training-export'
import type { TraceStore } from './trace/store'

export interface ExportedRewardModel {
  /** Version of the export format. Bump when payload shape changes. */
  version: '1.0'
  /** Metadata about the training corpus. */
  metadata: {
    nTraces: number
    nSamples: number
    rubrics: string[]
    exportedAt: string
    /** Mean reward across training corpus — use as sanity check at load. */
    meanReward: number
  }
  /** NDJSON training payload suitable for most fine-tuning frameworks. */
  trainingNdjson: string
}

export async function exportRewardModel(
  store: TraceStore,
  grader: PrmGrader,
  runIds: string[],
): Promise<ExportedRewardModel> {
  const graded = await Promise.all(runIds.map((id) => grader.grade(store, id)))
  const samples = await exportTrainingData(store, graded)
  const rubrics = [...new Set(samples.map((s) => s.rubricId))]
  const meanReward =
    samples.length > 0
      ? samples.reduce((a, s) => a + s.score, 0) / samples.length
      : 0
  return {
    version: '1.0',
    metadata: {
      nTraces: graded.length,
      nSamples: samples.length,
      rubrics,
      exportedAt: new Date().toISOString(),
      meanReward,
    },
    trainingNdjson: toNdjson(samples),
  }
}

/**
 * Zero-deps inference scorer — apply a grader to a trajectory and return
 * its aggregate score. This is the "reward model" customers embed when
 * they don't want (or can't) fine-tune one. Deterministic + portable.
 */
export interface InferenceScorer {
  /** Score a completed trajectory. Higher is better. */
  score(trajectory: Trajectory, store: TraceStore): Promise<number>
  metadata: { rubrics: string[]; deterministic: true }
}

export function loadScorerFromGrader(grader: PrmGrader): InferenceScorer {
  return {
    async score(trajectory, store) {
      const graded = await grader.grade(store, trajectory.runId)
      return graded.aggregateScore
    },
    metadata: {
      rubrics: ['grader-backed'],
      deterministic: true,
    },
  }
}

/**
 * Replay a trace corpus through a scorer — produces the canonical
 * "what would this reward model have said about every run?" table.
 * Callers use this to validate a trained model against the training
 * corpus (expect high agreement; drift indicates overfitting).
 */
export async function replayScorerOverCorpus(
  store: TraceStore,
  scorer: InferenceScorer,
  runIds: string[],
): Promise<Array<{ runId: string; score: number; outcomeScore: number | null }>> {
  return Promise.all(
    runIds.map(async (runId) => {
      const [trajectory, run] = await Promise.all([buildTrajectory(store, runId), store.getRun(runId)])
      return {
        runId,
        score: await scorer.score(trajectory, store),
        outcomeScore: run?.outcome?.score ?? null,
      }
    }),
  )
}

// Re-export for ergonomics
export type { PrmTrainingSample, PrmGradedTrace }
