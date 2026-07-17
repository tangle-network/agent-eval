import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  campaignSplitDigestFromIdentities,
  type DispatchFn,
  FsLabeledScenarioStore,
  fsCampaignStorage,
  inMemoryCampaignStorage,
  type JudgeConfig,
  LabeledScenarioStoreError,
  planCampaignRun,
  runCampaign,
  type Scenario,
} from '../../src/campaign/index'
import { CostLedger } from '../../src/cost-ledger'
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
  const paid = await ctx.cost.runPaidCall({
    actor: 'fake-llm',
    model: 'fake-model',
    execute: async () => ({
      text: `dispatched-${scenario.id}-rep${ctx.rep}`,
      intent: scenario.intent,
    }),
    receipt: () => ({
      model: 'fake-model',
      inputTokens: 0,
      outputTokens: 0,
      actualCostUsd: 0.01,
    }),
  })
  if (!paid.succeeded) throw paid.error
  return paid.value
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
    expect(result.scenarios.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'a', kind: 'chat' },
      { id: 'b', kind: 'chat' },
    ])
    expect(
      result.scenarios.every(({ scenarioDigest }) => /^sha256:[a-f0-9]{64}$/.test(scenarioDigest)),
    ).toBe(true)
    expect(campaignSplitDigestFromIdentities(result.scenarios, result.reps)).toBe(
      result.splitDigest,
    )
  })

  it('uses common random seeds for scenario variants in the same seed group', async () => {
    const observed = new Map<string, number>()
    const scenarios: FakeScenario[] = [
      { id: 'provider-a:case-1', kind: 'chat', intent: 'same task', seedGroup: 'case-1' },
      { id: 'provider-b:case-1', kind: 'chat', intent: 'same task', seedGroup: 'case-1' },
      { id: 'independent', kind: 'chat', intent: 'another task' },
    ]
    const result = await runCampaign({
      scenarios,
      reps: 2,
      seed: 100,
      runDir,
      expectUsage: 'off',
      dispatch: async (scenario, context) => {
        observed.set(`${scenario.id}:${context.rep}`, context.seed)
        return { text: String(context.seed), intent: scenario.intent }
      },
    })

    expect(Object.fromEntries(observed)).toEqual({
      'provider-a:case-1:0': 100,
      'provider-a:case-1:1': 101,
      'provider-b:case-1:0': 100,
      'provider-b:case-1:1': 101,
      'independent:0': 102,
      'independent:1': 103,
    })
    expect(Object.fromEntries(result.cells.map((cell) => [cell.cellId, cell.seed]))).toEqual({
      'provider-a:case-1:0': 100,
      'provider-a:case-1:1': 101,
      'provider-b:case-1:0': 100,
      'provider-b:case-1:1': 101,
      'independent:0': 102,
      'independent:1': 103,
    })
  })

  it('rejects an empty seed group', async () => {
    await expect(
      runCampaign({
        scenarios: [{ ...SCENARIOS[0]!, seedGroup: ' ' }],
        dispatch: DISPATCH,
        runDir,
      }),
    ).rejects.toThrow('seedGroup to be a non-empty string')
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

  it('resumes cached cells with their durable receipts', async () => {
    let dispatchCount = 0
    const counting: DispatchFn<FakeScenario, FakeArtifact> = async (s, ctx) => {
      const paid = await ctx.cost.runPaidCall({
        actor: 'worker',
        model: 'fake-model',
        execute: async () => {
          dispatchCount += 1
          return { text: `${s.id}-${ctx.rep}`, intent: s.intent }
        },
        receipt: () => ({
          model: 'fake-model',
          inputTokens: 10,
          outputTokens: 5,
          actualCostUsd: 0.4,
        }),
      })
      if (!paid.succeeded) throw paid.error
      return paid.value
    }
    await runCampaign({ scenarios: SCENARIOS, dispatch: counting, runDir })
    expect(dispatchCount).toBe(2)

    // Second run with same runDir + scenarios should hit cache.
    const r2 = await runCampaign({
      scenarios: SCENARIOS,
      dispatch: counting,
      runDir,
    })
    expect(dispatchCount).toBe(2) // no new dispatches
    expect(r2.cells.every((c) => c.cached)).toBe(true)
    expect(r2.aggregates.cellsCached).toBe(2)
    expect(r2.aggregates.totalCostUsd).toBe(0.8)
    expect(r2.aggregates.cost.totalCalls).toBe(2)

    await expect(
      runCampaign({
        scenarios: SCENARIOS,
        dispatch: counting,
        costLedger: new CostLedger(0),
        runDir,
      }),
    ).rejects.toThrow(/cached cell.*missing ledger receipt/)
  })

  it('rejects a cached judge score when its exact paid receipt is missing', async () => {
    const storage = inMemoryCampaignStorage()
    const paidJudge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'paid-judge',
      dimensions: [{ key: 'quality', description: 'quality' }],
      async score({ costLedger, costPhase, costTags, signal }) {
        if (!costLedger || !costPhase || !costTags) throw new Error('missing cost context')
        const paid = await costLedger.runPaidCall({
          channel: 'judge',
          phase: costPhase,
          actor: 'paid-judge',
          model: 'gpt-4o',
          tags: costTags,
          signal,
          maximumCharge: { externallyEnforcedMaximumUsd: 0.2 },
          execute: async () => 'score',
          receipt: () => ({
            model: 'gpt-4o',
            inputTokens: 20,
            outputTokens: 10,
            actualCostUsd: 0.2,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return { dimensions: { quality: 1 }, composite: 1, notes: 'ok' }
      },
    }
    const options = {
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: DISPATCH,
      judges: [paidJudge],
      runDir: '/paid-judge-cache',
      storage,
    }
    const first = await runCampaign(options)
    expect(first.cells[0]?.costCallIds).toHaveLength(2)

    const path = '/paid-judge-cache/cost-ledger.jsonl'
    const events = storage.read(path)!
    storage.write(
      path,
      `${events
        .split('\n')
        .filter((line) => {
          if (!line) return false
          const event = JSON.parse(line) as { record?: { channel?: string } }
          return event.record?.channel !== 'judge'
        })
        .join('\n')}\n`,
    )

    await expect(runCampaign(options)).rejects.toThrow(/missing ledger receipt/)
  })

  it('terminates when a judge reports a paid call without recording it', async () => {
    const unmeteredJudge: JudgeConfig<FakeArtifact, FakeScenario> = {
      name: 'unmetered-judge',
      dimensions: [{ key: 'quality', description: 'quality' }],
      score: async () => ({
        dimensions: { quality: 1 },
        composite: 1,
        notes: 'not admissible',
        llmCall: {
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            totalTokens: 12,
            captured: true,
          },
          costUsd: 0.2,
          model: 'paid-model',
          durationMs: 1,
        },
      }),
    }

    await expect(
      runCampaign({
        scenarios: SCENARIOS.slice(0, 1),
        dispatch: DISPATCH,
        judges: [unmeteredJudge],
        runDir: '/unmetered-judge',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow(/paid LLM call without a CostLedger receipt/)
  })

  it('invalidates resumed cells when a judge revision changes', async () => {
    const storage = inMemoryCampaignStorage()
    let dispatchCalls = 0
    const dispatch: DispatchFn<FakeScenario, FakeArtifact> = async (scenario) => {
      dispatchCalls += 1
      return { text: scenario.intent, intent: scenario.intent }
    }
    const judge = (
      judgeVersion: string,
      composite: number,
    ): JudgeConfig<FakeArtifact, FakeScenario> => ({
      name: 'versioned-judge',
      dimensions: [{ key: 'quality', description: 'quality' }],
      judgeVersion,
      score: async () => ({ dimensions: { quality: composite }, composite, notes: 'ok' }),
    })
    const options = {
      scenarios: SCENARIOS.slice(0, 1),
      dispatch,
      dispatchRef: 'stable-dispatch',
      runDir: '/judge-version-cache',
      storage,
    }

    const first = await runCampaign({ ...options, judges: [judge('v1', 0.2)] })
    const second = await runCampaign({ ...options, judges: [judge('v2', 0.9)] })

    expect(first.cells[0]?.judgeScores['versioned-judge']?.composite).toBe(0.2)
    expect(second.cells[0]?.judgeScores['versioned-judge']?.composite).toBe(0.9)
    expect(second.cells[0]?.cached).toBe(false)
    expect(dispatchCalls).toBe(2)
  })

  it('does not resume cached cells when the manifest changes', async () => {
    let dispatchCount = 0
    const dispatch: DispatchFn<FakeScenario, FakeArtifact> = async (s) => {
      dispatchCount += 1
      return { text: `fresh-${s.intent}`, intent: s.intent }
    }
    const first = [{ id: 'a', kind: 'chat', intent: 'first' }]
    const second = [{ id: 'a', kind: 'chat', intent: 'second' }]

    await runCampaign({ scenarios: first, dispatch, dispatchRef: 'stable-dispatch', runDir })
    const result = await runCampaign({
      scenarios: second,
      dispatch,
      dispatchRef: 'stable-dispatch',
      runDir,
    })

    expect(dispatchCount).toBe(2)
    expect(result.cells[0]?.cached).toBe(false)
    expect(result.cells[0]?.artifact.intent).toBe('second')
  })

  it('includes dispatchRef in the resume decision', async () => {
    let dispatchCount = 0
    const dispatch: DispatchFn<FakeScenario, FakeArtifact> = async (s) => {
      dispatchCount += 1
      return { text: `${s.id}-${dispatchCount}`, intent: s.intent }
    }

    await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch,
      dispatchRef: 'model-a',
      runDir,
    })
    const result = await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch,
      dispatchRef: 'model-b',
      runDir,
    })

    expect(dispatchCount).toBe(2)
    expect(result.cells[0]?.cached).toBe(false)
  })

  it('plans cached vs runnable cells before spending', async () => {
    await runCampaign({
      scenarios: SCENARIOS,
      dispatch: DISPATCH,
      dispatchRef: 'preview-dispatch',
      runDir,
    })

    const cached = planCampaignRun<FakeScenario, FakeArtifact>({
      scenarios: SCENARIOS,
      dispatchRef: 'preview-dispatch',
      runDir,
    })
    expect(cached.totalCells).toBe(2)
    expect(cached.cellsCached).toBe(2)
    expect(cached.cellsToRun).toBe(0)
    expect(cached.cells.every((cell) => cell.status === 'cached')).toBe(true)

    const stale = planCampaignRun<FakeScenario, FakeArtifact>({
      scenarios: [{ ...SCENARIOS[0]!, intent: 'changed' }, SCENARIOS[1]!],
      dispatchRef: 'preview-dispatch',
      runDir,
    })
    expect(stale.cellsCached).toBe(0)
    expect(stale.cellsToRun).toBe(2)
    expect(stale.cells.map((cell) => cell.reason)).toEqual([
      'manifest-mismatch',
      'manifest-mismatch',
    ])
  })

  it('captures dispatch errors per cell without crashing campaign', async () => {
    const ledger = new CostLedger()
    const flaky: DispatchFn<FakeScenario, FakeArtifact> = async (s, ctx) => {
      const amount = s.id === 'a' ? 0.4 : 0.1
      const paid = await ctx.cost.runPaidCall({
        actor: 'worker',
        model: 'fake-model',
        execute: async () => {
          if (s.id === 'a') throw new Error('boom after provider response')
          return { text: 'ok', intent: s.intent }
        },
        receipt: () => ({
          model: 'fake-model',
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: amount,
        }),
        receiptFromError: () => ({
          model: 'fake-model',
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: amount,
        }),
      })
      if (!paid.succeeded) throw paid.error
      return paid.value
    }
    const result = await runCampaign({
      scenarios: SCENARIOS,
      dispatch: flaky,
      costLedger: ledger,
      costPhase: 'search.baseline',
      runDir,
    })
    expect(result.cells).toHaveLength(2)
    expect(result.aggregates.cellsFailed).toBe(1)
    expect(result.cells.find((c) => c.scenarioId === 'a')?.error).toContain('boom')
    expect(result.cells.find((c) => c.scenarioId === 'b')?.error).toBeUndefined()
    expect(result.cells.find((c) => c.scenarioId === 'a')?.costUsd).toBeCloseTo(0.4, 9)
    expect(ledger.summary().totalCostUsd).toBeCloseTo(0.5, 9)
    expect(ledger.list()[0]).toMatchObject({ phase: 'search.baseline', actor: 'worker' })
  })

  it('atomically reserves capped calls without constraining free dispatches', async () => {
    let calls = 0
    const expensive: DispatchFn<FakeScenario, FakeArtifact> = async (s, ctx) => {
      const paid = await ctx.cost.runPaidCall({
        actor: 'expensive',
        model: 'gpt-4o',
        maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 1_500_000 },
        execute: async () => {
          calls += 1
          return { text: '', intent: s.intent }
        },
        receipt: () => ({
          model: 'fake-model',
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: 10,
        }),
      })
      if (!paid.succeeded) throw paid.error
      return paid.value
    }
    const result = await runCampaign({
      scenarios: [
        { id: 'a', kind: 'chat', intent: 'x' },
        { id: 'b', kind: 'chat', intent: 'y' },
        { id: 'c', kind: 'chat', intent: 'z' },
      ],
      dispatch: expensive,
      costCeiling: 15,
      maxConcurrency: 10,
      runDir,
    })
    expect(calls).toBe(1)
    expect(result.aggregates.totalCostUsd).toBe(10)
    expect(result.aggregates.totalCostUsd).toBeLessThanOrEqual(15)
    expect(result.aggregates.cellsFailed).toBe(2)

    const free = await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: async (scenario) => ({ text: '', intent: scenario.intent }),
      costCeiling: 15,
      resumable: false,
      runDir,
    })
    expect(free.aggregates.cellsExecuted).toBe(1)
    expect(free.cells[0]?.costUsd).toBe(0)
    expect(free.aggregates.totalCostUsd).toBe(10)
  })

  it('does not double-bill cached input when deriving a tokens-only receipt', async () => {
    const ledger = new CostLedger(1)
    await runCampaign({
      scenarios: SCENARIOS.slice(0, 1),
      dispatch: async (scenario, ctx) => {
        const paid = await ctx.cost.runPaidCall({
          actor: 'worker',
          model: 'gpt-4o',
          maximumCharge: {
            model: 'gpt-4o',
            inputTokens: 600,
            outputTokens: 0,
            cachedTokens: 400,
          },
          execute: async () => ({ text: '', intent: scenario.intent }),
          receipt: () => ({
            model: 'gpt-4o',
            inputTokens: 600,
            outputTokens: 0,
            cachedTokens: 400,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return paid.value
      },
      costLedger: ledger,
      resumable: false,
      runDir,
    })

    expect(ledger.summary().totalCostUsd).toBeCloseTo(0.0025, 9)
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
      const paid = await ctx.cost.runPaidCall({
        actor: 'llm',
        model: 'fake-model',
        execute: async () => ({ text: scenario.id, intent: scenario.intent }),
        receipt: () => ({
          model: 'fake-model',
          inputTokens: 80,
          outputTokens: 20,
          actualCostUsd: 0.002,
        }),
      })
      if (!paid.succeeded) throw paid.error
      return paid.value
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
