/** Ordinary kriging of node improvements with observed unit noise and bounded support. */
import {
  choleskyBackward as backward,
  cholesky,
  choleskyForward as forward,
} from '../../math/cholesky'
import { mean as arithmeticMean } from '../../statistics/mean'
import { evenSample, median, plural, round9 } from './geometry'
import type { LandscapeGrid, LandscapeNode } from './landscape-contract'
import { GRID_METHOD, SURFACE_MIN_NODES } from './landscape-contract'
import { fixed } from './landscape-text'

export function krige(
  records: readonly LandscapeNode[],
  scored: readonly LandscapeNode[],
  variances: ReadonlyMap<string, number | null>,
  columns: number,
  surfaceNodes: number,
): { grid: LandscapeGrid | null; insufficient: string | null } {
  if (scored.length < SURFACE_MIN_NODES) {
    return {
      grid: null,
      insufficient: `${plural(scored.length, 'placed node')} not decided invalid share 2 or more units with the root; a surface needs ${SURFACE_MIN_NODES}`,
    }
  }
  const noiseOf = (node: LandscapeNode): number | null => variances.get(node.nodeId) ?? null
  if (scored.some((node) => noiseOf(node) === null)) {
    return {
      grid: null,
      insufficient: 'no pooled between-unit variance, so the noise of a node’s score is unknown',
    }
  }
  let [x0, x1, y0, y1] = [
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]
  for (const record of records) {
    if (record.x === null || record.y === null) continue
    x0 = Math.min(x0, record.x)
    x1 = Math.max(x1, record.x)
    y0 = Math.min(y0, record.y)
    y1 = Math.max(y1, record.y)
  }
  const span = Math.max(x1 - x0, y1 - y0)
  if (span <= 0) {
    return { grid: null, insufficient: 'every placed node sits at one point' }
  }
  const pad = span * 0.05
  x0 -= pad
  x1 += pad
  y0 -= pad
  y1 += pad
  // Fit on at most `surfaceNodes`, evenly spaced by registration, with the
  // root (the reference) and the best node always in.
  const byScore = [...scored].sort(
    (left, right) => right.score! - left.score! || left.ordinal - right.ordinal,
  )
  const keep = new Set(evenSample(scored, surfaceNodes))
  const rootNode = scored.find((node) => noiseOf(node) === 0)
  for (const must of [rootNode, byScore[0]]) {
    if (!must || keep.has(must)) continue
    const drop = [...keep].reverse().find((node) => node !== rootNode && node !== byScore[0])
    if (drop) keep.delete(drop)
    keep.add(must)
  }
  const fit = scored.filter((node) => keep.has(node))
  const n = fit.length
  const y = fit.map((node) => node.score!)
  const noise = fit.map((node) => noiseOf(node)!)
  const meanScore = arithmeticMean(y)
  const spread = y.reduce((sum, value) => sum + (value - meanScore) ** 2, 0) / (n - 1)
  const meanNoise = arithmeticMean(noise)
  const priorVariance = spread - meanNoise
  if (!(priorVariance > 0)) {
    return {
      grid: null,
      insufficient: `the nodes' scores vary no more than their noise (between-node variance ${fixed(spread)}, mean noise variance ${fixed(meanNoise)}), so there is no surface beyond a flat one`,
    }
  }
  const cell = Math.max(x1 - x0, y1 - y0) / columns
  const nearest = evenSample(fit, 2000).map((a, _, sample) => {
    let best = Number.POSITIVE_INFINITY
    for (const b of sample) {
      if (a === b) continue
      const d = Math.hypot(a.x! - b.x!, a.y! - b.y!)
      if (d > 0 && d < best) best = d
    }
    return best
  })
  const typical = Math.max(median(nearest.filter(Number.isFinite)) ?? cell, cell)
  // Distances are squared once; each length scale reuses them.
  const d2 = fit.map((a) => fit.map((b) => (a.x! - b.x!) ** 2 + (a.y! - b.y!) ** 2))
  const jitter = priorVariance * 1e-9
  let best: {
    lengthScale: number
    lower: number[][]
    alpha: number[]
    mean: number
    logLikelihood: number
  } | null = null
  for (const multiple of [0.5, 1, 2, 4]) {
    const lengthScale = Math.max(typical * multiple, cell)
    const covariance = d2.map((row, i) =>
      row.map(
        (value, j) =>
          priorVariance * Math.exp(-value / (2 * lengthScale * lengthScale)) +
          (i === j ? noise[i]! + jitter : 0),
      ),
    )
    const lower = cholesky(covariance)
    if (lower === null) continue
    // Generalized least squares for the constant mean: 1ᵀC⁻¹y / 1ᵀC⁻¹1.
    const ones = forward(lower, new Array<number>(n).fill(1))
    const whiteY = forward(lower, y)
    let numerator = 0
    let denominator = 0
    for (let i = 0; i < n; i++) {
      numerator += ones[i]! * whiteY[i]!
      denominator += ones[i]! * ones[i]!
    }
    const mean = numerator / denominator
    const residual = forward(
      lower,
      y.map((value) => value - mean),
    )
    let quadratic = 0
    let logDeterminant = 0
    for (let i = 0; i < n; i++) {
      quadratic += residual[i]! ** 2
      logDeterminant += 2 * Math.log(lower[i]![i]!)
    }
    const logLikelihood = -0.5 * (quadratic + logDeterminant + n * Math.log(2 * Math.PI))
    if (best === null || logLikelihood > best.logLikelihood) {
      best = { lengthScale, lower, alpha: backward(lower, residual), mean, logLikelihood }
    }
  }
  if (best === null) {
    return { grid: null, insufficient: 'the kriging covariance is not positive definite' }
  }
  // The same scores with no spatial correlation: each node its own draw of
  // the prior around the mean. A surface is worth drawing only when distance
  // predicts score better than this, by more than the length scale's one
  // extra parameter costs (Akaike: 1 log-likelihood unit).
  const independent = independentLogLikelihood(y, noise, priorVariance)
  if (best.logLikelihood - independent < 1) {
    return {
      grid: null,
      insufficient: `node scores do not correlate with distance in this embedding (log-likelihood ${fixed(best.logLikelihood)} with a length scale against ${fixed(independent)} without one), so a surface would only interpolate noise`,
    }
  }
  const { lengthScale, lower, alpha, mean } = best
  const rows = columns
  const values: (number | null)[][] = []
  const sd: number[][] = []
  let supported = 0
  for (let r = 0; r < rows; r++) {
    const row: (number | null)[] = []
    const sdRow: number[] = []
    const gy = y0 + ((r + 0.5) * (y1 - y0)) / rows
    for (let c = 0; c < columns; c++) {
      const gx = x0 + ((c + 0.5) * (x1 - x0)) / columns
      const k = fit.map(
        (node) =>
          priorVariance *
          Math.exp(-((node.x! - gx) ** 2 + (node.y! - gy) ** 2) / (2 * lengthScale * lengthScale)),
      )
      let value = mean
      for (let i = 0; i < n; i++) value += k[i]! * alpha[i]!
      const white = forward(lower, k)
      let explained = 0
      for (const entry of white) explained += entry * entry
      const variance = Math.max(0, priorVariance - explained)
      sdRow.push(round9(Math.sqrt(variance)))
      if (variance <= priorVariance / 2) {
        row.push(round9(value))
        supported += 1
      } else {
        row.push(null)
      }
    }
    values.push(row)
    sd.push(sdRow)
  }
  return {
    grid: {
      columns,
      rows,
      x: [round9(x0), round9(x1)],
      y: [round9(y0), round9(y1)],
      values,
      sd,
      supportedCells: supported,
      model: {
        mean: round9(mean),
        priorVariance: round9(priorVariance),
        lengthScale: round9(lengthScale),
        logLikelihood: round9(best.logLikelihood),
        independentLogLikelihood: round9(independent),
        fitNodes: n,
      },
      method: GRID_METHOD,
    },
    insufficient: null,
  }
}

function independentLogLikelihood(
  y: readonly number[],
  noise: readonly number[],
  priorVariance: number,
): number {
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < y.length; i++) {
    const variance = priorVariance + noise[i]!
    numerator += y[i]! / variance
    denominator += 1 / variance
  }
  const mean = numerator / denominator
  let total = 0
  for (let i = 0; i < y.length; i++) {
    const variance = priorVariance + noise[i]!
    total += -0.5 * ((y[i]! - mean) ** 2 / variance + Math.log(2 * Math.PI * variance))
  }
  return total
}
