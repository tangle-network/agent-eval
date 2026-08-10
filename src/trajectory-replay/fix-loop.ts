/**
 * Iterative counterfactual fix loop.
 *
 * Attempt 1 is exactly the one-shot generator (same prompt, same caller), so
 * flip@1 stays comparable to one-shot fix mode. When an attempt does not flip
 * the failure — nonzero exit, signature still present, or the model call
 * itself failed — the next attempt's prompt carries every prior command and
 * its REAL executed stdout/stderr, up to a fixed attempt budget.
 *
 * Isolation invariant: every attempt executes through the injected executor,
 * which must provide a FRESH sandbox with the same replayed prefix. A used
 * sandbox is never mutated mid-arm; a flip therefore always proves the
 * corrected step against the recorded prefix state, not against debris from
 * an earlier attempt.
 */

import {
  buildFixPrompt,
  buildRetryFixPrompt,
  type ChatCompletionCaller,
  clipText,
  countScriptCommands,
  extractFixCommand,
  type FailedFixAttempt,
  type FixPromptInput,
} from './fix'

/** Result of executing one corrected command as a full arm. */
export interface FixArmExecution {
  readonly exitCode: number
  readonly prefixExecuted: number
  readonly prefixDivergences: number
  /** Divergent prefix steps over executed ones, in percent. */
  readonly prefixDivergencePct: number
  readonly failureVanished: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Runs one corrected command as a full arm: fresh sandbox + prefix replay. */
export type FixArmExecutor = (command: string, attempt: number) => Promise<FixArmExecution>

export interface FixLoopOptions {
  /** Total LLM attempts per case (≥1); 1 degenerates to the one-shot path. */
  readonly maxAttempts: number
  /** Command-line cap on retry scripts (default 5). */
  readonly maxScriptCommands?: number
  /** Chars kept per stdout/stderr tail in records and retry prompts. */
  readonly outputTailChars?: number
  readonly onProgress?: (message: string) => void
}

export interface FixLoopAttemptRecord {
  readonly attempt: number
  readonly command: string | null
  readonly llmError: string | null
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null
  readonly executed: boolean
  readonly exitCode: number | null
  readonly prefixExecuted: number | null
  readonly prefixDivergences: number | null
  readonly prefixDivergencePct: number | null
  readonly failureVanished: boolean | null
  readonly stdoutTail: string | null
  readonly stderrTail: string | null
  readonly armBError: string | null
  readonly wallMs: number
}

export interface FixLoopResult {
  readonly flipped: boolean
  readonly flippedAtAttempt: number | null
  readonly attempts: readonly FixLoopAttemptRecord[]
  /** True when a sandbox error ended the loop before the attempt budget. */
  readonly aborted: boolean
  readonly llmCalls: number
  /** Calls that produced no runnable fix: transport errors, empty replies,
   *  and retry scripts over the command cap. */
  readonly llmFailures: number
  readonly promptTokens: number
  readonly completionTokens: number
  /** Successful calls whose provider reported no usage. Their tokens are absent
   *  from the two totals above, so a nonzero count makes those totals a lower
   *  bound rather than a measurement. */
  readonly callsWithoutUsage: number
}

function toFailedAttempt(record: FixLoopAttemptRecord): FailedFixAttempt {
  return {
    attempt: record.attempt,
    command: record.command,
    exitCode: record.exitCode,
    stdoutTail: record.stdoutTail,
    stderrTail: record.stderrTail,
    llmError: record.llmError ?? record.armBError,
  }
}

export async function runFixLoop(
  caller: ChatCompletionCaller,
  input: FixPromptInput,
  executor: FixArmExecutor,
  options: FixLoopOptions,
): Promise<FixLoopResult> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error(
      `trajectory-replay: maxAttempts must be a positive integer, got ${options.maxAttempts}`,
    )
  }
  const scriptCap = options.maxScriptCommands ?? 5
  const tailChars = options.outputTailChars ?? 1600
  const attempts: FixLoopAttemptRecord[] = []
  let llmCalls = 0
  let llmFailures = 0
  let promptTokens = 0
  let completionTokens = 0
  let callsWithoutUsage = 0

  const unexecuted = (
    attempt: number,
    llmError: string,
    usage: FixLoopAttemptRecord['usage'],
    command: string | null,
    started: number,
  ): FixLoopAttemptRecord => ({
    attempt,
    command,
    llmError,
    usage,
    executed: false,
    exitCode: null,
    prefixExecuted: null,
    prefixDivergences: null,
    prefixDivergencePct: null,
    failureVanished: null,
    stdoutTail: null,
    stderrTail: null,
    armBError: null,
    wallMs: Date.now() - started,
  })

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const started = Date.now()
    const prompt =
      attempt === 1
        ? buildFixPrompt(input)
        : buildRetryFixPrompt(input, attempts.map(toFailedAttempt), scriptCap)
    llmCalls += 1
    const outcome = await caller.complete(prompt.system, prompt.user)
    if (!outcome.succeeded) {
      llmFailures += 1
      attempts.push(unexecuted(attempt, outcome.error, null, null, started))
      options.onProgress?.(
        `fix-loop attempt ${attempt}: LLM failed — ${outcome.error.slice(0, 160)}`,
      )
      continue
    }
    const usage = outcome.value.usage
    if (usage === null || usage === undefined) callsWithoutUsage += 1
    promptTokens += usage?.promptTokens ?? 0
    completionTokens += usage?.completionTokens ?? 0
    const command = extractFixCommand(outcome.value.content)
    if (command === null) {
      llmFailures += 1
      attempts.push(
        unexecuted(
          attempt,
          `completion carried no usable command: ${clipText(outcome.value.content, 300)}`,
          usage,
          null,
          started,
        ),
      )
      continue
    }
    // Attempt 1 mirrors one-shot exactly, so only retries enforce the cap.
    if (attempt > 1) {
      const commandLines = countScriptCommands(command)
      if (commandLines > scriptCap) {
        llmFailures += 1
        attempts.push(
          unexecuted(
            attempt,
            `script exceeds ${scriptCap} command lines (${commandLines})`,
            usage,
            null,
            started,
          ),
        )
        options.onProgress?.(
          `fix-loop attempt ${attempt}: rejected script with ${commandLines} command lines`,
        )
        continue
      }
    }
    let execution: FixArmExecution
    try {
      execution = await executor(command, attempt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      attempts.push({
        ...unexecuted(attempt, '', usage, command, started),
        llmError: null,
        armBError: message.slice(0, 500),
      })
      options.onProgress?.(`fix-loop attempt ${attempt}: sandbox error — ${message.slice(0, 160)}`)
      return {
        flipped: false,
        flippedAtAttempt: null,
        attempts,
        aborted: true,
        llmCalls,
        llmFailures,
        promptTokens,
        completionTokens,
        callsWithoutUsage,
      }
    }
    attempts.push({
      attempt,
      command,
      llmError: null,
      usage,
      executed: true,
      exitCode: execution.exitCode,
      prefixExecuted: execution.prefixExecuted,
      prefixDivergences: execution.prefixDivergences,
      prefixDivergencePct: execution.prefixDivergencePct,
      failureVanished: execution.failureVanished,
      stdoutTail: clipText(execution.stdout, tailChars),
      stderrTail: clipText(execution.stderr, tailChars),
      armBError: null,
      wallMs: Date.now() - started,
    })
    options.onProgress?.(
      `fix-loop attempt ${attempt}: exit=${execution.exitCode} failureVanished=${execution.failureVanished}`,
    )
    if (execution.failureVanished) {
      return {
        flipped: true,
        flippedAtAttempt: attempt,
        attempts,
        aborted: false,
        llmCalls,
        llmFailures,
        promptTokens,
        completionTokens,
        callsWithoutUsage,
      }
    }
  }
  return {
    flipped: false,
    flippedAtAttempt: null,
    attempts,
    aborted: false,
    llmCalls,
    llmFailures,
    promptTokens,
    completionTokens,
    callsWithoutUsage,
  }
}
