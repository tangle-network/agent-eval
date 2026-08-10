/**
 * The execution boundary replay runs across.
 *
 * A replay needs one thing from its environment: a session that runs a shell
 * command inside the trajectory's own image and reports the exit code and
 * output. That is the whole contract. Concrete backends — a sandbox platform
 * client, a docker exec, an SSH shell — live with the consumer that owns the
 * infrastructure, so this package depends on no sandbox client.
 */

export interface ReplayExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ReplayExecSession {
  exec(command: string, timeoutMs: number): Promise<ReplayExecResult>
  close(): Promise<void>
}

export interface ReplayExecBackend {
  /** One fresh execution environment per call; the caller closes it. */
  open(): Promise<ReplayExecSession>
}

/** Builds a backend pinned to one image. Callers that resolve images
 *  internally (batch, corpus wire, finding verification) take this instead of
 *  a backend, so every case runs against its own image. */
export type ReplayExecBackendFactory = (image: string) => ReplayExecBackend

/**
 * mini-SWE runs every action as a fresh /bin/sh subshell from a fixed
 * workdir. Reproduce that exactly — and stay quote-proof for arbitrary
 * recorded actions — by piping the base64 of the action into `sh` after
 * cd-ing to the workdir. Exit code is sh's, i.e. the action's.
 */
export function wrapActionForExec(action: string, cwd: string): string {
  const b64 = Buffer.from(action, 'utf8').toString('base64')
  const quotedCwd = `'${cwd.replaceAll("'", `'\\''`)}'`
  return `cd ${quotedCwd} && printf %s ${b64} | base64 -d | sh`
}
