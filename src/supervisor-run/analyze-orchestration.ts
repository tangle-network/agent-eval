import { roundDecimal as round } from '../math/round-decimal'
import type { Analysis } from './analyze-context'
import { type SpawnRow, type WorkerLogFacts, workerSourceKey } from './source-facts'
import {
  isUnavailable,
  type Measured,
  type OrchestrationMetrics,
  type SteerBreakdown,
  unavailable,
} from './types'

/** Supervisor wall time and where it ends. Explicit stamps win; the journal span is a lower bound; an inverted stamp pair stays unavailable. */
export function measureWall(a: Analysis) {
  const { gap, journalMissing, haveJournal, tree, startedAt, completedAt } = a
  // Wall provenance: explicit stamps when the store wrote both; otherwise the
  // journal event span (a lower bound) when there is no completion stamp at
  // all. A present-but-inverted stamp pair is corruption, not absence, and
  // stays unavailable.
  const wallSpanStart = startedAt ?? tree.firstEventAt
  const wallSpanEnd = tree.lastEventAt
  let supervisorWallMs: Measured<number>
  let supervisorWallSource: Measured<'stamps' | 'journal-span'>
  if (startedAt !== null && completedAt !== null && completedAt >= startedAt) {
    supervisorWallMs = completedAt - startedAt
    supervisorWallSource = 'stamps'
  } else if (
    completedAt === null &&
    wallSpanStart !== null &&
    wallSpanEnd !== null &&
    wallSpanEnd >= wallSpanStart
  ) {
    supervisorWallMs = wallSpanEnd - wallSpanStart
    supervisorWallSource = 'journal-span'
  } else {
    const reason = !haveJournal
      ? journalMissing
      : 'no parseable start/complete timestamps in state.json or journal'
    supervisorWallMs = gap('supervisorWallMs', reason)
    supervisorWallSource = unavailable(reason)
  }
  // Where the measured wall ends — the completion stamp, or the last stamped
  // journal event on the journal-span path. Idle and utilization integrate to
  // this bound so their denominator is the wall they are reported against.
  const wallEndAt = completedAt ?? (supervisorWallSource === 'journal-span' ? wallSpanEnd : null)
  return { supervisorWallMs, supervisorWallSource, wallEndAt }
}

/** Steer counts from worker inboxes and the driver log. */
export function measureSteers(a: Analysis) {
  const { src, gap, tree, workersGapReason } = a
  // ── steers (worker inbox + control events) ─────────────────────────────
  const steerRows: SteerBreakdown[] = []
  let steerQueuedTotal = 0
  let steerDeliveredTotal = 0
  let upLegMessages = 0
  if (src.workers !== null) {
    for (const w of src.workers) {
      const facts = tree.workerLogs.get(workerSourceKey(w))
      const queued = facts?.steersQueued ?? null
      const delivered = facts?.steersDelivered ?? null
      upLegMessages += facts?.questions ?? 0
      if (queued !== null && delivered !== null) {
        steerRows.push({ workerId: w.workerId ?? null, worker: w.label, queued, delivered })
      }
      if (queued !== null) steerQueuedTotal += queued
      if (delivered !== null) steerDeliveredTotal += delivered
    }
  }
  const unavailableReasons = (pick: (facts: WorkerLogFacts) => string | null): string | null => {
    const reasons = tree.workerLogRows
      .map((facts) => pick(facts))
      .filter((reason): reason is string => reason !== null)
    return reasons.length === 0
      ? null
      : `exact steer accounting unavailable for ${reasons.length} worker row(s): ${[...new Set(reasons)].join(' | ')}`
  }
  const queuedGapReason = unavailableReasons((facts) => facts.steersQueuedUnavailable)
  const deliveredGapReason = unavailableReasons((facts) => facts.steersDeliveredUnavailable)
  const workerEventsGapReason = unavailableReasons((facts) =>
    !facts.eventsCaptured
      ? 'events absent'
      : facts.eventsInvalidRows > 0
        ? 'events contain malformed rows'
        : null,
  )
  const steers: Measured<number> =
    src.workers === null
      ? gap('steers', workersGapReason)
      : queuedGapReason === null
        ? steerQueuedTotal
        : gap('steers', queuedGapReason)
  const steersDelivered: Measured<number> =
    src.workers === null
      ? unavailable(workersGapReason)
      : deliveredGapReason === null
        ? steerDeliveredTotal
        : unavailable(deliveredGapReason)
  const steersByWorker: Measured<readonly SteerBreakdown[]> =
    src.workers === null
      ? unavailable(workersGapReason)
      : queuedGapReason === null && deliveredGapReason === null
        ? steerRows
        : unavailable(queuedGapReason ?? deliveredGapReason ?? workersGapReason)

  // The `[driver] registered tools: …supervisor_steer…` banner names the verb without
  // invoking it, so banner lines are subtracted from the raw mention count.
  const driverSteerCalls: Measured<number> =
    src.driverLog === null
      ? gap('driverSteerCalls', 'driver.log absent')
      : Math.max(
          0,
          (src.driverLog.match(/supervisor_steer/g) ?? []).length -
            registrationMentions(src.driverLog),
        )
  return {
    steers,
    steersDelivered,
    steersByWorker,
    driverSteerCalls,
    steerQueuedTotal,
    upLegMessages,
    queuedGapReason,
    workerEventsGapReason,
  }
}

