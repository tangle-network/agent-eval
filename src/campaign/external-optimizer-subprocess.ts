import { type ChildProcess, spawn } from 'node:child_process'
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  type ExternalOptimizerRunnerCommand,
  isRecord,
  resolveExternalOptimizerProcessLimits,
} from './external-optimizer-contracts'
import { runWithCleanup } from './external-optimizer-resources'

const PROCESS_TERMINATION_GRACE_MS = 5_000
const PROCESS_TERMINATION_POLL_MS = 25
const PROCESS_KILL_WAIT_MS = 1_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

interface ProcessOutputCapture {
  full: string | undefined
  head: string
  tail: string
  totalChars: number
}

export async function runExternalOptimizerProcess<TOutput>(args: {
  label: string
  tempPrefix: string
  module: string
  input: unknown
  runner?: ExternalOptimizerRunnerCommand
  /** Additional bridge arguments inserted before --input/--output. */
  additionalArgs?: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}): Promise<TOutput> {
  if (
    !Number.isSafeInteger(args.timeoutMs) ||
    args.timeoutMs <= 0 ||
    args.timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(`${args.label} timeoutMs must be between 1 and ${MAX_TIMER_DELAY_MS}`)
  }
  const limits = resolveExternalOptimizerProcessLimits(args.runner?.limits)
  if (process.platform === 'win32') {
    throw new Error(
      `${args.label} requires POSIX process-group cleanup; run the optimizer through WSL or Linux`,
    )
  }
  throwIfAborted(args.signal, args.label)
  const dir = await mkdtemp(join(tmpdir(), args.tempPrefix))
  const inputPath = join(dir, 'input.json')
  const outputPath = join(dir, 'output.json')
  return runWithCleanup({
    label: `${args.label} temporary directory`,
    run: async () => {
      const serializedInput = JSON.stringify(args.input)
      if (serializedInput === undefined) {
        throw new Error(`${args.label} input must be JSON-serializable`)
      }
      const inputJson = `${serializedInput}\n`
      const inputBytes = Buffer.byteLength(inputJson)
      if (inputBytes > limits.maxInputBytes) {
        throw new Error(`${args.label} input exceeds ${limits.maxInputBytes} bytes (${inputBytes})`)
      }
      await writeFile(inputPath, inputJson)
      const command = resolveRunnerCommand(args.runner?.command ?? 'python')
      const commandArgs = [
        ...(args.runner?.args ?? ['-m', args.module]),
        ...(args.additionalArgs ?? []),
        '--input',
        inputPath,
        '--output',
        outputPath,
      ]
      await runProcess({
        label: args.label,
        command,
        args: commandArgs,
        cwd: dir,
        env: args.runner?.env,
        timeoutMs: args.timeoutMs,
        maxOutputChars: limits.maxOutputChars,
        signal: args.signal,
      })
      throwIfAborted(args.signal, args.label)
      const raw = JSON.parse(
        await readBoundedTextFile(outputPath, limits.maxResultBytes, `${args.label} output`),
      ) as unknown
      throwIfAborted(args.signal, args.label)
      if (!isRecord(raw)) throw new Error(`${args.label} output must be a JSON object`)
      return raw as TOutput
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  })
}

function resolveRunnerCommand(command: string): string {
  if (isAbsolute(command) || (!command.includes('/') && !command.includes('\\'))) return command
  return resolve(command)
}

async function readBoundedTextFile(path: string, maxBytes: number, label: string): Promise<string> {
  const entry = await lstat(path)
  if (!entry.isFile()) throw new Error(`${label} must be a regular file`)
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const chunk = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
      if (chunk.bytesRead === 0) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > maxBytes) {
      throw new Error(`${label} exceeds ${maxBytes} bytes`)
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

function runProcess(args: {
  label: string
  command: string
  args: string[]
  cwd: string | undefined
  env: NodeJS.ProcessEnv | undefined
  timeoutMs: number
  maxOutputChars: number
  signal: AbortSignal | undefined
}): Promise<void> {
  throwIfAborted(args.signal, args.label)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      env: { ...safeProcessEnvironment(), ...args.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const stdout = createProcessOutputCapture()
    const stderr = createProcessOutputCapture()
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const onAbort = () => finish(abortReason(args.signal!, args.label))
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      args.signal?.removeEventListener('abort', onAbort)
      void terminateProcessTree(child).then(
        () => {
          if (error) reject(error)
          else resolvePromise()
        },
        (cleanupError: unknown) => {
          if (error) {
            const cleanup =
              cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
            reject(
              new AggregateError(
                [error, cleanup],
                `${error.message}; ${args.label} process cleanup failed: ${cleanup.message}`,
              ),
            )
            return
          }
          reject(
            new Error(
              `${args.label} process cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            ),
          )
        },
      )
    }
    timeout = setTimeout(() => {
      finish(new Error(`${args.label} exceeded ${args.timeoutMs}ms`))
    }, args.timeoutMs)
    args.signal?.addEventListener('abort', onAbort, { once: true })
    if (args.signal?.aborted) onAbort()
    child.stdout.on('data', (chunk: Buffer) => {
      appendProcessOutput(stdout, chunk, args.maxOutputChars)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      appendProcessOutput(stderr, chunk, args.maxOutputChars)
    })
    child.on('error', (error) => {
      finish(new Error(`${args.label} could not start: ${error.message}`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish()
        return
      }
      finish(
        new Error(
          `${args.label} exited ${String(code)}. stderr=${summarizeProcessOutput(stderr)} stdout=${summarizeProcessOutput(stdout)}`,
        ),
      )
    })
  })
}

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw abortReason(signal, label)
}

function abortReason(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} aborted`, { cause: signal.reason })
}

function safeProcessEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'VIRTUAL_ENV',
    'PYTHONPATH',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'WINDIR',
  ] as const
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    throw new Error('native Windows process-tree cleanup is unsupported')
  }

  if (!signalProcessGroup(pid, 'SIGTERM')) return
  if (await waitForProcessGroupExit(pid, PROCESS_TERMINATION_GRACE_MS)) return
  if (!signalProcessGroup(pid, 'SIGKILL')) return
  if (await waitForProcessGroupExit(pid, PROCESS_KILL_WAIT_MS)) return
  throw new Error(`process group ${pid} remained alive after SIGKILL`)
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (isMissingProcessError(error)) return false
    throw error
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid)) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return false
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(PROCESS_TERMINATION_POLL_MS, remainingMs)),
    )
  }
  return true
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (isMissingProcessError(error)) return false
    throw error
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  )
}

