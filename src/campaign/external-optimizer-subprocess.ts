import { type ChildProcess, spawn } from 'node:child_process'
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ExternalOptimizerRunnerCommand, isRecord } from './external-optimizer-contracts'

const MAX_PROCESS_OUTPUT_CHARS = 64_000
const MAX_PROCESS_INPUT_BYTES = 64 * 1024 * 1024
const MAX_PROCESS_RESULT_BYTES = 4 * 1024 * 1024
const PROCESS_TERMINATION_GRACE_MS = 5_000
const PROCESS_OUTPUT_HEAD_CHARS = MAX_PROCESS_OUTPUT_CHARS / 2
const PROCESS_OUTPUT_TAIL_CHARS = MAX_PROCESS_OUTPUT_CHARS - PROCESS_OUTPUT_HEAD_CHARS

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
  timeoutMs: number
}): Promise<TOutput> {
  const dir = await mkdtemp(join(tmpdir(), args.tempPrefix))
  const inputPath = join(dir, 'input.json')
  const outputPath = join(dir, 'output.json')
  try {
    const serializedInput = JSON.stringify(args.input)
    if (serializedInput === undefined) {
      throw new Error(`${args.label} input must be JSON-serializable`)
    }
    const inputJson = `${serializedInput}\n`
    const inputBytes = Buffer.byteLength(inputJson)
    if (inputBytes > MAX_PROCESS_INPUT_BYTES) {
      throw new Error(
        `${args.label} input exceeds ${MAX_PROCESS_INPUT_BYTES} bytes (${inputBytes})`,
      )
    }
    await writeFile(inputPath, inputJson)
    const command = args.runner?.command ?? 'python'
    const commandArgs = [
      ...(args.runner?.args ?? ['-m', args.module]),
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
    })
    const raw = JSON.parse(
      await readBoundedTextFile(outputPath, MAX_PROCESS_RESULT_BYTES, `${args.label} output`),
    ) as unknown
    if (!isRecord(raw)) throw new Error(`${args.label} output must be a JSON object`)
    return raw as TOutput
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
}): Promise<void> {
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
    let timedOut = false
    let timeout: NodeJS.Timeout | undefined
    let terminationGrace: NodeJS.Timeout | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (terminationGrace) clearTimeout(terminationGrace)
      if (error) reject(error)
      else resolvePromise()
    }
    timeout = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child, 'SIGTERM')
      terminationGrace = setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL')
        finish(new Error(`${args.label} exceeded ${args.timeoutMs}ms`))
      }, PROCESS_TERMINATION_GRACE_MS)
    }, args.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      appendProcessOutput(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      appendProcessOutput(stderr, chunk)
    })
    child.on('error', (error) => {
      finish(new Error(`${args.label} could not start: ${error.message}`))
    })
    child.on('close', (code) => {
      if (timedOut) {
        if (!terminationGrace) {
          finish(new Error(`${args.label} exceeded ${args.timeoutMs}ms`))
        }
        return
      }
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

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (!isMissingProcessError(error)) {
        child.kill(signal)
        return
      }
    }
    child.kill(signal)
    return
  }

  const taskkill = spawn(
    'taskkill',
    ['/pid', String(child.pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  taskkill.on('error', () => child.kill(signal))
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

function appendProcessOutput(capture: ProcessOutputCapture, chunk: Buffer): void {
  const text = chunk.toString()
  capture.totalChars += text.length
  if (capture.full !== undefined) {
    const combined = `${capture.full}${text}`
    if (combined.length <= MAX_PROCESS_OUTPUT_CHARS) {
      capture.full = combined
      return
    }
    capture.head = combined.slice(0, PROCESS_OUTPUT_HEAD_CHARS)
    capture.tail = combined.slice(-PROCESS_OUTPUT_TAIL_CHARS)
    capture.full = undefined
    return
  }
  capture.tail = `${capture.tail}${text}`.slice(-PROCESS_OUTPUT_TAIL_CHARS)
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
