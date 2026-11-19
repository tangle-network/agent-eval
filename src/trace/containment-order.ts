/**
 * Containment order: the one traversal that turns a flat list of spans into a
 * depth-first walk of their parent tree. `buildTrajectory` and
 * `diffStepsFromSpans` both order through it, each with its own comparator.
 *
 * Every input item is returned exactly once, with its depth. A root is an item
 * that names no parent, or names a parent id no input item has; roots are
 * ordered by `compare`, and so are the children of each parent. Items whose
 * ancestry loops without reaching a root are walked after every root: each one
 * not yet visited, in `compare` order, starts a subtree of its own. Ties in
 * `compare` keep input order.
 *
 * Containment order is not time order. A depth-first walk lists a whole branch
 * before its next sibling, so when branches run in parallel an item late in the
 * list can have started before an item early in it.
 */

/** Why an item sits at depth 0 although it names a parent. */
export type DetachedCause =
  /** No input item has the parent id. */
  | 'absent'
  /** The parent is present, but its ancestry loops back without reaching a root. */
  | 'cycle'

export interface ContainmentEntry<T> {
  item: T
  /** 0 for a root; one more than the parent's depth otherwise. */
  depth: number
  /** Set only on an item placed at depth 0 although it names a parent. */
  detached?: DetachedCause
}

export interface ContainmentKeys<T> {
  id: (item: T) => string
  /** The parent id; null, undefined and the empty string all mean no parent. */
  parentId: (item: T) => string | null | undefined
  compare: (a: T, b: T) => number
}

export function containmentOrder<T>(
  items: readonly T[],
  keys: ContainmentKeys<T>,
): ContainmentEntry<T>[] {
  const ids = new Set(items.map(keys.id))
  const roots: number[] = []
  const absent = new Set<number>()
  const children = new Map<string, number[]>()
  items.forEach((item, i) => {
    const parent = keys.parentId(item)
    if (parent === null || parent === undefined || parent === '') {
      roots.push(i)
    } else if (!ids.has(parent)) {
      roots.push(i)
      absent.add(i)
    } else {
      const list = children.get(parent)
      if (list) list.push(i)
      else children.set(parent, [i])
    }
  })
  const byKey = (x: number, y: number) => keys.compare(items[x]!, items[y]!) || x - y
  roots.sort(byKey)
  for (const list of children.values()) list.sort(byKey)

  const ordered: ContainmentEntry<T>[] = []
  const visited = new Array<boolean>(items.length).fill(false)
  // An explicit stack, so a deep trace cannot exhaust the call stack.
  const walk = (start: number, detached: DetachedCause | undefined) => {
    const stack: Array<{ index: number; depth: number }> = [{ index: start, depth: 0 }]
    while (stack.length > 0) {
      const { index, depth } = stack.pop()!
      if (visited[index]) continue
      visited[index] = true
      const item = items[index]!
      ordered.push(depth === 0 && detached ? { item, depth, detached } : { item, depth })
      const kids = children.get(keys.id(item)) ?? []
      for (let k = kids.length - 1; k >= 0; k -= 1) {
        if (!visited[kids[k]!]) stack.push({ index: kids[k]!, depth: depth + 1 })
      }
    }
  }
  for (const root of roots) walk(root, absent.has(root) ? 'absent' : undefined)
  const rest = items.map((_, i) => i).filter((i) => !visited[i])
  for (const index of rest.sort(byKey)) walk(index, 'cycle')
  return ordered
}
