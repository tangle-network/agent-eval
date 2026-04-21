import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import type { SandboxDriver, SandboxResult, HarnessConfig } from '../src/sandbox-harness'
import {
  BuilderSession,
  ProjectRegistry,
  correlateLayers,
  resumeBuilderSession,
  scoreAllProjects,
  scoreProject,
} from '../src/builder-eval'

class FakeDriver implements SandboxDriver {
  id = 'fake'
  result: Partial<Record<SandboxResult['phase'], SandboxResult>> = {}
  async exec(phase: SandboxResult['phase'], _cmd: string, _cfg: HarnessConfig): Promise<SandboxResult> {
    return this.result[phase] ?? { phase, exitCode: 0, stdout: '', stderr: '', wallMs: 1 }
  }
}

async function completeProject(
  store: InMemoryTraceStore,
  projectId: string,
  metaScore: number,
  buildPassed: boolean,
  runtimeScore: number,
): Promise<void> {
  const driver = new FakeDriver()
  driver.result = {
    test: {
      phase: 'test',
      exitCode: buildPassed ? 0 : 1,
      stdout: '',
      stderr: '',
      wallMs: 5,
      testsTotal: 10,
      testsPassed: buildPassed ? 10 : 5,
    },
  }
  const session = new BuilderSession(store, { projectId }, driver)
  await session.startChat()
  // Simulate a builder edit span
  const edit = await session.emitter.span({ kind: 'custom', name: 'edit', attributes: { file: 'app.ts' } })
  await edit.end()
  await session.recordMetaScore(metaScore, 'simulated')
  await session.ship({ harness: { testCommand: 'pnpm test' } })
  // Two app-runtime scenarios
  for (let i = 0; i < 2; i++) {
    const runtimeDriver = new FakeDriver()
    runtimeDriver.result = {
      test: {
        phase: 'test', exitCode: runtimeScore >= 0.5 ? 0 : 1, stdout: '', stderr: '', wallMs: 5,
        testsTotal: 10, testsPassed: Math.round(runtimeScore * 10),
      },
    }
    await session.runAppScenario({
      scenario: { id: `${projectId}/scn-${i}`, harness: { testCommand: 'pnpm test' } },
      driver: runtimeDriver,
    })
  }
  await session.endChat({ pass: buildPassed && runtimeScore >= 0.5, score: (metaScore + runtimeScore) / 2 })
}

describe('BuilderSession', () => {
  it('emits builder → app-build → app-runtime runs with proper parent chain', async () => {
    const store = new InMemoryTraceStore()
    const driver = new FakeDriver()
    driver.result = { test: { phase: 'test', exitCode: 0, stdout: '', stderr: '', wallMs: 1, testsTotal: 4, testsPassed: 4 } }
    const session = new BuilderSession(store, { projectId: 'proj-1', chatId: 'chat-1' }, driver)
    await session.startChat()
    const { runId: buildRunId } = await session.ship({ harness: { testCommand: 'pnpm test' } })
    const runtime = await session.runAppScenario({
      scenario: { id: 'proj-1/scn-a', harness: { testCommand: 'pnpm test' } },
      driver,
    })

    const runs = await store.listRuns({ projectId: 'proj-1' })
    const builder = runs.find((r) => r.layer === 'builder')!
    const build = runs.find((r) => r.layer === 'app-build')!
    const appRun = runs.find((r) => r.runId === runtime.runId)!
    expect(build.parentRunId).toBe(builder.runId)
    expect(appRun.parentRunId).toBe(buildRunId)
    expect(appRun.layer).toBe('app-runtime')
    expect(appRun.projectId).toBe('proj-1')
    expect(appRun.chatId).toBe('chat-1')
  })

  it('ship() before startChat() throws — regression: silent mis-parenting was the whole failure mode', async () => {
    const session = new BuilderSession(new InMemoryTraceStore(), { projectId: 'p' }, new FakeDriver())
    await expect(
      session.ship({ harness: { testCommand: 'noop' } }),
    ).rejects.toThrow(/startChat/)
  })
})

describe('scoreProject + correlateLayers', () => {
  it('rolls up meta/build/runtime scores and flags complete=true', async () => {
    const store = new InMemoryTraceStore()
    await completeProject(store, 'proj-1', 0.8, true, 0.9)
    const report = await scoreProject(store, 'proj-1')
    expect(report.metaScore).toBeCloseTo(0.8)
    expect(report.buildScore).toBe(1)
    expect(report.runtimeScore).toBeCloseTo(0.9)
    expect(report.complete).toBe(true)
  })

  it('correlateLayers surfaces meta→runtime correlation across projects — regression: if builder self-score is uncorrelated with reality it must show as low r', async () => {
    const store = new InMemoryTraceStore()
    // Correlated pairs: higher meta → higher runtime
    const pairs = [
      [0.2, 0.3], [0.4, 0.4], [0.6, 0.7], [0.8, 0.85], [0.9, 0.95],
    ] as const
    for (let i = 0; i < pairs.length; i++) {
      await completeProject(store, `proj-${i}`, pairs[i][0], true, pairs[i][1])
    }
    const reports = await scoreAllProjects(store)
    const corr = correlateLayers(reports)
    expect(corr.completeProjects).toBe(5)
    expect(corr.metaVsRuntime?.pearson ?? 0).toBeGreaterThan(0.8)
  })
})

describe('ProjectRegistry + resumeBuilderSession', () => {
  it('listProjects returns chat/build/runtime counts and latest activity', async () => {
    const store = new InMemoryTraceStore()
    await completeProject(store, 'proj-1', 0.5, true, 0.5)
    const registry = new ProjectRegistry(store)
    const projects = await registry.listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].chatCount).toBe(1)
    expect(projects[0].buildCount).toBe(1)
    expect(projects[0].appRuntimeCount).toBe(2)
  })

  it('projectTimeline returns chronological buckets', async () => {
    const store = new InMemoryTraceStore()
    await completeProject(store, 'proj-1', 0.5, true, 0.5)
    const timeline = await new ProjectRegistry(store).projectTimeline('proj-1')
    const kinds = timeline.map((t) => t.layerBucket)
    expect(kinds[0]).toBe('chat')
    expect(kinds).toContain('build')
    expect(kinds).toContain('runtime')
  })

  it('resumeBuilderSession reconstructs the latest runs — regression: chat-first UIs need resume to land on current state', async () => {
    const store = new InMemoryTraceStore()
    await completeProject(store, 'proj-1', 0.5, true, 0.5)
    const resumed = await resumeBuilderSession(store, 'proj-1')
    expect(resumed.projectId).toBe('proj-1')
    expect(resumed.lastBuilderRun?.layer).toBe('builder')
    expect(resumed.lastBuildRun?.layer).toBe('app-build')
    expect(resumed.lastAppRuntimeRuns).toHaveLength(2)
  })

  it('projectChats returns per-chat summaries with llm/tool counts', async () => {
    const store = new InMemoryTraceStore()
    await completeProject(store, 'proj-1', 0.5, true, 0.5)
    const chats = await new ProjectRegistry(store).projectChats('proj-1')
    expect(chats).toHaveLength(1)
    expect(chats[0].appRuntimeRunIds).toHaveLength(2)
    expect(typeof chats[0].toolCalls).toBe('number')
  })
})
