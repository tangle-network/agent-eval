import type {
  ExternalOptimizerCallback,
  ExternalOptimizerModelProxy,
} from './external-optimizer-contracts'

export async function runWithCleanup<T>(args: {
  label: string
  run: () => Promise<T>
  cleanup: () => Promise<void>
}): Promise<T> {
  const [operation] = await Promise.allSettled([Promise.resolve().then(args.run)])
  const [cleanup] = await Promise.allSettled([Promise.resolve().then(args.cleanup)])
  const operationError = operation.status === 'rejected' ? toError(operation.reason) : undefined
  const cleanupError = cleanup.status === 'rejected' ? toError(cleanup.reason) : undefined
  if (operationError && cleanupError)
    throw new AggregateError(
      [operationError, cleanupError],
      `${operationError.message}; ${args.label} cleanup failed: ${cleanupError.message}`,
    )
  if (operation.status === 'rejected') throw operationError
  if (cleanupError)
    throw new Error(`${args.label} cleanup failed: ${cleanupError.message}`, {
      cause: cleanupError,
    })
  return operation.value
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
  if (errors.length)
    throw new AggregateError(errors, `${args.label}: failed to close optimizer resources`)
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
