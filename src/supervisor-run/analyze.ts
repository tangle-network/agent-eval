/**
 * The pure analyzer. Takes already-read bytes (`SupervisorRunSources`) and
 * returns the report — every metric derivable from a synthetic journal string
 * with no filesystem, no process, and no network. All I/O lives in a reader
 * (`loops-reader.ts` is one).
 */

import {
  asRecord,
  parseJson,
  parseJsonl,
  parseSupervisorTree,
  type SpawnRow,
  type WorkerLogFacts,
  workerSourceKey,
} from './source-facts'
import {
  type DecisionMetrics,
  type EconomicsMetrics,
  isUnavailable,
  type Measured,
  type OrchestrationMetrics,
  type OutcomeMetrics,
  type PatchStats,
  type PerWorkerRow,
  type RollupCellRow,
  type SteerBreakdown,
  SUPERVISOR_RUN_ROLLUP_SCHEMA,
  SUPERVISOR_RUN_SCHEMA,
  type SupervisorRunReport,
  type SupervisorRunRollup,
  type SupervisorRunSources,
  type Unavailable,
  unavailable,
} from './types'

export {
  asRecord,
  type CloseRow,
  parseJson,
  parseJsonl,
  parseSupervisorTree,
  type SpawnRow,
  type SteerAcknowledgementFact,
  type SteerRequestFact,
  type SupervisorTreeFacts,
  type WorkerLogFacts,
} from './source-facts'

const NO_CACHE_COUNTERS = 'the journal carries no cache-token counters for this role'

