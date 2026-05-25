import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FsLabeledScenarioStore,
  LabeledScenarioStoreError,
  type DispatchFn,
  type JudgeConfig,
  type Scenario,
  runCampaign,
} from '../../src/campaign/index'

interface FakeScenario extends Scenario {
  id: string
  kind: string
  intent: string
}

interface FakeArtifact {
  text: string
  intent: string
}

const DISPATCH: DispatchFn<FakeScenario, FakeArtifact> = async (scenario, ctx) => {
  ctx.cost.observe(0.01, 'fake-llm')
  return { text: `dispatched-${scenario.id}-rep${ctx.rep}`, intent: scenario.intent }
}

const SCENARIOS: FakeScenario[] = [
  { id: 'a', kind: 'chat', intent: 'help with X' },
  { id: 'b', kind: 'chat', intent: 'do Y' },
]

let runDir: string

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'run-campaign-'))
})

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('runCampaign — core primitive', () => {
  it('runs every (scenario × rep) cell and returns a CampaignResult', async () => {
    const result = await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      reps: 2,
      runDir,
    })

    expect(result.cells).toHaveLength(4)
    expect(result.aggregates.cellsExecuted).toBe(4)
    expect(result.aggregates.cellsFailed).toBe(0)
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.seed).toBe(42)
    expect(result.scenarios).toEqual([
      { id: 'a', kind: 'chat' },
      { id: 'b', kind: 'chat' },
    ])
  })

  it('produces a stable manifestHash for identical inputs', async () => {
    const r1 = await runCampaign({ scenarios: SCENARIOS, dispatch: DISPATCH, runDir })
    const r2 = await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      runDir: mkdtempSync(join(tmpdir(), 'run-campaign-')),
    })
    expect(r1.manifestHash).toBe(r2.manifestHash)
  })

  it('changes manifestHash when seed changes', async () => {
    const r1 = await runCampaign({ scenarios: SCENARIOS, dispatch: DISPATCH, seed: 42, runDir })
    const r2 = await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      seed: 1337,
      runDir: mkdtempSync(join(tmpdir(), 'run-campaign-')),
    })
    expect(r1.manifestHash).not.toBe(r2.manifestHash)
  })

  it('threads cell-level seed = baseSeed + cellIndex', async () => {
    const seenSeeds: number[] = []
    const dispatch: DispatchFn<FakeScenario, FakeArtifact> = async (s, ctx) => {
      seenSeeds.push(ctx.seed)
      return { text: '', intent: s.intent }
    }
    await runCampaign({ scenarios: SCENARIOS, dispatch, seed: 100, reps: 2, runDir })
    expect(seenSeeds.sort()).toEqual([100, 101, 102, 103])
  })

  it('resumes cached cells on rerun (resumability)', async () => {
    let dispatchCount = 0
    const counting: DispatchFn<FakeScenario, FakeArtifact> = async (s, ctx) => {
      dispatchCount += 1
      return { text: `${s.id}-${ctx.rep}`, intent: s.intent }
    }
    await runCampaign({ scenarios: SCENARIOS, dispatch: counting, runDir })
    expect(dispatchCount).toBe(2)

    // Second run with same runDir + scenarios should hit cache.
    const r2 = await runCampaign({ scenarios: SCENARIOS, dispatch: counting, runDir })
    expect(dispatchCount).toBe(2) // no new dispatches
    expect(r2.cells.every((c) => c.cached)).toBe(true)
    expect(r2.aggregates.cellsCached).toBe(2)
  })

  it('captures dispatch errors per cell without crashing campaign', async () => {
    const flaky: DispatchFn<FakeScenario, FakeArtifact> = async (s) => {
      if (s.id === 'a') throw new Error('boom')
      return { text: 'ok', intent: s.intent }
    }
    const result = await runCampaign({ scenarios: SCENARIOS, dispatch: flaky, runDir })
    expect(result.cells).toHaveLength(2)
    expect(result.aggregates.cellsFailed).toBe(1)
    expect(result.cells.find((c) => c.scenarioId === 'a')?.error).toContain('boom')
    expect(result.cells.find((c) => c.scenarioId === 'b')?.error).toBeUndefined()
  })

  it('respects costCeiling and marks excess cells skipped', async () => {
    const expensive: DispatchFn<FakeScenario, FakeArtifact> = async (s, ctx) => {
      ctx.cost.observe(10, 'expensive')
      return { text: '', intent: s.intent }
    }
    const result = await runCampaign({
      scenarios: [
        { id: 'a', kind: 'chat', intent: 'x' },
        { id: 'b', kind: 'chat', intent: 'y' },
        { id: 'c', kind: 'chat', intent: 'z' },
      ],
      dispatch: expensive,
      costCeiling: 15,
      maxConcurrency: 1, // serialize so cost-ceiling fires deterministically
      runDir,
    })
    expect(result.aggregates.totalCostUsd).toBeGreaterThanOrEqual(10)
    expect(result.aggregates.cellsSkipped).toBeGreaterThanOrEqual(1)
  })

  it('runs judges scoped via appliesTo', async () => {
    const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'len',
      dimensions: [{ key: 'len', description: 'text length' }],
      systemPrompt: '',
      buildPrompt: () => '',
      appliesTo: (s) => s.id === 'a',
    }
    const result = await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      judges: [judge],
      runDir,
    })
    const aCell = result.cells.find((c) => c.scenarioId === 'a')!
    const bCell = result.cells.find((c) => c.scenarioId === 'b')!
    expect(Object.keys(aCell.judgeScores)).toContain('len')
    expect(Object.keys(bCell.judgeScores)).not.toContain('len')
  })

  it('writes spans.jsonl per cell', async () => {
    await runCampaign({ scenarios: SCENARIOS.slice(0, 1), dispatch: DISPATCH, runDir })
    const cellDirs = readdirSync(runDir).filter((d) => d.startsWith('a_'))
    expect(cellDirs.length).toBeGreaterThan(0)
  })
})