/** Waves, peak concurrency, idle time and summed worker wall from the spawn/close timeline. */
export function measureConcurrency(a: Analysis, wallEndAt: number | null) {
  const { workerSpawns, workerCloses, startedAt } = a
  const timeline: { at: number; delta: 1 | -1 }[] = []
  for (const s of workerSpawns) if (s.at !== null) timeline.push({ at: s.at, delta: 1 })
  for (const c of workerCloses) if (c.at !== null) timeline.push({ at: c.at, delta: -1 })
  timeline.sort((a, b) => a.at - b.at || a.delta - b.delta)

  let waves = 0
  const waveSizes: number[] = []
  let closedSinceWaveStart = true
  for (const step of timeline) {
    if (step.delta === 1) {
      if (closedSinceWaveStart) {
        waves += 1
        waveSizes.push(0)
        closedSinceWaveStart = false
      }
      waveSizes[waveSizes.length - 1] = (waveSizes[waveSizes.length - 1] ?? 0) + 1
    } else {
      closedSinceWaveStart = true
    }
  }

  let live = 0
  let maxConcurrency = 0
  let idleMs = 0
  let sumWorkerWallMs = 0
  let prev = startedAt
  for (const step of timeline) {
    if (prev !== null && step.at >= prev) {
      const span = step.at - prev
      if (live === 0) idleMs += span
      sumWorkerWallMs += span * live
    }
    live += step.delta
    if (live > maxConcurrency) maxConcurrency = live
    prev = step.at
  }
  if (prev !== null && wallEndAt !== null && wallEndAt >= prev) {
    const span = wallEndAt - prev
    if (live === 0) idleMs += span
    sumWorkerWallMs += span * live
  }
  return { waves, waveSizes, maxConcurrency, idleMs, sumWorkerWallMs }
}

/** Respawn counts per parent, split by whether a sibling closed in between. */
export function measureRespawns(a: Analysis) {
  const { workerSpawns, closeById } = a
  const childSpawnsByParent = new Map<string, SpawnRow[]>()
  for (const spawn of workerSpawns) {
    if (spawn.parent === null) continue
    const siblings = childSpawnsByParent.get(spawn.parent) ?? []
    siblings.push(spawn)
    childSpawnsByParent.set(spawn.parent, siblings)
  }

  let respawns = 0
  let observeThenRespawn = 0
  let respawnWithoutEvidence = 0
  const repeatedLabelSet = new Set<string>()
  for (const siblings of childSpawnsByParent.values()) {
    const labelCounts = new Map<string, number>()
    for (const spawn of siblings) {
      labelCounts.set(spawn.label, (labelCounts.get(spawn.label) ?? 0) + 1)
    }
    for (const [label, count] of labelCounts) {
      if (count > 1) repeatedLabelSet.add(label)
    }

    const orderedSpawns = siblings
      .map((spawn, index) => ({ spawn, index }))
      .filter(
        (row): row is { spawn: SpawnRow & { at: number }; index: number } => row.spawn.at !== null,
      )
      .sort((a, b) => a.spawn.at - b.spawn.at || a.index - b.index)
    const directCloseTimes = siblings
      .map((spawn) => closeById.get(spawn.id)?.at ?? null)
      .filter((at): at is number => at !== null)
      .sort((a, b) => a - b)
    const firstDirectClose = directCloseTimes[0] ?? null

    for (let i = 1; i < orderedSpawns.length; i += 1) {
      const previous = orderedSpawns[i - 1]?.spawn.at
      const current = orderedSpawns[i]?.spawn.at
      if (previous === undefined || current === undefined) continue
      if (firstDirectClose === null || current <= firstDirectClose) continue
      respawns += 1
      const sawEvidence = hasNumberBetween(directCloseTimes, previous, current)
      if (sawEvidence) observeThenRespawn += 1
      else respawnWithoutEvidence += 1
    }
  }
  const repeatedLabels = [...repeatedLabelSet]
  return { respawns, observeThenRespawn, respawnWithoutEvidence, repeatedLabels }
}

