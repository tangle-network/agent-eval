import { welchsTTest } from '../baseline'
import { ValidationError } from '../errors'
import { ranks } from './descriptive'
import { assertFiniteSample } from './internal'
import { wilson } from './paired-binary'
export interface SampleEffect {
  n: [number, number]
  diff: number | null
  ci: [number, number] | null
  g: number | null
  gCi: [number, number] | null
  rates?: [number, number]
}
/** Independent means, oriented b − a: Welch 95% interval and Hedges' g with a normal 95% interval. */
export function meanEffect(a: number[], b: number[]): SampleEffect {
  const n: [number, number] = [a.length, b.length]
  const comparison = welchsTTest(a, b)
  const diff = a.length && b.length ? comparison.delta : null
  if (comparison.status === 'insufficient-sample') return { n, diff, ci: null, g: null, gCi: null }
  if (comparison.cohensD === null) return { n, diff, ci: comparison.standardError === 0 ? [comparison.delta, comparison.delta] : comparison.ci95, g: null, gCi: null }
  const correction = 1 - 3 / (4 * (a.length + b.length) - 9)
  const g = correction * comparison.cohensD
  const gSe = Math.sqrt((a.length + b.length) / (a.length * b.length) + g ** 2 / (2 * (a.length + b.length)))
  return { n, diff, ci: comparison.ci95, g, gCi: [g - 1.96 * gSe, g + 1.96 * gSe] }
}

function binary(values: readonly number[], name: string): void {
  if (values.some(value => value !== 0 && value !== 1)) throw new ValidationError(`${name}: expected binary 0/1 values`)
}

/** Independent binary samples, oriented b − a, with Newcombe's hybrid Wilson 95% interval. */
export function rateEffect(a: number[], b: number[]): SampleEffect {
  binary(a, 'rateEffect.a'); binary(b, 'rateEffect.b')
  const n: [number, number] = [a.length, b.length]
  if (!a.length || !b.length) return { n, diff: null, ci: null, g: null, gCi: null }
  const s1 = a.reduce((sum, value) => sum + value, 0), s2 = b.reduce((sum, value) => sum + value, 0)
  const { lower: l1, upper: u1 } = wilson(s1, a.length), { lower: l2, upper: u2 } = wilson(s2, b.length)
  const p1 = s1 / a.length, p2 = s2 / b.length, diff = p2 - p1
  return { n, rates: [p1, p2], diff,
    ci: [diff - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2), diff + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2)], g: null, gCi: null }
}

/** Mann–Whitney ROC area: ties count half; no observed member of either class means unknown. */
export function rocAuc(scores: number[], labels: number[]): number | null {
  assertFiniteSample('rocAuc', 'scores', scores)
  binary(labels, 'rocAuc.labels')
  if (scores.length !== labels.length) throw new ValidationError('rocAuc: scores and labels must have equal lengths')
  const ranked = ranks(scores)
  let positive = 0, sum = 0
  labels.forEach((label, index) => { if (label) { positive += 1; sum += ranked[index]! } })
  const negative = labels.length - positive
  return positive && negative ? (sum - positive * (positive + 1) / 2) / (positive * negative) : null
}

/** L2 logistic fit by fixed-step gradient descent; the returned linear score preserves ROC ordering. */
export function fitLogistic(rows: number[][], labels: number[], { lambda = 1, steps = 600, rate = 0.3 } = {}): (row: number[]) => number {
  binary(labels, 'fitLogistic.labels')
  const width = rows[0]?.length ?? 0
  if (!rows.length || rows.length !== labels.length || rows.some(row => row.length !== width)) throw new ValidationError('fitLogistic: nonempty equal-width rows and one label per row required')
  rows.forEach(row => assertFiniteSample('fitLogistic', 'row', row))
  if (!(Number.isFinite(lambda) && lambda >= 0 && Number.isInteger(steps) && steps >= 0 && Number.isFinite(rate) && rate > 0)) throw new ValidationError('fitLogistic: invalid optimizer bounds')
  const weights = new Array<number>(width).fill(0)
  let bias = 0
  const score = (row: number[]) => bias + row.reduce((sum, value, index) => sum + value * weights[index]!, 0)
  for (let step = 0; step < steps; step++) {
    const gradient = new Array<number>(width).fill(0)
    let gradientBias = 0
    rows.forEach((row, index) => {
      const error = 1 / (1 + Math.exp(-score(row))) - labels[index]!
      gradientBias += error
      row.forEach((value, column) => { gradient[column] = gradient[column]! + error * value })
    })
    bias -= rate * gradientBias / rows.length
    weights.forEach((weight, column) => { weights[column] = weight - rate * (gradient[column]! / rows.length + lambda * weight / rows.length) })
  }
  return score
}
