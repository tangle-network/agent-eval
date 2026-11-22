import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/errors'
import {
  compareWorldPolicies,
  doNothingPolicy,
  type EvidencePolicyOptions,
  evidencePolicy,
  impulsivePolicy,
  informedPolicy,
  launchQuarterScenario,
  patientPolicy,
  randomPolicy,
  replayWorld,
  runWorldEpisode,
  setAndHoldPolicy,
  World,
  type WorldAgent,
  type WorldResultRow,
  type WorldScenario,
  type WorldSession,
  type WorldStatus,
  type WorldToolResult,
  worldActions,
  worldDecisionCosts,
  worldTools,
} from '../src/world'

const scenario = launchQuarterScenario
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

function landed(world: World, lever: string, fromDay: number, toDay: number): number {
  return world
    .results({ lever, by: 'day' })
    .filter((row) => row.fromDay >= fromDay && row.fromDay <= toDay)
    .reduce((sum, row) => sum + row.outcomes, 0)
}

describe('launch quarter: the scripted policies rank as the scenario intends', () => {
  it('patient beats impulsive, set-and-hold and both floors by more than seed noise', async () => {
    const comparison = await compareWorldPolicies({
      scenario,
      seeds: SEEDS,
      policies: {
        'do-nothing': () => doNothingPolicy,
        random: (seed) => randomPolicy(seed),
        impulsive: () => impulsivePolicy,
        'set-and-hold': () => setAndHoldPolicy,
        patient: () => patientPolicy,
        informed: () => informedPolicy(scenario),
      },
      contrasts: [
        ['patient', 'impulsive'],
        ['patient', 'set-and-hold'],
        ['patient', 'random'],
        ['patient', 'do-nothing'],
        ['informed', 'patient'],
      ],
    })
    const row = (policy: string) => comparison.rows.find((r) => r.policy === policy)!

    // Doing nothing keeps the budget, exactly, on every seed.
    expect(row('do-nothing').values).toEqual(SEEDS.map(() => scenario.budget))
    for (const contrast of comparison.contrasts.slice(0, 4)) {
      expect(contrast.wins, `${contrast.better} over ${contrast.worse}`).toBe(SEEDS.length)
      expect(contrast.beyondNoise, `${contrast.better} over ${contrast.worse}`).toBe(true)
    }
    // The policy that reads the key is the ceiling the others are read against.
    expect(comparison.contrasts[4]!.wins).toBe(SEEDS.length)
    // Random spending loses money on average; acting on last week's number
    // makes far less than waiting.
    expect(row('random').mean).toBeLessThan(scenario.budget)
    expect(row('patient').meanGain).toBeGreaterThan(3 * row('impulsive').meanGain)
    // Neither scripted policy ever tries to send without an approval; the gap
    // between them is not an approvals gap.
    expect(row('patient').unapprovedSpendAttempts).toBe(0)
    expect(row('impulsive').unapprovedSpendAttempts).toBe(0)
    expect(row('random').unapprovedSpendAttempts).toBeGreaterThan(0)
    // The log shows why impulsive loses: its cuts and scale-ups come before
    // the evidence exists. The patient policy makes none.
    expect(row('patient').prematureDecisions).toBe(0)
    expect(row('impulsive').prematureDecisions).toBeGreaterThanOrEqual(3 * SEEDS.length)
    expect(comparison.rows.every((r) => r.failedSessions === 0)).toBe(true)
  })

  it('rewards reading matured results, staying inside guidelines and planning to the horizon', async () => {
    // The patient policy with one habit removed at a time. Each removal has to
    // cost: otherwise the scenario is not testing that habit.
    const patient: EvidencePolicyOptions = {
      evidence: 'matured',
      minEvidenceDays: 14,
      confidence: 2,
      scaleStep: 1.25,
      ceiling: 'guideline',
      planAhead: true,
    }
    const comparison = await compareWorldPolicies({
      scenario,
      seeds: SEEDS,
      policies: {
        patient: () => evidencePolicy(patient),
        'acts on the latest week': () => evidencePolicy({ ...patient, evidence: 'latest' }),
        'ignores guidelines': () => evidencePolicy({ ...patient, ceiling: 'max' }),
        'does not plan ahead': () => evidencePolicy({ ...patient, planAhead: false }),
      },
      contrasts: [
        ['patient', 'acts on the latest week'],
        ['patient', 'ignores guidelines'],
        ['patient', 'does not plan ahead'],
      ],
    })
    const [latest, guidelines, planning] = comparison.contrasts
    expect(latest!.meanDifference).toBeGreaterThan(10_000)
    expect(latest!.wins).toBe(SEEDS.length)
    expect(guidelines!.meanDifference).toBeGreaterThan(8_000)
    expect(guidelines!.wins).toBeGreaterThanOrEqual(9)
    expect(planning!.meanDifference).toBeGreaterThan(2_000)
    expect(planning!.wins).toBeGreaterThanOrEqual(8)
  })

  it('prices the early kills of the impulsive policy as its costliest decisions', async () => {
    const episode = await runWorldEpisode({ scenario, seed: 1, agent: impulsivePolicy })
    const costs = worldDecisionCosts(scenario, episode)
    const worst = costs[0]!
    expect(worst.action).toMatchObject({ kind: 'set_rate', dailyRate: 0 })
    expect(worst.day).toBeLessThanOrEqual(14)
    expect(worst.expectedCost).toBeGreaterThan(5_000)
    // Asking for approval is the opposite: removing it would have cost the lever.
    const approval = costs.find(
      (cost) => cost.action.kind === 'request_approval' && cost.action.lever === 'email',
    )!
    expect(approval.expectedCost).toBeLessThan(0)
  })
})