// ---------------------------------------------------------------------------
// The analyzer.
// ---------------------------------------------------------------------------

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
    src.supRunDir === null
      ? 'no supervisor run dir under <ws>/.loops/supervisor'
      : 'journal.jsonl absent'
  const haveJournal = src.journal !== null
  const tree = parseSupervisorTree(src)
  const state = tree.state
  const result = parseJson(src.result)
  const judge = parseJson(src.judge)
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

  const supervisorWallMs: Measured<number> =
    startedAt !== null && completedAt !== null && completedAt >= startedAt
      ? completedAt - startedAt
      : !haveJournal
        ? gap('supervisorWallMs', journalMissing)
        : gap('supervisorWallMs', 'no parseable start/complete timestamps in state.json or journal')

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
  if (prev !== null && completedAt !== null && completedAt >= prev) {
    const span = completedAt - prev
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
  const acceptedLimit = verdictLimit ?? src.limits.deliverables
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
      if ((w.patchBytes ?? f?.finishedPatchBytes ?? 0) > 0) accepted += 1
      else emptyPass += 1
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
      acceptedLimit !== null
        ? gap('accepted', acceptedLimit)
        : src.workers === null
          ? unavailable(workersGapReason)
          : accepted,
    rejected: rejectedLimit === null ? rejected : unavailable(rejectedLimit),
    emptyPass:
      acceptedLimit !== null
        ? gap('emptyPass', acceptedLimit)
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
  const rootChildIds = new Set(
    workerSpawns.filter((spawn) => spawn.parent === rootId).map((spawn) => spawn.id),
  )
  const rootChildCloses = workerCloses.filter((close) => rootChildIds.has(close.id))
  const journalWorkerIn = rootChildCloses.reduce((a, c) => a + c.spend.tokens.input, 0)
  const journalWorkerOut = rootChildCloses.reduce((a, c) => a + c.spend.tokens.output, 0)
  const journalWorkerUsd = rootChildCloses.reduce((a, c) => a + c.spend.usd, 0)
  const workerUsdById = new Map<string, number>()
  for (const c of workerCloses) {
    workerUsdById.set(c.id, (workerUsdById.get(c.id) ?? 0) + c.spend.usd)
  }
  const labelById = new Map(workerSpawns.map((spawn) => [spawn.id, spawn.label]))
  const workerUsdByLabel = new Map<string, number>()
  for (const close of workerCloses) {
    const label = labelById.get(close.id)
    if (label === undefined) continue
    workerUsdByLabel.set(label, (workerUsdByLabel.get(label) ?? 0) + close.spend.usd)
  }
  const sq = src.harnessWorkerTokens
  const harnessGapReason =
    src.harnessMissingReason ?? 'harness session store unavailable and journal settled spend is 0'
  const workerTokenLimit = src.limits.workerTokens
  const workerIn: Measured<number> =
    workerTokenLimit !== null
      ? gap('workers.tokensIn', workerTokenLimit)
      : sq !== null
        ? journalWorkerIn + sq.input
        : haveJournal
          ? journalWorkerIn
          : gap('workers.tokensIn', harnessGapReason)
  const workerOut: Measured<number> =
    workerTokenLimit !== null
      ? unavailable(workerTokenLimit)
      : sq !== null
        ? journalWorkerOut + sq.output
        : haveJournal
          ? journalWorkerOut
          : unavailable(harnessGapReason)

  const stateResult = asRecord(state?.result)
  const stateUsd = typeof stateResult.spentUsd === 'number' ? stateResult.spentUsd : null
  // A store that logs tokens but never a price yields usd 0 from every sum. That
  // 0 is the store's silence, not a free run, so the limit outranks the sum.
  const usdLimit = src.limits.spendUsd
  const totalUsd: Measured<number> =
    usdLimit !== null
      ? gap('totalUsd', usdLimit)
      : stateUsd !== null
        ? round(stateUsd, 6)
        : haveJournal
          ? round(tree.brain.usd + journalWorkerUsd, 6)
          : gap('totalUsd', journalMissing)

  const perWorker: PerWorkerRow[] = (src.workers ?? []).map((w) => {
    const f = tree.workerLogs.get(workerSourceKey(w))
    const matchingSpawns = spawnsForSource(w)
    const spawn = spawnForSource(w)
    const close = spawn === null ? null : (closeById.get(spawn.id) ?? null)
    const passed = close?.valid ?? f?.passed ?? null
    const matchingRoles = new Set(matchingSpawns.map((candidate) => candidate.role))
    const matchingRuntimes = new Set(matchingSpawns.map((candidate) => candidate.runtime))
    const matchingProfiles = new Set(matchingSpawns.map((candidate) => candidate.profileDigest))
    const journalWallMs =
      spawn?.at !== null &&
      spawn?.at !== undefined &&
      close?.at !== null &&
      close?.at !== undefined &&
      close.at >= spawn.at
        ? close.at - spawn.at
        : null
    return {
      workerId: w.workerId ?? null,
      worker: w.label,
      role: matchingRoles.size === 1 ? (matchingSpawns[0]?.role ?? null) : null,
      runtime: matchingRuntimes.size === 1 ? (matchingSpawns[0]?.runtime ?? null) : null,
      profileDigest:
        matchingProfiles.size === 1 ? (matchingSpawns[0]?.profileDigest ?? null) : null,
      status: close?.status ?? null,
      failure: close?.reason ?? null,
      infra: close?.infra ?? null,
      wallMs: f?.started != null && f.finishedAt != null ? f.finishedAt - f.started : journalWallMs,
      tokensIn: w.tokensIn ?? (close?.hasSpend ? close.spend.tokens.input : null),
      tokensOut: w.tokensOut ?? (close?.hasSpend ? close.spend.tokens.output : null),
      usd:
        usdLimit !== null
          ? null
          : w.workerId === undefined
            ? (workerUsdByLabel.get(w.label) ?? null)
            : (workerUsdById.get(w.workerId) ?? null),
      patchBytes: w.patchBytes ?? f?.finishedPatchBytes ?? null,
      passed,
      score: close?.score ?? f?.score ?? null,
    }
  })
  const walls = perWorker
    .map((w) => w.wallMs)
    .filter((w): w is number => w !== null)
    .sort((a, b) => a - b)

  const brainCalls = parseJsonl(src.brainLog)
  const managerTokenLimit = src.limits.managerTokens
  const economics: EconomicsMetrics = {
    brain: {
      tokensIn:
        managerTokenLimit !== null
          ? gap('brain.tokensIn', managerTokenLimit)
          : haveJournal
            ? tree.brain.tokensIn
            : gap('brain.tokensIn', journalMissing),
      tokensOut:
        managerTokenLimit !== null
          ? unavailable(managerTokenLimit)
          : haveJournal
            ? tree.brain.tokensOut
            : unavailable(journalMissing),
      usd:
        usdLimit !== null
          ? unavailable(usdLimit)
          : haveJournal
            ? round(tree.brain.usd, 6)
            : unavailable(journalMissing),
      cacheRead:
        managerTokenLimit !== null
          ? unavailable(managerTokenLimit)
          : !haveJournal
            ? unavailable(journalMissing)
            : tree.brain.hasCache
              ? tree.brain.cacheRead
              : unavailable(NO_CACHE_COUNTERS),
      cacheWrite:
        managerTokenLimit !== null
          ? unavailable(managerTokenLimit)
          : !haveJournal
            ? unavailable(journalMissing)
            : tree.brain.hasCache
              ? tree.brain.cacheWrite
              : unavailable(NO_CACHE_COUNTERS),
      source:
        managerTokenLimit ??
        (haveJournal ? `journal metered events (n=${tree.brain.meteredCount})` : journalMissing),
    },
    brainTruncations:
      src.brainLog === null
        ? gap(
            'brain.brainTruncations',
            src.brainLogMissingReason ??
              (src.supRunDir === null
                ? 'no supervisor run dir under <ws>/.loops/supervisor'
                : 'brain.jsonl absent — loops predates the brain-call tap, so truncation cannot be ruled out'),
          )
        : brainCalls.filter((c) => c.finish_reason === 'length').length,
    workers: {
      tokensIn: workerIn,
      tokensOut: workerOut,
      cacheRead:
        workerTokenLimit !== null
          ? unavailable(workerTokenLimit)
          : sq?.cacheRead !== undefined
            ? sq.cacheRead
            : unavailable(NO_CACHE_COUNTERS),
      cacheWrite:
        workerTokenLimit !== null
          ? unavailable(workerTokenLimit)
          : sq?.cacheWrite !== undefined
            ? sq.cacheWrite
            : unavailable(NO_CACHE_COUNTERS),
      usd:
        usdLimit !== null
          ? unavailable(usdLimit)
          : haveJournal
            ? round(journalWorkerUsd, 6)
            : unavailable(journalMissing),
      source:
        workerTokenLimit !== null
          ? workerTokenLimit
          : sq !== null
            ? `journal settled spend + ${sq.store} sessions (n=${sq.sessions})`
            : `journal settled spend only — ${src.harnessMissingReason ?? 'harness session store unavailable'}`,
    },
    totalUsd,
    totalUsdSource:
      usdLimit !== null
        ? usdLimit
        : stateUsd !== null
          ? `state.json result.spentUsd${rootChildCloses.length > 0 && journalWorkerUsd === 0 ? ' — brain-priced only; worker CLI inference is unpriced (see worker token counts)' : ''}`
          : haveJournal
            ? 'journal metered + settled usd'
            : journalMissing,
    costPerAcceptedPatchUsd: isUnavailable(totalUsd)
      ? unavailable(totalUsd.unavailable)
      : isUnavailable(decision.accepted)
        ? unavailable(decision.accepted.unavailable)
        : decision.accepted === 0
          ? unavailable('no accepted worker patch (cost has no denominator)')
          : round(totalUsd / decision.accepted, 6),
    workerWallMsDistribution:
      walls.length === 0
        ? unavailable(
            src.workers === null ? workersGapReason : 'no worker start/finish pairs captured',
          )
        : {
            n: walls.length,
            min: walls[0] as number,
            p50: quantile(walls, 0.5),
            p90: quantile(walls, 0.9),
            max: walls[walls.length - 1] as number,
            sum: walls.reduce((a, b) => a + b, 0),
          },
    perWorker: src.workers === null ? unavailable(workersGapReason) : perWorker,
  }

  // ── outcome ────────────────────────────────────────────────────────────
  const patchStats: Measured<PatchStats> =
    src.patch === null
      ? gap('patch', src.limits.deliverables ?? 'delivered patch file absent')
      : parsePatch(src.patch)

  const outcome: OutcomeMetrics = {
    supStatus:
      pickString(state, 'status') ??
      pickString(result, 'sup_status') ??
      gap('supStatus', 'no state.json / result.json status'),
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
    gaps,
    traceCommand:
      src.traceCommand ??
      'npx --yes @tangle-network/traces@latest analyze --harness opencode --cwd <worker-clone-cwd>',
  }
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

function pickString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key]
  return typeof v === 'string' ? v : null
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx] as number
}

