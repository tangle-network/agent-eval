/**
 * Series convergence — detects whether a sequence of scalar measurements
 * is stabilizing, drifting, or noisy.
 *
 * Lifted from ADC convergence.ts. The per-turn `ConvergenceTracker` is
 * about progress *within* a single run; this module is about drift
 * *across* runs (e.g. "are my nightly eval scores stabilizing?").
 *
 * Three signals:
 *   - stabilized: last K values have low variance (< epsilon) — done
 *   - drifting:   recent trend is monotonic and beyond noise — regressing or improving
 *   - noisy:      neither — keep iterating, but flag as untrustworthy for gating
 */

export interface SeriesConvergenceOptions {
  /** Window size for "recent" analysis (default 5). */
  window?: number
  /** Coefficient-of-variation threshold below which the window is stabilized (default 0.05 = 5%). */
  stableCv?: number
  /** Minimum monotone run length to call drift (default 3). */
  driftRun?: number
}

export interface SeriesConvergenceResult {
  state: 'stabilized' | 'drifting-up' | 'drifting-down' | 'noisy' | 'insufficient-data'
  windowMean: number
  windowCv: number
  /** Longest monotonic run at the tail of the series (positive for up, negative for down). */
  tailRun: number
  /** True when n ≥ window AND windowCv ≤ stableCv. */
  stable: boolean
}

export function analyzeSeries(
  values: number[],
  options: SeriesConvergenceOptions = {},
): SeriesConvergenceResult {
  const window = options.window ?? 5
  const stableCv = options.stableCv ?? 0.05
  const driftRun = options.driftRun ?? 3

  if (values.length < Math.max(2, Math.min(window, 3))) {
    return { state: 'insufficient-data', windowMean: 0, windowCv: 0, tailRun: 0, stable: false }
  }

  const tail = values.slice(-window)
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length
  const variance = tail.reduce((acc, v) => acc + (v - mean) ** 2, 0) / tail.length
  const stdDev = Math.sqrt(variance)
  const refMean = Math.abs(mean) > 1e-9 ? Math.abs(mean) : 1
  const cv = stdDev / refMean
  const stable = tail.length >= window && cv <= stableCv

  // Tail monotonic run: count how many consecutive strictly-increasing (or decreasing)
  // steps end at the final value.
  let tailRun = 0
  let direction: 1 | -1 | 0 = 0
  for (let i = values.length - 1; i > 0; i--) {
    const delta = values[i] - values[i - 1]
    if (delta === 0) break
    const dir = delta > 0 ? 1 : -1
    if (direction === 0) direction = dir
    if (dir !== direction) break
    tailRun += dir
  }

  let state: SeriesConvergenceResult['state']
  if (stable) {
    state = 'stabilized'
  } else if (Math.abs(tailRun) >= driftRun) {
    state = tailRun > 0 ? 'drifting-up' : 'drifting-down'
  } else {
    state = 'noisy'
  }

  return { state, windowMean: mean, windowCv: cv, tailRun, stable }
}
