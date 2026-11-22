import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  analyzeProfileMatrix,
  createProfileMatrixPlan,
  type DispatchContext,
  finalizeProfileMatrix,
  type JudgeConfig,
  type ProfileMatrixReportOptions,
  raceProfileMatrix,
  renderProfileMatrixReport,
  runProfileMatrixSegment,
  type Scenario,
} from '../../src/campaign'
import { type AgentProfile, agentProfileId } from '../../src/index'

/**
 * Five profiles over 32 cases in 16 two-case dockets. Answers are a fixed
 * function of profile and case, so every number the page shows has an exact
 * expected value. `weak` is never right and `strong` misses two cases in
 * different dockets, so any first batch of eight resolves `weak` as worse.
 */
const SPECS = {
  base: { model: 'a', effort: 'low', harness: 'box', accuracy: 0.65 },
  strong: { model: 'a', effort: 'high', harness: 'box', accuracy: 1 },
  flash: { model: 'b', effort: 'low', harness: 'box', accuracy: 0.35 },
  'flash-high': { model: 'b', effort: 'high', harness: 'box', accuracy: 0.5 },
  weak: { model: 'a', effort: 'low', harness: 'none', accuracy: 0 },
} as const
type Name = keyof typeof SPECS
const NAMES = Object.keys(SPECS) as Name[]
const SLICES = ['dismiss', 'summary', 'compel', 'strike']

interface Answer {
  correct: boolean
  probability: number
}

const scenarios: Scenario[] = Array.from({ length: 32 }, (_, i) => ({
  id: `case-${String(i).padStart(2, '0')}`,
  kind: 'fixture',
}))
const indexOf = (caseId: string) => Number(caseId.slice('case-'.length))
const clusters = Object.fromEntries(scenarios.map((s) => [s.id, `docket-${indexOf(s.id) >> 1}`]))
const slices = Object.fromEntries(scenarios.map((s) => [s.id, SLICES[indexOf(s.id) % 4]!]))

const modelId = (name: Name) => `fixture/model-${SPECS[name].model}@2026-08-01`
const profiles: AgentProfile[] = NAMES.map((name) => ({
  name: `race-${name}`,
  model: { default: modelId(name) },
  prompt: { systemPrompt: `Answer as the ${name} profile.` },
}))
const id = Object.fromEntries(
  NAMES.map((name, i) => [name, agentProfileId(profiles[i]!)]),
) as Record<Name, string>
const nameOf = (profile: AgentProfile) => profile.name!.slice('race-'.length) as Name
const factors = Object.fromEntries(
  NAMES.map((name) => {
    const { model, effort, harness } = SPECS[name]
    return [id[name], { model, effort, harness }]
  }),
)

function unit(text: string): number {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return hash / 2 ** 32
}

function isRight(name: Name, caseIndex: number): boolean {
  if (name === 'weak') return false
  if (name === 'strong') return caseIndex !== 5 && caseIndex !== 22
  return unit(`${name}:${caseIndex}`) < SPECS[name].accuracy
}

const accuracy = (name: Name) =>
  scenarios.filter((s) => isRight(name, indexOf(s.id))).length / scenarios.length

const judge: JudgeConfig<Answer, Scenario> = {
  name: 'verdict',
  judgeVersion: 'race-report-fixture/1',
  dimensions: [
    { key: 'correct', description: 'the answer matches the ruling' },
    { key: 'probability', description: 'the profile’s forecast that it is right' },
  ],
  score: ({ artifact }) => ({
    dimensions: { correct: artifact.correct ? 1 : 0, probability: artifact.probability },
    composite: artifact.correct ? 1 : 0,
    notes: '',
  }),
}

