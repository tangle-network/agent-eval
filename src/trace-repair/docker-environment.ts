/**
 * Docker-backed continuation environment.
 *
 * The runner refuses any container whose network mode is not `none`, so this
 * builds containers that way and reports the mode it reads back from the
 * daemon rather than the mode it asked for. A container created elsewhere and
 * attached here is described the same way, so an environment that quietly kept
 * its network is rejected instead of producing evidence.
 *
 * Commands are bounded twice. `timeout` inside the container is the primary
 * bound, because killing the host-side `docker exec` client leaves the process
 * it started running in the container, where it would keep writing files under
 * later steps. The host-side kill is a backstop for a daemon that stops
 * answering. The container must therefore provide `timeout`; `describe()`
 * checks for it and refuses the container when it is absent.
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { ValidationError } from '../errors'
import type { ContinuationEnvironment, ContinuationExecResult } from './continuation-policy'
import type { ContinuationEnvironmentDescription } from './continuation-records'

export interface ProcessRequest {
  argv: string[]
  /** Kills the process group when exceeded. */
  timeoutSeconds?: number
}

export interface ProcessResult {
  /** stdout and stderr interleaved, as the scaffold reads them. */
  output: string
  exitCode: number
  /** True when the process was killed for exceeding `timeoutSeconds`. */
  timedOut: boolean
}

/** Runs a process on the host. Injected so the environment is testable without a daemon. */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>

/**
 * Spawns a process, merges stdout and stderr the way the scaffold reads them,
 * and kills the whole process group on timeout so a killed command leaves no
 * children running in the container's namespace.
 */
export const nodeProcessRunner: ProcessRunner = (request) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const [command, ...args] = request.argv
    if (!command) {
      reject(new ValidationError('process runner requires a command'))
      return
    }
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: string[] = []
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => chunks.push(chunk))
    child.stderr.on('data', (chunk: string) => chunks.push(chunk))

    const timer =
      request.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            if (child.pid === undefined) return
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch (error) {
              // ESRCH means the group exited between the deadline and this
              // signal, and `close` resolves the promise. Any other failure
              // means the process may still be running, so surface it.
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error)
            }
          }, request.timeoutSeconds * 1000)

    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      const output = chunks.join('')
      if (code !== null) {
        resolve({ output, exitCode: code, timedOut })
        return
      }
      // A signalled exit carries no code. Report the negative signal number,
      // which is how the corpus records a killed command.
      const signalNumber = signal === null ? undefined : constants.signals[signal]
      if (signalNumber === undefined) {
        reject(
          new ValidationError(`process closed with no exit code and no known signal: ${signal}`),
        )
        return
      }
      resolve({ output, exitCode: -signalNumber, timedOut })
    })
  })

export interface DockerContinuationEnvironmentOptions {
  /** Container id or name holding the post-step-k state. */
  containerRef: string
  /** Working directory for every command. */
  cwd: string
  /** Environment variables set on every command. */
  env?: Record<string, string>
  /** Interpreter the scaffold runs commands through. */
  interpreter?: string[]
  /** `docker` unless a compatible client is used. */
  executable?: string
  runProcess: ProcessRunner
  /** Removes the container on dispose. Leave false when the caller owns its lifecycle. */
  removeOnDispose?: boolean
}

const DEFAULT_INTERPRETER = ['bash', '-lc']
const DEFAULT_EXECUTABLE = 'docker'

/** Seconds `timeout` waits after SIGTERM before sending SIGKILL. */
const KILL_GRACE_SECONDS = 5

/** Extra seconds the host-side backstop waits after the in-container bound. */
const BACKSTOP_SECONDS = 10

/** `timeout` reports this when it stopped the command. */
const TIMEOUT_EXIT_CODE = 124

/**
 * Arguments that create a container the policy accepts. `--network none` is
 * not optional: a continuation with network access could install what the
 * recorded run could not, and the arms would no longer differ only by the
 * intervention.
 */
export function dockerRunArgs(input: {
  image: string
  name: string
  cwd: string
  containerLifetime?: string
  executable?: string
}): string[] {
  return [
    input.executable ?? DEFAULT_EXECUTABLE,
    'run',
    '-d',
    '--name',
    input.name,
    '--network',
    'none',
    '-w',
    input.cwd,
    '--rm',
    input.image,
    'sleep',
    input.containerLifetime ?? '2h',
  ]
}

export function createDockerContinuationEnvironment(
  options: DockerContinuationEnvironmentOptions,
): ContinuationEnvironment {
  if (!options.containerRef.trim()) {
    throw new ValidationError('docker continuation environment requires a container reference')
  }
  const executable = options.executable ?? DEFAULT_EXECUTABLE
  const interpreter = options.interpreter ?? DEFAULT_INTERPRETER
  const envEntries = Object.entries(options.env ?? {})

  return {
    containerRef: options.containerRef,

    async describe(): Promise<ContinuationEnvironmentDescription> {
      const inspect = await options.runProcess({
        argv: [
          executable,
          'inspect',
          '--format',
          '{{.HostConfig.NetworkMode}}\t{{.Config.Image}}',
          options.containerRef,
        ],
      })
      if (inspect.exitCode !== 0) {
        throw new ValidationError(
          `docker inspect failed for ${options.containerRef} (exit ${inspect.exitCode}): ${inspect.output.trim()}`,
        )
      }
      const [networkMode, image] = inspect.output.trim().split('\t')
      if (!networkMode) {
        throw new ValidationError(
          `docker inspect returned no network mode for ${options.containerRef}`,
        )
      }
      const hasTimeout = await options.runProcess({
        argv: [executable, 'exec', options.containerRef, ...interpreter, 'command -v timeout'],
      })
      if (hasTimeout.exitCode !== 0) {
        throw new ValidationError(
          `container ${options.containerRef} provides no \`timeout\`, so a long command cannot be bounded inside it`,
        )
      }
      return image ? { networkMode, image } : { networkMode }
    },

    async exec(
      command: string,
      execOptions: { timeoutSeconds: number },
    ): Promise<ContinuationExecResult> {
      const argv = [executable, 'exec', '-w', options.cwd]
      for (const [key, value] of envEntries) argv.push('-e', `${key}=${value}`)
      argv.push(
        options.containerRef,
        'timeout',
        `--kill-after=${KILL_GRACE_SECONDS}s`,
        `${execOptions.timeoutSeconds}s`,
        ...interpreter,
        command,
      )
      const result = await options.runProcess({
        argv,
        // Backstop only: it fires after the in-container bound plus its grace.
        timeoutSeconds: execOptions.timeoutSeconds + KILL_GRACE_SECONDS + BACKSTOP_SECONDS,
      })
      // `timeout` exits 124 when it stopped the command. A command that exits
      // 124 on its own is reported the same way, which overstates timeouts
      // rather than hiding them.
      const timedOut = result.timedOut || result.exitCode === TIMEOUT_EXIT_CODE
      return {
        output: result.output,
        returncode: result.exitCode,
        timedOut,
      }
    },

    async dispose(): Promise<void> {
      if (!options.removeOnDispose) return
      await options.runProcess({ argv: [executable, 'rm', '-f', options.containerRef] })
    },
  }
}
