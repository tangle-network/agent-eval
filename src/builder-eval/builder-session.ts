/**
 * BuilderSession — ties a builder-of-builders workflow together.
 *
 * Models agent-builder's shape: Project → Chat → Edit → Ship → App →
 * AppAgent. Each layer is a Run (linked via parentRunId). The
 * framework-enforced invariants:
 *
 *   - One Project → many Chats; chatId scopes runs within a project.
 *   - One Chat = one builder Run with `layer='builder'`.
 *   - One Ship = one child Run with `layer='app-build'` + SandboxHarness.
 *   - One AppScenario = one grandchild Run with `layer='app-runtime'`.
 *
 * Consumers obtain a BuilderSession, call `startChat`, drive the
 * builder agent (emitting spans), and call `ship` / `runAppScenario`
 * as the workflow progresses. The session reconstructs itself from
 * trace data via `resume(store, projectId)`.
 */

import type { Run } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { TraceEmitter } from '../trace/emitter'
import type { TestGradedScenario, TestGradedRunResult } from '../test-graded-scenario'
import { runTestGradedScenario } from '../test-graded-scenario'
import type { SandboxDriver, HarnessConfig, SandboxHarnessResult } from '../sandbox-harness'
import { SandboxHarness } from '../sandbox-harness'

export interface BuilderSessionInit {
  projectId: string
  chatId?: string
  /** Free-form: user's task description, project name, etc. Stored on the builder Run. */
  tags?: Record<string, string>
}

export interface ShipOptions {
  harness: HarnessConfig
  driver?: SandboxDriver
  /** scenarioId of this app-build run. Defaults to `${projectId}/build`. */
  scenarioId?: string
}

export interface RunAppScenarioOptions {
  scenario: TestGradedScenario
  /** Harness driver override; defaults to the one the session was created with. */
  driver?: SandboxDriver
}

export class BuilderSession {
  private store: TraceStore
  private builderEmitter: TraceEmitter
  readonly projectId: string
  readonly chatId: string
  private builderRunId?: string
  private lastBuildRunId?: string
  private defaultDriver?: SandboxDriver

  constructor(store: TraceStore, init: BuilderSessionInit, driver?: SandboxDriver) {
    this.store = store
    this.projectId = init.projectId
    this.chatId = init.chatId ?? cryptoId()
    this.defaultDriver = driver
    this.builderEmitter = new TraceEmitter(store)
  }

  /** Start the builder (L0) run for this chat. Returns the runId. */
  async startChat(scenarioId = `${this.projectId}/chat`): Promise<string> {
    await this.builderEmitter.startRun({
      scenarioId,
      projectId: this.projectId,
      chatId: this.chatId,
      layer: 'builder',
    })
    this.builderRunId = this.builderEmitter.runId
    return this.builderRunId
  }

  /** The emitter for builder-level spans (edits, LLM calls, tool invocations). */
  get emitter(): TraceEmitter {
    if (!this.builderRunId) throw new Error('BuilderSession.emitter: call startChat() first')
    return this.builderEmitter
  }

  /**
   * Ship the project's generated app: run the sandbox harness as a child
   * Run (`layer='app-build'`). Returns the build result + runId.
   */
  async ship(options: ShipOptions): Promise<{ runId: string; result: SandboxHarnessResult }> {
    if (!this.builderRunId) throw new Error('BuilderSession.ship: call startChat() first')
    const buildEmitter = new TraceEmitter(this.store)
    await buildEmitter.startRun({
      scenarioId: options.scenarioId ?? `${this.projectId}/build`,
      projectId: this.projectId,
      chatId: this.chatId,
      parentRunId: this.builderRunId,
      layer: 'app-build',
    })
    const harness = new SandboxHarness(options.driver ?? this.defaultDriver)
    const result = await harness.run(options.harness, buildEmitter)
    await buildEmitter.endRun({
      pass: result.passed,
      score: result.score,
      failureClass: result.passed ? 'success' : 'sandbox_failure',
    })
    this.lastBuildRunId = buildEmitter.runId
    return { runId: buildEmitter.runId, result }
  }

  /**
   * Run a domain scenario against the just-built app as a grandchild Run
   * (`layer='app-runtime'`). The `ship` call must precede this so the
   * parent is set correctly; if no build exists yet the session attaches
   * directly to the builder run (useful for prototypes).
   */
  async runAppScenario(options: RunAppScenarioOptions): Promise<TestGradedRunResult> {
    const parentRunId = this.lastBuildRunId ?? this.builderRunId
    if (!parentRunId) throw new Error('BuilderSession.runAppScenario: call startChat() + ship() first')
    const { scenario, driver } = options
    const result = await runTestGradedScenario(scenario, this.store, {
      driver: driver ?? this.defaultDriver,
      provenance: { codeSha: undefined, promptSha: undefined, modelFingerprint: undefined },
    })
    // Attach to the parent chain by updating the stored Run in place.
    await this.store.updateRun(result.runId, {
      parentRunId,
      projectId: this.projectId,
      chatId: this.chatId,
      layer: 'app-runtime',
    })
    return result
  }

  /** Record an end-of-chat meta score (judge verdict on whether the builder
   *  served the user's intent). Accepts a numeric score + optional rationale. */
  async recordMetaScore(score: number, rationale?: string): Promise<void> {
    if (!this.builderRunId) throw new Error('BuilderSession.recordMetaScore: call startChat() first')
    await this.builderEmitter.recordJudge({
      judgeId: 'builder-meta',
      targetSpanId: this.builderRunId, // attach to the builder run itself
      dimension: 'user_intent_satisfaction',
      score,
      rationale,
      name: 'builder-meta',
    })
  }

  /** Close the builder Run with a final outcome. */
  async endChat(outcome: { pass: boolean; score?: number; notes?: string }): Promise<void> {
    await this.builderEmitter.endRun({ pass: outcome.pass, score: outcome.score, notes: outcome.notes })
  }

  get lastBuildRunIdValue(): string | undefined { return this.lastBuildRunId }
  get builderRunIdValue(): string | undefined { return this.builderRunId }
}

/**
 * Reconstruct the most recent BuilderSession state for a given project —
 * returns { builderRunId, lastBuildRunId, chatRuns }. For chat-first UIs
 * this is how a resumed session finds its place in the edit history.
 */
export async function resumeBuilderSession(
  store: TraceStore,
  projectId: string,
): Promise<{
  projectId: string
  chatRuns: Run[]
  lastBuilderRun?: Run
  lastBuildRun?: Run
  lastAppRuntimeRuns: Run[]
}> {
  const runs = await store.listRuns({ projectId })
  const chatRuns = runs.filter((r) => r.layer === 'builder').sort((a, b) => b.startedAt - a.startedAt)
  const buildRuns = runs.filter((r) => r.layer === 'app-build').sort((a, b) => b.startedAt - a.startedAt)
  const appRuntimeRuns = runs.filter((r) => r.layer === 'app-runtime').sort((a, b) => b.startedAt - a.startedAt)
  return {
    projectId,
    chatRuns,
    lastBuilderRun: chatRuns[0],
    lastBuildRun: buildRuns[0],
    lastAppRuntimeRuns: appRuntimeRuns,
  }
}

function cryptoId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
