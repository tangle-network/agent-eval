// Scripted policies. They act through the same tools and the same notes as a
// model-backed agent, so a scenario can be checked before any model is paid
// for: a policy that waits for evidence must beat one that acts on the latest
// number, and both must clear the floors. When they do not rank that way the
// scenario is wrong.

import { ValidationError } from '../errors'
import { makeRng, seedFromData, zQuantile } from '../statistics/internal'
import type { WorldAgent, WorldScenario, WorldSession } from './types'
import type { WorldResultRow, WorldStatus, WorldStatusLever } from './world'

export interface EvidencePolicyOptions {
  /** `matured` sets every landed outcome against the spend old enough to have
   *  landed, by the lever's public lag. `latest` sets the last period's landed
   *  outcomes against the last period's spend. */
  evidence: 'matured' | 'latest'
  /** Days of counted spend a lever needs before it is judged. */
  minEvidenceDays: number
  /** Standard errors the return must clear break-even by, in either
   *  direction, before the lever is killed or scaled. Zero acts on the point
   *  estimate. */
  confidence: number
  /** Factor a winning lever's rate is raised by. */
  scaleStep: number
  /** The rate a lever is never raised above. */
  ceiling: 'guideline' | 'max'
  /** Stop a lever once its results would land after the horizon, and never
   *  plan more spend than the budget left. */
  planAhead: boolean
}

interface PolicyMemory {
  killed: string[]
}

const MEMORY_NOTE = 'policy'

function statusOf(session: WorldSession): WorldStatus {
  return session.call('status').data as WorldStatus
}

function approvalCovers(lever: WorldStatusLever, rate: number): boolean {
  return !lever.requiresApproval || (lever.approvedMaxRate ?? 0) >= rate
}

function requestApprovalOnce(
  session: WorldSession,
  status: WorldStatus,
  lever: WorldStatusLever,
  rate: number,
): void {
  if (approvalCovers(lever, rate)) return
  const asked = status.approvals.some(
    (approval) => approval.lever === lever.id && approval.maxDailyRate >= rate,
  )
  if (!asked) {
    session.call('request_approval', {
      lever: lever.id,
      maxDailyRate: rate,
      reason: `Run ${lever.label} at up to ${rate} a day.`,
    })
  }
}

/** Never acts. Its end value is the starting budget: the floor every policy is read against. */
export const doNothingPolicy: WorldAgent = () => {}

/** Sets random rates across the whole allowed range each session. */
export function randomPolicy(seed: number): WorldAgent {
  return (session) => {
    const rng = makeRng(seedFromData([[seed, session.index]]))
    const status = statusOf(session)
    for (const lever of status.levers) {
      if (rng() < 0.5) continue
      const rate = Math.round(rng() * lever.maxRate)
      if (lever.requiresApproval && rng() < 0.5) {
        session.call('request_approval', { lever: lever.id, maxDailyRate: rate, reason: 'random' })
      }
      session.call('set_rate', { lever: lever.id, dailyRate: rate })
    }
  }
}

/** Starts every lever at its suggested rate, then kills and scales on the
 *  evidence rule its options state. */
export function evidencePolicy(opts: EvidencePolicyOptions): WorldAgent {
  if (!(opts.scaleStep >= 1) || !(opts.confidence >= 0) || !(opts.minEvidenceDays >= 0)) {
    throw new ValidationError(
      'evidencePolicy: scaleStep must be 1 or more; confidence and minEvidenceDays zero or more',
    )
  }
  return (session) => {
    const status = statusOf(session)
    const rows = session.call('results', { by: 'day' }).data as WorldResultRow[]
    const memory: PolicyMemory = session.notes[MEMORY_NOTE]
      ? (JSON.parse(session.notes[MEMORY_NOTE]) as PolicyMemory)
      : { killed: [] }
    const rates = new Map(status.levers.map((lever) => [lever.id, lever.dailyRate]))
    const returns = new Map<string, number>()
    const setRate = (lever: string, dailyRate: number) => {
      if (session.call('set_rate', { lever, dailyRate }).ok) rates.set(lever, dailyRate)
    }

    for (const lever of status.levers) {
      const ceiling = opts.ceiling === 'guideline' ? lever.guidelineRate : lever.maxRate
      requestApprovalOnce(session, status, lever, ceiling)
      if (memory.killed.includes(lever.id)) continue

      const lag = (lever.resultLagDays.from + lever.resultLagDays.to) / 2
      const tooLate = opts.planAhead && status.daysLeft <= lag
      if (lever.dailyRate === 0) {
        if (!tooLate && lever.spent === 0 && approvalCovers(lever, lever.startRate)) {
          setRate(lever.id, lever.startRate)
        }
        continue
      }
      if (tooLate) {
        setRate(lever.id, 0)
        continue
      }

      // Spend is counted up to the day whose results should have landed by
      // now; outcomes are counted over the same window shifted by the lag.
      const mine = rows.filter((row) => row.lever === lever.id)
      const window = opts.evidence === 'latest' ? status.sessionEveryDays : Number.POSITIVE_INFINITY
      const shift = opts.evidence === 'matured' ? lag : 0
      let spend = 0
      let days = 0
      let outcomes = 0
      for (const row of mine) {
        if (row.fromDay < status.day - window) continue
        outcomes += row.outcomes
        if (row.fromDay < status.day - shift && row.spend > 0) {
          spend += row.spend
          days += 1
        }
      }
      if (spend === 0 || days < opts.minEvidenceDays) continue
      const error = opts.confidence * Math.sqrt(Math.max(outcomes, 1))
      const low = ((outcomes - error) * status.outcomeValue) / spend
      const high = ((outcomes + error) * status.outcomeValue) / spend
      returns.set(lever.id, (outcomes * status.outcomeValue) / spend)
      if (high < 1) {
        setRate(lever.id, 0)
        memory.killed.push(lever.id)
      } else if (low > 1 && lever.dailyRate < ceiling) {
        const next = Math.min(ceiling, Math.round(lever.dailyRate * opts.scaleStep))
        if (approvalCovers(lever, next)) setRate(lever.id, next)
      }
    }

    if (opts.planAhead) {
      // Fit the plan to the money: lower the weakest lever until the standing
      // rates can be paid to the horizon.
      const weakestFirst = [...rates.keys()].sort(
        (a, b) => (returns.get(a) ?? 1) - (returns.get(b) ?? 1),
      )
      for (const lever of weakestFirst) {
        const planned = [...rates.values()].reduce((sum, rate) => sum + rate, 0) * status.daysLeft
        const over = planned - status.budgetLeft
        if (over <= 0) break
        const rate = rates.get(lever) ?? 0
        if (rate > 0) setRate(lever, Math.max(0, Math.floor(rate - over / status.daysLeft)))
      }
    }
    session.call('save_note', { key: MEMORY_NOTE, text: JSON.stringify(memory) })
  }
}

