import { describe, expect, it } from 'vitest'
import type { Run, ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { failureClusterView } from './failure-cluster'

function failedRun(runId: string, scenarioId: string): Run {
  return {
    runId,
    scenarioId,
    startedAt: 1000,
    endedAt: 2000,
    status: 'completed',
    outcome: { pass: false, failureClass: 'tool_recovery_failure' },
  }
}

function erroredTool(runId: string, name: string, args: unknown): ToolSpan {
  return {
    spanId: `${runId}-t`,
    runId,
    kind: 'tool',
    name: `tool.${name}`,
    startedAt: 1500,
    status: 'error',
    error: `${name} blew up`,
    toolName: name,
    args,
  }
}

async function storeWith(
  entries: Array<{ run: Run; spans: ToolSpan[] }>,
): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore()
  for (const { run, spans } of entries) {
    await store.appendRun(run)
    for (const s of spans) await store.appendSpan(s)
  }
  return store
}

describe('failureClusterView', () => {
  it('collapses identical failureClass+toolName+argPrefix into one cluster with summed runCount', async () => {
    const store = await storeWith([
      {
        run: failedRun('r1', 's1'),
        spans: [erroredTool('r1', 'bash', { cmd: 'ls -la /etc/passwd' })],
      },
      {
        run: failedRun('r2', 's2'),
        spans: [erroredTool('r2', 'bash', { cmd: 'ls -la /etc/passwd' })],
      },
      {
        run: failedRun('r3', 's1'),
        spans: [erroredTool('r3', 'bash', { cmd: 'ls -la /etc/passwd' })],
      },
    ])
    const report = await failureClusterView(store)
    expect(report.clusters).toHaveLength(1)
    const c = report.clusters[0]!
    expect(c.runCount).toBe(3)
    expect(c.toolName).toBe('bash')
    expect(c.failureClass).toBe('tool_recovery_failure')
    // distinct scenarios are tracked, runs are not double-counted as scenarios
    expect([...c.scenarioIds].sort()).toEqual(['s1', 's2'])
    expect(report.totalFailures).toBe(3)
    expect(report.totalRuns).toBe(3)
  })

  it('splits clusters that differ on any of the three dimensions', async () => {
    const store = await storeWith([
      // same class+tool, DIFFERENT args -> argPrefix differs -> separate cluster
      { run: failedRun('a1', 's'), spans: [erroredTool('a1', 'bash', { cmd: 'one' })] },
      { run: failedRun('a2', 's'), spans: [erroredTool('a2', 'bash', { cmd: 'two' })] },
      // same class+args-shape but DIFFERENT tool -> separate cluster
      { run: failedRun('b1', 's'), spans: [erroredTool('b1', 'curl', { cmd: 'one' })] },
    ])
    const report = await failureClusterView(store)
    // three distinct (class, tool, argPrefix) tuples
    expect(report.clusters).toHaveLength(3)
    expect(report.clusters.every((c) => c.runCount === 1)).toBe(true)
  })

  it('does NOT merge a tool whose argHash differs only by a 17th+ char (argPrefix is first 16)', async () => {
    // argHash is stableStringify of args; pick two arg objects whose stringify
    // shares the first 16 chars but diverges later -> SAME prefix -> SAME cluster.
    const shared = 'aaaaaaaaaaaaaa' // padding inside a shared key
    const store = await storeWith([
      { run: failedRun('p1', 's'), spans: [erroredTool('p1', 'bash', { k: `${shared}1` })] },
      { run: failedRun('p2', 's'), spans: [erroredTool('p2', 'bash', { k: `${shared}2` })] },
    ])
    const report = await failureClusterView(store)
    // {"k":"aaaaaaaaaaaaaa... -> first 16 chars identical across both
    expect(report.clusters).toHaveLength(1)
    expect(report.clusters[0]!.runCount).toBe(2)
    expect(report.clusters[0]!.argPrefix).toHaveLength(16)
  })

  it('minClusterSize filters out clusters below the threshold', async () => {
    const store = await storeWith([
      { run: failedRun('big1', 's'), spans: [erroredTool('big1', 'bash', { cmd: 'x' })] },
      { run: failedRun('big2', 's'), spans: [erroredTool('big2', 'bash', { cmd: 'x' })] },
      { run: failedRun('small', 's'), spans: [erroredTool('small', 'curl', { cmd: 'y' })] },
    ])
    const filtered = await failureClusterView(store, { minClusterSize: 2 })
    expect(filtered.clusters).toHaveLength(1)
    expect(filtered.clusters[0]!.toolName).toBe('bash')
    expect(filtered.clusters[0]!.runCount).toBe(2)
    // but totals still count every failure regardless of filtering
    expect(filtered.totalFailures).toBe(3)
  })

  it('sorts clusters by descending runCount', async () => {
    const store = await storeWith([
      { run: failedRun('s1', 's'), spans: [erroredTool('s1', 'rare', { cmd: 'r' })] },
      { run: failedRun('m1', 's'), spans: [erroredTool('m1', 'mid', { cmd: 'm' })] },
      { run: failedRun('m2', 's'), spans: [erroredTool('m2', 'mid', { cmd: 'm' })] },
      { run: failedRun('h1', 's'), spans: [erroredTool('h1', 'hot', { cmd: 'h' })] },
      { run: failedRun('h2', 's'), spans: [erroredTool('h2', 'hot', { cmd: 'h' })] },
      { run: failedRun('h3', 's'), spans: [erroredTool('h3', 'hot', { cmd: 'h' })] },
    ])
    const report = await failureClusterView(store)
    const counts = report.clusters.map((c) => c.runCount)
    expect(counts).toEqual([3, 2, 1])
    expect(report.clusters[0]!.toolName).toBe('hot')
  })

  it('does not count passing/completed runs as failures', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun({
      runId: 'ok',
      scenarioId: 's',
      startedAt: 1,
      status: 'completed',
      outcome: { pass: true, score: 1 },
    })
    const report = await failureClusterView(store)
    expect(report.totalFailures).toBe(0)
    expect(report.clusters).toHaveLength(0)
    expect(report.totalRuns).toBe(1)
  })
})
