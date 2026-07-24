import {
  type ExternalOptimizerRunnerCommand,
  removeCredentialEnvironment,
} from './external-optimizer-process'

export function externalOptimizerRunnerIdentity(
  runner: ExternalOptimizerRunnerCommand | undefined,
  module: string,
): {
  command: string
  args: readonly string[]
  environment: Readonly<Record<string, string>>
} {
  return {
    command: runner?.command ?? 'python',
    args: [...(runner?.args ?? ['-m', module])],
    environment: removeCredentialEnvironment(runner?.env ?? {}),
  }
}

export function snapshotExternalOptimizerRunner(
  runner: ExternalOptimizerRunnerCommand | undefined,
): ExternalOptimizerRunnerCommand | undefined {
  if (!runner) return undefined
  return {
    ...runner,
    ...(runner.args ? { args: [...runner.args] } : {}),
    ...(runner.env ? { env: { ...runner.env } } : {}),
  }
}

export function snapshotJson<T>(value: T, label: string): T {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error(`${label} must be JSON-serializable`)
  return JSON.parse(serialized) as T
}
