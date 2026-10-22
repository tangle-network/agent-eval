/** Hand-off between work that finishes asynchronously and the loop that records it. */

/** Completions in arrival order; one waiter at a time sleeps until one arrives or `wakeUp` fires. */
export class SearchCompletionQueue<T> {
  private readonly items: T[] = []
  private wake: (() => void) | null = null

  /** The next completion, or null when `wakeUp` ended the wait without one. */
  async next(): Promise<T | null> {
    if (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
    return this.items.shift() ?? null
  }

  push(item: T): void {
    this.items.push(item)
    this.wakeUp()
  }

  wakeUp(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}
