export interface ExecutionLane {
  key: string
  scopeKey: string
  start: number | null
  end: number | null
}

/** Assign lanes to serial tracks without joining concurrent or ambiguously timed work. */
export function executionTrackByLane(lanes: readonly ExecutionLane[]): Map<string, string> {
  const unique = new Map<string, ExecutionLane>()
  for (const lane of lanes) {
    const existing = unique.get(lane.key)
    if (existing && !sameLane(existing, lane)) {
      throw new Error(`execution lane '${lane.key}' has conflicting scope or timing`)
    }
    unique.set(lane.key, lane)
  }

  const trackByLane = new Map<string, string>()
  const lanesByScope = new Map<string, ExecutionLane[]>()
  for (const lane of unique.values()) {
    const scoped = lanesByScope.get(lane.scopeKey) ?? []
    scoped.push(lane)
    lanesByScope.set(lane.scopeKey, scoped)
  }

  for (const [scopeKey, scoped] of lanesByScope) {
    if (scoped.some((lane) => lane.start === null && lane.end === null)) {
      for (const lane of scoped) trackByLane.set(lane.key, trackId('lane', lane.key))
      continue
    }
    const incompleteKeys = new Set<string>()
    const boundarySet = new Set<number>()
    for (const lane of scoped) {
      if (lane.start !== null && lane.end !== null && lane.end > lane.start) continue
      incompleteKeys.add(lane.key)
      const boundary = lane.start ?? lane.end
      if (boundary !== null) boundarySet.add(boundary)
      trackByLane.set(lane.key, trackId('lane', lane.key))
    }
    const boundaries = [...boundarySet].sort((a, b) => a - b)
    const completeBySegment = new Map<number, ExecutionLane[]>()
    for (const lane of scoped) {
      if (incompleteKeys.has(lane.key)) continue
      const segment = upperBound(boundaries, lane.start!)
      const nextBoundary = boundaries[segment]
      if (nextBoundary !== undefined && nextBoundary < lane.end!) {
        trackByLane.set(lane.key, trackId('lane', lane.key))
        continue
      }
      const complete = completeBySegment.get(segment) ?? []
      complete.push(lane)
      completeBySegment.set(segment, complete)
    }

    let serialTrack = 0
    for (const [, segment] of [...completeBySegment].sort(([a], [b]) => a - b)) {
      const ordered = [...segment].sort(
        (a, b) => a.start! - b.start! || a.end! - b.end! || a.key.localeCompare(b.key),
      )
      let component: ExecutionLane[] = []
      let componentEnd = Number.NEGATIVE_INFINITY
      const flush = () => {
        if (component.length === 1) {
          trackByLane.set(component[0]!.key, trackId('serial', scopeKey, serialTrack))
        } else if (component.length > 1) {
          for (const lane of component) trackByLane.set(lane.key, trackId('lane', lane.key))
          serialTrack += 1
        }
        component = []
        componentEnd = Number.NEGATIVE_INFINITY
      }

      for (const lane of ordered) {
        if (component.length > 0 && lane.start! >= componentEnd) flush()
        component.push(lane)
        componentEnd = Math.max(componentEnd, lane.end!)
      }
      flush()
      serialTrack += 1
    }
  }

  return trackByLane
}

function sameLane(a: ExecutionLane, b: ExecutionLane): boolean {
  return a.scopeKey === b.scopeKey && a.start === b.start && a.end === b.end
}

function trackId(kind: string, key: string, index?: number): string {
  return JSON.stringify(index === undefined ? [kind, key] : [kind, key, index])
}

function upperBound(sorted: readonly number[], target: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! <= target) low = middle + 1
    else high = middle
  }
  return low
}
