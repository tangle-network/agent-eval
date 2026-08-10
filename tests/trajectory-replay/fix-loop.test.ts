import { describe, expect, it } from 'vitest'
import {
  buildFixPrompt,
  buildRetryFixPrompt,
  type ChatCompletionCaller,
  countScriptCommands,
} from '../../src/trajectory-replay/fix'
import { type FixArmExecution, runFixLoop } from '../../src/trajectory-replay/fix-loop'
import { fixtureStep } from './fixtures'

const steps = () => [
  fixtureStep(1, 'ls', 0, 'files'),
  fixtureStep(2, 'sed -i broken file.c', 0),
  fixtureStep(3, 'make target', 2, 'file.c:9:2: error: broken build\nstopped'),
  fixtureStep(4, 'echo done', 0),
]

const input = () => ({ taskStatement: 'Fix the build.', steps: steps(), k: 3 })

function fenced(command: string): string {
  return `\`\`\`sh\n${command}\n\`\`\``
}

/** Caller that replies with the queued contents in order and records prompts. */
function queuedCaller(replies: readonly ({ content: string } | { error: string })[]): {
  caller: ChatCompletionCaller
  prompts: { system: string; user: string }[]
} {
  const prompts: { system: string; user: string }[] = []
  let call = 0
  return {
    prompts,
    caller: {
      complete: async (system, user) => {
        prompts.push({ system, user })
        const reply = replies[call++]
        if (!reply) throw new Error(`caller exhausted after ${call - 1} replies`)
        if ('error' in reply) return { succeeded: false, error: reply.error }
        return {
          succeeded: true,
          value: { content: reply.content, usage: { promptTokens: 10, completionTokens: 5 } },
        }
      },
    },
  }
}

/** Executor that fails until `flipOn`, recording every command and attempt. */
function scriptedExecutor(flipOn: (command: string, attempt: number) => boolean) {
  const executions: { command: string; attempt: number }[] = []
  const executor = async (command: string, attempt: number): Promise<FixArmExecution> => {
    executions.push({ command, attempt })
    if (flipOn(command, attempt)) {
      return {
        exitCode: 0,
        prefixExecuted: 2,
        prefixDivergences: 0,
        failureVanished: true,
        stdout: 'built ok',
        stderr: '',
      }
    }
    return {
      exitCode: 2,
      prefixExecuted: 2,
      prefixDivergences: 0,
      failureVanished: false,
      stdout: 'stopped',
      stderr: 'file.c:9:2: error: broken build',
    }
  }
  return { executor, executions }
}

describe('countScriptCommands', () => {
  it('counts non-empty non-comment lines', () => {
    expect(countScriptCommands('make -j2')).toBe(1)
    expect(countScriptCommands('# fix\nsed -i x f\n\nmake target\n')).toBe(2)
    expect(countScriptCommands('a\nb\nc\nd\ne\nf')).toBe(6)
  })
})

describe('buildRetryFixPrompt', () => {
  it('carries the failed command, its real output, and the script allowance', () => {
    const { system, user } = buildRetryFixPrompt(input(), [
      {
        attempt: 1,
        command: 'make -j2 target',
        exitCode: 2,
        stdoutTail: 'stopped',
        stderrTail: 'file.c:9:2: error: broken build',
        llmError: null,
      },
    ])
    expect(system).toContain('at most 5 commands')
    expect(system).toContain('ONE /bin/sh unit')
    expect(user).toContain('## Previous fix attempts')
    expect(user).toContain('make -j2 target')
    expect(user).toContain('exit code: 2')
    expect(user).toContain('file.c:9:2: error: broken build')
    expect(user).toContain('Fix the build.')
    expect(user).toContain('step 3 (INCORRECT — correct this one)')
  })

  it('renders a model-call failure as an attempt without a command', () => {
    const { user } = buildRetryFixPrompt(input(), [
      {
        attempt: 1,
        command: null,
        exitCode: null,
        stdoutTail: null,
        stderrTail: null,
        llmError: 'This operation was aborted',
      },
    ])
    expect(user).toContain(
      'model call failed before producing a command: This operation was aborted',
    )
  })

  it('requires at least one prior attempt', () => {
    expect(() => buildRetryFixPrompt(input(), [])).toThrow(/prior attempt/)
  })
})

