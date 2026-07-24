import type {
  ExternalOptimizerCallback,
  ExternalOptimizerModelProxy,
} from './external-optimizer-contracts'

export async function runWithCleanup<T>(args: {
  label: string
  run: () => Promise<T>
  cleanup: () => Promise<void>
}): Promise<T> {
  let value: T | undefined
  let operationError: Error | undefined
  try {
    value = await args.run()
  } catch (cause) {
    operationError = toError(cause)
  }

  let cleanupError: Error | undefined
  try {
    await args.cleanup()
  } catch (cause) {
    cleanupError = toError(cause)
  }

  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      `${operationError.message}; ${args.label} cleanup failed: ${cleanupError.message}`,
    )
  }
  if (operationError) throw operationError
  if (cleanupError) {
    throw new Error(`${args.label} cleanup failed: ${cleanupError.message}`, {
      cause: cleanupError,
    })
  }
  return value as T
}

export async function closeExternalOptimizerResources(args: {
  label: string
  callback: ExternalOptimizerCallback
  modelProxy?: ExternalOptimizerModelProxy
}): Promise<void> {
  const results = await Promise.allSettled([
    ...(args.modelProxy ? [args.modelProxy.close()] : []),
    args.callback.close(),
  ])
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length > 0) {
    throw new AggregateError(errors, `${args.label}: failed to close optimizer resources`)
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
