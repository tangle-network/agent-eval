/**
 * Generators and readers shared by the measure validity planted-truth tests.
 * Every draw comes from a seeded `makeRng`, so each scenario is reproducible.
 */

import { type MeasureValidityPlanInput, sealMeasureValidityPlan } from '../../src/experiment'
import {
  type DeploymentOutcome,
  InMemoryOutcomeStore,
  type MeasuredChange,
  type MeasureOutcomeValidity,
  type MeasureValidityReport,
  measureValidityStudy,
} from '../../src/meta-eval'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export type Rng = () => number

export function normal(rng: Rng): number {
  const u = Math.max(rng(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
export const bernoulli = (rng: Rng, p: number) => (rng() < p ? 1 : 0)

export interface Draw {
  change: MeasuredChange
  capturedAt: number
  outcomes: Record<string, number>
}

/** One change per hour; units drawn uniformly; outcomes arrive two to five days later. */
export function changeAt(index: number, unit: string, rng: Rng, start = 0) {
  const at = start + index * HOUR
  return { id: `change-${start}-${index}`, at, unit, capturedAt: at + 2 * DAY + rng() * 3 * DAY }
}

export function outcomeRows(draws: readonly Draw[]): DeploymentOutcome[] {
  return draws.map((draw) => ({
    runId: draw.change.id,
    capturedAt: draw.capturedAt,
    metrics: draw.outcomes,
  }))
}

export async function study(
  draws: readonly Draw[],
  plan: Omit<MeasureValidityPlanInput, 'id'>,
): Promise<MeasureValidityReport> {
  const outcomes = new InMemoryOutcomeStore()
  for (const row of outcomeRows(draws)) await outcomes.append(row)
  return measureValidityStudy({
    plan: sealMeasureValidityPlan({ id: 'planted-truth', ...plan }),
    changes: draws.map((draw) => draw.change),
    outcomes,
  })
}

export function pairOf(report: MeasureValidityReport, measure: string, outcome: string) {
  const found = report.pairs.find((pair) => pair.measure === measure && pair.outcome === outcome)
  if (!found) throw new Error(`no pair ${measure} x ${outcome}`)
  return found
}

export function estimate(pair: MeasureOutcomeValidity): number {
  const value = pair.postCut.association?.estimate
  if (value === undefined) throw new Error(`pair ${pair.measure} has no post-cut estimate`)
  return value
}