describe('FsLabeledScenarioStore', () => {
  let storeDir: string
  let store: FsLabeledScenarioStore

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'labeled-store-'))
    store = new FsLabeledScenarioStore({ root: storeDir })
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  it('rejects writes without provenance', async () => {
    await expect(
      store.observe({
        scenario: { id: 'a', kind: 'chat' },
        artifact: {},
        judgeScores: {},
      } as never),
    ).rejects.toBeInstanceOf(LabeledScenarioStoreError)
  })

  it('rejects sample() without explicit split', async () => {
    await expect(
      store.sample({ count: 10 } as never),
    ).rejects.toMatchObject({ code: 'split_required' })
  })

  it('rejects sample() without capturedBefore', async () => {
    await expect(
      store.sample({ count: 10, split: 'train' } as never),
    ).rejects.toMatchObject({ code: 'capturedBefore_required' })
  })

  it('excludes production-trace from train sample by default', async () => {
    await store.observe({
      scenario: { id: 'p1', kind: 'chat' },
      artifact: {},
      judgeScores: {},
      source: 'production-trace',
      sourceVersionHash: 'v1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      redactionStatus: 'raw',
    })
    await store.observe({
      scenario: { id: 'e1', kind: 'chat' },
      artifact: {},
      judgeScores: {},
      source: 'eval-run',
      sourceVersionHash: 'v1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      redactionStatus: 'raw',
    })

    // Default train sample — production-trace excluded.
    const trainDefault = await store.sample({
      count: 10,
      split: 'train',
      capturedBefore: '2026-12-31T00:00:00.000Z',
    })
    expect(trainDefault.map((r) => r.scenario.id)).toEqual(['e1'])

    // Explicit opt-in to production-trace — included.
    const trainExplicit = await store.sample({
      count: 10,
      split: 'train',
      capturedBefore: '2026-12-31T00:00:00.000Z',
      filter: { source: 'production-trace' },
    })
    expect(trainExplicit.map((r) => r.scenario.id)).toContain('p1')
  })

  it('enforces temporal split: scenarios captured before cutoff are train, after are test', async () => {
    await store.observe({
      scenario: { id: 'before', kind: 'chat' },
      artifact: {},
      judgeScores: {},
      source: 'eval-run',
      sourceVersionHash: 'v1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      redactionStatus: 'raw',
    })
    await store.observe({
      scenario: { id: 'after', kind: 'chat' },
      artifact: {},
      judgeScores: {},
      source: 'eval-run',
      sourceVersionHash: 'v1',
      capturedAt: '2026-06-01T00:00:00.000Z',
      redactionStatus: 'raw',
    })

    const train = await store.sample({ count: 10, split: 'train', capturedBefore: '2026-03-01T00:00:00.000Z' })
    expect(train.map((r) => r.scenario.id)).toEqual(['before'])

    const test = await store.sample({ count: 10, split: 'test', capturedBefore: '2026-03-01T00:00:00.000Z' })
    expect(test.map((r) => r.scenario.id)).toEqual(['after'])
  })

  it('enforces per-source rate limit', async () => {
    const tinyStore = new FsLabeledScenarioStore({
      root: storeDir,
      maxWritesPerMinutePerBucket: 2,
    })
    const write = (id: string) => ({
      scenario: { id, kind: 'chat' },
      artifact: {},
      judgeScores: {},
      source: 'production-trace' as const,
      sourceVersionHash: 'v1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      redactionStatus: 'raw' as const,
      rateLimitBucket: 'tenant-A',
    })
    await tinyStore.observe(write('a'))
    await tinyStore.observe(write('b'))
    await expect(tinyStore.observe(write('c'))).rejects.toMatchObject({ code: 'rate_limit_exceeded' })
  })

  it('rate limit window resets after 60s', async () => {
    let nowMs = 0
    const tinyStore = new FsLabeledScenarioStore({
      root: storeDir,
      maxWritesPerMinutePerBucket: 1,
      now: () => nowMs,
    })
    const write = (id: string) => ({
      scenario: { id, kind: 'chat' },
      artifact: {},
      judgeScores: {},
      source: 'production-trace' as const,
      sourceVersionHash: 'v1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      redactionStatus: 'raw' as const,
      rateLimitBucket: 'tenant-A',
    })
    await tinyStore.observe(write('a'))
    await expect(tinyStore.observe(write('b'))).rejects.toThrow()
    nowMs += 61_000
    await tinyStore.observe(write('c')) // new window
  })
})

describe('runCampaign + LabeledScenarioStore integration', () => {
  let storeDir: string
  let store: FsLabeledScenarioStore

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'labeled-store-'))
    store = new FsLabeledScenarioStore({ root: storeDir })
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  it('captures completed cells into the store by default', async () => {
    const spy = vi.spyOn(store, 'observe')
    await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      labeledStore: store,
      captureSource: 'eval-run',
      captureSourceVersionHash: 'test-v1',
      runDir,
    })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not capture when labeledStore = "off"', async () => {
    const spy = vi.spyOn(store, 'observe')
    await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      labeledStore: 'off',
      runDir,
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not capture failed cells', async () => {
    const spy = vi.spyOn(store, 'observe')
    const flaky: DispatchFn<FakeScenario, FakeArtifact> = async () => {
      throw new Error('boom')
    }
    await runCampaign({
      scenarios: SCENARIOS,
      dispatch: flaky,
      labeledStore: store,
      captureSource: 'eval-run',
      captureSourceVersionHash: 'v1',
      runDir,
    })
    expect(spy).not.toHaveBeenCalled()
  })
})
