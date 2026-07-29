export interface SharedAbortableTask<T> {
  controller: AbortController
  promise: Promise<T>
  consumers: number
  settled: boolean
}

export function createSharedAbortableTask<T>(
  factory: (signal: AbortSignal) => Promise<T>,
): SharedAbortableTask<T> {
  const controller = new AbortController()
  const task: SharedAbortableTask<T> = {
    controller,
    promise: factory(controller.signal),
    consumers: 0,
    settled: false,
  }
  void task.promise.then(
    () => {
      task.settled = true
    },
    () => {
      task.settled = true
    },
  )
  return task
}

export function waitForSharedTask<T>(
  task: SharedAbortableTask<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  signal?.throwIfAborted()
  task.consumers += 1

  return new Promise<T>((resolve, reject) => {
    let finished = false
    const finish = (callback: () => void): void => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      task.consumers -= 1
      callback()
    }
    const onAbort = (): void => {
      finish(() => {
        reject(signal?.reason)
        if (!task.settled && task.consumers === 0) {
          task.controller.abort(signal?.reason)
        }
      })
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    task.promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
    if (signal?.aborted) onAbort()
  })
}