/** Waits for a lever's matured results to clear break-even by two standard
 *  errors, moves in small steps, stays inside the guidelines and plans to the
 *  horizon. */
export const patientPolicy: WorldAgent = evidencePolicy({
  evidence: 'matured',
  minEvidenceDays: 14,
  confidence: 2,
  scaleStep: 1.25,
  ceiling: 'guideline',
  planAhead: true,
})

/** Acts on last period's number at the first review: kills what is under
 *  break-even, doubles what is over it, up to the hard cap. */
export const impulsivePolicy: WorldAgent = evidencePolicy({
  evidence: 'latest',
  minEvidenceDays: 1,
  confidence: 0,
  scaleStep: 2,
  ceiling: 'max',
  planAhead: false,
})

/** Starts every lever at its suggested rate and never changes it. Patience
 *  has to beat this too, or the scenario only rewards sitting still. */
export const setAndHoldPolicy: WorldAgent = evidencePolicy({
  evidence: 'matured',
  minEvidenceDays: Number.POSITIVE_INFINITY,
  confidence: 0,
  scaleStep: 1,
  ceiling: 'guideline',
  planAhead: false,
})

/** A reference that reads the key. Each lever is two tiers of spend, up to
 *  its saturation or wear limit and above it; tiers are funded best return
 *  first until the budget is planned, and a tier stops once its results would
 *  land too late to pay. It is a strong informed plan, not a proven optimum. */
export function informedPolicy(scenario: WorldScenario): WorldAgent {
  const value = scenario.outcome.value
  const tiers = scenario.levers
    .flatMap((lever) => {
      const key = scenario.key.levers[lever.id]!
      const cap = Math.min(lever.maxRate, key.wear ? key.wear.weeklyLoad / 7 : lever.maxRate)
      const base = Math.floor(Math.min(cap, key.saturationRate))
      const spread =
        key.delayDays.max > key.delayDays.median
          ? Math.log(key.delayDays.max / key.delayDays.median) / 2
          : 0
      return [
        { rate: base, perUnit: key.yield * value },
        { rate: Math.floor(cap) - base, perUnit: key.yield * value * key.marginalYield },
      ].map((tier) => ({
        ...tier,
        lever: lever.id,
        // Spend stops paying when the share of its outcomes landing in time
        // falls under 1 / perUnit.
        stopDaysLeft:
          tier.perUnit > 1
            ? Math.ceil(key.delayDays.median * Math.exp(spread * zQuantile(1 / tier.perUnit)))
            : 0,
      }))
    })
    .filter((tier) => tier.rate > 0 && tier.perUnit > 1)
    .sort((a, b) => b.perUnit - a.perUnit)
  return (session) => {
    const status = statusOf(session)
    const target = new Map<string, number>()
    const wanted = new Map<string, number>()
    let unplanned = status.budgetLeft
    for (const tier of tiers) {
      wanted.set(tier.lever, (wanted.get(tier.lever) ?? 0) + tier.rate)
      const days = Math.max(0, status.daysLeft - tier.stopDaysLeft)
      const affordable = days > 0 ? Math.min(tier.rate, Math.floor(unplanned / days)) : 0
      unplanned -= affordable * days
      target.set(tier.lever, (target.get(tier.lever) ?? 0) + affordable)
    }
    for (const lever of status.levers) {
      const rate = target.get(lever.id)
      if (rate === undefined) continue
      requestApprovalOnce(session, status, lever, wanted.get(lever.id) ?? rate)
      if (rate !== lever.dailyRate && approvalCovers(lever, rate)) {
        session.call('set_rate', { lever: lever.id, dailyRate: rate })
      }
    }
  }
}