describe('the world clock and delayed consequences', () => {
  it('moves time only when advanced, and lands results after their delay', () => {
    const world = new World(scenario, 7)
    expect(world.date()).toBe('2027-01-04')
    expect(world.setRate('community', 200).ok).toBe(true)
    world.status()
    world.results()
    expect(world.day).toBe(0)

    world.advance(7)
    expect(world.date()).toBe('2027-01-11')
    expect(world.now().toISOString()).toBe('2027-01-11T00:00:00.000Z')
    // A week of spend is on the books and nothing has landed: the fastest
    // community result takes seven days.
    expect(world.status().levers.find((l) => l.id === 'community')!.spent).toBe(1_400)
    expect(landed(world, 'community', 0, 6)).toBe(0)

    world.advance(28)
    expect(landed(world, 'community', 7, 34)).toBeGreaterThan(20)
    world.advance(1_000)
    expect(world.day).toBe(scenario.horizonDays)
    expect(world.setRate('community', 100)).toMatchObject({ ok: false, refused: 'episode_over' })
  })

  it('spends a one-off today only, inside the same cap and approval as the rate', () => {
    const world = new World(scenario, 6)
    expect(world.setRate('paid_search', 300).ok).toBe(true)
    expect(world.spendOnce('paid_search', 900)).toMatchObject({ ok: true })
    // Rate and one-off share the daily cap, whichever comes first.
    expect(world.spendOnce('paid_search', 400).refused).toBe('over_max_rate')
    expect(world.setRate('paid_search', 700).refused).toBe('over_max_rate')
    expect(world.setRate('paid_search', 600).ok).toBe(true)
    // A gated lever's one-off needs an approval that covers the whole day.
    world.requestApproval('email', 60, 'launch send')
    world.advance(scenario.approvalDelayDays)
    expect(world.day).toBe(2)
    expect(world.spendOnce('email', 60).ok).toBe(true)
    expect(world.setRate('email', 60).refused).toBe('approval_missing')
    expect(world.setRate('email', 0).ok).toBe(true)
    // One-offs cannot be placed past the budget.
    expect(world.spendOnce('paid_social', 1_500).ok).toBe(true)
    expect(world.spendOnce('community', 800).ok).toBe(true)
    expect(world.spendOnce('content', 1).refused).toBe('approval_missing')

    const snapshot = JSON.parse(JSON.stringify(world.snapshot()))
    world.advance(1)
    const day2 = (lever: string) => world.results({ lever, by: 'day' })[2]!.spend
    expect(world.results({ lever: 'paid_search', by: 'day' }).map((row) => row.spend)).toEqual([
      1_500, 600, 600,
    ])
    expect(day2('email')).toBe(60)
    expect(day2('paid_social')).toBe(1_500)
    world.advance(1)
    expect(world.results({ lever: 'email', by: 'day' })[3]!.spend).toBe(0)
    expect(world.results({ lever: 'paid_social', by: 'day' })[3]!.spend).toBe(0)

    // The one-off survives a snapshot taken before its day ran, and a replay.
    const resumed = World.restore(scenario, snapshot)
    resumed.advance(2)
    world.advance(world.daysLeft)
    resumed.advance(resumed.daysLeft)
    expect(resumed.end()).toEqual(world.end())
    expect(
      replayWorld(scenario, 6, [
        { kind: 'set_rate', day: 0, lever: 'paid_search', dailyRate: 300 },
        { kind: 'spend_once', day: 0, lever: 'paid_search', amount: 900 },
        { kind: 'set_rate', day: 0, lever: 'paid_search', dailyRate: 600 },
        {
          kind: 'request_approval',
          day: 0,
          lever: 'email',
          maxDailyRate: 60,
          reason: 'launch send',
        },
        { kind: 'spend_once', day: 2, lever: 'email', amount: 60 },
        { kind: 'spend_once', day: 2, lever: 'paid_social', amount: 1_500 },
        { kind: 'spend_once', day: 2, lever: 'community', amount: 800 },
      ]),
    ).toEqual(world.end())
  })

  it('makes over-driving a lever look good this week and cost the quarter', () => {
    const run = (rate: number) => {
      const world = new World(scenario, 3)
      world.requestApproval('email', rate, 'test')
      world.advance(scenario.approvalDelayDays)
      expect(world.setRate('email', rate).ok).toBe(true)
      world.advance(9)
      const firstWeek = world.status().outcomes
      world.advance(world.daysLeft)
      return { firstWeek, end: world.end() }
    }
    const guideline = run(scenario.levers[0]!.guidelineRate)
    const hard = run(scenario.levers[0]!.maxRate)
    expect(hard.firstWeek).toBeGreaterThan(2 * guideline.firstWeek)
    expect(hard.end.outcomes).toBeLessThan(guideline.end.outcomes)
    expect(hard.end.value).toBeLessThan(guideline.end.value - 20_000)
    expect(hard.end.levers.email!.health).toBeLessThan(0.5)
    expect(guideline.end.levers.email!.overdriveDays).toBe(0)
  })

  it('is a function of scenario, seed and actions, however often the agent looks', async () => {
    const looksOften: WorldAgent = (session) => {
      for (let i = 0; i < 10; i++) session.call('results', { by: 'day' })
      return patientPolicy(session)
    }
    const once = await runWorldEpisode({ scenario, seed: 4, agent: patientPolicy })
    const again = await runWorldEpisode({ scenario, seed: 4, agent: patientPolicy })
    const often = await runWorldEpisode({ scenario, seed: 4, agent: looksOften })
    const other = await runWorldEpisode({ scenario, seed: 5, agent: patientPolicy })
    expect(again).toEqual(once)
    expect(often.end).toEqual(once.end)
    expect(other.end.value).not.toBe(once.end.value)
    expect(replayWorld(scenario, 4, worldActions(once.log))).toEqual(once.end)

    // A world stopped and restored from a JSON snapshot ends the same: once
    // with an approval still pending, once mid-quarter with weeks of content
    // and community results still in flight.
    const whole = new World(scenario, 4)
    whole.requestApproval('content', 250, 'publish')
    whole.setRate('community', 200)
    whole.advance(1)
    let resumed = World.restore(scenario, JSON.parse(JSON.stringify(whole.snapshot())))
    for (const world of [whole, resumed]) {
      expect(world.status().approvals[0]!.status).toBe('pending')
      world.advance(1)
      expect(world.setRate('content', 250).ok).toBe(true)
      world.advance(38)
    }
    expect(whole.end().levers.content!.inFlight).toBeGreaterThan(20)
    resumed = World.restore(scenario, JSON.parse(JSON.stringify(resumed.snapshot())))
    whole.advance(51)
    resumed.advance(51)
    expect(resumed.end()).toEqual(whole.end())
    expect(resumed.results({ by: 'day' })).toEqual(whole.results({ by: 'day' }))
    const edited: WorldScenario = { ...scenario, budget: scenario.budget + 1 }
    expect(() => World.restore(edited, whole.snapshot())).toThrow(ValidationError)
  })
})

