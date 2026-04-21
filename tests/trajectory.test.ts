import { describe, expect, it } from 'vitest'
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
    const tool = await e.span({ kind: 'tool', name: 'search', toolName: 'search', args: { q: 'x' } })
    await tool.end()
    await outer.end()
    const judge = await e.recordJudge({ judgeId: 'j', targetSpanId: llm.span.spanId, dimension: 'quality', score: 0.9, name: 'quality-judge' })

    const traj = await buildTrajectory(store, e.runId)
    expect(traj.steps.map((s) => s.span.name)).toEqual(['plan', 'first-call', 'search', 'quality-judge'])
    expect(traj.steps[0].depth).toBe(0)
    expect(traj.steps[1].depth).toBe(1)
    expect(traj.steps[2].depth).toBe(1)
    expect(traj.llmTurns).toBe(1)
    expect(traj.toolCalls).toBe(1)
    expect(traj.judgeVerdicts).toBe(1)
    // silence unused warning
    expect(judge.judgeId).toBe('j')
  })

  it('returns empty trajectory for unknown run — regression: undefined spans shouldn\'t throw', async () => {
    const store = new InMemoryTraceStore()
    const traj = await buildTrajectory(store, 'missing')
    expect(traj.steps).toHaveLength(0)
    expect(traj.totalDurationMs).toBe(0)
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
