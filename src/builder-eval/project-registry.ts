/**
 * ProjectRegistry — project-level aggregation over the trace corpus.
 *
 * Thin reader over TraceStore that answers the questions a chat-first,
 * resumable UI needs:
 *   - listProjects() → project IDs with latest activity
 *   - projectTimeline(id) → chats + builds + runtime runs, chronological
 *   - projectChats(id) → chat-level summaries (turn count, outcome)
 *
 * All queries are pure reads; no state duplication.
 */

import type { Run } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export interface ProjectSummary {
  projectId: string
  chatCount: number
  buildCount: number
  appRuntimeCount: number
  lastActivityAt: number
  latestChatId?: string
  latestOutcome?: { pass: boolean; score?: number }
}

export interface ChatSummary {
  chatId: string
  projectId: string
  builderRunId: string
  startedAt: number
  endedAt?: number
  status: Run['status']
  outcome?: Run['outcome']
  /** Counts of spans emitted during the chat. */
  llmTurns?: number
  toolCalls?: number
  buildRunId?: string
  appRuntimeRunIds: string[]
}

export interface ProjectTimelineEntry {
  run: Run
  layerBucket: 'chat' | 'build' | 'runtime' | 'other'
}

export class ProjectRegistry {
  constructor(private store: TraceStore) {}

  async listProjects(): Promise<ProjectSummary[]> {
    const runs = await this.store.listRuns()
    const byProject = new Map<string, Run[]>()
    for (const r of runs) {
      if (!r.projectId) continue
      const arr = byProject.get(r.projectId) ?? []
      arr.push(r)
      byProject.set(r.projectId, arr)
    }
    const summaries: ProjectSummary[] = []
    for (const [projectId, projectRuns] of byProject) {
      const sorted = projectRuns.slice().sort((a, b) => b.startedAt - a.startedAt)
      const chats = projectRuns.filter((r) => r.layer === 'builder')
      const builds = projectRuns.filter((r) => r.layer === 'app-build')
      const runtimes = projectRuns.filter((r) => r.layer === 'app-runtime')
      const latest = sorted[0]
      summaries.push({
        projectId,
        chatCount: chats.length,
        buildCount: builds.length,
        appRuntimeCount: runtimes.length,
        lastActivityAt: latest.startedAt,
        latestChatId: chats[0]?.chatId,
        latestOutcome: latest.outcome
          ? { pass: latest.outcome.pass ?? false, score: latest.outcome.score }
          : undefined,
      })
    }
    return summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  async projectTimeline(projectId: string): Promise<ProjectTimelineEntry[]> {
    const runs = await this.store.listRuns({ projectId })
    const ordered = runs.slice().sort((a, b) => a.startedAt - b.startedAt)
    return ordered.map((run) => ({
      run,
      layerBucket:
        run.layer === 'builder'
          ? 'chat'
          : run.layer === 'app-build'
            ? 'build'
            : run.layer === 'app-runtime'
              ? 'runtime'
              : 'other',
    }))
  }

  async projectChats(projectId: string): Promise<ChatSummary[]> {
    const builderRuns = (await this.store.listRuns({ projectId, layer: 'builder' })).sort(
      (a, b) => b.startedAt - a.startedAt,
    )
    const childrenFor = async (runId: string) => this.store.listRuns({ parentRunId: runId })
    const out: ChatSummary[] = []
    for (const run of builderRuns) {
      const spans = await this.store.spans({ runId: run.runId })
      const children = await childrenFor(run.runId)
      const build = children.find((c) => c.layer === 'app-build')
      const runtime: string[] = []
      // Runtime runs can be grandchildren (attached to the build) or siblings
      // when shipped skipped.
      if (build) {
        const grands = await childrenFor(build.runId)
        for (const g of grands) if (g.layer === 'app-runtime') runtime.push(g.runId)
      }
      for (const c of children) if (c.layer === 'app-runtime') runtime.push(c.runId)
      out.push({
        chatId: run.chatId ?? run.runId,
        projectId,
        builderRunId: run.runId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
        outcome: run.outcome,
        llmTurns: spans.filter((s) => s.kind === 'llm').length,
        toolCalls: spans.filter((s) => s.kind === 'tool').length,
        buildRunId: build?.runId,
        appRuntimeRunIds: runtime,
      })
    }
    return out
  }
}
