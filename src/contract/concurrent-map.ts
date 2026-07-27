import { mapConcurrentRange } from '../concurrency'

export interface MapPairedConcurrentOptions<T> {
  count: number
  maxConcurrency: number
  label: string
  signal?: AbortSignal
  map(index: number, arm: 'baseline' | 'candidate', signal: AbortSignal): Promise<T>
}

/** Map both arms while bounding the actual executions, not the number of pairs. */
export async function mapPairedConcurrent<T>(
  options: MapPairedConcurrentOptions<T>,
): Promise<Array<{ baseline: T; candidate: T }>> {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new Error(`${options.label} pair count must be a non-negative integer`)
  }
  if (options.count > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new Error(`${options.label} pair count is too large to schedule both arms`)
  }
  const executions = await mapConcurrentRange({
    count: options.count * 2,
    maxConcurrency: options.maxConcurrency,
    label: options.label,
    ...(options.signal ? { signal: options.signal } : {}),
    map(flatIndex, signal) {
      const index = Math.floor(flatIndex / 2)
      const arm = flatIndex % 2 === 0 ? 'baseline' : 'candidate'
      return options.map(index, arm, signal)
    },
  })

  return Array.from({ length: options.count }, (_, index) => ({
    baseline: executions[index * 2]!,
    candidate: executions[index * 2 + 1]!,
  }))
}
