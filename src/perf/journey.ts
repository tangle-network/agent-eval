/**
 * Journey × axes matrix for infra performance benchmarks.
 *
 * A journey is one measurable user path ("provision.cold", "chat.ttft");
 * axes are free-form scenario dimensions (driver, region, image…). The
 * matrix expansion is pure bookkeeping — running the scenarios and
 * recording metrics is the caller's job. This module complements the
 * judge-panel `BenchmarkRunner` (src/benchmark.ts): that one scores
 * QUALITY via judges, this one structures LATENCY / RELIABILITY runs
 * over flat metric records.
 */

/** One measurable user journey (e.g. "provision.cold", "chat.ttft"). */
export interface JourneySpec {
  id: string
  description: string
  /** Needs a real LLM call — schedule nightly, not per-PR. */
  requiresLLM: boolean
  /**
   * Fields that MUST be non-null on a passing record of this journey.
   * A "passing" record missing one is an integrity violation, not a pass.
   */
  requiredFields: ReadonlyArray<string>
  /** Numeric floors, e.g. {field: 'event_count', min: 1} for streaming. */
  minimums?: ReadonlyArray<{ field: string; min: number }>
  /** Per-phase breakdown fields expected non-null (subset of requiredFields semantics, reported separately). */
  phaseFields?: ReadonlyArray<string>
}

export interface ScenarioAxes {
  /** e.g. driver: ['docker','firecracker'] — every key is a free-form dimension. */
  [dimension: string]: ReadonlyArray<string>
}

export interface PerfScenario {
  /** `${journeyId}|${dim1}=${v1}|${dim2}=${v2}` (dims sorted). */
  key: string
  journey: JourneySpec
  axes: Record<string, string>
}

/** Stable scenario key: journey id then `dim=value` pairs in sorted-dim order. */
export function scenarioKey(journeyId: string, axes: Record<string, string>): string {
  const parts = Object.keys(axes)
    .sort()
    .map((dim) => `${dim}=${axes[dim]}`)
  return [journeyId, ...parts].join('|')
}

/** Cartesian expansion; `filter` lets callers drop invalid combos (e.g. firecracker×resume). */
export function expandMatrix(
  journeys: ReadonlyArray<JourneySpec>,
  axes: ScenarioAxes,
  filter?: (journeyId: string, combo: Record<string, string>) => boolean,
): PerfScenario[] {
  const dims = Object.keys(axes).sort()
  let combos: Record<string, string>[] = [{}]
  for (const dim of dims) {
    const values = axes[dim] as ReadonlyArray<string>
    const next: Record<string, string>[] = []
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [dim]: value })
      }
    }
    combos = next
  }
  const scenarios: PerfScenario[] = []
  for (const journey of journeys) {
    for (const combo of combos) {
      if (filter && !filter(journey.id, combo)) continue
      scenarios.push({ key: scenarioKey(journey.id, combo), journey, axes: combo })
    }
  }
  return scenarios
}
