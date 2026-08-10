/**
 * Execution-replay verification for recorded shell trajectories.
 *
 * Turns a cited claim ("step k is the error-critical step") into an executed
 * proof: replay steps 1..k-1 inside the trajectory's own image, then
 *   arm A — run the recorded step k and check the recorded failure signature
 *           reproduces (returncode + a stable output substring), and
 *   arm B — run a corrected step k and check the failure vanishes.
 *
 * Built on the counterfactual scaffold: the trajectory is ingested into a
 * TraceStore, each arm is a `runCounterfactual` meta-run, and the
 * `SandboxCounterfactualRunner` here supplies the `executeFrom` callback that
 * scaffold deliberately leaves to consumers.
 *
 * Honest limits:
 * - Only trajectories that record their image can be replayed; tasks whose
 *   environment needs external compose peers cannot be replayed this way.
 * - Each arm replays the prefix in its own fresh session, so a backend
 *   without copy-on-write forks pays the prefix twice.
 * - Prefix divergence (recorded vs replayed returncode) is recorded per step
 *   and surfaced in the verdict, never hidden: a high divergence count is a
 *   finding about replayability, not an error of the harness.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CounterfactualContext,
  type CounterfactualRunner,
  runCounterfactual,
} from '../counterfactual'
import { TraceEmitter } from '../trace/emitter'
import type { ToolSpan } from '../trace/schema'
import { InMemoryTraceStore, type TraceStore } from '../trace/store'
import type { ReplayExecBackend } from './exec'
import { wrapActionForExec } from './exec'
import {
  deriveFailureSignature,
  parseObservationOutput,
  parseRecordedReturncode,
  type RecordedTrajectoryStep,
} from './steps'

// ── Ingest: recorded steps → a trace run ─────────────────────────────

export interface IngestedTrajectory {
  runId: string
  stepCount: number
}

/**
 * Emit one tool span per trajectory step, in order, with a monotonic
 * injected clock so `buildTrajectory` ordering is deterministic even when
 * two spans would share a Date.now() millisecond.
 */
export async function ingestRecordedTrajectory(
  store: TraceStore,
  steps: readonly RecordedTrajectoryStep[],
  caseId: string,
): Promise<IngestedTrajectory> {
  let tick = 0
  const emitter = new TraceEmitter(store, { now: () => ++tick })
  await emitter.startRun({
    scenarioId: caseId,
    tags: { source: 'trajectory-replay', caseId },
  })
  for (const step of steps) {
    if (typeof step.action !== 'string' || step.action.length === 0) {
      throw new Error(`trajectory-replay: step ${step.step_id} has no action`)
    }
    const handle = await emitter.tool({
      name: `step:${step.step_id}`,
      toolName: 'shell',
      args: { command: step.action },
      result: {
        returncode: parseRecordedReturncode(step.observation),
        observation: step.observation,
      },
    })
    await handle.end()
  }
  await emitter.endRun({ pass: true, notes: 'recorded trajectory (ingested for replay)' })
  return { runId: emitter.runId, stepCount: steps.length }
}

// ── Counterfactual runner over an exec backend ───────────────────────

export interface PrefixDivergence {
  step: number
  expectedReturncode: number | null
  actualExit: number
}

export interface PrefixReplayResult {
  prefixExecuted: number
  prefixDivergences: PrefixDivergence[]
  wallMs: number
}

export interface ArmExecutionResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  wallMs: number
}

export interface SandboxCounterfactualRunnerOptions {
  cwd: string
  stepTimeoutMs: number
  /** Execute at most this many prefix steps (from the start). Fast-iteration
   *  knob; a truncated prefix weakens state fidelity and the verdict says so. */
  prefixLimit?: number
  onProgress?: (message: string) => void
}

function toolCommand(span: ToolSpan): string {
  const args = span.args as { command?: unknown } | null
  if (!args || typeof args.command !== 'string') {
    throw new Error(`trajectory-replay: span ${span.name} carries no command`)
  }
  return args.command
}

function recordedReturncodeOf(span: ToolSpan): number | null {
  const result = span.result as { returncode?: unknown } | null
  return typeof result?.returncode === 'number' ? result.returncode : null
}

/**
 * Replays `ctx.prefix` in a fresh session, then executes the mutated step.
 * Divergences are recorded and never abort the replay. Results land on
 * `lastPrefix` / `lastArm` for the caller; spans for every exec land in the
 * counterfactual meta-run.
 */