describe('the multi-session driver', () => {
  it('carries only what the agent saved', async () => {
    const seen: Array<Record<string, string>> = []
    const closed: WorldToolResult[] = []
    let previous: WorldSession | undefined
    const agent: WorldAgent = (session) => {
      seen.push({ ...session.notes })
      if (previous) closed.push(previous.call('status'))
      previous = session
      if (session.index === 0) {
        session.call('save_note', { key: 'plan', text: 'wait for week 3' })
        expect(session.call('save_note', { key: '__proto__', text: 'x' }).ok).toBe(false)
        // What the agent holds is a copy; editing it changes no record.
        const status = session.call('status')
        ;(status.data as WorldStatus).levers[0]!.resultLagDays.to = 999
        status.ok = false
      }
      if (session.index === 2) session.call('save_note', { key: 'plan', text: '' })
    }
    const episode = await runWorldEpisode({ scenario, seed: 1, agent })
    expect(episode.sessions).toHaveLength(13)
    expect(episode.sessions.map((s) => s.day)).toEqual(
      Array.from({ length: 13 }, (_, index) => index * 7),
    )
    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ plan: 'wait for week 3' })
    expect(seen[2]).toEqual({ plan: 'wait for week 3' })
    expect(seen[3]).toEqual({})
    // A session handed out earlier is closed: it cannot act in a later one.
    expect(closed.every((result) => result.refused === 'session_closed')).toBe(true)
    expect(episode.score.refused.session_closed).toBe(12)
    expect(episode.score.refused.invalid_input).toBe(1)
    expect(episode.sessions.map((s) => s.calls)).toEqual([3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(episode.log.find((entry) => entry.tool === 'status')!.result.ok).toBe(true)
    expect(scenario.levers[0]!.resultLagDays.to).toBe(4)
  })

  it('records an agent that throws and lets the quarter go on', async () => {
    const agent: WorldAgent = (session) => {
      if (session.index === 0) session.call('set_rate', { lever: 'paid_search', dailyRate: 300 })
      if (session.index === 3) throw new Error('model endpoint down')
    }
    const episode = await runWorldEpisode({ scenario, seed: 2, agent })
    expect(episode.sessions[3]).toMatchObject({ error: 'model endpoint down' })
    expect(episode.sessions.filter((s) => s.error)).toHaveLength(1)
    expect(episode.score.failedSessions).toBe(1)
    expect(episode.end.levers.paid_search!.spent).toBe(300 * 91)

    // A service failure is not the agent's choice: an arm with one is never
    // declared beaten, or the winner, beyond noise.
    const flaky = await compareWorldPolicies({
      scenario,
      seeds: [1, 2, 3],
      policies: {
        patient: () => patientPolicy,
        'do-nothing': () => doNothingPolicy,
        flaky: () => agent,
      },
      contrasts: [
        ['patient', 'do-nothing'],
        ['patient', 'flaky'],
      ],
    })
    expect(flaky.rows.find((r) => r.policy === 'flaky')!.failedSessions).toBe(3)
    expect(flaky.contrasts[0]!.beyondNoise).toBe(true)
    expect(flaky.contrasts[1]!.wins).toBe(3)
    expect(flaky.contrasts[1]!.beyondNoise).toBe(false)
    await expect(
      compareWorldPolicies({
        scenario,
        seeds: [1, 2],
        policies: { patient: () => patientPolicy },
        contrasts: [['patient', 'impulsiv']],
      }),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses a send with no recorded approval and logs the attempt', async () => {
    const agent: WorldAgent = (session) => {
      if (session.index === 0) {
        expect(session.call('set_rate', { lever: 'email', dailyRate: 40 })).toMatchObject({
          ok: false,
          refused: 'approval_missing',
        })
        expect(session.call('spend_once', { lever: 'content', amount: 500 }).refused).toBe(
          'approval_missing',
        )
        session.call('request_approval', { lever: 'email', maxDailyRate: 60, reason: 'launch' })
        // Asking is not having: the decision takes two days.
        expect(session.call('set_rate', { lever: 'email', dailyRate: 40 }).ok).toBe(false)
      }
      if (session.index === 1) {
        const status = session.call('status').data as WorldStatus
        expect(status.approvals).toMatchObject([
          { lever: 'email', status: 'granted', requestedDay: 0, decisionDay: 2 },
        ])
        expect(session.call('set_rate', { lever: 'email', dailyRate: 60 }).ok).toBe(true)
        expect(session.call('set_rate', { lever: 'email', dailyRate: 61 }).refused).toBe(
          'approval_missing',
        )
        expect(session.call('set_rate', { lever: 'email', dailyRate: 9_999 }).refused).toBe(
          'over_max_rate',
        )
        expect(session.call('launch_missiles', {}).refused).toBe('unknown_tool')
      }
    }
    const episode = await runWorldEpisode({ scenario, seed: 1, agent })
    expect(episode.sessions.every((s) => s.error === undefined)).toBe(true)
    expect(episode.score.refused).toEqual({
      approval_missing: 4,
      over_max_rate: 1,
      unknown_tool: 1,
    })
    expect(episode.end.levers.email!.spent).toBe(60 * 84)
    expect(episode.end.levers.content!.spent).toBe(0)
    expect(worldActions(episode.log).map((action) => action.kind)).toEqual([
      'request_approval',
      'set_rate',
    ])
  })
})

describe('the key stays hidden', () => {
  it('appears in no brief, tool definition or tool result', async () => {
    const episode = await runWorldEpisode({ scenario, seed: 9, agent: randomPolicy(9) })
    const patient = await runWorldEpisode({ scenario, seed: 9, agent: patientPolicy })
    const shown = JSON.stringify([
      scenario.brief,
      worldTools(scenario),
      ...[...episode.log, ...patient.log].map((entry) => entry.result),
    ])
    const hiddenFields = [
      ...Object.keys(scenario.key.levers.email!),
      ...Object.keys(scenario.key.levers.email!.wear!),
      ...Object.keys(scenario.key.evidence),
      'health',
      'maturedSpend',
      'inFlight',
      'produced',
    ]
    for (const field of hiddenFields) {
      expect(shown, `'${field}' reached the agent`).not.toContain(`"${field}"`)
    }
    // What the agent does see: rows of spend and landed outcomes per period.
    const rows = patient.log.find((entry) => entry.tool === 'results' && entry.day === 14)!.result
      .data as WorldResultRow[]
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['fromDate', 'fromDay', 'lever', 'outcomes', 'spend', 'toDay'].sort(),
    )
  })

  it('refuses a scenario whose key does not cover its levers', () => {
    const { email: _email, ...rest } = scenario.key.levers
    const broken: WorldScenario = { ...scenario, key: { ...scenario.key, levers: rest } }
    expect(() => new World(broken, 1)).toThrow(ValidationError)
  })
})