describe('runFixLoop', () => {
  it('degenerates to one-shot when attempt 1 flips: one call, one arm, one-shot prompt', async () => {
    const { caller, prompts } = queuedCaller([{ content: fenced('fix file.c && make target') }])
    const { executor, executions } = scriptedExecutor(() => true)
    const result = await runFixLoop(caller, input(), executor, { maxAttempts: 3 })
    expect(result).toMatchObject({
      flipped: true,
      flippedAtAttempt: 1,
      aborted: false,
      llmCalls: 1,
      llmFailures: 0,
      promptTokens: 10,
      completionTokens: 5,
    })
    expect(result.attempts).toHaveLength(1)
    expect(executions).toEqual([{ command: 'fix file.c && make target', attempt: 1 }])
    // Attempt 1 must be byte-identical to the one-shot prompt.
    expect(prompts[0]).toEqual(buildFixPrompt(input()))
  })

  it('flips on attempt 3 and feeds each failure back into the next prompt', async () => {
    const { caller, prompts } = queuedCaller([
      { content: fenced('fix-v1 && make target') },
      { content: fenced('fix-v2 && make target') },
      { content: fenced('fix-v3 && make target') },
    ])
    const { executor, executions } = scriptedExecutor((command) => command.startsWith('fix-v3'))
    const result = await runFixLoop(caller, input(), executor, { maxAttempts: 3 })
    expect(result).toMatchObject({
      flipped: true,
      flippedAtAttempt: 3,
      llmCalls: 3,
      llmFailures: 0,
    })
    expect(result.attempts.map((a) => a.executed)).toEqual([true, true, true])
    expect(executions.map((e) => e.attempt)).toEqual([1, 2, 3])
    // Attempt 2 sees attempt 1's command and real output; attempt 3 sees both.
    expect(prompts[1]!.user).toContain('fix-v1 && make target')
    expect(prompts[1]!.user).toContain('file.c:9:2: error: broken build')
    expect(prompts[2]!.user).toContain('fix-v1 && make target')
    expect(prompts[2]!.user).toContain('fix-v2 && make target')
    expect(result.promptTokens).toBe(30)
    expect(result.completionTokens).toBe(15)
  })

  it('exhausts the attempt budget without a flip', async () => {
    const { caller } = queuedCaller([
      { content: fenced('fix-v1') },
      { content: fenced('fix-v2') },
      { content: fenced('fix-v3') },
    ])
    const { executor, executions } = scriptedExecutor(() => false)
    const result = await runFixLoop(caller, input(), executor, { maxAttempts: 3 })
    expect(result).toMatchObject({ flipped: false, flippedAtAttempt: null, aborted: false })
    expect(result.attempts).toHaveLength(3)
    expect(executions).toHaveLength(3)
    expect(result.attempts.every((a) => a.failureVanished === false)).toBe(true)
  })

  it('retries after a model-call failure and can flip on the retry', async () => {
    const { caller, prompts } = queuedCaller([
      { error: 'This operation was aborted' },
      { content: fenced('fix file.c && make target') },
    ])
    const { executor } = scriptedExecutor(() => true)
    const result = await runFixLoop(caller, input(), executor, { maxAttempts: 3 })
    expect(result).toMatchObject({
      flipped: true,
      flippedAtAttempt: 2,
      llmCalls: 2,
      llmFailures: 1,
    })
    expect(result.attempts[0]).toMatchObject({
      executed: false,
      llmError: 'This operation was aborted',
      command: null,
    })
    expect(prompts[1]!.user).toContain('model call failed before producing a command')
  })

  it('executes a retry script as one arm and rejects scripts over the cap', async () => {
    const script = 'apt-get install -y jq\nsed -i x file.c\nmake target'
    const tooLong = 'a\nb\nc\nd\ne\nf'
    const { caller } = queuedCaller([
      { content: fenced('fix-v1') },
      { content: fenced(tooLong) },
      { content: fenced(script) },
    ])
    const { executor, executions } = scriptedExecutor((command) => command === script)
    const result = await runFixLoop(caller, input(), executor, { maxAttempts: 3 })
    expect(result).toMatchObject({ flipped: true, flippedAtAttempt: 3, llmFailures: 1 })
    expect(result.attempts[1]).toMatchObject({
      executed: false,
      llmError: 'script exceeds 5 command lines (6)',
    })
    // The whole script arrives at the executor as ONE arm.
    expect(executions).toEqual([
      { command: 'fix-v1', attempt: 1 },
      { command: script, attempt: 3 },
    ])
  })

  it('does not enforce the script cap on attempt 1 (one-shot parity)', async () => {
    const sixLines = 'a\nb\nc\nd\ne\nf'
    const { caller } = queuedCaller([{ content: fenced(sixLines) }])
    const { executor, executions } = scriptedExecutor(() => true)
    const result = await runFixLoop(caller, input(), executor, { maxAttempts: 1 })
    expect(result.flipped).toBe(true)
    expect(executions).toEqual([{ command: sixLines, attempt: 1 }])
  })

  it('aborts on a sandbox error and records it on the attempt', async () => {
    const { caller } = queuedCaller([{ content: fenced('fix-v1') }])
    const executor = async () => {
      throw new Error('sandbox create timed out')
    }
    const result = await runFixLoop(caller, input(), executor, { maxAttempts: 3 })
    expect(result).toMatchObject({ flipped: false, aborted: true, llmCalls: 1 })
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]).toMatchObject({
      executed: false,
      command: 'fix-v1',
      armBError: 'sandbox create timed out',
      llmError: null,
    })
  })

  it('rejects a non-positive attempt budget', async () => {
    const { caller } = queuedCaller([])
    const { executor } = scriptedExecutor(() => true)
    await expect(runFixLoop(caller, input(), executor, { maxAttempts: 0 })).rejects.toThrow(
      /maxAttempts/,
    )
  })
})
