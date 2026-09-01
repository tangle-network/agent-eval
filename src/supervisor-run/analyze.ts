/**
 * The pure analyzer. Takes already-read bytes (`SupervisorRunSources`) and
 * returns the report — every metric derivable from a synthetic journal string
 * with no filesystem, no process, and no network. All I/O lives in a reader
 * (`loops-reader.ts` is one).
 */

import { summarizeNumberSeries } from '../statistics'
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
  type SpendMeasurements,
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
  type SupervisorJournalDialect,
  type SupervisorTreeFacts,
  type WorkerLogFacts,
} from './source-facts'

const NO_CACHE_COUNTERS = 'the journal carries no cache-token counters for this role'
const NO_CACHE_BREAKDOWN =
  'Runtime recorded cacheBreakdownKnown:false — the provider reported a total without splitting cache reads from writes'

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
    src.journalMissingReason ??
    (src.supRunDir === null
      ? 'no supervisor run dir under <ws>/.agent/supervisor (or legacy <ws>/.loops/supervisor)'
      : 'journal.jsonl absent')
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
  const rootChildIds = new Set(
    workerSpawns.filter((spawn) => spawn.parent === rootId).map((spawn) => spawn.id),
  )
  const rootChildCloses = workerCloses.filter((close) => rootChildIds.has(close.id))
  // Runtime marks a spend record `usdKnown: false` / `tokensKnown: false` when the work
  // HAPPENED but no provider receipt covered its price or its tokens. Folding such a record
  // in prices unreported work at zero; dropping the whole channel discards every record that
  // DID report. So each channel sums only the reporting records and names the rest.
  const rootChildSpends = rootChildCloses.filter((close) => close.hasSpend)
  const workerUsdUnknownNodes = rootChildSpends
    .filter((close) => !close.spend.usdKnown)
    .map((close) => close.id)
  const workerTokensUnknownNodes = rootChildSpends
    .filter((close) => !close.spend.tokensKnown)
    .map((close) => close.id)
  const workerTokenSpends = rootChildSpends.filter((close) => close.spend.tokensKnown)
  const journalWorkerIn = workerTokenSpends.reduce((a, c) => a + c.spend.tokens.input, 0)
  const journalWorkerOut = workerTokenSpends.reduce((a, c) => a + c.spend.tokens.output, 0)
  const journalWorkerUsd = rootChildSpends
    .filter((close) => close.spend.usdKnown)
    .reduce((a, c) => a + c.spend.usd, 0)
  const usdUnknownIds = new Set(
    workerCloses.filter((close) => close.hasSpend && !close.spend.usdKnown).map((c) => c.id),
  )
  const workerUsdById = new Map<string, number>()
  for (const c of workerCloses) {
    if (usdUnknownIds.has(c.id)) continue
    workerUsdById.set(c.id, (workerUsdById.get(c.id) ?? 0) + c.spend.usd)
  }
  const labelById = new Map(workerSpawns.map((spawn) => [spawn.id, spawn.label]))
  const usdUnknownLabels = new Set(
    [...usdUnknownIds].map((id) => labelById.get(id)).filter((l): l is string => l !== undefined),
  )
  const workerUsdByLabel = new Map<string, number>()
  for (const close of workerCloses) {
    const label = labelById.get(close.id)
    if (label === undefined || usdUnknownLabels.has(label)) continue
    workerUsdByLabel.set(label, (workerUsdByLabel.get(label) ?? 0) + close.spend.usd)
  }
  const brainUsdUnknownNodes =
    tree.brain.usdUnknownCount > 0 && rootId !== null ? ([rootId] as const) : []
  const brainTokensUnknownNodes =
    tree.brain.tokensUnknownCount > 0 && rootId !== null ? ([rootId] as const) : []
  const usdKnownRecords =
    tree.brain.usdKnownCount + rootChildSpends.filter((close) => close.spend.usdKnown).length
  const usdUnknownRecords = tree.brain.usdUnknownCount + workerUsdUnknownNodes.length
  const usdUnknownNodes = [...brainUsdUnknownNodes, ...workerUsdUnknownNodes]
  // The named nodes are what makes the gap actionable, but a fleet run can have hundreds,
  // and this string lands in a report line. Name the first few and count the rest.
  const NAMED_NODE_LIMIT = 5
  const nameNodes = (nodes: readonly string[]): string => {
    if (nodes.length === 0) return ''
    const shown = nodes.slice(0, NAMED_NODE_LIMIT)
    const rest = nodes.length - shown.length
    return ` (${shown.join(', ')}${rest === 0 ? '' : ` +${rest} more`})`
  }
  const unpriced = (unknown: number, total: number, nodes: readonly string[]): string =>
    `Runtime recorded usdKnown:false on ${unknown} of ${total} spend record(s)${nameNodes(nodes)}`
  // A token total is a bare `Measured<number>` with no record denominator beside it, so a
  // partial sum there would be an unlabelled floor — the exact collapse this module refuses.
  // Spend has `SpendMeasurement.records`/`unknownRecords` to carry the split, so it stays
  // partial; tokens go absent with the unreporting nodes named.
  const unreportedTokens = (unknown: number, total: number, nodes: readonly string[]): string =>
    `Runtime recorded tokensKnown:false on ${unknown} of ${total} spend record(s)${nameNodes(nodes)}`
  const usdPartial = usdKnownRecords > 0 && usdUnknownRecords > 0
  const usdAllUnknown = usdKnownRecords === 0 && usdUnknownRecords > 0
  // A role whose records are ALL unreported has nothing measured to report, so it stays
  // unavailable. A role with some of each keeps its sum and labels it in `source`.
  const brainTokensUnreported =
    tree.brain.tokensUnknownCount === 0
      ? null
      : unreportedTokens(
          tree.brain.tokensUnknownCount,
          tree.brain.meteredCount,
          brainTokensUnknownNodes,
        )
  const brainUsdUnreported =
    tree.brain.usdKnownCount > 0 || tree.brain.usdUnknownCount === 0
      ? null
      : unpriced(tree.brain.usdUnknownCount, tree.brain.meteredCount, brainUsdUnknownNodes)
  const workerUsdUnreported =
    workerUsdUnknownNodes.length === 0 || workerUsdUnknownNodes.length < rootChildSpends.length
      ? null
      : unpriced(workerUsdUnknownNodes.length, rootChildSpends.length, workerUsdUnknownNodes)
  const sq = src.harnessWorkerTokens
  const harnessGapReason =
    src.harnessMissingReason ?? 'harness session store unavailable and journal settled spend is 0'
  const workerTokenLimit = src.limits.workerTokens
  const workerTokensUnreported =
    workerTokensUnknownNodes.length === 0
      ? null
      : unreportedTokens(
          workerTokensUnknownNodes.length,
          rootChildSpends.length,
          workerTokensUnknownNodes,
        )
  const workerIn: Measured<number> =
    workerTokenLimit !== null
      ? gap('workers.tokensIn', workerTokenLimit)
      : workerTokensUnreported !== null
        ? gap('workers.tokensIn', workerTokensUnreported)
        : sq !== null
          ? journalWorkerIn + sq.input
          : haveJournal
            ? journalWorkerIn
            : gap('workers.tokensIn', harnessGapReason)
  const workerOut: Measured<number> =
    workerTokenLimit !== null
      ? unavailable(workerTokenLimit)
      : workerTokensUnreported !== null
        ? unavailable(workerTokensUnreported)
        : sq !== null
          ? journalWorkerOut + sq.output
          : haveJournal
            ? journalWorkerOut
            : unavailable(harnessGapReason)

  const stateResult = asRecord(state?.result)
  const stateUsd = typeof stateResult.spentUsd === 'number' ? stateResult.spentUsd : null
  const resultSpentTotal = asRecord(result?.spentTotal)
  const resultCloseUsd =
    typeof resultSpentTotal.usd === 'number' && Number.isFinite(resultSpentTotal.usd)
      ? resultSpentTotal.usd
      : null
  // The close record: what the store wrote as settled when the run closed.
  const closeUsd = stateUsd ?? resultCloseUsd
  // A store that logs tokens but never a price yields usd 0 from every sum. That
  // 0 is the store's silence, not a free run, so the limit outranks the sum.
  const usdLimit = src.limits.spendUsd
  // The close record carries its own completeness flag: `spentTotal.usdKnown: false` means
  // Runtime priced part of the run from a catalog, so the number is a floor, not a total.
  const closeUsdUnreported =
    stateUsd === null && resultCloseUsd !== null && resultSpentTotal.usdKnown === false
  const usdUnreportedReason = unpriced(
    usdUnknownRecords,
    usdKnownRecords + usdUnknownRecords,
    usdUnknownNodes,
  )
  // Which numbers may be partial, and which must go absent: a number may be a floor only
  // when its own record carries the known/unknown split beside it — `SpendMeasurement`
  // has `records`/`unknownRecords`, and `RoleSpend` has `source`. `totalUsd` is a bare
  // scalar, so a floor there is an unlabelled understatement and stays unavailable; the
  // partial sum with its denominators lives in `spend.journalDerived`, which this type's
  // own doc already names as the field to prefer.
  const totalUsd: Measured<number> =
    usdLimit !== null
      ? gap('totalUsd', usdLimit)
      : stateUsd !== null
        ? round(stateUsd, 6)
        : !haveJournal
          ? gap('totalUsd', journalMissing)
          : usdUnknownRecords > 0
            ? gap('totalUsd', usdUnreportedReason)
            : round(tree.brain.usd + journalWorkerUsd, 6)

  const journalSpendRecords = usdKnownRecords
  // `journalDerived` keeps its partial sum: `records` and `unknownRecords` state exactly
  // how much of the run it covers. Only an all-unreported channel has nothing to report.
  const journalDerivedAvailable = usdLimit === null && haveJournal && !usdAllUnknown
  const closeRecordAvailable = usdLimit === null && closeUsd !== null && !closeUsdUnreported
  const spend: SpendMeasurements = {
    journalDerived: {
      usd: journalDerivedAvailable
        ? round(tree.brain.usd + journalWorkerUsd, 6)
        : unavailable(usdLimit ?? (haveJournal ? usdUnreportedReason : journalMissing)),
      records: journalDerivedAvailable ? journalSpendRecords : 0,
      unknownRecords: usdLimit === null && haveJournal ? usdUnknownRecords : 0,
      partial: journalDerivedAvailable && usdPartial,
      unknownNodes: usdLimit === null && haveJournal ? usdUnknownNodes : [],
    },
    closeRecord: {
      usd: closeRecordAvailable
        ? round(closeUsd as number, 6)
        : unavailable(
            usdLimit ??
              (closeUsdUnreported
                ? 'close record incomplete: result.json spentTotal.usdKnown is false'
                : 'no close record: neither state.json result.spentUsd nor result.json spentTotal.usd is present'),
          ),
      records: closeRecordAvailable ? 1 : 0,
      unknownRecords: closeUsdUnreported ? 1 : 0,
      partial: false,
      unknownNodes: closeUsdUnreported && rootId !== null ? [rootId] : [],
    },
  }

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
      tokensIn:
        w.tokensIn ??
        (close?.hasSpend === true && close.spend.tokensKnown ? close.spend.tokens.input : null),
      tokensOut:
        w.tokensOut ??
        (close?.hasSpend === true && close.spend.tokensKnown ? close.spend.tokens.output : null),
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
  const wallDistribution = summarizeNumberSeries(
    perWorker.map((w) => w.wallMs).filter((w): w is number => w !== null),
  )

  const brainCalls = parseJsonl(src.brainLog)
  const managerTokenLimit = src.limits.managerTokens
  const economics: EconomicsMetrics = {
    brain: {
      tokensIn:
        managerTokenLimit !== null
          ? gap('brain.tokensIn', managerTokenLimit)
          : !haveJournal
            ? gap('brain.tokensIn', journalMissing)
            : brainTokensUnreported !== null
              ? gap('brain.tokensIn', brainTokensUnreported)
              : tree.brain.tokensIn,
      tokensOut:
        managerTokenLimit !== null
          ? unavailable(managerTokenLimit)
          : !haveJournal
            ? unavailable(journalMissing)
            : brainTokensUnreported !== null
              ? unavailable(brainTokensUnreported)
              : tree.brain.tokensOut,
      usd:
        usdLimit !== null
          ? unavailable(usdLimit)
          : !haveJournal
            ? unavailable(journalMissing)
            : brainUsdUnreported !== null
              ? unavailable(brainUsdUnreported)
              : round(tree.brain.usd, 6),
      cacheRead:
        managerTokenLimit !== null
          ? unavailable(managerTokenLimit)
          : !haveJournal
            ? unavailable(journalMissing)
            : brainTokensUnreported !== null
              ? unavailable(brainTokensUnreported)
              : !tree.brain.hasCache
                ? unavailable(NO_CACHE_COUNTERS)
                : tree.brain.cacheBreakdownKnown
                  ? tree.brain.cacheRead
                  : unavailable(NO_CACHE_BREAKDOWN),
      cacheWrite:
        managerTokenLimit !== null
          ? unavailable(managerTokenLimit)
          : !haveJournal
            ? unavailable(journalMissing)
            : brainTokensUnreported !== null
              ? unavailable(brainTokensUnreported)
              : !tree.brain.hasCache
                ? unavailable(NO_CACHE_COUNTERS)
                : tree.brain.cacheBreakdownKnown
                  ? tree.brain.cacheWrite
                  : unavailable(NO_CACHE_BREAKDOWN),
      source:
        managerTokenLimit ??
        (haveJournal
          ? `journal metered events (n=${tree.brain.meteredCount})${
              tree.brain.usdKnownCount > 0 && tree.brain.usdUnknownCount > 0
                ? ` — ${tree.brain.usdUnknownCount} unpriced`
                : ''
            }`
          : journalMissing),
    },
    brainTruncations:
      src.brainLog === null
        ? gap(
            'brain.brainTruncations',
            src.brainLogMissingReason ??
              (src.supRunDir === null
                ? 'no supervisor run dir under <ws>/.agent/supervisor (or legacy <ws>/.loops/supervisor)'
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
          : !haveJournal
            ? unavailable(journalMissing)
            : workerUsdUnreported !== null
              ? unavailable(workerUsdUnreported)
              : round(journalWorkerUsd, 6),
      source: `${
        workerTokenLimit !== null
          ? workerTokenLimit
          : sq !== null
            ? `journal settled spend + ${sq.store} sessions (n=${sq.sessions})`
            : `journal settled spend only — ${src.harnessMissingReason ?? 'harness session store unavailable'}`
      }${
        workerUsdUnknownNodes.length > 0 && workerUsdUnknownNodes.length < rootChildSpends.length
          ? ` — ${workerUsdUnknownNodes.length} unpriced`
          : ''
      }`,
    },
    spend,
    totalUsd,
    totalUsdSource:
      usdLimit !== null
        ? usdLimit
        : stateUsd !== null
          ? `state.json result.spentUsd${rootChildCloses.length > 0 && journalWorkerUsd === 0 ? ' — brain-priced only; worker CLI inference is unpriced (see worker token counts)' : ''}`
          : !haveJournal
            ? journalMissing
            : usdUnknownRecords > 0
              ? usdUnreportedReason
              : 'journal metered + settled usd',
    costPerAcceptedPatchUsd: isUnavailable(totalUsd)
      ? unavailable(totalUsd.unavailable)
      : isUnavailable(decision.accepted)
        ? unavailable(decision.accepted.unavailable)
        : decision.accepted === 0
          ? unavailable('no accepted worker patch (cost has no denominator)')
          : round(totalUsd / decision.accepted, 6),
    workerWallMsDistribution:
      wallDistribution === null
        ? unavailable(
            src.workers === null ? workersGapReason : 'no worker start/finish pairs captured',
          )
        : wallDistribution,
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
  const journalSpendVals = known(reports.map((r) => r.economics.spend.journalDerived.usd))
  const closeSpendVals = known(reports.map((r) => r.economics.spend.closeRecord.usd))
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
    spendUsd: {
      journalDerived: {
        value:
          journalSpendVals.length === 0
            ? unavailable('no cell measured journal-derived spend')
            : round(sum(journalSpendVals), 6),
        runs: journalSpendVals.length,
      },
      closeRecord: {
        value:
          closeSpendVals.length === 0
            ? unavailable('no cell carried a close record')
            : round(sum(closeSpendVals), 6),
        runs: closeSpendVals.length,
      },
    },
    resolvedCount:
      resolvedVals.length === 0
        ? unavailable('no cell reported a judge verdict')
        : resolvedVals.filter((v) => v === true).length,
    perCell,
  }
}
