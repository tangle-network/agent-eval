/** Which nodes are admitted, how many cells each still runs, and which finished their screen. */
import type { SearchStateView } from './search-state'

export class SearchNodeProgress {
  /** Unfinished cells per node. */
  private readonly pending = new Map<string, number>()
  /** Admitted nodes whose screen finished, in registration order. */
  screened: string[] = []
  readonly screenedSet = new Set<string>()
  readonly admitted = new Set<string>()

  constructor(private readonly state: () => SearchStateView) {}

  /** Unfinished cells of a node; zero when none was ever allocated. */
  count(nodeId: string): number {
    return this.pending.get(nodeId) ?? 0
  }

  add(nodeId: string, cells: number): void {
    this.pending.set(nodeId, this.count(nodeId) + cells)
  }

  /** One of the node's cells finished; returns how many remain. */
  release(nodeId: string): number {
    const left = (this.pending.get(nodeId) ?? 1) - 1
    this.pending.set(nodeId, left)
    return left
  }

  /** Admitted and running nothing: ready for the allocator to rank. */
  idle(nodeId: string): boolean {
    return this.admitted.has(nodeId) && this.count(nodeId) === 0
  }

  screening(): number {
    return this.admitted.size - this.screenedSet.size
  }

  markScreened(nodeId: string): void {
    if (this.screenedSet.has(nodeId)) return
    this.screenedSet.add(nodeId)
    const state = this.state()
    const ordinal = state.node(nodeId)!.ordinal
    let index = this.screened.length
    while (index > 0 && state.node(this.screened[index - 1]!)!.ordinal > ordinal) index--
    this.screened = [...this.screened.slice(0, index), nodeId, ...this.screened.slice(index)]
  }
}
