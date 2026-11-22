// The world: a clock only the caller advances, a budget, and levers whose
// spend turns into outcomes days later. Every random draw comes from a stream
// named by (seed, lever, day), so what a day of spend returns never depends on
// when or how often anyone looked, and two policies run on one seed meet the
// same luck.

import { ValidationError } from '../errors'
import { hashCanonical } from '../ledger-core/canonical'
import { makeRng, seedFromData } from '../statistics/internal'
import type {
  WorldAction,
  WorldApproval,
  WorldDecisionEvidence,
  WorldEndState,
  WorldLever,
  WorldLeverKey,
  WorldRefusal,
  WorldScenario,
} from './types'

const DAY_MS = 86_400_000
const WEEK_DAYS = 7
/** Stream slots at or above this belong to weekly shocks, below it to days. */
const WEEK_STREAM_OFFSET = 1_000_000
const MAX_NOTES = 32
const MAX_NOTE_CHARS = 8_000

interface LeverState {
  rate: number
  /** Consecutive days with spend, today included once it has run. */
  age: number
  health: number
  spent: number
  produced: number
  landed: number
  approvedMaxRate: number
  overdriveDays: number
  spendByDay: number[]
  landedByDay: number[]
  /** Outcomes scheduled to land, by day; runs past the horizon. */
  landing: number[]
  /** One-off spend added to the rate, by day. */
  onceByDay: Record<string, number>
}

interface WorldState {
  day: number
  budget: number
  levers: Record<string, LeverState>
  approvals: WorldApproval[]
  notes: Record<string, string>
}

/** A world's whole state as plain data, for a driver whose sessions run in
 *  separate processes. */
export interface WorldSnapshot {
  scenarioDigest: string
  seed: number
  state: unknown
}

export type WorldActionOutcome =
  | { ok: true; message: string; action: WorldAction; evidence?: WorldDecisionEvidence }
  | { ok: false; refused: WorldRefusal; message: string }

export interface WorldStatusLever extends WorldLever {
  dailyRate: number
  /** Highest daily rate a granted approval covers; absent when none is needed. */
  approvedMaxRate?: number
  spent: number
  outcomes: number
}

export interface WorldStatus {
  day: number
  date: string
  daysLeft: number
  horizonDays: number
  sessionEveryDays: number
  budgetLeft: number
  spent: number
  outcomes: number
  outcomeUnit: string
  outcomeValue: number
  currency: string
  approvalDelayDays: number
  levers: WorldStatusLever[]
  approvals: WorldApproval[]
}

export interface WorldResultRow {
  lever: string
  fromDay: number
  /** Last day of the period, inclusive. */
  toDay: number
  fromDate: string
  spend: number
  /** Outcomes that landed in the period, whenever their spend was made. */
  outcomes: number
}

/** Digest of the whole scenario, key included: two episodes compare only when
 *  this matches. */
function worldScenarioDigest(scenario: WorldScenario): string {
  return hashCanonical(scenario)
}

function finite(name: string, value: number, min: number, max = Number.POSITIVE_INFINITY): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`world scenario: ${name} must be within [${min}, ${max}]`)
  }
}

