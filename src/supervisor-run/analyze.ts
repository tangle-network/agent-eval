/**
 * The pure analyzer. Takes already-read bytes (`SupervisorRunSources`) and
 * returns the report — every metric derivable from a synthetic journal string
 * with no filesystem, no process, and no network. All I/O lives in a reader
 * (`reader.ts` is one).
 */

import { roundDecimal as round } from '../math/round-decimal'
import { analyzeSupervisorEconomics } from './analyze-economics'
import { parsePatch } from './patch-stats'
import {
  parseJson,
  parseSupervisorTree,
  type SpawnRow,
  type WorkerLogFacts,
  workerSourceKey,
} from './source-facts'
import { readTerminalRecord } from './terminal-record'
import {
  type DecisionMetrics,
  isUnavailable,
  type Measured,
  type OrchestrationMetrics,
  type OutcomeMetrics,
  type PatchStats,
  type SteerBreakdown,
  SUPERVISOR_RUN_SCHEMA,
  type SupervisorRunReport,
  type SupervisorRunSources,
  type Unavailable,
  unavailable,
} from './types'

export { roundDecimal as round } from '../math/round-decimal'
export { parsePatch } from './patch-stats'
export { rollupSupervisorRuns } from './rollup'

export {
  asRecord,
  type CloseRow,
  parseJson,
  parseJsonl,
  parseSupervisorTree,
  type SpawnRow,
  type SteerAcknowledgementFact,
  type SteerRequestFact,
  type SupervisorJournalDialect,
  type SupervisorTreeFacts,
  type WorkerLogFacts,
} from './source-facts'

/**
 * Analyze already-read supervisor-run bytes. Pure and synchronous: same bytes
 * in, same report out (modulo `generatedAt`, which `now` pins in tests).
 */
