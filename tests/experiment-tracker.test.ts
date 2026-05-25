import { beforeEach, describe, expect, it } from 'vitest'
import { ExperimentTracker, InMemoryExperimentStore } from '../src/experiment-tracker'
import type { BenchmarkReport } from '../src/types'

function report(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    timestamp: new Date().toISOString(),
    generation: 1,
    promptVersion: 'v1',
    scenarioCount: 2,
    results: [
      {
        scenarioId: 's1',
        persona: 'p',
        turns: [],
        artifactResults: [],
        judgeScores: [],
        judgeErrors: 0,
        overallScore: 0.8,
        totalDurationMs: 100,
        artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
      },
      {
        scenarioId: 's2',
        persona: 'p',
        turns: [],
        artifactResults: [],
        judgeScores: [],
        judgeErrors: 0,
        overallScore: 0.6,
        totalDurationMs: 200,
        artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
      },
    ],
    summary: { overallAvg: 0.7, byPersona: {}, byDimension: {}, weakest: [], strongest: [] },
    ...overrides,
  }
}

describe('ExperimentTracker — lifecycle', () => {
  let tracker: ExperimentTracker
  let store: InMemoryExperimentStore

  beforeEach(() => {
    store = new InMemoryExperimentStore()
    tracker = new ExperimentTracker(store)
  })

  it('startExperiment + startRun + completeRun', async () => {
    const exp = await tracker.startExperiment('prompt-tuning-legal')
    const run = await tracker.startRun({ experimentId: exp.id, name: 'v1-baseline' })
    expect(run.status).toBe('running')
    await tracker.completeRun(run.id, report())
    const loaded = await store.getRun(run.id)
    expect(loaded?.status).toBe('completed')
    expect(loaded?.report?.summary.overallAvg).toBe(0.7)
  })

  it('failRun records an error — regression: silent failures look like completions', async () => {
    const exp = await tracker.startExperiment('x')
    const run = await tracker.startRun({ experimentId: exp.id })
    await tracker.failRun(run.id, 'judge call timed out')
    const loaded = await store.getRun(run.id)
    expect(loaded?.status).toBe('failed')
    expect(loaded?.error).toMatch(/timed out/)
  })

  it('startRun rejects unknown experimentId', async () => {
    await expect(tracker.startRun({ experimentId: 'missing' })).rejects.toThrow(/not found/)
  })

  it('completeRun rejects unknown runId', async () => {
    await expect(tracker.completeRun('missing', report())).rejects.toThrow(/not found/)
  })
})

describe('ExperimentTracker — diff', () => {
  let tracker: ExperimentTracker

  beforeEach(() => {
    tracker = new ExperimentTracker(new InMemoryExperimentStore())
  })

  it('scenario delta: improved/regressed/added/removed, aggregate delta, config changes', async () => {
    const exp = await tracker.startExperiment('prompt-tuning')
    const a = await tracker.startRun({
      experimentId: exp.id,
      name: 'v1',
      promptVersion: 'v1',
      model: 'sonnet',
    })
    await tracker.completeRun(
      a.id,
      report({
        results: [
          {
            scenarioId: 's1',
            persona: 'p',
            turns: [],
            artifactResults: [],
            judgeScores: [],
            judgeErrors: 0,
            overallScore: 0.8,
            totalDurationMs: 0,
            artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
          },
          {
            scenarioId: 's_dropped',
            persona: 'p',
            turns: [],
            artifactResults: [],
            judgeScores: [],
            judgeErrors: 0,
            overallScore: 0.7,
            totalDurationMs: 0,
            artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
          },
        ],
        summary: { overallAvg: 0.75, byPersona: {}, byDimension: {}, weakest: [], strongest: [] },
      }),
    )

    const b = await tracker.startRun({
      experimentId: exp.id,
      name: 'v2',
      promptVersion: 'v2',
      model: 'opus',
    })
    await tracker.completeRun(
      b.id,
      report({
        results: [
          {
            scenarioId: 's1',
            persona: 'p',
            turns: [],
            artifactResults: [],
            judgeScores: [],
            judgeErrors: 0,
            overallScore: 0.9,
            totalDurationMs: 0,
            artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
          },
          {
            scenarioId: 's_new',
            persona: 'p',
            turns: [],
            artifactResults: [],
            judgeScores: [],
            judgeErrors: 0,
            overallScore: 0.85,
            totalDurationMs: 0,
            artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
          },
        ],
        summary: { overallAvg: 0.875, byPersona: {}, byDimension: {}, weakest: [], strongest: [] },
      }),
    )

    const diff = await tracker.diff(a.id, b.id)
    expect(diff.aggregateDelta).toBeCloseTo(0.125, 3)
    const byId = new Map(diff.scenarios.map((s) => [s.scenarioId, s]))
    expect(byId.get('s1')?.status).toBe('improved')
    expect(byId.get('s1')?.delta).toBeCloseTo(0.1, 3)
    expect(byId.get('s_new')?.status).toBe('added')
    expect(byId.get('s_dropped')?.status).toBe('removed')
    expect(diff.configChanges).toMatchObject({
      name: { before: 'v1', after: 'v2' },
      promptVersion: { before: 'v1', after: 'v2' },
      model: { before: 'sonnet', after: 'opus' },
    })
  })

  it('timeline returns runs chronologically', async () => {
    const exp = await tracker.startExperiment('timeline')
    const a = await tracker.startRun({ experimentId: exp.id })
    await tracker.completeRun(
      a.id,
      report({
        summary: { overallAvg: 0.6, byPersona: {}, byDimension: {}, weakest: [], strongest: [] },
      }),
    )
    const b = await tracker.startRun({ experimentId: exp.id })
    await tracker.completeRun(
      b.id,
      report({
        summary: { overallAvg: 0.8, byPersona: {}, byDimension: {}, weakest: [], strongest: [] },
      }),
    )
    const timeline = await tracker.timeline(exp.id)
    expect(timeline.map((t) => t.overall)).toEqual([0.6, 0.8])
  })

  it('diff rejects non-existent runs', async () => {
    const exp = await tracker.startExperiment('x')
    const a = await tracker.startRun({ experimentId: exp.id })
    await tracker.completeRun(a.id, report())
    await expect(tracker.diff(a.id, 'nope')).rejects.toThrow(/must exist/)
  })

  it('diff rejects incomplete runs', async () => {
    const exp = await tracker.startExperiment('x')
    const a = await tracker.startRun({ experimentId: exp.id })
    const b = await tracker.startRun({ experimentId: exp.id })
    await tracker.completeRun(a.id, report())
    await expect(tracker.diff(a.id, b.id)).rejects.toThrow(/completed/)
  })
})
