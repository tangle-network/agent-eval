/**
 * Percentile ratchet over perf metric records.
 *
 * `summarizeRecords` folds flat records into per-scenario p50/p90 stats;
 * `gatePerf` compares a current summary against a committed baseline and
 * trips on regressions beyond tolerance. Percentiles use nearest-rank on
 * sorted values. Null / non-numeric metric values are excluded from the
 * stat (n reflects only real samples); a field with zero samples is
 * omitted entirely — no fake zeros.
 */

export interface PerfStat {
  p50: number
  p90: number
  n: number
}

export interface PerfBaseline {
  version: 1
  /** key → metric field → stat. */
  scenarios: Record<string, Record<string, PerfStat>>
}

export interface PerfRegression {
  scenarioKey: string
  field: string
  baseline: PerfStat
  current: PerfStat
  /** percent over baseline p50 / p90, whichever tripped. */
  overBy: { p50Pct: number; p90Pct: number }
}

export interface PerfGateResult {
  succeeded: boolean
  regressions: PerfRegression[]
  /** Negative overBy: strictly better than baseline on both percentiles. */
  improvements: PerfRegression[]
  /** In baseline but absent (or under-sampled, n < minSamples) in current. */
  missingScenarios: string[]
  /** In records but absent from baseline. */
  newScenarios: string[]
}

/** Nearest-rank percentile over a non-empty ascending-sorted array (p in (0, 100]). */
function nearestRank(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) throw new Error('nearestRank requires at least one sample')
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1] as number
}

export function summarizeRecords(
  records: ReadonlyArray<Record<string, unknown>>,
  keyOf: (record: Record<string, unknown>) => string | null,
  metricFields: ReadonlyArray<string>,
): PerfBaseline {
  const samples = new Map<string, Map<string, number[]>>()
  for (const record of records) {
    const key = keyOf(record)
    if (key === null) continue
    let byField = samples.get(key)
    if (!byField) {
      byField = new Map()
      samples.set(key, byField)
    }
    for (const field of metricFields) {
      const value = record[field]
      if (typeof value !== 'number' || Number.isNaN(value)) continue
      let values = byField.get(field)
      if (!values) {
        values = []
        byField.set(field, values)
      }
      values.push(value)
    }
  }
  const scenarios: Record<string, Record<string, PerfStat>> = {}
  for (const [key, byField] of samples) {
    const stats: Record<string, PerfStat> = {}
    for (const [field, values] of byField) {
      if (values.length === 0) continue
      const sorted = [...values].sort((a, b) => a - b)
      stats[field] = {
        p50: nearestRank(sorted, 50),
        p90: nearestRank(sorted, 90),
        n: sorted.length,
      }
    }
    scenarios[key] = stats
  }
  return { version: 1, scenarios }
}

/** Percent over baseline; baseline 0 → 0% when equal, Infinity when current grew. */
function pctOver(currentValue: number, baselineValue: number): number {
  if (baselineValue === 0) {
    return currentValue === 0 ? 0 : Number.POSITIVE_INFINITY
  }
  return ((currentValue - baselineValue) / baselineValue) * 100
}

export function gatePerf(
  current: PerfBaseline,
  baseline: PerfBaseline,
  options?: { tolerancePct?: number; minSamples?: number },
): PerfGateResult {
  const tolerancePct = options?.tolerancePct ?? 10
  const minSamples = options?.minSamples ?? 3
  const regressions: PerfRegression[] = []
  const improvements: PerfRegression[] = []
  const missing = new Set<string>()

  for (const [scenarioKey, baselineStats] of Object.entries(baseline.scenarios)) {
    const currentStats = current.scenarios[scenarioKey]
    if (!currentStats) {
      missing.add(scenarioKey)
      continue
    }
    for (const [field, baselineStat] of Object.entries(baselineStats)) {
      const currentStat = currentStats[field]
      if (!currentStat || currentStat.n < minSamples) {
        // Under-sampled current data cannot gate — surface it instead of
        // pretending the scenario passed.
        missing.add(scenarioKey)
        continue
      }
      const overBy = {
        p50Pct: pctOver(currentStat.p50, baselineStat.p50),
        p90Pct: pctOver(currentStat.p90, baselineStat.p90),
      }
      const entry: PerfRegression = {
        scenarioKey,
        field,
        baseline: baselineStat,
        current: currentStat,
        overBy,
      }
      if (overBy.p50Pct > tolerancePct || overBy.p90Pct > tolerancePct) {
        regressions.push(entry)
      } else if (overBy.p50Pct < 0 && overBy.p90Pct < 0) {
        improvements.push(entry)
      }
    }
  }

  const newScenarios = Object.keys(current.scenarios).filter((key) => !(key in baseline.scenarios))

  return {
    succeeded: regressions.length === 0,
    regressions,
    improvements,
    missingScenarios: [...missing],
    newScenarios,
  }
}
