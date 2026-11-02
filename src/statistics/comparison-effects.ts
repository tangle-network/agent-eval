import { ValidationError } from '../errors'
import { ranks } from './descriptive'
import { assertFiniteSample } from './internal'

function binary(values: readonly number[], name: string): void {
  if (values.some(value => value !== 0 && value !== 1)) throw new ValidationError(`${name}: expected binary 0/1 values`)
}

/** Mann–Whitney ROC area: ties count half; no observed member of either class means unknown. */
export function rocAuc(scores: number[], labels: number[]): number | null {
  assertFiniteSample('rocAuc', 'scores', scores)
  binary(labels, 'rocAuc.labels')
  if (scores.length !== labels.length) throw new ValidationError('rocAuc: scores and labels must have equal lengths')
  const ranked = ranks(scores)
  const positive = labels.reduce((sum, label) => sum + label, 0)
  const sum = labels.reduce((total, label, index) => total + label * ranked[index]!, 0)
  const negative = labels.length - positive
  return positive && negative ? (sum - positive * (positive + 1) / 2) / (positive * negative) : null
}
