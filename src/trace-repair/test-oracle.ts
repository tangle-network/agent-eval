/**
 * The held-out suite, injected from outside the box at grade time.
 *
 * A repair is only measurable if the thing that decides pass or fail is out
 * of the trajectory's reach. Terminal-Bench gets that by uploading the suite
 * into the container at grade time, after the agent has stopped; a suite the
 * agent planted is overwritten before it is ever read. `injectedTestOracle`
 * reproduces that property and then proves it per call:
 *
 *   1. purge the suite root, so a planted extra file cannot survive
 *   2. upload every suite file from outside the session
 *   3. read the bytes back from inside and hash them
 *   4. refuse to grade when the read-back digest is not the uploaded digest
 *
 * Step 4 is why the property is asserted rather than assumed. A container
 * that silently drops the upload, or a filesystem trick that serves different
 * bytes to the reader, raises `TestSuiteTamperedError` instead of returning a
 * result. An oracle that cannot prove what it graded reports nothing.
 */

import { createHash } from 'node:crypto'
import { CaptureIntegrityError, ValidationError } from '../errors'
import type {
  RepairExecResult,
  RepairSession,
  TestOracle,
  TestOracleContext,
  TestOracleOutcome,
} from './ports'

/** The suite the oracle read back is not the suite it uploaded. */
export class TestSuiteTamperedError extends CaptureIntegrityError {}

/** The oracle could not place or run the suite, so it graded nothing. */
export class TestOracleError extends CaptureIntegrityError {}

export interface TestSuiteFile {
  /** Absolute path inside the container. */
  readonly path: string
  readonly contents: string
  /** Octal mode applied after upload, e.g. '0755' for a runner script. */
  readonly mode?: string
}

export interface InjectedTestOracleOptions {
  /** Every file of the held-out suite. Uploaded on every grade call. */
  readonly files: readonly TestSuiteFile[]
  /** Command that runs the suite. Exit 0 is the only pass. */
  readonly command: string
  /** Absolute directories removed before upload. A planted file that the
   *  upload does not overwrite dies here. */
  readonly purge?: readonly string[]
  readonly uploadTimeoutMs?: number
  readonly commandTimeoutMs?: number
}

const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000
const DEFAULT_COMMAND_TIMEOUT_MS = 900_000

/**
 * Content digest of the suite: sha256 over each path and its bytes, in path
 * order. Two suites with the same digest are the same suite.
 */
export function testSuiteDigest(files: readonly TestSuiteFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(Buffer.from(file.contents, 'utf8'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function injectedTestOracle(options: InjectedTestOracleOptions): TestOracle {
  assertOracleOptions(options)
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const expectedDigest = testSuiteDigest(options.files)

  return {
    async grade(session: RepairSession, context: TestOracleContext): Promise<TestOracleOutcome> {
      const where = `${context.rowId}/${context.arm}#${context.rolloutIndex}`

      for (const directory of options.purge ?? []) {
        await mustSucceed(
          session,
          `rm -rf ${shellQuote(directory)}`,
          uploadTimeoutMs,
          `purge ${directory} in ${where}`,
        )
      }

      for (const file of options.files) {
        const directory = parentDirectory(file.path)
        if (directory) {
          await mustSucceed(
            session,
            `mkdir -p ${shellQuote(directory)}`,
            uploadTimeoutMs,
            `mkdir ${directory} in ${where}`,
          )
        }
        const payload = Buffer.from(file.contents, 'utf8').toString('base64')
        await mustSucceed(
          session,
          `printf %s ${shellQuote(payload)} | base64 -d > ${shellQuote(file.path)}`,
          uploadTimeoutMs,
          `upload ${file.path} in ${where}`,
        )
        if (file.mode) {
          await mustSucceed(
            session,
            `chmod ${file.mode} ${shellQuote(file.path)}`,
            uploadTimeoutMs,
            `chmod ${file.path} in ${where}`,
          )
        }
      }

      const readBack: TestSuiteFile[] = []
      for (const file of options.files) {
        const result = await mustSucceed(
          session,
          `base64 < ${shellQuote(file.path)} | tr -d '\\n'`,
          uploadTimeoutMs,
          `read back ${file.path} in ${where}`,
        )
        readBack.push({
          path: file.path,
          contents: Buffer.from(result.stdout.trim(), 'base64').toString('utf8'),
        })
      }
      const observedDigest = testSuiteDigest(readBack)
      if (observedDigest !== expectedDigest) {
        throw new TestSuiteTamperedError(
          `test suite in ${where} does not match the suite uploaded from outside ` +
            `(expected ${expectedDigest}, read back ${observedDigest}); the graded result is discarded`,
        )
      }

      const run = await session.exec(options.command, commandTimeoutMs)
      return {
        passed: run.exitCode === 0 && !run.timedOut,
        exitCode: run.exitCode,
        output: `${run.stdout}\n${run.stderr}`.trim(),
        suiteDigest: observedDigest,
        timedOut: run.timedOut,
      }
    },
  }
}

/**
 * Run a setup command that must succeed. A failed upload is an oracle
 * failure, never a failed test: reporting it as a failing suite would turn a
 * broken container into evidence against the intervention.
 */
async function mustSucceed(
  session: RepairSession,
  command: string,
  timeoutMs: number,
  what: string,
): Promise<RepairExecResult> {
  const result = await session.exec(command, timeoutMs)
  if (result.timedOut) {
    throw new TestOracleError(`test oracle timed out while it tried to ${what}`)
  }
  if (result.exitCode !== 0) {
    throw new TestOracleError(
      `test oracle failed to ${what}: exit ${result.exitCode}\n${result.stderr.trim()}`,
    )
  }
  return result
}

function assertOracleOptions(options: InjectedTestOracleOptions): void {
  if (options.files.length === 0) {
    throw new ValidationError('injectedTestOracle requires at least one suite file')
  }
  const seen = new Set<string>()
  for (const file of options.files) {
    if (!file.path.startsWith('/')) {
      throw new ValidationError(`suite file path must be absolute, got "${file.path}"`)
    }
    if (seen.has(file.path)) {
      throw new ValidationError(`suite file ${file.path} is listed twice`)
    }
    seen.add(file.path)
  }
  if (options.command.trim().length === 0) {
    throw new ValidationError('injectedTestOracle requires a suite command')
  }
  for (const directory of options.purge ?? []) {
    if (!directory.startsWith('/') || directory.trim() === '/') {
      throw new ValidationError(
        `purge path must be an absolute directory below the root, got "${directory}"`,
      )
    }
  }
}

function parentDirectory(path: string): string | null {
  const index = path.lastIndexOf('/')
  if (index <= 0) return null
  return path.slice(0, index)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
