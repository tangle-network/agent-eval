import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BenchmarkReport } from '../src/index'
import { ExperimentTracker, FileSystemExperimentStore } from '../src/index'

function fakeReport(overall: number): BenchmarkReport {
  return {
    summary: {
      overallAvg: overall,
      totalScenarios: 1,
      passRate: overall,
      totalCost: 0,
      totalLatencyMs: 0,
      totalTokens: 0,
    },
    results: [
      {
        scenarioId: 's1',
        overallScore: overall,
        passed: true,
        turns: [],
        artifacts: { artifacts: [] },
        judgeScores: [],
        cost: 0,
        latencyMs: 0,
        tokens: { prompt: 0, completion: 0 },
      },
    ],
    metadata: { startedAt: '', completedAt: '', model: 'test', driver: 'test' },
  } as unknown as BenchmarkReport
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-fs-store-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('FileSystemExperimentStore', () => {
  it('persists experiments and runs across process boundaries', async () => {
    const storeA = new FileSystemExperimentStore({ dir })
    const trackerA = new ExperimentTracker(storeA)
    const exp = await trackerA.startExperiment('e1', { tag: 'first' })
    const run = await trackerA.startRun({ experimentId: exp.id, model: 'gpt-5.4' })
    await trackerA.completeRun(run.id, fakeReport(7.5))

    // New store reads the same dir — simulates a process restart.
    const storeB = new FileSystemExperimentStore({ dir })
    const trackerB = new ExperimentTracker(storeB)
    const reloadedExp = await storeB.getExperiment(exp.id)
    expect(reloadedExp?.name).toBe('e1')
    expect(reloadedExp?.metadata).toEqual({ tag: 'first' })

    const reloadedRun = await storeB.getRun(run.id)
    expect(reloadedRun?.status).toBe('completed')
    expect(reloadedRun?.report?.summary.overallAvg).toBe(7.5)

    const timeline = await trackerB.timeline(exp.id)
    expect(timeline).toHaveLength(1)
    expect(timeline[0]!.overall).toBe(7.5)
  })

  it('writes NDJSON files to disk', async () => {
    const store = new FileSystemExperimentStore({ dir })
    const tracker = new ExperimentTracker(store)
    const exp = await tracker.startExperiment('e1')
    await tracker.startRun({ experimentId: exp.id })

    const expFile = path.join(dir, 'experiments.ndjson')
    const runFile = path.join(dir, 'runs.ndjson')
    expect(fs.existsSync(expFile)).toBe(true)
    expect(fs.existsSync(runFile)).toBe(true)

    const expLines = fs.readFileSync(expFile, 'utf8').trim().split('\n')
    expect(expLines).toHaveLength(1)
    expect(JSON.parse(expLines[0]!).name).toBe('e1')
  })

  it('preserves audit history — every state transition appends a line', async () => {
    const store = new FileSystemExperimentStore({ dir })
    const tracker = new ExperimentTracker(store)
    const exp = await tracker.startExperiment('e1')
    const run = await tracker.startRun({ experimentId: exp.id })
    await tracker.completeRun(run.id, fakeReport(8))

    // start-run + complete-run both append. The audit log is "running" → "completed".
    const lines = fs.readFileSync(path.join(dir, 'runs.ndjson'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).status).toBe('running')
    expect(JSON.parse(lines[1]!).status).toBe('completed')
  })

  it('rolls over once the active file exceeds maxBytes', async () => {
    // Tiny cap so a single large config trips the rollover.
    const store = new FileSystemExperimentStore({ dir, maxBytes: 200 })
    const tracker = new ExperimentTracker(store)
    const exp = await tracker.startExperiment('e1', { padding: 'x'.repeat(300) })
    await tracker.startRun({ experimentId: exp.id, metadata: { padding: 'y'.repeat(300) } })
    await tracker.startRun({ experimentId: exp.id })

    const files = fs.readdirSync(dir).filter((f) => f.startsWith('runs.'))
    // At least one rolled file exists in addition to the active one.
    expect(files.length).toBeGreaterThanOrEqual(2)
  })

  it('listExperiments returns most-recent first', async () => {
    const store = new FileSystemExperimentStore({ dir })
    const tracker = new ExperimentTracker(store)
    const a = await tracker.startExperiment('a')
    await new Promise((r) => setTimeout(r, 5))
    const b = await tracker.startExperiment('b')

    const list = await store.listExperiments()
    expect(list[0]!.id).toBe(b.id)
    expect(list[1]!.id).toBe(a.id)
  })

  it('listRuns scopes to experimentId', async () => {
    const store = new FileSystemExperimentStore({ dir })
    const tracker = new ExperimentTracker(store)
    const a = await tracker.startExperiment('a')
    const b = await tracker.startExperiment('b')
    await tracker.startRun({ experimentId: a.id })
    await tracker.startRun({ experimentId: a.id })
    await tracker.startRun({ experimentId: b.id })

    expect(await store.listRuns(a.id)).toHaveLength(2)
    expect(await store.listRuns(b.id)).toHaveLength(1)
  })

  it('skips truncated tail lines from a crash', async () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'experiments.ndjson'),
      JSON.stringify({ id: 'e1', name: 'good', createdAt: '2026-01-01T00:00:00Z' }) +
        '\n' +
        '{"id":"e2","name":"part', // truncated, no closing brace, no newline
      'utf8',
    )
    const store = new FileSystemExperimentStore({ dir })
    const list = await store.listExperiments()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('e1')
  })
})