function createProcessOutputCapture(): ProcessOutputCapture {
  return { full: '', head: '', tail: '', totalChars: 0 }
}

function appendProcessOutput(
  capture: ProcessOutputCapture,
  chunk: Buffer,
  maxOutputChars: number,
): void {
  const text = chunk.toString()
  capture.totalChars += text.length
  const headChars = Math.floor(maxOutputChars / 2)
  const tailChars = maxOutputChars - headChars
  if (capture.full !== undefined) {
    const combined = `${capture.full}${text}`
    if (combined.length <= maxOutputChars) {
      capture.full = combined
      return
    }
    capture.head = combined.slice(0, headChars)
    capture.tail = combined.slice(-tailChars)
    capture.full = undefined
    return
  }
  capture.tail = `${capture.tail}${text}`.slice(-tailChars)
}

function summarizeProcessOutput(capture: ProcessOutputCapture, max = 4_000): string {
  const raw =
    capture.full ??
    `${capture.head}\n...[${capture.totalChars - capture.head.length - capture.tail.length} chars omitted]...\n${capture.tail}`
  const compact = raw.trim().replace(/\s+/g, ' ')
  if (compact.length <= max) return compact
  const headChars = Math.floor(max / 3)
  const tailChars = max - headChars
  return `${compact.slice(0, headChars)}...[${compact.length - max} chars omitted]...${compact.slice(-tailChars)}`
}