/** Unified-diff stats. Counts `+++ b/<path>` targets, body +/- lines, and test-file touches. */
export function parsePatch(text: string): PatchStats {
  const files = new Set<string>()
  const testFiles = new Set<string>()
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim().replace(/^b\//, '')
      if (p !== '/dev/null') {
        files.add(p)
        if (isTestPath(p)) testFiles.add(p)
      }
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ')) {
      continue
    }
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return {
    files: files.size,
    linesAdded: added,
    linesRemoved: removed,
    testFilesTouched: [...testFiles].sort(),
  }
}

function isTestPath(p: string): boolean {
  const base = p.split('/').pop() ?? p
  return (
    /(^|\/)(tests?|__tests__|testing|spec)(\/|$)/.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base)
  )
}

// ---------------------------------------------------------------------------
// Rollup across runs.
// ---------------------------------------------------------------------------

/**
 * Aggregate many supervisor-run reports. A metric no run could measure stays
 * `unavailable` rather than becoming a 0-valued mean, and cells whose steer
 * count was unavailable are counted separately from cells that measured zero.
 */
export function rollupSupervisorRuns(reports: readonly SupervisorRunReport[]): SupervisorRunRollup {
  const known = <T>(vals: readonly Measured<T>[]): T[] =>
    vals.filter((v): v is T => !isUnavailable(v))
  const steerVals = known(reports.map((r) => r.orchestration.steers))
  const waveVals = known(reports.map((r) => r.orchestration.waves))
  const concVals = known(reports.map((r) => r.orchestration.maxConcurrency))
  const utilVals = known(reports.map((r) => r.orchestration.workerUtilization))
  const idleVals = known(reports.map((r) => r.orchestration.idlePct))
  const spawnVals = known(reports.map((r) => r.orchestration.workersSpawned))
  const acceptVals = known(reports.map((r) => r.decision.accepted))
  const usdVals = known(reports.map((r) => r.economics.totalUsd))
  const resolvedVals = known(reports.map((r) => r.outcome.judgeResolved))
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)
  const mean = (xs: readonly number[]): Measured<number> =>
    xs.length === 0 ? unavailable('no cell reported this metric') : round(sum(xs) / xs.length, 3)

  const perCell: RollupCellRow[] = reports.map((r) => ({
    instanceId: r.instanceId,
    arm: r.arm,
    steers: r.orchestration.steers,
    waves: r.orchestration.waves,
    utilization: r.orchestration.workerUtilization,
    idlePct: r.orchestration.idlePct,
    resolved: r.outcome.judgeResolved,
    usd: r.economics.totalUsd,
  }))

  return {
    schema: SUPERVISOR_RUN_ROLLUP_SCHEMA,
    cells: reports.length,
    steersTotal:
      steerVals.length === 0 ? unavailable('no cell reported a steer count') : sum(steerVals),
    cellsWithSteers:
      steerVals.length === 0
        ? unavailable('no cell reported a steer count')
        : steerVals.filter((n) => n > 0).length,
    cellsWithUnavailableSteers: reports.filter((r) => isUnavailable(r.orchestration.steers)).length,
    wavesMean: mean(waveVals),
    maxConcurrencyMax:
      concVals.length === 0 ? unavailable('no cell reported concurrency') : Math.max(...concVals),
    utilizationMean: mean(utilVals),
    idlePctMean: mean(idleVals),
    workersSpawnedTotal:
      spawnVals.length === 0 ? unavailable('no cell reported spawns') : sum(spawnVals),
    acceptedTotal:
      acceptVals.length === 0 ? unavailable('no cell reported acceptance') : sum(acceptVals),
    usdTotal: usdVals.length === 0 ? unavailable('no cell reported spend') : round(sum(usdVals), 6),
    resolvedCount:
      resolvedVals.length === 0
        ? unavailable('no cell reported a judge verdict')
        : resolvedVals.filter((v) => v === true).length,
    perCell,
  }
}