/** The deepest chain of spawns below the root. */
export function measureDelegationDepth(a: Analysis) {
  const { tree, rootId, workerSpawns } = a
  const parentOf = new Map(tree.spawns.map((s) => [s.id, s.parent]))
  let delegationDepth = 0
  for (const s of workerSpawns) {
    let d = 0
    let cur: string | null = s.id
    const seen = new Set<string>()
    while (cur !== null && cur !== rootId && !seen.has(cur)) {
      seen.add(cur)
      d += 1
      cur = parentOf.get(cur) ?? null
    }
    if (d > delegationDepth) delegationDepth = d
  }
  return delegationDepth
}

export function buildOrchestration(a: Analysis, m: StepFacts): OrchestrationMetrics {
  const { gap, journalMissing, haveJournal, workerSpawns, workerCloses, startedAt } = a
  const {
    supervisorWallMs,
    supervisorWallSource,
    steers,
    steersDelivered,
    steersByWorker,
    driverSteerCalls,
    waves,
    waveSizes,
    maxConcurrency,
    idleMs,
    sumWorkerWallMs,
    respawns,
    repeatedLabels,
    delegationDepth,
  } = m
  const firstWorkerSpawnAt = workerSpawns.reduce<number | null>(
    (acc, s) => (s.at === null ? acc : acc === null ? s.at : Math.min(acc, s.at)),
    null,
  )

  const orchestration: OrchestrationMetrics = {
    workersSpawned: haveJournal ? workerSpawns.length : gap('workersSpawned', journalMissing),
    workersSettled: haveJournal
      ? workerCloses.filter((c) => c.kind === 'settled').length
      : unavailable(journalMissing),
    workersCancelled: haveJournal
      ? workerCloses.filter((c) => c.kind === 'cancelled').length
      : unavailable(journalMissing),
    steers,
    steersDelivered,
    steersByWorker,
    driverSteerCalls,
    waves: haveJournal ? waves : unavailable(journalMissing),
    waveSizes: haveJournal ? waveSizes : unavailable(journalMissing),
    maxConcurrency: haveJournal ? maxConcurrency : unavailable(journalMissing),
    respawns: haveJournal ? respawns : unavailable(journalMissing),
    repeatedLabels: haveJournal ? repeatedLabels : unavailable(journalMissing),
    delegationDepth: haveJournal ? delegationDepth : unavailable(journalMissing),
    timeToFirstSpawnMs:
      startedAt !== null && firstWorkerSpawnAt !== null
        ? firstWorkerSpawnAt - startedAt
        : haveJournal
          ? unavailable('no worker spawn timestamps')
          : unavailable(journalMissing),
    supervisorWallMs,
    supervisorWallSource,
    idleMs: isUnavailable(supervisorWallMs) ? unavailable(supervisorWallMs.unavailable) : idleMs,
    idlePct:
      isUnavailable(supervisorWallMs) || supervisorWallMs === 0
        ? isUnavailable(supervisorWallMs)
          ? unavailable(supervisorWallMs.unavailable)
          : unavailable('supervisor wall is 0ms')
        : round((idleMs / supervisorWallMs) * 100, 1),
    workerUtilization:
      isUnavailable(supervisorWallMs) || supervisorWallMs === 0
        ? isUnavailable(supervisorWallMs)
          ? unavailable(supervisorWallMs.unavailable)
          : unavailable('supervisor wall is 0ms')
        : round(sumWorkerWallMs / supervisorWallMs, 3),
  }
  return orchestration
}

/** Whether sorted values contain one value in the inclusive interval. */
function hasNumberBetween(sorted: readonly number[], low: number, high: number): boolean {
  let left = 0
  let right = sorted.length
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2)
    if ((sorted[middle] as number) < low) left = middle + 1
    else right = middle
  }
  return left < sorted.length && (sorted[left] as number) <= high
}

/** `[driver] registered tools: …supervisor_steer…` is a banner, not an invocation. */
function registrationMentions(driverLog: string): number {
  let n = 0
  for (const line of driverLog.split('\n')) {
    if (line.includes('registered tools:') && line.includes('supervisor_steer')) n += 1
  }
  return n
}

export type StepFacts = ReturnType<typeof measureWall> &
  ReturnType<typeof measureSteers> &
  ReturnType<typeof measureConcurrency> &
  ReturnType<typeof measureRespawns> & { delegationDepth: number }
