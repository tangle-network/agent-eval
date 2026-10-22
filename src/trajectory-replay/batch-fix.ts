import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCounterfactual } from '../counterfactual'
import { mulberry32 } from '../statistics/random'
import type { ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import type { BatchRun, ReplayBatchCaseRow, ReplayBatchFixResult, ReplayBatchReport } from './batch'
import type { ReplayableCase } from './corpus'
import type { ReplayExecBackend } from './exec'
import { type ChatCompletionCaller, type ChatUsage, generateFixCommand } from './fix'
import { runFixLoop } from './fix-loop'
import {
  ingestRecordedTrajectory,
  type PrefixReplayResult,
  type ReplayVerdict,
  SandboxCounterfactualRunner,
} from './verify'

/** Arm B and the counterfactual fix phase of a replay batch. */

export function seededSample<T>(items: readonly T[], size: number, seed: number): Set<T> {
  const pool = [...items]
  const random = mulberry32(seed)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return new Set(pool.slice(0, size))
}

export function caseOutDirName(row: { corpus: string; trajId: string }): string {
  return `${row.corpus}--${row.trajId}`.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 180)
}

interface ArmBExecution {
  readonly exitCode: number
  readonly prefixExecuted: number
  readonly prefixDivergences: number
  readonly prefixDivergencePct: number
  readonly failureVanished: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * Arm B standalone: fresh sandbox, prefix replay, corrected step k. Reuses
 * the same counterfactual scaffold as replayVerify without re-running arm A.
 */
async function executeArmB(
  replayCase: ReplayableCase,
  fixCommand: string,
  backend: ReplayExecBackend,
  signature: string | null,
  stepTimeoutMs: number,
  prefixLimit: number | undefined,
  onProgress?: (message: string) => void,
): Promise<ArmBExecution> {
  const store = new InMemoryTraceStore()
  const { runId } = await ingestRecordedTrajectory(store, replayCase.steps, replayCase.trajId)
  const runner = new SandboxCounterfactualRunner(backend, {
    cwd: replayCase.cwd,
    stepTimeoutMs,
    prefixLimit,
    onProgress,
  })
  await runCounterfactual(
    store,
    runId,
    {
      kind: 'custom',
      at: replayCase.k - 1,
      describe: 'arm-B corrected step',
      apply: (step) => ({
        ...step,
        span: { ...(step.span as ToolSpan), args: { command: fixCommand } },
      }),
    },
    runner,
  )
  const exec = runner.lastArm
  if (!exec) throw new Error('arm B finished without executing the corrected step')
  const prefix: PrefixReplayResult | null = runner.lastPrefix
  if (!prefix) throw new Error('arm B reported no prefix replay result')
  const output = `${exec.stdout}\n${exec.stderr}`
  return {
    exitCode: exec.exitCode,
    prefixExecuted: prefix.prefixExecuted,
    prefixDivergences: prefix.prefixDivergences.length,
    prefixDivergencePct: prefix.prefixDivergencePct,
    failureVanished:
      prefix.prefixWithinTolerance &&
      exec.exitCode === 0 &&
      (signature ? !output.includes(signature) : true),
    stdout: exec.stdout,
    stderr: exec.stderr,
  }
}

/** Token and call totals across every fix prompt of a batch. */
interface LlmTally {
  calls: number
  failures: number
  promptTokens: number
  completionTokens: number
  callsWithoutUsage: number
}

/** Everything a fix mode needs about the case it is fixing. */
interface FixCase {
  readonly row: ReplayBatchCaseRow
  readonly replayCase: ReplayableCase
  readonly label: string
  readonly signature: string | null
  readonly stepTimeoutMs: number
  readonly caseOut: string
  readonly promptInput: Parameters<typeof generateFixCommand>[1]
}

/** A fix outcome with nothing measured; callers name what they did measure. */
function fixResult(measured: Partial<ReplayBatchFixResult>): ReplayBatchFixResult {
  return {
    attempted: true,
    sampledOut: false,
    command: null,
    llmError: null,
    usage: null,
    armBExit: null,
    armBPrefixExecuted: null,
    armBPrefixDivergences: null,
    armBPrefixDivergencePct: null,
    failureVanished: null,
    armBError: null,
    attempts: null,
    flippedAtAttempt: null,
    ...measured,
  }
}

function runArmB(run: BatchRun, fixCase: FixCase, command: string, label: string) {
  const { options } = run
  return executeArmB(
    fixCase.replayCase,
    command,
    options.backendFactory(fixCase.row.derivedImage!),
    fixCase.signature,
    fixCase.stepTimeoutMs,
    options.prefixLimit,
    (message) => run.onProgress(`${label}: ${message}`),
  )
}

/** The fix summary a finished loop reports: the flipping attempt, else the last executed one, else why it stopped. */
function loopFixResult(
  result: Awaited<ReturnType<typeof runFixLoop>>,
  usage: ChatUsage | null,
): ReplayBatchFixResult {
  const flippedRecord =
    result.flippedAtAttempt !== null
      ? result.attempts.find((a) => a.attempt === result.flippedAtAttempt)!
      : null
  const summary = flippedRecord ?? [...result.attempts].reverse().find((a) => a.executed) ?? null
  const lastRecord = result.attempts.at(-1) ?? null
  if (summary) {
    return fixResult({
      command: summary.command,
      usage,
      armBExit: summary.exitCode,
      armBPrefixExecuted: summary.prefixExecuted,
      armBPrefixDivergences: summary.prefixDivergences,
      armBPrefixDivergencePct: summary.prefixDivergencePct,
      failureVanished: summary.failureVanished,
      attempts: result.attempts,
      flippedAtAttempt: result.flippedAtAttempt,
    })
  }
  if (result.aborted) {
    return fixResult({
      command: lastRecord?.command ?? null,
      usage,
      armBError: lastRecord?.armBError ?? 'sandbox error',
      attempts: result.attempts,
    })
  }
  return fixResult({
    llmError: lastRecord?.llmError ?? 'no attempt produced a runnable fix',
    usage,
    attempts: result.attempts,
  })
}

/** Iterative fix: failed arms feed their real output into up to `fixAttempts` prompts. */
async function fixByLoop(
  run: BatchRun,
  fixCase: FixCase,
  caller: ChatCompletionCaller,
  tally: LlmTally,
): Promise<ReplayBatchCaseRow> {
  const { options, onProgress } = run
  const { row, label, caseOut } = fixCase
  const fixAttempts = options.fixAttempts ?? 3
  onProgress(`${label}: fix loop (budget ${fixAttempts} attempts)`)
  const result = await runFixLoop(
    caller,
    fixCase.promptInput,
    async (command, attempt) => {
      onProgress(`${label}: attempt ${attempt} arm B — ${command.split('\n')[0]!.slice(0, 120)}`)
      const armB = await runArmB(run, fixCase, command, `${label}: attempt ${attempt}`)
      mkdirSync(caseOut, { recursive: true })
      writeFileSync(
        join(caseOut, `armB-attempt${attempt}-result.json`),
        `${JSON.stringify({ command, ...armB }, null, 2)}\n`,
      )
      // armB-result.json always holds the LAST executed attempt — the
      // flipped one when the loop flips (it stops there).
      writeFileSync(
        join(caseOut, 'armB-result.json'),
        `${JSON.stringify({ command, attempt, ...armB }, null, 2)}\n`,
      )
      return armB
    },
    { maxAttempts: fixAttempts, onProgress: (message) => onProgress(`${label}: ${message}`) },
  )
  tally.calls += result.llmCalls
  tally.failures += result.llmFailures
  tally.promptTokens += result.promptTokens
  tally.completionTokens += result.completionTokens
  tally.callsWithoutUsage += result.callsWithoutUsage
  const usage =
    result.promptTokens + result.completionTokens > 0
      ? { promptTokens: result.promptTokens, completionTokens: result.completionTokens }
      : null
  onProgress(
    `${label}: loop done — flipped=${result.flipped}` +
      (result.flippedAtAttempt !== null ? ` at attempt ${result.flippedAtAttempt}` : '') +
      ` (${result.llmCalls} calls, ${result.attempts.filter((a) => a.executed).length} arms)`,
  )
  return { ...row, fix: loopFixResult(result, usage) }
}

/** One-shot fix: a single generated command, one arm B. */
async function fixByOneShot(
  run: BatchRun,
  fixCase: FixCase,
  caller: ChatCompletionCaller,
  tally: LlmTally,
): Promise<ReplayBatchCaseRow> {
  const { onProgress } = run
  const { row, label, caseOut } = fixCase
  onProgress(`${label}: generating corrected command`)
  tally.calls += 1
  const generated = await generateFixCommand(caller, fixCase.promptInput)
  if (!generated.succeeded) {
    tally.failures += 1
    onProgress(`${label}: LLM failed — ${generated.error.slice(0, 200)}`)
    return { ...row, fix: fixResult({ llmError: generated.error }) }
  }
  if (generated.value.usage === null || generated.value.usage === undefined) {
    tally.callsWithoutUsage += 1
  }
  tally.promptTokens += generated.value.usage?.promptTokens ?? 0
  tally.completionTokens += generated.value.usage?.completionTokens ?? 0
  onProgress(`${label}: arm B — ${generated.value.command.split('\n')[0]!.slice(0, 120)}`)
  try {
    const armB = await runArmB(run, fixCase, generated.value.command, label)
    const fix = fixResult({
      command: generated.value.command,
      usage: generated.value.usage,
      armBExit: armB.exitCode,
      armBPrefixExecuted: armB.prefixExecuted,
      armBPrefixDivergences: armB.prefixDivergences,
      armBPrefixDivergencePct: armB.prefixDivergencePct,
      failureVanished: armB.failureVanished,
      flippedAtAttempt: armB.failureVanished ? 1 : null,
    })
    mkdirSync(caseOut, { recursive: true })
    writeFileSync(
      join(caseOut, 'armB-result.json'),
      `${JSON.stringify({ command: generated.value.command, ...armB }, null, 2)}\n`,
    )
    onProgress(`${label}: armB exit=${armB.exitCode} failureVanished=${armB.failureVanished}`)
    return { ...row, fix }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    onProgress(`${label}: arm B error — ${message.slice(0, 200)}`)
    return {
      ...row,
      fix: fixResult({
        command: generated.value.command,
        usage: generated.value.usage,
        armBError: message.slice(0, 500),
      }),
    }
  }
}

/** Phase 2: counterfactual fixes for the cases where arm A reproduced, capped and seeded-sampled. */
export async function runFixPhase(
  run: BatchRun,
  selected: readonly ReplayableCase[],
  rows: ReplayBatchCaseRow[],
  verdicts: Map<string, ReplayVerdict>,
): Promise<ReplayBatchReport['llm']> {
  const { options, onProgress } = run
  const caller = options.fixCaller
  if (!caller) throw new Error(`trajectory-replay: fix=${options.fix} requires a fixCaller`)
  const maxFixCases = options.maxFixCases ?? 30
  const seed = options.seed ?? 17
  const eligible = rows.filter((r) => r.status === 'ok' && r.replayed)
  const sampled =
    eligible.length > maxFixCases ? seededSample(eligible, maxFixCases, seed) : new Set(eligible)
  if (eligible.length > maxFixCases) {
    onProgress(
      `fix phase: ${eligible.length} eligible > cap ${maxFixCases}; seeded sample (seed=${seed})`,
    )
  }
  const tally: LlmTally = {
    calls: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    callsWithoutUsage: 0,
  }
  for (const row of eligible) {
    const index = rows.indexOf(row)
    if (!sampled.has(row)) {
      rows[index] = { ...row, fix: fixResult({ attempted: false, sampledOut: true }) }
      continue
    }
    const replayCase = selected.find((c) => c.trajId === row.trajId && c.corpus === row.corpus)!
    const fixCase: FixCase = {
      row,
      replayCase,
      label: `fix ${row.corpus}/${row.trajId}`,
      signature: verdicts.get(row.trajId)?.signature ?? null,
      stepTimeoutMs: options.stepTimeoutMs ?? replayCase.recordedStepTimeoutMs ?? 120_000,
      caseOut: join(options.out, caseOutDirName(row)),
      promptInput: {
        taskStatement: replayCase.taskStatement,
        steps: replayCase.steps,
        k: replayCase.k,
      },
    }
    rows[index] =
      options.fix === 'loop'
        ? await fixByLoop(run, fixCase, caller, tally)
        : await fixByOneShot(run, fixCase, caller, tally)
  }
  return { model: options.fixModelLabel ?? 'unknown', ...tally }
}
