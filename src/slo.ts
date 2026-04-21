/**
 * SLO gates — quantified pass/fail primitives beyond score thresholds.
 *
 * Lifted from ADC's sandbox eval suite. Each SLO defines a metric, a
 * threshold, and a severity (critical | warning). Critical breaches fail
 * the eval; warnings are reported but don't gate CI. Margin is the
 * ratio of actual to threshold for histogramming "how close are we?"
 *
 * Consumers assemble their own SLO arrays; DEFAULT_AGENT_SLOS covers
 * the generic agent flow (provision, first token, pass rate, cost).
 */

export type SloSeverity = 'critical' | 'warning'
export type SloComparator = 'lte' | 'gte'

export interface Slo {
  /** Stable identifier — must be unique within an SLO set. */
  id: string
  /** Human description, shown in reports. */
  description: string
  /** Metric key looked up in the candidate record. */
  metric: string
  /** Whether the metric should stay below (lte) or above (gte) threshold. */
  comparator: SloComparator
  /** Threshold value. */
  threshold: number
  severity: SloSeverity
}

export interface SloCheckResult {
  slo: Slo
  actual: number | undefined
  passed: boolean
  /** actual/threshold for lte, threshold/actual for gte. >1 means safe margin; <1 means breach. 0 when actual is missing. */
  margin: number
  detail: string
}

export interface SloReport {
  results: SloCheckResult[]
  passedCritical: boolean
  criticalBreaches: SloCheckResult[]
  warnings: SloCheckResult[]
}

/**
 * Evaluate an SLO set against a candidate metrics object. Missing metrics
 * count as breaches — if you declared it, you must measure it.
 */
export function checkSlos(metrics: Record<string, number>, slos: Slo[]): SloReport {
  const results: SloCheckResult[] = slos.map((slo) => check(slo, metrics[slo.metric]))
  const criticalBreaches = results.filter((r) => !r.passed && r.slo.severity === 'critical')
  const warnings = results.filter((r) => !r.passed && r.slo.severity === 'warning')
  return { results, passedCritical: criticalBreaches.length === 0, criticalBreaches, warnings }
}

function check(slo: Slo, actual: number | undefined): SloCheckResult {
  if (actual === undefined || !Number.isFinite(actual)) {
    return {
      slo,
      actual,
      passed: false,
      margin: 0,
      detail: `metric "${slo.metric}" missing — declared SLOs must be measured`,
    }
  }
  if (slo.comparator === 'lte') {
    const passed = actual <= slo.threshold
    const margin = slo.threshold === 0 ? (actual === 0 ? Infinity : 0) : slo.threshold / actual
    return { slo, actual, passed, margin, detail: `${actual} ≤ ${slo.threshold}: ${passed ? 'ok' : 'breach'}` }
  }
  const passed = actual >= slo.threshold
  const margin = actual === 0 ? 0 : actual / slo.threshold
  return { slo, actual, passed, margin, detail: `${actual} ≥ ${slo.threshold}: ${passed ? 'ok' : 'breach'}` }
}

/** Reference SLO set for agent-style evals. Tune per-product by cloning + overriding. */
export const DEFAULT_AGENT_SLOS: Slo[] = [
  { id: 'provision_ms', description: 'Sandbox/session provision under 60s', metric: 'provisionMs', comparator: 'lte', threshold: 60_000, severity: 'critical' },
  { id: 'first_token_ms', description: 'First token under 15s', metric: 'firstTokenMs', comparator: 'lte', threshold: 15_000, severity: 'critical' },
  { id: 'pass_rate', description: 'Scenario pass rate ≥ 90%', metric: 'passRate', comparator: 'gte', threshold: 0.9, severity: 'critical' },
  { id: 'cost_usd', description: 'Per-scenario cost under $0.05', metric: 'costUsd', comparator: 'lte', threshold: 0.05, severity: 'warning' },
  { id: 'overall_score', description: 'Overall score ≥ 0.7', metric: 'overallScore', comparator: 'gte', threshold: 0.7, severity: 'critical' },
]
