import type {
  ExternalOptimizerCallback,
  ExternalOptimizerModelProxy,
} from './external-optimizer-contracts'

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
