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
  const completeByScope = new Map<string, ExecutionLane[]>()
  for (const lane of unique.values()) {
    if (lane.start === null || lane.end === null || lane.end <= lane.start) {
      trackByLane.set(lane.key, trackId('lane', lane.key))
      continue
    }
    const scoped = completeByScope.get(lane.scopeKey) ?? []
    scoped.push(lane)
    completeByScope.set(lane.scopeKey, scoped)
  }

  for (const [scopeKey, scoped] of completeByScope) {
    const ordered = [...scoped].sort(
      (a, b) => a.start! - b.start! || a.end! - b.end! || a.key.localeCompare(b.key),
    )
    let componentStart = 0
    let componentEnd = Number.NEGATIVE_INFINITY
    let serialTrack = 0
    const flush = (end: number) => {
      const component = ordered.slice(componentStart, end)
      if (component.length === 1) {
        trackByLane.set(component[0]!.key, trackId('serial', scopeKey, serialTrack))
        return
      }
      for (const lane of component) trackByLane.set(lane.key, trackId('lane', lane.key))
      serialTrack += 1
    }

    for (let index = 0; index < ordered.length; index += 1) {
      const lane = ordered[index]!
      if (index > componentStart && lane.start! >= componentEnd) {
        flush(index)
        componentStart = index
        componentEnd = Number.NEGATIVE_INFINITY
      }
      componentEnd = Math.max(componentEnd, lane.end!)
    }
    flush(ordered.length)
  }

  return trackByLane
}

function sameLane(a: ExecutionLane, b: ExecutionLane): boolean {
  return a.scopeKey === b.scopeKey && a.start === b.start && a.end === b.end
}

function trackId(kind: string, key: string, index?: number): string {
  return JSON.stringify(index === undefined ? [kind, key] : [kind, key, index])
}
