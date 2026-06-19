import { cpus } from 'node:os'
import {
  type HarnessConfig,
  type SandboxDriver,
  SandboxHarness,
  type SandboxHarnessResult,
  SubprocessSandboxDriver,
} from './sandbox-harness'
import { TraceEmitter } from './trace/emitter'
import { InMemoryTraceStore } from './trace/store'

export type SandboxJudgeKind = 'compiler' | 'test' | 'linter' | 'security'

export interface SandboxJudgeSpec {
  id: string
  kind: SandboxJudgeKind
  config: HarnessConfig
}

export interface SandboxJudgeResult {
  id: string
  kind: SandboxJudgeKind
  passed: boolean
  score: number
  summary: string
  detail: SandboxHarnessResult
}

export interface JudgeFleetOptions {
  driver?: SandboxDriver
  parallel?: boolean
  /**
   * Max concurrent judge subprocesses. Each spec spawns its own subprocess
   * via the driver, so unbounded fan-out exhausts file descriptors / PIDs.
   * Defaults to the host CPU count. Ignored when `parallel === false`.
   */
  concurrency?: number
}

export class JudgeRunner {
  private readonly driver: SandboxDriver

  constructor(driver: SandboxDriver = new SubprocessSandboxDriver()) {
    this.driver = driver
  }

  async run(spec: SandboxJudgeSpec): Promise<SandboxJudgeResult> {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store, { runId: `judge-${spec.id}` })
    await emitter.startRun({
      scenarioId: spec.id,
      layer: 'meta',
      projectId: 'judge-runner',
    })
    const harness = new SandboxHarness(this.driver)
    const detail = await harness.run(spec.config, emitter)
    await emitter.endRun({ pass: detail.passed, score: detail.score, notes: `${spec.kind} judge` })
    return {
      id: spec.id,
      kind: spec.kind,
      passed: detail.passed,
      score: detail.score,
      summary: renderJudgeSummary(spec.kind, detail),
      detail,
    }
  }
}

export async function runJudgeFleet(
  specs: SandboxJudgeSpec[],
  options: JudgeFleetOptions = {},
): Promise<SandboxJudgeResult[]> {
  const runner = new JudgeRunner(options.driver)
  if (options.parallel === false) {
    const results: SandboxJudgeResult[] = []
    for (const spec of specs) results.push(await runner.run(spec))
    return results
  }
  const concurrency = Math.max(1, options.concurrency ?? cpus().length)
  const results: SandboxJudgeResult[] = new Array(specs.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= specs.length) return
      results[i] = await runner.run(specs[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, () => worker()))
  return results
}

export function compilerJudge(id: string, config: HarnessConfig): SandboxJudgeSpec {
  return { id, kind: 'compiler', config }
}

export function testJudge(id: string, config: HarnessConfig): SandboxJudgeSpec {
  return { id, kind: 'test', config }
}

export function linterJudge(id: string, config: HarnessConfig): SandboxJudgeSpec {
  return { id, kind: 'linter', config }
}

export function securityJudge(id: string, config: HarnessConfig): SandboxJudgeSpec {
  return { id, kind: 'security', config }
}

function renderJudgeSummary(kind: SandboxJudgeKind, detail: SandboxHarnessResult): string {
  if (!detail.passed) return `${kind} judge failed`
  if (detail.test?.testsTotal)
    return `${kind} judge passed ${detail.test.testsPassed}/${detail.test.testsTotal} tests`
  return `${kind} judge passed`
}
