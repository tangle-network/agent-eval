/**
 * Meta-eval correlation — the highest-leverage signal in the framework.
 *
 * Given a corpus of three-layer project reports, compute how well each
 * pair of layers correlates. The question we care about most:
 *
 *   Does `metaScore` (what the builder thinks it did) predict
 *   `runtimeScore` (what the user actually gets)?
 *
 * If r < ~0.4, the builder's self-scoring is broken — it's optimizing
 * for something other than real-world success. If r > 0.7, meta_score
 * is a usable proxy and can drive CI gates cheaply.
 *
 * Non-parametric rank correlation (Spearman) is also reported because
 * meta scores are often ordinal-ish.
 */

import type { ThreeLayerProjectReport } from './three-layer-eval'

export interface LayerCorrelation {
  n: number
  pearson: number
  spearman: number
}

export interface CorrelationReport {
  /** Pairs present in the corpus (layers with ≥ 2 matched data points). */
  metaVsBuild?: LayerCorrelation
  metaVsRuntime?: LayerCorrelation
  buildVsRuntime?: LayerCorrelation
  /** Number of complete projects (all 3 scores present). */
  completeProjects: number
}

export function correlateLayers(reports: ThreeLayerProjectReport[]): CorrelationReport {
  const completeProjects = reports.filter((r) => r.complete).length
  return {
    metaVsBuild: pairwise(
      reports,
      (r) => r.metaScore,
      (r) => r.buildScore,
    ),
    metaVsRuntime: pairwise(
      reports,
      (r) => r.metaScore,
      (r) => r.runtimeScore,
    ),
    buildVsRuntime: pairwise(
      reports,
      (r) => r.buildScore,
      (r) => r.runtimeScore,
    ),
    completeProjects,
  }
}

function pairwise(
  reports: ThreeLayerProjectReport[],
  a: (r: ThreeLayerProjectReport) => number | null,
  b: (r: ThreeLayerProjectReport) => number | null,
): LayerCorrelation | undefined {
  const xs: number[] = []
  const ys: number[] = []
  for (const r of reports) {
    const x = a(r)
    const y = b(r)
    if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x)
      ys.push(y)
    }
  }
  if (xs.length < 2) return undefined
  return {
    n: xs.length,
    pearson: pearsonR(xs, ys),
    spearman: spearmanR(xs, ys),
  }
}

function pearsonR(a: number[], b: number[]): number {
  const mA = a.reduce((s, v) => s + v, 0) / a.length
  const mB = b.reduce((s, v) => s + v, 0) / b.length
  let num = 0,
    dA = 0,
    dB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - mA
    const db = b[i] - mB
    num += da * db
    dA += da * da
    dB += db * db
  }
  if (dA === 0 || dB === 0) return dA === 0 && dB === 0 ? 1 : 0
  return num / Math.sqrt(dA * dB)
}

function spearmanR(a: number[], b: number[]): number {
  return pearsonR(ranks(a), ranks(b))
}

function ranks(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v)
  const r = new Array<number>(xs.length)
  for (let i = 0; i < indexed.length; i++) {
    // Average rank for ties
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) r[indexed[k].i] = avg
    i = j
  }
  return r
}
