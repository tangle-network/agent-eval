import { describe, expect, it } from 'vitest'
import { ingestSpans } from '../src/diagnosis'
import { diffStepsFromSpans } from '../src/pipelines'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { buildTrajectory } from '../src/trajectory'

describe('buildTrajectory', () => {
  it('returns steps in DFS chronological order with correct depths', async () => {
    const store = new InMemoryTraceStore()
    let t = 1000
    const e = new TraceEmitter(store, { now: () => t++ })
    await e.startRun({ scenarioId: 's' })

    const outer = await e.span({ kind: 'agent', name: 'plan' })
    const llm = await e.span({ kind: 'llm', name: 'first-call', model: 'm', messages: [] })
    await llm.end()
    const tool = await e.span({
      kind: 'tool',
      name: 'search',
      toolName: 'search',
      args: { q: 'x' },
    })
    await tool.end()
    await outer.end()
    const judge = await e.recordJudge({
      judgeId: 'j',
      targetSpanId: llm.span.spanId,
      dimension: 'quality',
      score: 0.9,
      name: 'quality-judge',
    })

    const traj = await buildTrajectory(store, e.runId)
    expect(traj.steps.map((s) => s.span.name)).toEqual([
      'plan',
      'first-call',
      'search',
      'quality-judge',
    ])
    expect(traj.steps[0].depth).toBe(0)
    expect(traj.steps[1].depth).toBe(1)
    expect(traj.steps[2].depth).toBe(1)
    expect(traj.llmTurns).toBe(1)
    expect(traj.toolCalls).toBe(1)
    expect(traj.judgeVerdicts).toBe(1)
    // silence unused warning
    expect(judge.judgeId).toBe('j')
  })

  it("returns empty trajectory for unknown run — regression: undefined spans shouldn't throw", async () => {
    const store = new InMemoryTraceStore()
    const traj = await buildTrajectory(store, 'missing')
    expect(traj.steps).toHaveLength(0)
    expect(traj.totalDurationMs).toBe(0)
  })

  it('keeps a span whose parent is missing from the capture and counts it', async () => {
    // A parent's appendSpan was dropped: its child still names it.
    const store = new InMemoryTraceStore()
    let t = 0
    const e = new TraceEmitter(store, { now: () => t++ })
    await e.startRun({ scenarioId: 's' })
    const llm = await e.span({ kind: 'llm', name: 'plan', model: 'm', messages: [] })
    await llm.end()
    const orphan = await e.span({
      kind: 'tool',
      name: 'write',
      toolName: 'write',
      args: { path: 'a.txt' },
      parentSpanId: 'agent-never-captured',
    })
    await orphan.end()

    const traj = await buildTrajectory(store, e.runId)
    expect(traj.toolCalls).toBe(1)
    expect(traj.steps.map((s) => s.span.name)).toEqual(['plan', 'write'])
    expect(traj.steps[1]!.depth).toBe(0)
    expect(traj.missingParents).toEqual([
      {
        index: 1,
        spanId: orphan.span.spanId,
        parentSpanId: 'agent-never-captured',
        cause: 'absent',
      },
    ])
  })

  it('reports no missing parents for a complete capture', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.within({ kind: 'agent', name: 'outer' }, async () => {
      const tool = await e.tool({ name: 'ls', toolName: 'ls', args: {} })
      await tool.end()
    })
    const traj = await buildTrajectory(store, e.runId)
    expect(traj.steps.map((s) => [s.span.name, s.depth])).toEqual([
      ['outer', 0],
      ['ls', 1],
    ])
    expect(traj.missingParents).toEqual([])
  })

  it('orders spans as diffStepsFromSpans does, orphans and parent cycles included', async () => {
    const base = 1_700_000_000_000
    const captured = [
      { spanId: 'root', startedAt: 0, endedAt: 50 },
      { spanId: 'late-child', parentSpanId: 'root', startedAt: 20, endedAt: 30 },
      { spanId: 'early-child', parentSpanId: 'root', startedAt: 10, endedAt: 15 },
      { spanId: 'orphan', parentSpanId: 'never-captured', startedAt: 5, endedAt: 6 },
      { spanId: 'loop-a', parentSpanId: 'loop-b', startedAt: 40, endedAt: 41 },
      { spanId: 'loop-b', parentSpanId: 'loop-a', startedAt: 42, endedAt: 43 },
    ]
    const store = new InMemoryTraceStore()
    for (const span of captured) {
      await store.appendSpan({
        ...span,
        runId: 'r',
        kind: 'custom',
        name: span.spanId,
        startedAt: base + span.startedAt,
        endedAt: base + span.endedAt,
      })
    }

    const traj = await buildTrajectory(store, 'r')
    expect(traj.steps.map((s) => [s.span.spanId, s.depth])).toEqual([
      ['root', 0],
      ['early-child', 1],
      ['late-child', 1],
      ['orphan', 0],
      ['loop-a', 0],
      ['loop-b', 1],
    ])
    expect(traj.missingParents).toEqual([
      { index: 3, spanId: 'orphan', parentSpanId: 'never-captured', cause: 'absent' },
      { index: 4, spanId: 'loop-a', parentSpanId: 'loop-b', cause: 'cycle' },
    ])
    expect(traj.steps.length).toBe(captured.length)

    const { spans } = ingestSpans(
      captured.map((span) => ({
        trace_id: 't',
        span_id: span.spanId,
        parent_span_id: span.parentSpanId,
        name: span.spanId,
        start_time: base + span.startedAt,
        end_time: base + span.endedAt,
      })),
      { contentIncluded: false },
    )
    expect(diffStepsFromSpans(spans).map((step) => step.id)).toEqual(
      traj.steps.map((s) => s.span.spanId),
    )
  })

  it('attaches events to their spans', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const h = await e.span({ kind: 'agent', name: 'work' })
    await e.emit({ kind: 'log', spanId: h.span.spanId, payload: { msg: 'hi' } })
    await h.end()
    const traj = await buildTrajectory(store, e.runId)
    expect(traj.steps[0].events).toHaveLength(1)
    expect(traj.steps[0].events[0].kind).toBe('log')
  })
})
