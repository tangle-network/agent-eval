import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DispatchFn,
  FsLabeledScenarioStore,
  fsCampaignStorage,
  inMemoryCampaignStorage,
  type JudgeConfig,
  LabeledScenarioStoreError,
  runCampaign,
  type Scenario,
} from '../../src/campaign/index'
import { BackendIntegrityError } from '../../src/integrity/backend-integrity'

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

describe('fsCampaignStorage — default Node FS adapter', () => {
  // Regression: fsCampaignStorage() used a bare `require('node:fs')`, which is
  // a ReferenceError under native ESM (`"type":"module"`, the shape this
  // package publishes) — every campaign that took the default storage threw
  // before running a single cell. Constructing it + doing real FS I/O guards
  // that the adapter builds and reads/writes without hitting `require`.
  it('constructs and performs real read/write/exists without a bare require', () => {
    const storage = fsCampaignStorage()
    const dir = mkdtempSync(join(tmpdir(), 'fs-storage-'))
    try {
      const file = join(dir, 'nested', 'x.txt')
      storage.ensureDir(join(file, '..'))
      expect(storage.read(file)).toBeUndefined()
      storage.write(file, 'hello')
      expect(storage.exists(file)).toBe(true)
      expect(storage.read(file)).toBe('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runCampaign — core primitive', () => {
  it('fails closed on a missing runDir instead of writing under ./undefined', async () => {
    const spillDir = join(process.cwd(), 'undefined')
    rmSync(spillDir, { recursive: true, force: true })

    try {
      await expect(
        runCampaign({
          scenarios: SCENARIOS.slice(0, 1),
          dispatch: DISPATCH,
          runDir: undefined as unknown as string,
        }),
      ).rejects.toThrow(/runDir is required/)
      expect(existsSync(spillDir)).toBe(false)
    } finally {
      rmSync(spillDir, { recursive: true, force: true })
    }
  })

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

  it('actually invokes judge.score and records the real composite', async () => {
    // Regression guard: runCampaign MUST call judge.score — not a stub. The
    // composite must reflect the artifact (here: text length / 10).
    const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'len',
      dimensions: [{ key: 'len' }],
      score: ({ artifact }) => ({
        dimensions: { len: artifact.text.length },
        composite: artifact.text.length / 10,
        notes: `scored ${artifact.text.length} chars`,
      }),
    }
    const result = await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: DISPATCH,
      judges: [judge],
      runDir,
    })
    const cell = result.cells[0]!
    const score = cell.judgeScores.len!
    // The score is derived from the REAL artifact — not 0, not 'phase-1-stub'.
    expect(score.composite).toBeCloseTo(cell.artifact.text.length / 10)
    expect(score.composite).toBeGreaterThan(0)
    expect(score.notes).toMatch(/scored \d+ chars/)
    expect(result.aggregates.byJudge.len!.mean).toBeCloseTo(score.composite)
  })

  it('runs judges scoped via appliesTo', async () => {
    const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'len',
      dimensions: [{ key: 'len' }],
      score: ({ artifact }) => ({
        dimensions: { len: artifact.text.length },
        composite: 1,
        notes: '',
      }),
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

  it('a thrown judge invalidates the cell (no fake composite:0)', async () => {
    const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'boom',
      dimensions: [{ key: 'x' }],
      score: () => {
        throw new Error('judge exploded')
      },
    }
    const result = await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: DISPATCH,
      judges: [judge],
      runDir,
    })
    const cell = result.cells[0]!
    expect(cell.error).toMatch(/judge 'boom' failed: judge exploded/)
    // No fabricated composite:0 recorded for the failed judge.
    expect(cell.judgeScores.boom).toBeUndefined()
    expect(result.aggregates.cellsFailed).toBe(1)
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
    await expect(store.sample({ count: 10 } as never)).rejects.toMatchObject({
      code: 'split_required',
    })
  })

  it('rejects sample() without capturedBefore', async () => {
    await expect(store.sample({ count: 10, split: 'train' } as never)).rejects.toMatchObject({
      code: 'capturedBefore_required',
    })
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

    const train = await store.sample({
      count: 10,
      split: 'train',
      capturedBefore: '2026-03-01T00:00:00.000Z',
    })
    expect(train.map((r) => r.scenario.id)).toEqual(['before'])

    const test = await store.sample({
      count: 10,
      split: 'test',
      capturedBefore: '2026-03-01T00:00:00.000Z',
    })
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
    await expect(tinyStore.observe(write('c'))).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
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

  it('gold gate: minTrust admits only records at or above the requested tier', async () => {
    const obs = (id: string, labelTrust?: 'verified-signal' | 'human-rated') =>
      store.observe({
        scenario: { id, kind: 'chat' },
        artifact: {},
        judgeScores: {},
        source: 'eval-run',
        sourceVersionHash: 'v1',
        capturedAt: '2026-06-01T00:00:00.000Z',
        redactionStatus: 'raw',
        ...(labelTrust ? { labelTrust } : {}),
      })
    await obs('weak') // absent labelTrust ⇒ unverified
    await obs('signal', 'verified-signal')
    await obs('human', 'human-rated')

    const cutoff = '2026-01-01T00:00:00.000Z'
    // Gold gate at verified-signal admits both verified-signal and human-rated,
    // never the unverified heuristic — the data-poisoning guard.
    const gold = await store.sample({
      count: 10,
      split: 'test',
      capturedBefore: cutoff,
      filter: { minTrust: 'verified-signal' },
    })
    expect(gold.map((r) => r.scenario.id).sort()).toEqual(['human', 'signal'])

    // Strictest tier admits only human-rated.
    const strict = await store.sample({
      count: 10,
      split: 'test',
      capturedBefore: cutoff,
      filter: { minTrust: 'human-rated' },
    })
    expect(strict.map((r) => r.scenario.id)).toEqual(['human'])

    // No trust gate ⇒ corpus-level read returns everything.
    const corpus = await store.sample({ count: 10, split: 'test', capturedBefore: cutoff })
    expect(corpus).toHaveLength(3)
  })

  it('size() reports byTrust; absent labelTrust counts as unverified', async () => {
    const obs = (id: string, labelTrust?: 'verified-signal' | 'human-rated') =>
      store.observe({
        scenario: { id, kind: 'chat' },
        artifact: {},
        judgeScores: {},
        source: 'eval-run',
        sourceVersionHash: 'v1',
        capturedAt: '2026-06-01T00:00:00.000Z',
        redactionStatus: 'raw',
        ...(labelTrust ? { labelTrust } : {}),
      })
    await obs('w1')
    await obs('w2')
    await obs('s1', 'verified-signal')
    await obs('h1', 'human-rated')

    const size = await store.size()
    expect(size.byTrust).toEqual({
      unverified: 2,
      'verified-signal': 1,
      'human-rated': 1,
    })
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

describe('runCampaign — in-memory storage (filesystem-less runtimes)', () => {
  it('produces a full CampaignResult without touching the filesystem', async () => {
    // A runDir path that does NOT exist on disk — the in-memory adapter
    // must never create it (proves no FS writes leak through).
    const ghostDir = join(
      tmpdir(),
      `run-campaign-ghost-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    expect(existsSync(ghostDir)).toBe(false)

    const judge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'len',
      dimensions: [{ key: 'len', description: 'text length' }],
      score: ({ artifact }) => ({
        composite: artifact.text.length / 100,
        dimensions: { len: artifact.text.length },
        notes: '',
      }),
    }

    const result = await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      judges: [judge],
      reps: 2,
      runDir: ghostDir,
      storage: inMemoryCampaignStorage(),
    })

    // Result is fully populated...
    expect(result.cells).toHaveLength(4)
    expect(result.aggregates.cellsExecuted).toBe(4)
    expect(result.aggregates.cellsFailed).toBe(0)
    expect(result.aggregates.byJudge.len?.n).toBe(4)
    expect(result.cells.every((c) => c.judgeScores.len !== undefined)).toBe(true)
    // ...but NOTHING was written to disk.
    expect(existsSync(ghostDir)).toBe(false)
  })

  it('caches cells across re-runs within the same in-memory storage instance', async () => {
    const storage = inMemoryCampaignStorage()
    const ghostDir = join(tmpdir(), `run-campaign-ghost-cache-${Date.now()}`)
    const opts = { scenarios: SCENARIOS, dispatch: DISPATCH, reps: 1, runDir: ghostDir, storage }

    const first = await runCampaign(opts)
    expect(first.aggregates.cellsCached).toBe(0)
    // Re-run with the SAME storage → cells resolve from the in-memory cache.
    const second = await runCampaign(opts)
    expect(second.aggregates.cellsCached).toBe(2)
    expect(existsSync(ghostDir)).toBe(false)
  })
})

describe('runCampaign — expectUsage stub guard', () => {
  // A dispatch that produces an artifact but never reports usage via ctx.cost —
  // the exact stub the fleet's products fell into.
  const STUB_DISPATCH: DispatchFn<FakeScenario, FakeArtifact> = async (scenario) => ({
    text: `stub-${scenario.id}`,
    intent: scenario.intent,
  })

  it('throws BackendIntegrityError on a zero-usage cell when expectUsage=assert', async () => {
    await expect(
      runCampaign({
        scenarios: SCENARIOS.slice(0, 1),
        dispatch: STUB_DISPATCH,
        expectUsage: 'assert',
        runDir: mkdtempSync(join(tmpdir(), 'run-campaign-')),
      }),
    ).rejects.toBeInstanceOf(BackendIntegrityError)
  })

  it('does NOT throw when the dispatch reports usage (real cell)', async () => {
    const real: DispatchFn<FakeScenario, FakeArtifact> = async (scenario, ctx) => {
      ctx.cost.observe(0.002, 'llm')
      ctx.cost.observeTokens({ input: 80, output: 20 })
      return { text: scenario.id, intent: scenario.intent }
    }
    const result = await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: real,
      expectUsage: 'assert',
      runDir: mkdtempSync(join(tmpdir(), 'run-campaign-')),
    })
    expect(result.cells[0]!.tokenUsage).toEqual({ input: 80, output: 20 })
    expect(result.cells[0]!.error).toBeUndefined()
  })

  it('expectUsage=off lets a stub cell through (replay/offline)', async () => {
    const result = await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: STUB_DISPATCH,
      expectUsage: 'off',
      runDir: mkdtempSync(join(tmpdir(), 'run-campaign-')),
    })
    expect(result.cells).toHaveLength(1)
    expect(result.cells[0]!.tokenUsage).toEqual({ input: 0, output: 0 })
  })
})

describe('runCampaign — dispatchTimeoutMs (the no-silent-hang guard)', () => {
  // Regression: a dispatch that never settles (a stalled model request, an
  // exhausted runtime resource, a stream that never closes) used to hang the
  // cell — and with it the lane, the campaign, the improvement loop, and the
  // CI job above them — forever, with zero diagnostic. The per-cell deadline
  // must convert that into a LOUD error cell while the campaign proceeds.
  it('fails a non-settling dispatch loud as an error cell instead of hanging', async () => {
    const neverSettles: DispatchFn<FakeScenario, FakeArtifact> = () =>
      new Promise<FakeArtifact>(() => {})
    const result = await runCampaign<FakeScenario, FakeArtifact>({
      scenarios: [{ id: 'hang', kind: 'chat', intent: 'never returns' }],
      dispatch: neverSettles,
      judges: [],
      runDir: mkdtempSync(join(tmpdir(), 'run-campaign-timeout-')),
      dispatchTimeoutMs: 50,
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
    })
    expect(result.cells).toHaveLength(1)
    expect(result.cells[0]!.error).toMatch(/dispatch exceeded 50ms/)
    expect(result.cells[0]!.artifact).toBeNull()
  }, 5_000)

  it("aborts the cell's signal on timeout so a signal-honoring dispatch releases its work", async () => {
    let sawAbort = false
    const honorsSignal: DispatchFn<FakeScenario, FakeArtifact> = (_scenario, ctx) =>
      new Promise<FakeArtifact>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true
          reject(new Error('aborted by signal'))
        })
      })
    const result = await runCampaign<FakeScenario, FakeArtifact>({
      scenarios: [{ id: 'abortme', kind: 'chat', intent: 'waits for abort' }],
      dispatch: honorsSignal,
      judges: [],
      runDir: mkdtempSync(join(tmpdir(), 'run-campaign-abort-')),
      dispatchTimeoutMs: 40,
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
    })
    expect(sawAbort).toBe(true)
    expect(result.cells[0]!.error).toBeTruthy()
  }, 5_000)

  it('leaves a fast dispatch untouched (timeout never trips on healthy work)', async () => {
    const result = await runCampaign<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: DISPATCH,
      judges: [],
      runDir: mkdtempSync(join(tmpdir(), 'run-campaign-fast-')),
      dispatchTimeoutMs: 10_000,
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
    })
    expect(result.cells[0]!.error).toBeUndefined()
    expect(result.cells[0]!.artifact).not.toBeNull()
  }, 5_000)
})