export class SandboxCounterfactualRunner implements CounterfactualRunner {
  lastPrefix: PrefixReplayResult | null = null
  lastArm: ArmExecutionResult | null = null

  constructor(
    private readonly backend: ReplayExecBackend,
    private readonly options: SandboxCounterfactualRunnerOptions,
  ) {}

  async executeFrom(ctx: CounterfactualContext, emitter: TraceEmitter): Promise<void> {
    const { cwd, stepTimeoutMs, prefixLimit, onProgress } = this.options
    const session = await this.backend.open()
    try {
      const toolSteps = ctx.prefix.filter(
        (s): s is typeof s & { span: ToolSpan } => s.span.kind === 'tool',
      )
      const toExecute = prefixLimit !== undefined ? toolSteps.slice(0, prefixLimit) : toolSteps
      const divergences: PrefixDivergence[] = []
      const prefixStart = Date.now()
      for (const step of toExecute) {
        const command = toolCommand(step.span)
        const expected = recordedReturncodeOf(step.span)
        const started = Date.now()
        const result = await session.exec(wrapActionForExec(command, cwd), stepTimeoutMs)
        const handle = await emitter.sandbox({
          name: step.span.name,
          command,
          exitCode: result.exitCode,
          wallMs: Date.now() - started,
        })
        await handle.end()
        if (expected !== null && expected !== result.exitCode) {
          divergences.push({
            step: step.index + 1,
            expectedReturncode: expected,
            actualExit: result.exitCode,
          })
        }
        onProgress?.(
          `prefix ${step.span.name}: exit=${result.exitCode}` +
            (expected !== null && expected !== result.exitCode ? ` (recorded ${expected})` : ''),
        )
      }
      this.lastPrefix = {
        prefixExecuted: toExecute.length,
        prefixDivergences: divergences,
        wallMs: Date.now() - prefixStart,
      }

      if (ctx.mutatedStep.span.kind !== 'tool') {
        throw new Error('trajectory-replay: mutation target is not a tool span')
      }
      const armCommand = toolCommand(ctx.mutatedStep.span as ToolSpan)
      const armStart = Date.now()
      const armResult = await session.exec(wrapActionForExec(armCommand, cwd), stepTimeoutMs)
      const armWallMs = Date.now() - armStart
      const armHandle = await emitter.sandbox({
        name: `candidate:${ctx.mutatedStep.span.name}`,
        command: armCommand,
        exitCode: armResult.exitCode,
        wallMs: armWallMs,
      })
      await armHandle.end()
      this.lastArm = {
        command: armCommand,
        exitCode: armResult.exitCode,
        stdout: armResult.stdout,
        stderr: armResult.stderr,
        wallMs: armWallMs,
      }
      onProgress?.(`candidate step: exit=${armResult.exitCode} in ${armWallMs}ms`)
      await emitter.endRun({
        pass: armResult.exitCode === 0,
        notes: `prefix ${toExecute.length} steps, ${divergences.length} divergences`,
      })
    } finally {
      await session.close()
    }
  }
}

// ── Verdict assembly ─────────────────────────────────────────────────

export interface ReplayVerifyOptions {
  stepsPath: string
  image: string
  /** 1-based step_id of the error-critical step. */
  at: number
  /** Corrected command for arm B. Omit to run arm A only. */
  fixCommand?: string
  cwd: string
  out: string
  caseId?: string
  /** Override the auto-derived failure signature substring. */
  signature?: string
  stepTimeoutMs?: number
  prefixLimit?: number
  /** Label of the driver backing the exec backend (reported, not probed). */
  driverLabel?: string
  /** Execution environment for both arms; each arm opens its own session. */
  backend: ReplayExecBackend
  onProgress?: (message: string) => void
}

export interface ReplayArmVerdict {
  command: string
  exitCode: number
  wallMs: number
  prefix: PrefixReplayResult
}

export interface ReplayVerdict {
  case: string
  image: string
  driver: string
  k: number
  cwd: string
  recordedReturncode: number | null
  signature: string | null
  signatureBasis: 'returncode+output-substring' | 'returncode-only'
  prefixExecuted: number
  prefixDivergences: PrefixDivergence[]
  armA: ReplayArmVerdict & { failureSignatureMatch: boolean }
  armB: (ReplayArmVerdict & { failureVanished: boolean }) | null
  timings: { armAMs: number; armBMs: number | null; totalMs: number }
  runIds: { original: string; armA: string; armB: string | null }
}

