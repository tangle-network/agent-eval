import { describe, expect, it } from 'vitest'
import {
  exportTrainingData,
  isPrmVerdict,
  nonRefusalRubric,
  outputLengthRubric,
  PrmGrader,
  prmBestOfN,
  prmEnsembleBestOfN,
  type StepRubric,
  toNdjson,
  toolNonRedundantRubric,
  toolSuccessRubric,
} from '../src/prm'
import type { ToolSpan } from '../src/trace'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

async function seedTrajectory(store: InMemoryTraceStore, output: string): Promise<string> {
  const e = new TraceEmitter(store)
  await e.startRun({ scenarioId: 's' })
  const llm = await e.span({
    kind: 'llm',
    name: 'gen',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    output,
  })
  await llm.end()
  const tool = await e.span({ kind: 'tool', name: 'search', toolName: 'search', args: { q: 'x' } })
  await tool.end({ result: 'result text here' } as Partial<ToolSpan>)
  await e.endRun({ pass: true })
  return e.runId
}

describe('PrmGrader', () => {
  it('grades per-span, emits JudgeVerdict span, aggregates via weighted mean', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedTrajectory(
      store,
      'This is a normal-length response that should score well.',
    )
    const grader = new PrmGrader([outputLengthRubric(), toolSuccessRubric()])
    const graded = await grader.grade(store, runId)
    expect(graded.gradedCount).toBe(2)
    expect(graded.aggregateScore).toBeGreaterThan(0.8)
    const verdicts = (await store.spans({ kind: 'judge' })).filter(isPrmVerdict)
    expect(verdicts).toHaveLength(2)
  })

  it('penalizes empty outputs via outputLengthRubric — regression: silent empty responses rewarded was the bug', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedTrajectory(store, '')
    const grader = new PrmGrader([outputLengthRubric()])
    const graded = await grader.grade(store, runId)
    expect(graded.aggregateScore).toBe(0)
  })

  it('toolNonRedundantRubric flags duplicate tool calls', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const a = await e.tool({ name: 'search', toolName: 'search', args: { q: 'x' } })
    await a.end({ result: 'ok' } as Partial<ToolSpan>)
    const b = await e.tool({ name: 'search', toolName: 'search', args: { q: 'x' } })
    await b.end({ result: 'ok' } as Partial<ToolSpan>)
    await e.endRun({ pass: true })
    const graded = await new PrmGrader([toolNonRedundantRubric()]).grade(store, e.runId)
    // Second call duplicates first → score 0.5
    const duplicateVerdict = graded.steps.find((s) => s.score < 1)
    expect(duplicateVerdict).toBeDefined()
  })

  it('does not score redundancy without captured arguments', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    for (const argsCaptured of [false, false, true, true]) {
      const call = await e.tool({
        name: 'search',
        toolName: 'search',
        args: argsCaptured ? { q: 'x' } : undefined,
        argsCaptured,
      })
      await call.end({ result: 'ok' } as Partial<ToolSpan>)
    }
    await e.endRun({ pass: true })

    const graded = await new PrmGrader([toolNonRedundantRubric()]).grade(store, e.runId)

    expect(graded.steps.map(({ score, rationale }) => ({ score, rationale }))).toEqual([
      { score: 1, rationale: 'novel call' },
      { score: 0.5, rationale: '1 duplicate(s)' },
    ])
    expect(graded.ungradedCount).toBe(2)
  })

  it('nonRefusalRubric scores 0 on a refusal', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedTrajectory(store, 'I cannot help with that.')
    const graded = await new PrmGrader([nonRefusalRubric()]).grade(store, runId)
    expect(graded.aggregateScore).toBe(0)
  })

  it('empty rubric list throws', () => {
    expect(() => new PrmGrader([])).toThrow(/at least 1 rubric/)
  })

  it('returns null verdict when rubric does not apply', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedTrajectory(store, 'ok')
    const rubric: StepRubric = {
      id: 'custom',
      kinds: ['llm'],
      async grade() {
        return null
      },
    }
    const graded = await new PrmGrader([rubric]).grade(store, runId)
    expect(graded.gradedCount).toBe(0)
    expect(graded.ungradedCount).toBeGreaterThan(0)
  })
})

describe('training export', () => {
  it('emits NDJSON with step context', async () => {
    const store = new InMemoryTraceStore()
    const runId = await seedTrajectory(
      store,
      'normal response that is long enough for the length rubric to score well',
    )
    const graded = await new PrmGrader([outputLengthRubric(), toolSuccessRubric()]).grade(
      store,
      runId,
    )
    const samples = await exportTrainingData(store, [graded])
    expect(samples.length).toBeGreaterThan(0)
    expect(samples[0].context.step.text.length).toBeGreaterThan(0)
    const ndjson = toNdjson(samples)
    expect(ndjson.split('\n').filter(Boolean)).toHaveLength(samples.length)
  })
})

describe('prmBestOfN', () => {
  it('picks the highest-scoring candidate trajectory', async () => {
    const store = new InMemoryTraceStore()
    const good = await seedTrajectory(
      store,
      'This is the better, longer response that the PRM will reward.',
    )
    const bad = await seedTrajectory(store, 'ok')
    const grader = new PrmGrader([outputLengthRubric()])
    const result = await prmBestOfN(store, grader, [good, bad])
    expect(result.winner.runId).toBe(good)
    expect(result.ranked.map((r) => r.runId)).toEqual([good, bad])
    expect(result.stdDev).toBeGreaterThan(0)
  })

  it('ensemble via Borda count robust to score-scale differences', async () => {
    const store = new InMemoryTraceStore()
    const a = await seedTrajectory(
      store,
      'great response of reasonable length for scoring purposes here now',
    )
    const b = await seedTrajectory(store, '')
    const g1 = new PrmGrader([outputLengthRubric()])
    const g2 = new PrmGrader([toolSuccessRubric()])
    const result = await prmEnsembleBestOfN(store, [g1, g2], [a, b])
    expect(result.winner.runId).toBe(a)
  })
})