function dispatchFor(calls: string[]) {
  return async (
    profile: AgentProfile,
    scenario: Scenario,
    context: DispatchContext,
  ): Promise<Answer> => {
    const name = nameOf(profile)
    const spec = SPECS[name]
    calls.push(`${name}:${scenario.id}`)
    const high = spec.effort === 'high'
    await new Promise((resolve) =>
      setTimeout(resolve, (high ? 8 : 2) + (spec.harness === 'box' ? 2 : 0)),
    )
    const correct = isRight(name, indexOf(scenario.id))
    const paid = await context.cost.runPaidCall({
      actor: 'fixture-agent',
      model: modelId(name),
      execute: async () => ({
        correct,
        probability: correct ? (name === 'strong' ? 0.9 : 0.7) : name === 'strong' ? 0.4 : 0.6,
      }),
      receipt: () => ({
        model: modelId(name),
        inputTokens: 1000 + 10 * indexOf(scenario.id) + (spec.harness === 'box' ? 500 : 0),
        outputTokens: high ? 400 : 100,
        reasoningTokens: high ? 300 : 20,
        actualCostUsd: (spec.model === 'a' ? 0.002 : 0.0005) * (high ? 2 : 1),
      }),
    })
    if (!paid.succeeded) throw paid.error
    return paid.value
  }
}

function plan() {
  return createProfileMatrixPlan<Scenario, Answer>({
    profiles,
    scenarios,
    judges: [judge],
    commitSha: 'fixture-commit',
    dispatchRef: 'race-report-fixture/1',
    seed: 7,
  })
}