export function analyzeSupervisorRunSources(
  src: SupervisorRunSources,
  now: () => number = Date.now,
): SupervisorRunReport {
  const gaps: string[] = []
  const gap = (what: string, reason: string): Unavailable => {
    gaps.push(`${what}: ${reason}`)
    return unavailable(reason)
  }

  const journalMissing =
    src.journalMissingReason ??
    (src.supRunDir === null ? 'no Runtime supervisor run directory' : 'journal.jsonl absent')
  const haveJournal = src.journal !== null
  const tree = parseSupervisorTree(src)
  const state = tree.state
  const result = parseJson(src.result)
  const judge = parseJson(src.judge)
  // Runtime's terminal record is named on the report so a status never arrives unlabeled.
  const terminal = readTerminalRecord({
    state,
    result,
    failure: src.failure === undefined ? undefined : parseJson(src.failure),
  })
  const { rootId, workerSpawns, workerCloses, startedAt, completedAt } = tree
  const rootSpawn =
    rootId === null ? null : (tree.spawns.find((spawn) => spawn.id === rootId) ?? null)
  const spawnById = new Map(workerSpawns.map((spawn) => [spawn.id, spawn]))
  const spawnsByLabel = new Map<string, SpawnRow[]>()
  for (const spawn of workerSpawns) {
    const matches = spawnsByLabel.get(spawn.label) ?? []
    matches.push(spawn)
    spawnsByLabel.set(spawn.label, matches)
  }
  const spawnsForSource = (
    worker: NonNullable<SupervisorRunSources['workers']>[number],
  ): readonly SpawnRow[] => {
    if (worker.workerId === undefined) return spawnsByLabel.get(worker.label) ?? []
    const spawn = spawnById.get(worker.workerId)
    return spawn === undefined ? [] : [spawn]
  }
  const spawnForSource = (
    worker: NonNullable<SupervisorRunSources['workers']>[number],
  ): SpawnRow | null => {
    const matches = spawnsForSource(worker)
    return matches.length === 1 ? (matches[0] ?? null) : null
  }

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
  const workersGapReason = src.workersMissingReason ?? 'workers/ directory absent'
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

  // ── waves / concurrency / idle ─────────────────────────────────────────
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

  const firstWorkerSpawnAt = workerSpawns.reduce<number | null>(
    (acc, s) => (s.at === null ? acc : acc === null ? s.at : Math.min(acc, s.at)),
    null,
  )
  const closeById = new Map(workerCloses.map((close) => [close.id, close]))
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

  // ── decision quality ───────────────────────────────────────────────────
  const settledByStatus: Record<string, number> = {}
  const settledVerdicts: Record<string, number> = {}
  for (const c of workerCloses) {
    const key = c.status ?? 'unknown'
    settledByStatus[key] = (settledByStatus[key] ?? 0) + 1
    if (c.verdict !== null) settledVerdicts[c.verdict] = (settledVerdicts[c.verdict] ?? 0) + 1
  }

  // A store with no verify step never says pass or fail. Counting its silent
  // workers as `rejected: 0 / accepted: 0` would read as "nothing was accepted".
  const verdictLimit = src.limits.workerVerdicts
  // A store that retains no delivered patch still SETTLES a verdict, and that verdict is
  // the acceptance decision it recorded. Only the split between a green verdict backed by
  // a patch and a green verdict with nothing behind it needs patch bytes, so the
  // deliverables limit takes `emptyPass` and leaves `accepted` measured.
  const deliverablesLimit = src.limits.deliverables
  let accepted = 0
  let emptyPass = 0
  let evidenceBytes = 0
  const sourceVerdicts: boolean[] = []
  for (const w of src.workers ?? []) {
    const f = tree.workerLogs.get(workerSourceKey(w))
    if (f?.finished) evidenceBytes += f.evidenceBytes
    const spawn = spawnForSource(w)
    const close = spawn === null ? null : (closeById.get(spawn.id) ?? null)
    const passed = close?.valid ?? f?.passed ?? null
    if (passed !== null) sourceVerdicts.push(passed)
    if (passed === true) {
      if (deliverablesLimit !== null || (w.patchBytes ?? f?.finishedPatchBytes ?? 0) > 0) {
        accepted += 1
      } else {
        emptyPass += 1
      }
    }
  }
  const settledCloses = workerCloses.filter((close) => close.kind === 'settled')
  const structuredVerdicts = settledCloses
    .map((close) => close.valid)
    .filter((valid): valid is boolean => valid !== null)
  const journalVerdictsComplete =
    settledCloses.length > 0 && structuredVerdicts.length === settledCloses.length
  const sourceVerdictsComplete =
    sourceVerdicts.length > 0 && sourceVerdicts.length >= settledCloses.length
  const rejected = journalVerdictsComplete
    ? structuredVerdicts.filter((valid) => !valid).length
    : sourceVerdictsComplete
      ? sourceVerdicts.filter((valid) => !valid).length
      : 0
  const rejectedLimit =
    journalVerdictsComplete || sourceVerdictsComplete
      ? null
      : settledCloses.length > 0
        ? (verdictLimit ?? 'a settled journal verdict has no validity and no matched worker log')
        : verdictLimit !== null
          ? verdictLimit
          : !haveJournal && src.workers === null
            ? workersGapReason
            : null

  const decision: DecisionMetrics = {
    settledByStatus: haveJournal ? settledByStatus : gap('settledByStatus', journalMissing),
    settledVerdicts:
      verdictLimit !== null
        ? unavailable(verdictLimit)
        : haveJournal
          ? settledVerdicts
          : unavailable(journalMissing),
    accepted:
      verdictLimit !== null
        ? gap('accepted', verdictLimit)
        : src.workers === null
          ? unavailable(workersGapReason)
          : accepted,
    rejected: rejectedLimit === null ? rejected : unavailable(rejectedLimit),
    emptyPass:
      verdictLimit !== null
        ? gap('emptyPass', verdictLimit)
        : deliverablesLimit !== null
          ? gap('emptyPass', deliverablesLimit)
          : src.workers === null
            ? unavailable(workersGapReason)
            : emptyPass,
    observeThenRespawn: haveJournal ? observeThenRespawn : unavailable(journalMissing),
    respawnWithoutEvidence: haveJournal ? respawnWithoutEvidence : unavailable(journalMissing),
    reviewActions:
      src.workers === null
        ? unavailable(workersGapReason)
        : queuedGapReason === null
          ? steerQueuedTotal + upLegMessages
          : unavailable(queuedGapReason),
    workerEvidenceBytes:
      src.workers === null
        ? unavailable(workersGapReason)
        : workerEventsGapReason === null
          ? evidenceBytes
          : unavailable(workerEventsGapReason),
  }

  // ── economics ──────────────────────────────────────────────────────────
  const { economics, stateResult } = analyzeSupervisorEconomics({
    src,
    tree,
    result,
    decision,
    haveJournal,
    journalMissing,
    workersGapReason,
    gaps,
    gap,
    spawnsForSource,
    spawnForSource,
    closeById,
  })

  // ── outcome ────────────────────────────────────────────────────────────
  const patchStats: Measured<PatchStats> =
    src.patch === null
      ? gap('patch', src.limits.deliverables ?? 'delivered patch file absent')
      : parsePatch(src.patch)

  const outcome: OutcomeMetrics = {
    supStatus: isUnavailable(terminal.supStatus)
      ? gap('supStatus', terminal.supStatus.unavailable)
      : terminal.supStatus,
    supStatusSource: terminal.supStatusSource,
    supReason: terminal.supReason,
    failure: terminal.failure,
    supVerdict:
      pickString(state, 'verdict') ??
      pickString(result, 'sup_verdict') ??
      unavailable('no state.json / result.json verdict'),
    delivered:
      typeof stateResult.delivered === 'boolean'
        ? stateResult.delivered
        : typeof result?.delivered === 'boolean'
          ? result.delivered
          : unavailable('no delivered flag in state.json or result.json'),
    judgeResolved:
      judge === null
        ? gap('judge', 'judge.json absent')
        : typeof judge.resolved === 'boolean'
          ? judge.resolved
          : null,
    judgeScore:
      judge === null
        ? unavailable('judge.json absent')
        : typeof judge.score === 'number'
          ? judge.score
          : null,
    judgePassed:
      judge === null
        ? unavailable('judge.json absent')
        : typeof judge.passed === 'number'
          ? judge.passed
          : null,
    judgeTotal:
      judge === null
        ? unavailable('judge.json absent')
        : typeof judge.total === 'number'
          ? judge.total
          : null,
    verifyPass:
      typeof result?.verify_pass === 'boolean'
        ? result.verify_pass
        : gap('verifyPass', 'result.json absent or has no verify_pass'),
    verifyRc:
      typeof result?.verify_rc === 'number'
        ? result.verify_rc
        : unavailable('result.json absent or has no verify_rc'),
    patch: patchStats,
    judgeSource: src.judgeSource,
  }

  return {
    schema: SUPERVISOR_RUN_SCHEMA,
    runRef: src.runRef,
    instanceId: src.instanceId,
    arm: src.arm,
    supervisorId: rootId !== null ? rootId : unavailable(journalMissing),
    supervisorProfileDigest:
      rootSpawn?.profileDigest !== null && rootSpawn?.profileDigest !== undefined
        ? rootSpawn.profileDigest
        : gap('supervisorProfileDigest', 'root spawned event has no profile digest'),
    generatedAt: new Date(now()).toISOString(),
    orchestration,
    decision,
    economics,
    outcome,
    rootWorkspaceCaptures: src.rootWorkspaceCaptures ?? null,
    gaps,
    traceCommand:
      src.traceCommand ??
      'npx --yes @tangle-network/traces@latest analyze --harness opencode --cwd <worker-clone-cwd>',
  }
}

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

function registrationMentions(driverLog: string): number {
  let n = 0
  for (const line of driverLog.split('\n')) {
    if (line.includes('registered tools:') && line.includes('supervisor_steer')) n += 1
  }
  return n
}

function pickString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key]
  return typeof v === 'string' ? v : null
}
