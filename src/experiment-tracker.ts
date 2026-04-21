/**
 * Experiment tracker — group runs, diff them, watch scores move over time.
 *
 * Not MLflow. Not Weights & Biases. Just the 20% that actually ships:
 *   - A run has a config (prompt hash, model, scenario ids, seed)
 *   - Runs belong to experiments (named groups)
 *   - The store is pluggable (in-memory for tests, filesystem for local,
 *     custom for Langfuse/D1)
 *   - Diffs show score deltas, new/dropped scenarios, and config changes
 *
 * The output plugs directly into `BenchmarkReport` — runs archive the full
 * report, diff operates on the summary.
 */

import type { BenchmarkReport } from './types'

export interface RunConfig {
  experimentId: string
  name?: string
  model?: string
  promptHash?: string
  promptVersion?: string
  seed?: number
  metadata?: Record<string, unknown>
}

export interface Run {
  id: string
  experimentId: string
  name?: string
  config: RunConfig
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed'
  report?: BenchmarkReport
  error?: string
}

export interface Experiment {
  id: string
  name: string
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface ExperimentStore {
  saveExperiment(exp: Experiment): Promise<void>
  getExperiment(id: string): Promise<Experiment | null>
  listExperiments(): Promise<Experiment[]>
  saveRun(run: Run): Promise<void>
  getRun(id: string): Promise<Run | null>
  listRuns(experimentId: string): Promise<Run[]>
}

export class InMemoryExperimentStore implements ExperimentStore {
  private readonly experiments = new Map<string, Experiment>()
  private readonly runs = new Map<string, Run>()

  async saveExperiment(exp: Experiment): Promise<void> {
    this.experiments.set(exp.id, { ...exp })
  }
  async getExperiment(id: string): Promise<Experiment | null> {
    const e = this.experiments.get(id)
    return e ? { ...e } : null
  }
  async listExperiments(): Promise<Experiment[]> {
    return [...this.experiments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async saveRun(run: Run): Promise<void> {
    this.runs.set(run.id, structuredClone(run))
  }
  async getRun(id: string): Promise<Run | null> {
    const r = this.runs.get(id)
    return r ? structuredClone(r) : null
  }
  async listRuns(experimentId: string): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((r) => r.experimentId === experimentId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => structuredClone(r))
  }
}

// ---------------------------------------------------------------------------
// The tracker itself
// ---------------------------------------------------------------------------

export class ExperimentTracker {
  constructor(private readonly store: ExperimentStore) {}

  async startExperiment(name: string, metadata?: Record<string, unknown>): Promise<Experiment> {
    const exp: Experiment = {
      id: `exp_${rand(8)}`,
      name,
      createdAt: new Date().toISOString(),
      metadata,
    }
    await this.store.saveExperiment(exp)
    return exp
  }

  async startRun(config: RunConfig): Promise<Run> {
    const exp = await this.store.getExperiment(config.experimentId)
    if (!exp) throw new Error(`Experiment ${config.experimentId} not found`)

    const run: Run = {
      id: `run_${rand(10)}`,
      experimentId: config.experimentId,
      name: config.name,
      config,
      startedAt: new Date().toISOString(),
      status: 'running',
    }
    await this.store.saveRun(run)
    return run
  }

  async completeRun(runId: string, report: BenchmarkReport): Promise<void> {
    const run = await this.store.getRun(runId)
    if (!run) throw new Error(`Run ${runId} not found`)
    run.status = 'completed'
    run.completedAt = new Date().toISOString()
    run.report = report
    await this.store.saveRun(run)
  }

  async failRun(runId: string, error: string): Promise<void> {
    const run = await this.store.getRun(runId)
    if (!run) throw new Error(`Run ${runId} not found`)
    run.status = 'failed'
    run.completedAt = new Date().toISOString()
    run.error = error
    await this.store.saveRun(run)
  }

  /**
   * Diff two completed runs. Returns per-scenario deltas, aggregate delta,
   * and config changes that may explain the movement.
   */
  async diff(runIdA: string, runIdB: string): Promise<RunDiff> {
    const [a, b] = await Promise.all([this.store.getRun(runIdA), this.store.getRun(runIdB)])
    if (!a || !b) throw new Error('Both runs must exist')
    if (!a.report || !b.report) throw new Error('Both runs must be completed with reports')

    const byScenarioA = new Map(a.report.results.map((r) => [r.scenarioId, r.overallScore]))
    const byScenarioB = new Map(b.report.results.map((r) => [r.scenarioId, r.overallScore]))

    const scenarioIds = new Set([...byScenarioA.keys(), ...byScenarioB.keys()])
    const scenarios: RunDiff['scenarios'] = []
    for (const id of scenarioIds) {
      const aScore = byScenarioA.get(id)
      const bScore = byScenarioB.get(id)
      if (aScore === undefined) {
        scenarios.push({ scenarioId: id, before: null, after: bScore!, delta: null, status: 'added' })
      } else if (bScore === undefined) {
        scenarios.push({ scenarioId: id, before: aScore, after: null, delta: null, status: 'removed' })
      } else {
        scenarios.push({
          scenarioId: id,
          before: aScore,
          after: bScore,
          delta: bScore - aScore,
          status: bScore > aScore ? 'improved' : bScore < aScore ? 'regressed' : 'unchanged',
        })
      }
    }
    scenarios.sort((x, y) => (y.delta ?? 0) - (x.delta ?? 0))

    const aggregateDelta = b.report.summary.overallAvg - a.report.summary.overallAvg
    const configChanges: Record<string, { before: unknown; after: unknown }> = {}
    const keys = new Set([...Object.keys(a.config), ...Object.keys(b.config)])
    const aCfg = a.config as unknown as Record<string, unknown>
    const bCfg = b.config as unknown as Record<string, unknown>
    for (const k of keys) {
      if (JSON.stringify(aCfg[k]) !== JSON.stringify(bCfg[k])) {
        configChanges[k] = { before: aCfg[k], after: bCfg[k] }
      }
    }

    return {
      before: { runId: runIdA, name: a.name, startedAt: a.startedAt },
      after: { runId: runIdB, name: b.name, startedAt: b.startedAt },
      aggregateDelta,
      scenarios,
      configChanges,
    }
  }

  /** Timeline of aggregate scores for an experiment. */
  async timeline(experimentId: string): Promise<Array<{ runId: string; startedAt: string; overall: number | null }>> {
    const runs = await this.store.listRuns(experimentId)
    return runs
      .slice()
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((r) => ({
        runId: r.id,
        startedAt: r.startedAt,
        overall: r.report?.summary.overallAvg ?? null,
      }))
  }
}

export interface RunDiff {
  before: { runId: string; name?: string; startedAt: string }
  after: { runId: string; name?: string; startedAt: string }
  aggregateDelta: number
  scenarios: Array<{
    scenarioId: string
    before: number | null
    after: number | null
    delta: number | null
    status: 'improved' | 'regressed' | 'unchanged' | 'added' | 'removed'
  }>
  configChanges: Record<string, { before: unknown; after: unknown }>
}

function rand(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}