const roots: string[] = []
function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-race-report-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('profile matrix race and decision page', () => {
  it('races, replays from its segments, completes the skipped rows and renders the page', async () => {
    const current = plan()
    const root = runDir()
    const calls: string[] = []
    const raceOptions = {
      plan: current,
      runDir: root,
      baseline: id.base,
      firstBatch: 8,
      clusters,
      maxConcurrency: 4,
    }
    const race = await raceProfileMatrix({ ...raceOptions, dispatch: dispatchFor(calls) })

    const decisions = race.log.flatMap((batch) =>
      batch.standings.map((standing) => ({ batch: batch.batch, ...standing })),
    )
    const weakDrop = decisions.find((d) => d.profileId === id.weak && d.dropped)
    expect(weakDrop?.batch).toBe(1)
    expect(weakDrop?.reason).toMatch(/lies below zero/)
    expect(weakDrop?.high).toBeLessThan(0)
    expect(race.survivors).toContain(id.base)
    expect(race.survivors).not.toContain(id.weak)
    expect(race.log.map((batch) => batch.casesSeen)).toEqual([8, 16, 32].slice(0, race.log.length))
    expect(race.cellsRun).toBe(calls.length)
    expect(race.cellsRun).toBeLessThan(race.plannedCells)
    expect(calls.filter((call) => call.startsWith('weak:'))).toHaveLength(8)
    expect(race.final.cases).toBe(race.casesRaced.length)
    expect(race.selectionBias).toContain(race.leader)
    expect(race.selectionBias).toMatch(/biased upward/)
    expect(race.selectionBias).toMatch(/held-out/)

    // A second call replays the claimed segments from the cell cache.
    const replayCalls: string[] = []
    const replay = await raceProfileMatrix({ ...raceOptions, dispatch: dispatchFor(replayCalls) })
    expect(replayCalls).toEqual([])
    expect(replay.log).toEqual(race.log)
    expect(replay.leader).toBe(race.leader)

    // The rows the race skipped stay claimable, so the full matrix can still be finalized.
    const ran = new Set(race.records.map((r) => `${r.candidateId}:${r.scenarioId}`))
    const skipped = current.rows.filter((row) => !ran.has(`${row.profileId}:${row.scenarioId}`))
    expect(skipped.length).toBe(race.plannedCells - race.cellsRun)
    await runProfileMatrixSegment({
      plan: current,
      segmentId: 'complete',
      rows: skipped.map((row) => row.rowId),
      dispatch: dispatchFor(calls),
      runDir: root,
      maxConcurrency: 4,
    })
    const full = await finalizeProfileMatrix({ plan: current, runDir: root })
    expect(full.records).toHaveLength(current.rows.length)
    for (const record of full.records) {
      const dispatchMs = record.outcome.raw.dispatch_ms
      expect(Number.isFinite(dispatchMs)).toBe(true)
      expect(dispatchMs).toBeLessThanOrEqual(record.wallMs)
    }

    const options: ProfileMatrixReportOptions = {
      source: full,
      baseline: id.base,
      clusters,
      slices,
      factors,
      probabilityOf: (record) => record.outcome.raw['verdict.probability'],
      race,
      title: 'Fixture motions',
    }
    const analysis = analyzeProfileMatrix(options)
    expect(analysis.passFail).toBe(true)
    expect(analysis.sharedCases).toHaveLength(32)
    expect(analysis.sharedClusters).toBe(16)
    expect(analysis.profiles.map((p) => p.profileId)).toEqual(NAMES.map((name) => id[name]))
    for (const name of NAMES) {
      const stats = analysis.profiles.find((p) => p.profileId === id[name])!
      expect(stats.quality?.estimate).toBeCloseTo(accuracy(name), 12)
      expect(stats.failureRate).toBe(0)
      if (name !== 'base') {
        expect(stats.vsBaseline?.estimate).toBeCloseTo(accuracy(name) - accuracy('base'), 12)
        expect(stats.vsBaseline?.n).toBe(32)
      }
    }
    const effort = analysis.factorEffects.find((e) => e.factor === 'effort' && e.level === 'high')
    expect(effort?.reference).toBe('low')
    expect(effort?.matchedPairs).toBe(2)
    expect(effort?.effect?.estimate).toBeCloseTo(
      (accuracy('strong') - accuracy('base') + accuracy('flash-high') - accuracy('flash')) / 2,
      12,
    )
    const harness = analysis.factorEffects.find((e) => e.factor === 'harness')
    expect(harness).toMatchObject({ level: 'none', reference: 'box', matchedPairs: 1 })
    expect(harness?.effect?.estimate).toBeCloseTo(accuracy('weak') - accuracy('base'), 12)
    expect(harness?.effect?.high).toBeLessThan(0)

    expect(analysis.axes.map((axis) => [axis.axis, axis.drawn])).toEqual([
      ['usd', true],
      ['tokens', true],
      ['seconds', true],
    ])
    const tokens = analysis.axes.find((axis) => axis.axis === 'tokens')!
    expect(tokens.frontier[0]).toBe(id.weak)
    expect(tokens.frontier).toContain(id.strong)
    expect(analysis.oracle).toBeGreaterThanOrEqual(accuracy('strong'))
    const shares = analysis.difficulty.map((item) => item.share)
    expect(shares).toEqual([...shares].sort((x, y) => x - y))
    expect(analysis.sliceCells).toHaveLength(NAMES.length * SLICES.length)
    expect(analysis.calibration).toHaveLength(NAMES.length)
    expect(analysis.calibration.every((c) => Number.isFinite(c.ece) && c.n === 32)).toBe(true)
    expect(analysis.power?.clusters).toBe(16)
    expect(analysis.power?.detectable).toBeGreaterThan(0)
    expect(analysis.power?.detectable).toBeLessThanOrEqual(1)

    const html = renderProfileMatrixReport(options)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    const headings = [
      'Frontier',
      'Profiles',
      'Factor main effects',
      'Slices',
      'Error overlap',
      'Item difficulty',
      'Calibration',
      'Power',
      'Race',
    ]
    const positions = headings.map((heading) => html.indexOf(`<h2>${heading}</h2>`))
    expect(positions.every((position) => position > 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((x, y) => x - y))
    expect(html).toContain(race.selectionBias)
    expect(html).toContain('prefers-color-scheme:dark')
    expect(html).toContain(':root[data-theme="dark"]')
    expect(html).not.toMatch(/https?:\/\/|<script|<link|@import|url\(/)
    expect((html.match(/<svg/g) ?? []).length).toBeGreaterThan(3 + NAMES.length)
  })

  it('stops before a batch that would pass the cell budget', async () => {
    const calls: string[] = []
    const race = await raceProfileMatrix({
      plan: plan(),
      dispatch: dispatchFor(calls),
      runDir: runDir(),
      baseline: id.base,
      firstBatch: 8,
      cellBudget: 48,
      clusters,
      maxConcurrency: 4,
    })
    expect(race.stoppedBecause).toBe('cell-budget')
    expect(race.log).toHaveLength(1)
    expect(race.cellsRun).toBe(40)
    expect(calls).toHaveLength(40)
    expect(race.casesRaced).toHaveLength(8)
  })
})
