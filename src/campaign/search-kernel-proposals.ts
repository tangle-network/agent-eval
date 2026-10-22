/** The one proposal in flight and the proposals that have completed. */

export class SearchProposalSlot {
  /** The running proposal, or null when none runs. */
  running: Promise<void> | null = null
  private controller: AbortController | null = null
  /** Operations started: the next one's id. */
  started = 0
  /** Proposals that completed, by operation index. A proposal an interrupted
   * process lost counts toward none of the stop rules, so a resumed search
   * makes the proposals the uninterrupted one would have made. */
  readonly completed: number[] = []

  begin(running: Promise<void>, controller: AbortController): void {
    this.running = running
    this.controller = controller
  }

  end(): void {
    this.running = null
    this.controller = null
  }

  abort(reason: unknown): void {
    this.controller?.abort(reason)
  }

  /** Completed proposals made after the given expansion. */
  completedAfter(expansion: number): number {
    return this.completed.filter((index) => index > expansion).length
  }
}
