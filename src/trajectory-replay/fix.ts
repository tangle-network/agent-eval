/**
 * Counterfactual patch synthesis: turn a recorded incorrect step into a
 * corrected shell command for replay arm B.
 *
 * The caller is a typed outcome boundary ({ succeeded, value, error }) so a
 * provider failure is a per-case report row, never a thrown batch abort and
 * never a silent empty fix. Concrete chat transports live with the consumer;
 * this module only builds prompts and reads replies.
 */

import {
  parseObservationOutput,
  parseRecordedReturncode,
  type RecordedTrajectoryStep,
} from './steps'

export interface ChatUsage {
  readonly promptTokens: number
  readonly completionTokens: number
}

export type ChatOutcome =
  | { readonly succeeded: true; readonly value: { content: string; usage: ChatUsage | null } }
  | { readonly succeeded: false; readonly error: string }

export interface ChatCompletionCaller {
  complete(system: string, user: string): Promise<ChatOutcome>
}

export interface FixPromptInput {
  readonly taskStatement: string | null
  readonly steps: readonly RecordedTrajectoryStep[]
  /** 1-based step_id of the incorrect step. */
  readonly k: number
  /** Steps of context on each side of k (default 3). */
  readonly contextRadius?: number
}

/** Head+tail excerpt with an elision marker; identity below the limit. */
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n… [${text.length - limit} chars elided] …\n${text.slice(-half)}`
}

function renderStep(step: RecordedTrajectoryStep, marker: string): string {
  const rc = parseRecordedReturncode(step.observation)
  const output = clipText(parseObservationOutput(step.observation).trim(), 1600)
  return [
    `### step ${step.step_id}${marker}`,
    '```sh',
    clipText(step.action, 2000),
    '```',
    `returncode: ${rc ?? 'none recorded'}`,
    output.length > 0 ? `output:\n\`\`\`\n${output}\n\`\`\`` : 'output: (empty)',
  ].join('\n')
}

/** Shared user-prompt sections: task statement, ±radius context, failing step. */
function promptBody(input: FixPromptInput): string[] {
  const radius = input.contextRadius ?? 3
  const target = input.steps.find((s) => s.step_id === input.k)
  if (!target) throw new Error(`trajectory-replay: no step with step_id ${input.k}`)
  const context = input.steps.filter(
    (s) => s.step_id !== input.k && Math.abs(s.step_id - input.k) <= radius,
  )
  return [
    '## Task the agent was solving',
    input.taskStatement ? clipText(input.taskStatement, 4000) : '(no task statement recorded)',
    '',
    '## Surrounding steps',
    ...context.map((s) => renderStep(s, '')),
    '',
    '## Failing step to correct',
    renderStep(target, ' (INCORRECT — correct this one)'),
  ]
}

export function buildFixPrompt(input: FixPromptInput): { system: string; user: string } {
  const system = [
    'You repair one failed shell command from a recorded coding-agent trajectory.',
    'The trajectory replays inside the original docker image; every command runs as a fresh /bin/sh subshell from a fixed working directory.',
    'You are given the failing step, its recorded output, surrounding steps, and the task statement.',
    'Reply with exactly ONE corrected shell command (compound commands with && or pipes are fine) inside a single ```sh fenced block.',
    "The corrected command must accomplish the failing step's intent and exit 0. No prose outside the fenced block.",
  ].join('\n')
  const user = [
    ...promptBody(input),
    '',
    'Output the single corrected replacement for the failing step now.',
  ].join('\n')
  return { system, user }
}

/** One prior attempt of the fix loop, rendered into the retry prompt. */
export interface FailedFixAttempt {
  readonly attempt: number
  /** Null when the model call itself failed before producing a command. */
  readonly command: string | null
  readonly exitCode: number | null
  readonly stdoutTail: string | null
  readonly stderrTail: string | null
  readonly llmError: string | null
}

function renderFailedAttempt(prior: FailedFixAttempt): string {
  if (prior.command === null) {
    return [
      `### attempt ${prior.attempt}`,
      `model call failed before producing a command: ${prior.llmError ?? 'unknown error'}`,
    ].join('\n')
  }
  const stdout = (prior.stdoutTail ?? '').trim()
  const stderr = (prior.stderrTail ?? '').trim()
  return [
    `### attempt ${prior.attempt}`,
    '```sh',
    clipText(prior.command, 2000),
    '```',
    `exit code: ${prior.exitCode ?? 'not executed'}`,
    stdout.length > 0 ? `stdout:\n\`\`\`\n${stdout}\n\`\`\`` : 'stdout: (empty)',
    stderr.length > 0 ? `stderr:\n\`\`\`\n${stderr}\n\`\`\`` : 'stderr: (empty)',
  ].join('\n')
}

/**
 * Retry prompt for fix-loop attempts ≥2: the original context plus every prior
 * attempt with its REAL executed output, and permission to answer with a short
 * script (the block still executes as one /bin/sh unit).
 */
export function buildRetryFixPrompt(
  input: FixPromptInput,
  priorAttempts: readonly FailedFixAttempt[],
  maxScriptCommands = 5,
): { system: string; user: string } {
  if (priorAttempts.length === 0) {
    throw new Error('trajectory-replay: buildRetryFixPrompt requires at least one prior attempt')
  }
  const system = [
    'You repair one failed shell command from a recorded coding-agent trajectory.',
    'The trajectory replays inside the original docker image; every command runs as a fresh /bin/sh subshell from a fixed working directory.',
    'Earlier corrected commands were executed for real and failed; their actual output is included below.',
    `Reply with a corrected fix inside a single \`\`\`sh fenced block: either one command, or a short script of at most ${maxScriptCommands} commands (one per line).`,
    'The whole block executes as ONE /bin/sh unit from the fixed working directory and must exit 0.',
    'Do not repeat a command that already failed. Keep reasoning brief. No prose outside the fenced block.',
  ].join('\n')
  const user = [
    ...promptBody(input),
    '',
    '## Previous fix attempts (executed for real — all failed)',
    ...priorAttempts.map((prior) => renderFailedAttempt(prior)),
    '',
    `Output a corrected fix now — one \`\`\`sh block, at most ${maxScriptCommands} commands.`,
  ].join('\n')
  return { system, user }
}

/** Non-empty, non-comment lines of a fix script — the loop's script-size cap. */
export function countScriptCommands(script: string): number {
  return script.split('\n').filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
    .length
}

/** Last fenced code block, else the whole trimmed content; null when empty. */
export function extractFixCommand(content: string): string | null {
  const blocks = [...content.matchAll(/```(?:sh|bash|shell)?\n([\s\S]*?)```/g)]
  const candidate = blocks.length > 0 ? blocks[blocks.length - 1]![1]! : content
  const command = candidate.trim()
  if (command.length === 0 || command.includes('```')) return null
  return command
}

export type FixGenerationOutcome =
  | { readonly succeeded: true; readonly value: { command: string; usage: ChatUsage | null } }
  | { readonly succeeded: false; readonly error: string }

export async function generateFixCommand(
  caller: ChatCompletionCaller,
  input: FixPromptInput,
): Promise<FixGenerationOutcome> {
  const { system, user } = buildFixPrompt(input)
  const outcome = await caller.complete(system, user)
  if (!outcome.succeeded) return outcome
  const command = extractFixCommand(outcome.value.content)
  if (command === null) {
    return {
      succeeded: false,
      error: `completion carried no usable command: ${clipText(outcome.value.content, 300)}`,
    }
  }
  return { succeeded: true, value: { command, usage: outcome.value.usage } }
}
