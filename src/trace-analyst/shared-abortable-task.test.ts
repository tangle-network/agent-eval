import { describe, expect, it } from 'vitest'
import { createSharedAbortableTask, waitForSharedTask } from './shared-abortable-task'

describe('shared abortable task', () => {
  it('lets one caller cancel without stopping another caller', async () => {
    let finish!: (value: string) => void
    let sharedSignal!: AbortSignal
    const task = createSharedAbortableTask(
      (signal) =>
        new Promise<string>((resolve) => {
          sharedSignal = signal
          finish = resolve
        }),
    )
    const first = new AbortController()
    const second = new AbortController()
    const firstRead = waitForSharedTask(task, first.signal)
    const secondRead = waitForSharedTask(task, second.signal)
    const reason = new Error('first caller stopped')

    first.abort(reason)
    await expect(firstRead).rejects.toBe(reason)
    expect(sharedSignal.aborted).toBe(false)

    finish('indexed')
    await expect(secondRead).resolves.toBe('indexed')
  })

  it('cancels shared work after every caller leaves', async () => {
    let sharedSignal!: AbortSignal
    const task = createSharedAbortableTask(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          sharedSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const first = new AbortController()
    const second = new AbortController()
    const firstRead = waitForSharedTask(task, first.signal)
    const secondRead = waitForSharedTask(task, second.signal)
    const firstReason = new Error('first caller stopped')
    const secondReason = new Error('second caller stopped')

    first.abort(firstReason)
    await expect(firstRead).rejects.toBe(firstReason)
    expect(sharedSignal.aborted).toBe(false)

    second.abort(secondReason)
    await expect(secondRead).rejects.toBe(secondReason)
    expect(sharedSignal.aborted).toBe(true)
    expect(sharedSignal.reason).toBe(secondReason)
  })
})
