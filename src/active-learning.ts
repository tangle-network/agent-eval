/**
 * Active learning — agent-as-scenario-author.
 *
 * Analyzes an existing Dataset + trace corpus for coverage gaps and
 * weak spots, returns a prioritized list of *synthesis targets*:
 * (gap description, existing-neighbor examples, suggested direction).
 *
 * Does NOT call an LLM itself — the proposer agent is caller-supplied.
 * This module's job is to identify WHERE new scenarios would compound
 * the most information, not to author them.
 *
 * Gaps we detect:
 *   - dimensions with high score variance (unstable, need more data)
 *   - dimensions with low coverage count (undersampled)
 *   - failure classes with clusters (systematic weakness)
 *   - difficulty bins with no coverage
 */

import type { Dataset, DatasetScenario } from './dataset'
import { classifyFailure } from './failure-taxonomy'
import type { Run } from './trace/schema'
import type { TraceStore } from './trace/store'

export type SynthesisReason =
  | 'high-variance'
  | 'undersampled'
  | 'failure-cluster'
  | 'difficulty-gap'

export interface SynthesisTarget {
  reason: SynthesisReason
  description: string
  /** Existing scenarios that are closest to the gap; caller feeds these to
   *  their LLM proposer as few-shot examples. */
  neighbors: DatasetScenario[]
  /** Suggested direction — e.g. "harder variants", "edge cases of X", "failure class Y". */
  direction: string
  /** Priority score — higher = more information-dense gap. 0..1. */
  priority: number
}

export interface ActiveLearningOptions {
  /** Minimum scenarios per difficulty band to count as "covered". */
  minPerBand?: number
  /** Variance threshold above which a scenario's dimension is "unstable". */
  varianceThreshold?: number
  /** Max synthesis targets returned. */
  topK?: number
}

export async function proposeSynthesisTargets(
  dataset: Dataset,
  traceStore: TraceStore,
  options: ActiveLearningOptions = {},
): Promise<SynthesisTarget[]> {
  const minPerBand = options.minPerBand ?? 5
  const varianceThreshold = options.varianceThreshold ?? 0.05
  const topK = options.topK ?? 10
  const scenarios = dataset.all()

  const targets: SynthesisTarget[] = []

  // 1. Difficulty coverage gaps
  const BANDS: Array<DatasetScenario['difficulty']> = ['easy', 'medium', 'hard', 'extreme']
  for (const band of BANDS) {
    const count = scenarios.filter((s) => s.difficulty === band).length
    if (count < minPerBand) {
      const neighbors = scenarios.filter((s) => s.difficulty === band).slice(0, 3)
      targets.push({
        reason: 'difficulty-gap',
        description: `difficulty="${band}" has ${count} scenario(s) — below minimum ${minPerBand}`,
        neighbors: [...neighbors],
        direction: `create more "${band}" scenarios; reuse domain but shift complexity`,
        priority: Math.max(0, 1 - count / minPerBand),
      })
    }
  }

  // 2. Undersampled scenarios (few runs per scenario)
  const runs = await traceStore.listRuns()
  const runCountByScenario = new Map<string, number>()
  for (const r of runs) {
    runCountByScenario.set(r.scenarioId, (runCountByScenario.get(r.scenarioId) ?? 0) + 1)
  }
  const runCounts = [...runCountByScenario.values()]
  const p25 = runCounts.length > 0 ? quantile(runCounts, 0.25) : 0
  for (const s of scenarios) {
    const count = runCountByScenario.get(s.id) ?? 0
    if (count <= p25 && count < 3) {
      targets.push({
        reason: 'undersampled',
        description: `scenario "${s.id}" has only ${count} run(s)`,
        neighbors: [s],
        direction: `create near-duplicates of "${s.id}" to stabilize its mean`,
        priority: Math.max(0, 1 - count / 3) * 0.7,
      })
    }
  }

  // 3. High-variance scenarios (same scenario scored inconsistently)
  for (const s of scenarios) {
    const sRuns = runs.filter((r) => r.scenarioId === s.id)
    const scores = sRuns
      .map((r) => r.outcome?.score)
      .filter((x): x is number => typeof x === 'number')
    if (scores.length < 3) continue
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length
    if (variance > varianceThreshold) {
      targets.push({
        reason: 'high-variance',
        description: `scenario "${s.id}" has unstable scoring (variance ${variance.toFixed(3)})`,
        neighbors: [s],
        direction: `disambiguate the scenario description — current wording admits too many valid interpretations`,
        priority: Math.min(1, variance * 5),
      })
    }
  }

  // 4. Failure-class clusters — run classifier across the corpus
  const failureByClass = new Map<string, Run[]>()
  for (const run of runs) {
    if (run.outcome?.pass === true) continue
    const spans = await traceStore.spans({ runId: run.runId })
    const events = await traceStore.events({ runId: run.runId })
    const { failureClass } = classifyFailure({ run, spans, events })
    if (failureClass === 'success' || failureClass === 'unknown') continue
    const arr = failureByClass.get(failureClass) ?? []
    arr.push(run)
    failureByClass.set(failureClass, arr)
  }
  for (const [cls, runs] of failureByClass) {
    if (runs.length < 3) continue
    const affectedScenarios = [...new Set(runs.map((r) => r.scenarioId))]
    const neighbors = scenarios.filter((s) => affectedScenarios.includes(s.id)).slice(0, 3)
    targets.push({
      reason: 'failure-cluster',
      description: `failure class "${cls}" observed ${runs.length}× across ${affectedScenarios.length} scenario(s)`,
      neighbors,
      direction: `create scenarios that exercise "${cls}" recovery — currently a systematic weakness`,
      priority: Math.min(1, runs.length / 10),
    })
  }

  return targets.sort((a, b) => b.priority - a.priority).slice(0, topK)
}

function quantile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = p * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}
