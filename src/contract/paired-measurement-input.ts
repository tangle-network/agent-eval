/** Normalize caller-owned receipts and reject malformed paired measurements. */

import type { AgentImprovementCost } from '@tangle-network/agent-interface'
import type { PairedMeasurement, PairedMeasurementAdapter } from './measured-comparison-types'

interface ProjectedRun {
  score: number
  dimensions: Map<string, number>
  costUsd: number
  costProvenance: AgentImprovementCost['provenance']
  latencyMs: number
  completed: boolean
  passed: boolean
}

interface ProjectedPairedMeasurement {
  cellId: string
  baseline: ProjectedRun
  candidate: ProjectedRun
}

export function projectPairedMeasurement<TRun>(
  measurement: PairedMeasurement<TRun>,
  index: number,
  adapter: PairedMeasurementAdapter<TRun>,
): ProjectedPairedMeasurement {
  if (typeof measurement.cellId !== 'string' || !measurement.cellId.trim()) {
    throw new Error(`paired measurement ${index} requires a cell id`)
  }
  return {
    cellId: measurement.cellId,
    baseline: projectRun(measurement.baseline, adapter, `paired measurement ${index} baseline`),
    candidate: projectRun(measurement.candidate, adapter, `paired measurement ${index} candidate`),
  }
}

function projectRun<TRun>(
  run: TRun,
  adapter: PairedMeasurementAdapter<TRun>,
  label: string,
): ProjectedRun {
  const suppliedDimensions = adapter.dimensions(run)
  if (!Array.isArray(suppliedDimensions)) {
    throw new Error(`${label} dimensions must be an array`)
  }
  const dimensions = new Map<string, number>()
  for (const dimension of suppliedDimensions) {
    if (typeof dimension.name !== 'string' || !dimension.name.trim()) {
      throw new Error(`${label} contains an unnamed dimension`)
    }
    if (dimensions.has(dimension.name)) {
      throw new Error(`${label} repeats dimension '${dimension.name}'`)
    }
    dimensions.set(dimension.name, finiteMeasurement(dimension.score, `${label} ${dimension.name}`))
  }
  const completed = adapter.completed(run)
  const passed = adapter.passed(run)
  if (typeof completed !== 'boolean' || typeof passed !== 'boolean') {
    throw new Error(`${label} completion and pass values must be booleans`)
  }
  const costProvenance = adapter.costProvenance(run)
  if (costProvenance !== 'observed' && costProvenance !== 'estimated') {
    throw new Error(`${label} cost provenance must be observed or estimated`)
  }
  return {
    score: finiteMeasurement(adapter.score(run), `${label} score`),
    dimensions,
    costUsd: nonNegativeMeasurement(adapter.costUsd(run), `${label} cost`),
    costProvenance,
    latencyMs: nonNegativeMeasurement(adapter.latencyMs(run), `${label} latency`),
    completed,
    passed,
  }
}

export function sharedProjectedDimensions(
  measurements: readonly ProjectedPairedMeasurement[],
): string[] {
  const expected = [...measurements[0]!.baseline.dimensions.keys()]
  for (const [index, measurement] of measurements.entries()) {
    for (const [arm, run] of [
      ['baseline', measurement.baseline],
      ['candidate', measurement.candidate],
    ] as const) {
      const actual = [...run.dimensions.keys()]
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`paired measurement ${index} ${arm} dimensions do not match the suite`)
      }
    }
  }
  return expected
}

export function dimensionScore(run: ProjectedRun, name: string): number {
  const value = run.dimensions.get(name)
  if (value === undefined) throw new Error(`paired measurement is missing dimension '${name}'`)
  return value
}

function finiteMeasurement(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function nonNegativeMeasurement(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`)
  return value
}

export function assertKnownCost(cost: AgentImprovementCost, label: string): void {
  if (!Number.isFinite(cost.usd) || cost.usd < 0) {
    throw new Error(`${label} must be a non-negative number`)
  }
  if (cost.provenance !== 'observed' && cost.provenance !== 'estimated') {
    throw new Error(`${label} provenance must be observed or estimated`)
  }
}