function excerpt(text: string, limit = 2400): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit / 2)
  const tail = text.slice(-limit / 2)
  return `${head}\n… [${text.length - limit} chars elided] …\n${tail}`
}

export async function replayVerify(options: ReplayVerifyOptions): Promise<ReplayVerdict> {
  const totalStart = Date.now()
  const steps = JSON.parse(readFileSync(options.stepsPath, 'utf8')) as RecordedTrajectoryStep[]
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`trajectory-replay: ${options.stepsPath} is not a non-empty steps array`)
  }
  const index = options.at - 1
  if (index < 0 || index >= steps.length) {
    throw new Error(`trajectory-replay: at ${options.at} out of range [1, ${steps.length}]`)
  }
  const target = steps[index]!
  if (target.step_id !== options.at) {
    throw new Error(
      `trajectory-replay: steps[${index}].step_id=${target.step_id} != at ${options.at}; ` +
        'steps.json must be ordered with 1-based contiguous step_ids',
    )
  }
  const caseId = options.caseId ?? options.stepsPath
  const recordedReturncode = parseRecordedReturncode(target.observation)
  const signature = options.signature ?? deriveFailureSignature(target.observation)
  const signatureBasis = signature ? 'returncode+output-substring' : 'returncode-only'

  const runnerOptions: SandboxCounterfactualRunnerOptions = {
    cwd: options.cwd,
    stepTimeoutMs: options.stepTimeoutMs ?? 300_000,
    prefixLimit: options.prefixLimit,
    onProgress: options.onProgress,
  }

  const store = new InMemoryTraceStore()
  const { runId } = await ingestRecordedTrajectory(store, steps, caseId)

  options.onProgress?.(`arm A: replaying ${index} prefix steps then recorded step ${options.at}`)
  const armARunner = new SandboxCounterfactualRunner(options.backend, runnerOptions)
  const armAStart = Date.now()
  const armAResult = await runCounterfactual(
    store,
    runId,
    { kind: 'custom', at: index, describe: 'arm-A identity replay', apply: (s) => s },
    armARunner,
  )
  const armAMs = Date.now() - armAStart
  const armAExec = requireExec(armARunner, 'arm A')
  const armAOutput = `${armAExec.stdout}\n${armAExec.stderr}`
  const failureSignatureMatch =
    recordedReturncode !== null &&
    armAExec.exitCode === recordedReturncode &&
    (signature ? armAOutput.includes(signature) : true)

  let armBRunner: SandboxCounterfactualRunner | null = null
  let armBExec: ArmExecutionResult | null = null
  let armBRunId: string | null = null
  let armBMs: number | null = null
  if (options.fixCommand) {
    const fixCommand = options.fixCommand
    options.onProgress?.('arm B: replaying prefix then corrected step')
    armBRunner = new SandboxCounterfactualRunner(options.backend, runnerOptions)
    const armBStart = Date.now()
    const armBResult = await runCounterfactual(
      store,
      runId,
      {
        kind: 'custom',
        at: index,
        describe: 'arm-B corrected step',
        apply: (step) => ({
          ...step,
          span: { ...(step.span as ToolSpan), args: { command: fixCommand } },
        }),
      },
      armBRunner,
    )
    armBMs = Date.now() - armBStart
    armBRunId = armBResult.counterfactualRunId
    armBExec = requireExec(armBRunner, 'arm B')
  }

  const armBOutput = armBExec ? `${armBExec.stdout}\n${armBExec.stderr}` : null
  const verdict: ReplayVerdict = {
    case: caseId,
    image: options.image,
    driver: options.driverLabel ?? 'docker',
    k: options.at,
    cwd: options.cwd,
    recordedReturncode,
    signature,
    signatureBasis,
    prefixExecuted: armARunner.lastPrefix?.prefixExecuted ?? 0,
    prefixDivergences: armARunner.lastPrefix?.prefixDivergences ?? [],
    armA: {
      command: armAExec.command,
      exitCode: armAExec.exitCode,
      wallMs: armAExec.wallMs,
      prefix: armARunner.lastPrefix!,
      failureSignatureMatch,
    },
    armB:
      armBExec && armBRunner
        ? {
            command: armBExec.command,
            exitCode: armBExec.exitCode,
            wallMs: armBExec.wallMs,
            prefix: armBRunner.lastPrefix!,
            failureVanished:
              armBExec.exitCode === 0 &&
              (signature && armBOutput ? !armBOutput.includes(signature) : true),
          }
        : null,
    timings: { armAMs, armBMs, totalMs: Date.now() - totalStart },
    runIds: {
      original: runId,
      armA: armAResult.counterfactualRunId,
      armB: armBRunId,
    },
  }

  mkdirSync(options.out, { recursive: true })
  writeFileSync(join(options.out, 'replay-verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`)
  writeFileSync(join(options.out, 'report.md'), renderReport(verdict, target, armAExec, armBExec))
  return verdict
}

function requireExec(runner: SandboxCounterfactualRunner, arm: string): ArmExecutionResult {
  if (!runner.lastArm) {
    throw new Error(`trajectory-replay: ${arm} finished without executing step k`)
  }
  return runner.lastArm
}

function renderReport(
  verdict: ReplayVerdict,
  target: RecordedTrajectoryStep,
  armA: ArmExecutionResult,
  armB: ArmExecutionResult | null,
): string {
  const lines: string[] = []
  const divergencePct =
    verdict.prefixExecuted > 0
      ? ((verdict.prefixDivergences.length / verdict.prefixExecuted) * 100).toFixed(1)
      : '0.0'
  lines.push(`# Replay verification — ${verdict.case}`)
  lines.push('')
  lines.push(`- image: \`${verdict.image}\` (driver: ${verdict.driver})`)
  lines.push(`- error-critical step k = ${verdict.k}, cwd \`${verdict.cwd}\``)
  lines.push(`- recorded returncode at k: ${verdict.recordedReturncode ?? 'none recorded'}`)
  lines.push(
    `- failure signature (${verdict.signatureBasis}): ${
      verdict.signature ? `\`${verdict.signature}\`` : '—'
    }`,
  )
  lines.push('')
  lines.push(`## Prefix replay (steps 1..${verdict.k - 1})`)
  lines.push('')
  lines.push(
    `Executed ${verdict.prefixExecuted} steps; ${verdict.prefixDivergences.length} returncode divergences (${divergencePct}%).`,
  )
  if (verdict.prefixDivergences.length > 0) {
    lines.push('')
    lines.push('| step | recorded rc | replayed exit |')
    lines.push('| --- | --- | --- |')
    for (const d of verdict.prefixDivergences) {
      lines.push(`| ${d.step} | ${d.expectedReturncode} | ${d.actualExit} |`)
    }
  }
  lines.push('')
  lines.push('## Arm A — recorded step k, replayed')
  lines.push('')
  lines.push('```sh')
  lines.push(armA.command)
  lines.push('```')
  lines.push('')
  lines.push(
    `Exit ${armA.exitCode} in ${armA.wallMs}ms — failureSignatureMatch: **${verdict.armA.failureSignatureMatch}**`,
  )
  lines.push('')
  lines.push('Recorded observation excerpt:')
  lines.push('')
  lines.push('```')
  lines.push(excerpt(parseObservationOutput(target.observation)))
  lines.push('```')
  lines.push('')
  lines.push('Replayed stdout+stderr excerpt:')
  lines.push('')
  lines.push('```')
  lines.push(excerpt(`${armA.stdout}\n${armA.stderr}`.trim()))
  lines.push('```')
  if (armB && verdict.armB) {
    lines.push('')
    lines.push('## Arm B — corrected step k')
    lines.push('')
    lines.push('```sh')
    lines.push(armB.command)
    lines.push('```')
    lines.push('')
    lines.push(
      `Exit ${armB.exitCode} in ${armB.wallMs}ms — failureVanished: **${verdict.armB.failureVanished}** ` +
        `(prefix re-replayed in a fresh session: ${verdict.armB.prefix.prefixExecuted} steps, ` +
        `${verdict.armB.prefix.prefixDivergences.length} divergences)`,
    )
    lines.push('')
    lines.push('Replayed stdout+stderr excerpt:')
    lines.push('')
    lines.push('```')
    lines.push(excerpt(`${armB.stdout}\n${armB.stderr}`.trim()))
    lines.push('```')
  }
  lines.push('')
  lines.push('## Timings')
  lines.push('')
  lines.push(
    `arm A ${verdict.timings.armAMs}ms, arm B ${verdict.timings.armBMs ?? '—'}ms, total ${verdict.timings.totalMs}ms.`,
  )
  lines.push('')
  return lines.join('\n')
}