/** Refuse a scenario the simulation cannot run as written. */
function validateWorldScenario(scenario: WorldScenario): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scenario.startDate) || Number.isNaN(dateMs(scenario.startDate))) {
    throw new ValidationError('world scenario: startDate must be a YYYY-MM-DD date')
  }
  for (const name of ['horizonDays', 'sessionEveryDays'] as const) {
    if (!Number.isSafeInteger(scenario[name]) || scenario[name] < 1) {
      throw new ValidationError(`world scenario: ${name} must be a positive integer`)
    }
  }
  if (!Number.isSafeInteger(scenario.approvalDelayDays) || scenario.approvalDelayDays < 0) {
    throw new ValidationError('world scenario: approvalDelayDays must be a non-negative integer')
  }
  finite('budget', scenario.budget, 0)
  finite('outcome.value', scenario.outcome.value, 0)
  if (scenario.levers.length === 0) {
    throw new ValidationError('world scenario: at least one lever is required')
  }
  const ids = new Set<string>()
  for (const lever of scenario.levers) {
    if (!/^[a-z][a-z0-9_]*$/.test(lever.id) || ids.has(lever.id)) {
      throw new ValidationError(`world scenario: lever id '${lever.id}' is invalid or repeated`)
    }
    ids.add(lever.id)
    finite(`${lever.id}.maxRate`, lever.maxRate, 0)
    finite(`${lever.id}.guidelineRate`, lever.guidelineRate, 0, lever.maxRate)
    finite(`${lever.id}.startRate`, lever.startRate, 0, lever.maxRate)
    finite(`${lever.id}.resultLagDays.from`, lever.resultLagDays.from, 0)
    finite(`${lever.id}.resultLagDays.to`, lever.resultLagDays.to, lever.resultLagDays.from)
    const key = scenario.key.levers[lever.id]
    if (!key) throw new ValidationError(`world scenario: the key has no lever '${lever.id}'`)
    finite(`${lever.id}.yield`, key.yield, 0)
    finite(`${lever.id}.weeklyNoise`, key.weeklyNoise, 0, 3)
    finite(`${lever.id}.rampDays`, key.rampDays, 1)
    finite(`${lever.id}.saturationRate`, key.saturationRate, 0)
    finite(`${lever.id}.marginalYield`, key.marginalYield, 0, 1)
    finite(`${lever.id}.delayDays.min`, key.delayDays.min, 1)
    finite(`${lever.id}.delayDays.median`, key.delayDays.median, key.delayDays.min)
    finite(`${lever.id}.delayDays.max`, key.delayDays.max, key.delayDays.median)
    // A day's outcomes are drawn one by one; keep the largest possible day small.
    finite(`${lever.id} daily outcomes at maxRate`, lever.maxRate * key.yield, 0, 10_000)
    if (key.wear) {
      finite(`${lever.id}.wear.weeklyLoad`, key.wear.weeklyLoad, Number.MIN_VALUE)
      finite(`${lever.id}.wear.damagePerDay`, key.wear.damagePerDay, 0, 1)
      finite(`${lever.id}.wear.recoveryPerDay`, key.wear.recoveryPerDay, 0, 1)
      finite(`${lever.id}.wear.floor`, key.wear.floor, 0, 1)
    }
  }
  for (const id of Object.keys(scenario.key.levers)) {
    if (!ids.has(id)) throw new ValidationError(`world scenario: the key names no lever '${id}'`)
  }
  finite('key.evidence.minOutcomes', scenario.key.evidence.minOutcomes, 0)
  finite('key.evidence.scaleFactor', scenario.key.evidence.scaleFactor, 1)
}

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`)
}

function standardNormal(rng: () => number): number {
  // Box-Muller; 1 - u keeps the log argument above zero.
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())
}

function poisson(mean: number, rng: () => number): number {
  if (mean <= 0) return 0
  if (mean >= 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * standardNormal(rng)))
  const limit = Math.exp(-mean)
  let count = 0
  let product = rng()
  while (product > limit) {
    count += 1
    product *= rng()
  }
  return count
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export class World {
  readonly scenario: WorldScenario
  readonly seed: number
  readonly scenarioDigest: string
  private state: WorldState

  constructor(scenario: WorldScenario, seed: number) {
    validateWorldScenario(scenario)
    if (!Number.isSafeInteger(seed)) {
      throw new ValidationError(`world: seed must be a safe integer, got ${seed}`)
    }
    this.scenario = scenario
    this.seed = seed
    this.scenarioDigest = worldScenarioDigest(scenario)
    const levers: Record<string, LeverState> = {}
    for (const lever of scenario.levers) {
      levers[lever.id] = {
        rate: 0,
        age: 0,
        health: 1,
        spent: 0,
        produced: 0,
        landed: 0,
        approvedMaxRate: 0,
        overdriveDays: 0,
        spendByDay: [],
        landedByDay: [],
        landing: [],
        onceByDay: {},
      }
    }
    this.state = { day: 0, budget: scenario.budget, levers, approvals: [], notes: {} }
  }

  /** Rebuild a world from `snapshot()`. The scenario and seed must be the ones it was taken from. */
  static restore(scenario: WorldScenario, snapshot: WorldSnapshot): World {
    const world = new World(scenario, snapshot.seed)
    if (snapshot.scenarioDigest !== world.scenarioDigest) {
      throw new ValidationError('world: the snapshot was taken from a different scenario')
    }
    world.state = structuredClone(snapshot.state) as WorldState
    return world
  }

  snapshot(): WorldSnapshot {
    return {
      scenarioDigest: this.scenarioDigest,
      seed: this.seed,
      state: structuredClone(this.state),
    }
  }

  // ── The clock ────────────────────────────────────────────────────────

  get day(): number {
    return this.state.day
  }

  get daysLeft(): number {
    return this.scenario.horizonDays - this.state.day
  }

  get over(): boolean {
    return this.state.day >= this.scenario.horizonDays
  }

  /** Calendar date of a day, by default today. */
  date(day = this.state.day): string {
    return new Date(dateMs(this.scenario.startDate) + day * DAY_MS).toISOString().slice(0, 10)
  }

  /** The simulated instant: midnight UTC at the start of today. */
  now(): Date {
    return new Date(dateMs(this.scenario.startDate) + this.state.day * DAY_MS)
  }

  /** Run the world forward. Time moves only here, and stops at the horizon. */
  advance(days: number): void {
    if (!Number.isSafeInteger(days) || days < 0) {
      throw new ValidationError(`world: advance takes a non-negative integer, got ${days}`)
    }
    for (let i = 0; i < days && !this.over; i++) {
      this.simulateDay(this.state.day)
      this.state.day += 1
      this.decideApprovals()
    }
  }

  // ── What the agent may read ──────────────────────────────────────────

  get notes(): Readonly<Record<string, string>> {
    return { ...this.state.notes }
  }

  status(): WorldStatus {
    const { scenario, state } = this
    let spent = 0
    let outcomes = 0
    const levers = scenario.levers.map((lever): WorldStatusLever => {
      const s = state.levers[lever.id]!
      spent += s.spent
      outcomes += s.landed
      return {
        ...lever,
        dailyRate: s.rate,
        ...(lever.requiresApproval ? { approvedMaxRate: s.approvedMaxRate } : {}),
        spent: round2(s.spent),
        outcomes: s.landed,
      }
    })
    return {
      day: state.day,
      date: this.date(),
      daysLeft: this.daysLeft,
      horizonDays: scenario.horizonDays,
      sessionEveryDays: scenario.sessionEveryDays,
      budgetLeft: round2(state.budget),
      spent: round2(spent),
      outcomes,
      outcomeUnit: scenario.outcome.unit,
      outcomeValue: scenario.outcome.value,
      currency: scenario.currency,
      approvalDelayDays: scenario.approvalDelayDays,
      levers,
      approvals: state.approvals.map((approval) => ({ ...approval })),
    }
  }

  /** Spend and landed outcomes for every finished day, by week or by day. */
  results(opts: { lever?: string; by?: 'week' | 'day' } = {}): WorldResultRow[] {
    const span = opts.by === 'day' ? 1 : WEEK_DAYS
    const rows: WorldResultRow[] = []
    for (const lever of this.scenario.levers) {
      if (opts.lever !== undefined && opts.lever !== lever.id) continue
      const s = this.state.levers[lever.id]!
      for (let from = 0; from < this.state.day; from += span) {
        const to = Math.min(from + span, this.state.day)
        let spend = 0
        let outcomes = 0
        for (let day = from; day < to; day++) {
          spend += s.spendByDay[day] ?? 0
          outcomes += s.landedByDay[day] ?? 0
        }
        rows.push({
          lever: lever.id,
          fromDay: from,
          toDay: to - 1,
          fromDate: this.date(from),
          spend: round2(spend),
          outcomes,
        })
      }
    }
    return rows
  }

  // ── What the agent may do ────────────────────────────────────────────

  /** Set a lever's standing daily spend, from today on. */
  setRate(leverId: string, dailyRate: number): WorldActionOutcome {
    const checked = this.spendCheck(leverId, dailyRate, dailyRate)
    if (!checked.ok) return checked
    const s = checked.state
    const evidence = this.evidence(leverId)
    s.rate = dailyRate
    return {
      ok: true,
      message: `${leverId} runs at ${dailyRate} ${this.scenario.currency} a day from ${this.date()}.`,
      action: { kind: 'set_rate', day: this.state.day, lever: leverId, dailyRate },
      evidence,
    }
  }

  /** Add a one-off spend to today, on top of the lever's standing rate. */
  spendOnce(leverId: string, amount: number): WorldActionOutcome {
    const s = this.state.levers[leverId]
    const today = String(this.state.day)
    const planned = (s?.rate ?? 0) + (s?.onceByDay[today] ?? 0) + amount
    const checked = this.spendCheck(leverId, amount, planned)
    if (!checked.ok) return checked
    if (!(amount > 0)) {
      return { ok: false, refused: 'invalid_input', message: 'amount must be above zero.' }
    }
    if (amount > this.state.budget) {
      return {
        ok: false,
        refused: 'insufficient_budget',
        message: `The budget has ${round2(this.state.budget)} ${this.scenario.currency} left.`,
      }
    }
    checked.state.onceByDay[today] = (checked.state.onceByDay[today] ?? 0) + amount
    return {
      ok: true,
      message: `${leverId} spends an extra ${amount} ${this.scenario.currency} on ${this.date()}.`,
      action: { kind: 'spend_once', day: this.state.day, lever: leverId, amount },
    }
  }

  /** Ask for approval to run a gated lever up to a daily rate. The decision
   *  lands `approvalDelayDays` later. */
  requestApproval(leverId: string, maxDailyRate: number, reason: string): WorldActionOutcome {
    if (this.over) return { ok: false, refused: 'episode_over', message: 'The episode is over.' }
    const lever = this.scenario.levers.find((candidate) => candidate.id === leverId)
    if (!lever) {
      return { ok: false, refused: 'unknown_lever', message: `No lever '${leverId}'.` }
    }
    if (!Number.isFinite(maxDailyRate) || maxDailyRate <= 0) {
      return { ok: false, refused: 'invalid_input', message: 'maxDailyRate must be above zero.' }
    }
    if (maxDailyRate > lever.maxRate) {
      return {
        ok: false,
        refused: 'over_max_rate',
        message: `${leverId} cannot run above ${lever.maxRate} ${this.scenario.currency} a day.`,
      }
    }
    const approval: WorldApproval = {
      id: `approval-${this.state.approvals.length + 1}`,
      lever: leverId,
      maxDailyRate,
      reason,
      requestedDay: this.state.day,
      decisionDay: this.state.day + this.scenario.approvalDelayDays,
      status: 'pending',
    }
    this.state.approvals.push(approval)
    this.decideApprovals()
    return {
      ok: true,
      message:
        approval.status === 'granted'
          ? `${approval.id} is granted.`
          : `${approval.id} is pending; the decision lands on ${this.date(approval.decisionDay)}.`,
      action: {
        kind: 'request_approval',
        day: this.state.day,
        lever: leverId,
        maxDailyRate,
        reason,
      },
    }
  }

  /** Keep a note for later sessions. Notes are the only memory the world carries. */
  saveNote(key: string, text: string): { ok: true } | { ok: false; message: string } {
    if (!key || key.length > 80) return { ok: false, message: 'key must be 1 to 80 characters.' }
    if (text.length > MAX_NOTE_CHARS) {
      return { ok: false, message: `A note holds at most ${MAX_NOTE_CHARS} characters.` }
    }
    if (!(key in this.state.notes) && Object.keys(this.state.notes).length >= MAX_NOTES) {
      return { ok: false, message: `At most ${MAX_NOTES} notes are kept.` }
    }
    if (text === '') delete this.state.notes[key]
    else this.state.notes[key] = text
    return { ok: true }
  }

  /** Apply a recorded action. Used to replay an episode. */
  apply(action: WorldAction): WorldActionOutcome {
    if (action.kind === 'set_rate') return this.setRate(action.lever, action.dailyRate)
    if (action.kind === 'spend_once') return this.spendOnce(action.lever, action.amount)
    return this.requestApproval(action.lever, action.maxDailyRate, action.reason)
  }

  // ── What only the scorer may read ────────────────────────────────────

  /** How much a lever's results can say so far. Hidden from the agent. */
  evidence(leverId: string): WorldDecisionEvidence {
    const s = this.state.levers[leverId]
    const key = this.scenario.key.levers[leverId]
    if (!s || !key) throw new ValidationError(`world: no lever '${leverId}'`)
    let maturedSpend = 0
    for (let day = 0; day + key.delayDays.max < this.state.day; day++) {
      maturedSpend += s.spendByDay[day] ?? 0
    }
    return { lever: leverId, previousRate: s.rate, landed: s.landed, maturedSpend }
  }

  end(): WorldEndState {
    const levers: WorldEndState['levers'] = {}
    let spent = 0
    let outcomes = 0
    for (const lever of this.scenario.levers) {
      const s = this.state.levers[lever.id]!
      spent += s.spent
      outcomes += s.landed
      levers[lever.id] = {
        rate: s.rate,
        health: s.health,
        spent: s.spent,
        landed: s.landed,
        inFlight: s.produced - s.landed,
        overdriveDays: s.overdriveDays,
      }
    }
    return {
      day: this.state.day,
      budgetLeft: this.state.budget,
      spent,
      outcomes,
      value: this.state.budget + outcomes * this.scenario.outcome.value,
      levers,
      approvals: this.state.approvals.map((approval) => ({ ...approval })),
    }
  }

  // ── Simulation ───────────────────────────────────────────────────────

  private spendCheck(
    leverId: string,
    amount: number,
    plannedDailySpend: number,
  ): { ok: true; state: LeverState } | Extract<WorldActionOutcome, { ok: false }> {
    if (this.over) return { ok: false, refused: 'episode_over', message: 'The episode is over.' }
    const lever = this.scenario.levers.find((candidate) => candidate.id === leverId)
    const state = this.state.levers[leverId]
    if (!lever || !state) {
      return { ok: false, refused: 'unknown_lever', message: `No lever '${leverId}'.` }
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, refused: 'invalid_input', message: 'Spend must be zero or more.' }
    }
    if (plannedDailySpend > lever.maxRate) {
      return {
        ok: false,
        refused: 'over_max_rate',
        message: `${leverId} cannot spend more than ${lever.maxRate} ${this.scenario.currency} in a day.`,
      }
    }
    // Lowering a gated lever, to zero included, never needs approval.
    if (lever.requiresApproval && amount > 0 && plannedDailySpend > state.approvedMaxRate) {
      return {
        ok: false,
        refused: 'approval_missing',
        message:
          state.approvedMaxRate > 0
            ? `${leverId} is approved up to ${state.approvedMaxRate} ${this.scenario.currency} a day. Request approval for more first.`
            : `${leverId} needs a granted approval before it can spend. Request one first.`,
      }
    }
    return { ok: true, state }
  }

  private decideApprovals(): void {
    for (const approval of this.state.approvals) {
      if (approval.status !== 'pending' || approval.decisionDay > this.state.day) continue
      approval.status = 'granted'
      const s = this.state.levers[approval.lever]!
      s.approvedMaxRate = Math.max(s.approvedMaxRate, approval.maxDailyRate)
    }
  }

  private stream(leverIndex: number, slot: number): () => number {
    return makeRng(seedFromData([[this.seed, leverIndex, slot]]))
  }

  private weekShock(leverIndex: number, key: WorldLeverKey, day: number): number {
    if (key.weeklyNoise === 0) return 1
    const week = Math.floor(day / WEEK_DAYS)
    const z = standardNormal(this.stream(leverIndex, WEEK_STREAM_OFFSET + week))
    // Mean-one lognormal, so noise moves a week's yield without moving its expectation.
    return Math.exp(key.weeklyNoise * z - key.weeklyNoise ** 2 / 2)
  }

  private simulateDay(day: number): void {
    const { scenario, state } = this
    scenario.levers.forEach((lever, leverIndex) => {
      const s = state.levers[lever.id]!
      const key = scenario.key.levers[lever.id]!

      const landedToday = s.landing[day] ?? 0
      s.landedByDay[day] = landedToday
      s.landed += landedToday

      const planned = s.rate + (s.onceByDay[String(day)] ?? 0)
      const spend = Math.min(planned, state.budget)
      state.budget -= spend
      s.spent += spend
      s.spendByDay[day] = spend
      s.age = spend > 0 ? s.age + 1 : 0

      if (spend > 0) {
        const effective =
          spend <= key.saturationRate
            ? spend
            : key.saturationRate + (spend - key.saturationRate) * key.marginalYield
        const ramp = Math.min(1, s.age / key.rampDays)
        const mean = effective * key.yield * ramp * s.health * this.weekShock(leverIndex, key, day)
        const rng = this.stream(leverIndex, day)
        const count = poisson(mean, rng)
        const { min, median, max } = key.delayDays
        const spread = max > median ? Math.log(max / median) / 2 : 0
        for (let i = 0; i < count; i++) {
          const delay = Math.round(median * Math.exp(spread * standardNormal(rng)))
          const lands = day + Math.min(max, Math.max(min, delay))
          s.landing[lands] = (s.landing[lands] ?? 0) + 1
        }
        s.produced += count
      }

      if (key.wear) {
        let load = 0
        for (let back = 0; back < WEEK_DAYS; back++) load += s.spendByDay[day - back] ?? 0
        if (load > key.wear.weeklyLoad) {
          s.overdriveDays += 1
          const excess = load / key.wear.weeklyLoad - 1
          s.health = Math.max(key.wear.floor, s.health - key.wear.damagePerDay * excess)
        } else {
          s.health = Math.min(1, s.health + key.wear.recoveryPerDay)
        }
      }
    })
  }
}
