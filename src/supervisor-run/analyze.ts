/**
 * The pure analyzer. Takes already-read bytes (`SupervisorRunSources`) and
 * returns the report — every metric derivable from a synthetic journal string
 * with no filesystem, no process, and no network. All I/O lives in a reader
 * (`loops-reader.ts` is one).
 */

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

// ---------------------------------------------------------------------------
// Journal shapes — structurally parsed. The journal is the contract, not the type.
// ---------------------------------------------------------------------------

interface JournalEvent {
  kind?: unknown
  id?: unknown
  parent?: unknown
  label?: unknown
  status?: unknown
  verdict?: unknown
  reason?: unknown
  seq?: unknown
  at?: unknown
  spend?: unknown
  spent?: unknown
}

interface Tokens {
  input: number
  output: number
}

interface SpendLike {
  tokens: Tokens
  usd: number
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function readSpend(v: unknown): SpendLike {
  const rec = asRecord(v)
  const tok = asRecord(rec.tokens)
  return { tokens: { input: num(tok.input), output: num(tok.output) }, usd: num(rec.usd) }
}

export function parseJsonl(text: string | null): Record<string, unknown>[] {
  if (text === null) return []
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) out.push(parsed as Record<string, unknown>)
    } catch {
      // A torn last line (writer killed mid-append) is skipped, never fatal.
    }
  }
  return out
}

export function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function ms(at: unknown): number | null {
  if (typeof at !== 'string') return null
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : null
}

// ---------------------------------------------------------------------------
// The supervision tree, as parsed from the journal event stream.
// ---------------------------------------------------------------------------

export interface SpawnRow {
  id: string
  parent: string | null
  label: string
  at: number | null
}

export interface CloseRow {
  id: string
  kind: 'settled' | 'cancelled'
  status: string | null
  verdict: string | null
  at: number | null
  spend: SpendLike
}

export interface WorkerLogFacts {
  started: number | null
  /** True once a `finished` event was seen — independent of whether its `at` parsed. */
  finished: boolean
  finishedAt: number | null
  passed: boolean | null
  /** `patchBytes` as reported by the finished event (not the patch file's size). */
  finishedPatchBytes: number | null
  evidenceBytes: number
  steersQueued: number
  steersDelivered: number
  questions: number
}

/**
 * The tree + timeline the report is computed from, exposed because the rollout-row
 * minter needs exactly the same parse (one parser, two consumers).
 */
export interface SupervisorTreeFacts {
  readonly rootId: string | null
  readonly spawns: readonly SpawnRow[]
  readonly closes: readonly CloseRow[]
  readonly workerSpawns: readonly SpawnRow[]
  readonly workerCloses: readonly CloseRow[]
  readonly brain: { tokensIn: number; tokensOut: number; usd: number; meteredCount: number }
  readonly workerLogs: ReadonlyMap<string, WorkerLogFacts>
  readonly startedAt: number | null
  readonly completedAt: number | null
}

export function parseSupervisorTree(src: SupervisorRunSources): SupervisorTreeFacts {
  const events = parseJsonl(src.journal)
  const state = parseJson(src.state)

  const spawns: SpawnRow[] = []
  const closes: CloseRow[] = []
  let brainIn = 0
  let brainOut = 0
  let brainUsd = 0
  let meteredCount = 0
  let rootId: string | null = null
  for (const ev of events as JournalEvent[]) {
    const kind = typeof ev.kind === 'string' ? ev.kind : ''
    const id = typeof ev.id === 'string' ? ev.id : ''
    if (kind === 'spawned') {
      const parent = typeof ev.parent === 'string' ? ev.parent : null
      const label = typeof ev.label === 'string' ? ev.label : ''
      if (parent === null && rootId === null) rootId = id
      spawns.push({ id, parent, label, at: ms(ev.at) })
    } else if (kind === 'settled') {
      closes.push({
        id,
        kind: 'settled',
        status: typeof ev.status === 'string' ? ev.status : null,
        verdict: typeof ev.verdict === 'string' ? ev.verdict : null,
        at: ms(ev.at),
        spend: readSpend(ev.spent),
      })
    } else if (kind === 'cancelled') {
      closes.push({
        id,
        kind: 'cancelled',
        status: 'cancelled',
        verdict: typeof ev.reason === 'string' ? ev.reason : null,
        at: ms(ev.at),
        spend: { tokens: { input: 0, output: 0 }, usd: 0 },
      })
    } else if (kind === 'metered') {
      const s = readSpend(ev.spend)
      brainIn += s.tokens.input
      brainOut += s.tokens.output
      brainUsd += s.usd
      meteredCount += 1
    }
  }

  const workerSpawns = spawns.filter((s) => s.id !== rootId)
  const workerIds = new Set(workerSpawns.map((s) => s.id))
  const workerCloses = closes.filter((c) => workerIds.has(c.id))

  const workerLogs = new Map<string, WorkerLogFacts>()
  for (const w of src.workers ?? []) {
    const facts: WorkerLogFacts = {
      started: null,
      finished: false,
      finishedAt: null,
      passed: null,
      finishedPatchBytes: null,
      evidenceBytes: 0,
      steersQueued: 0,
      steersDelivered: 0,
      questions: 0,
    }
    for (const req of parseJsonl(w.inbox)) {
      if (typeof req.message === 'string' && req.message.trim().length > 0) facts.steersQueued += 1
    }
    for (const ev of parseJsonl(w.events)) {
      const kind = ev.kind
      if (kind === 'message') {
        if (ev.direction === 'up') {
          facts.questions += 1
          continue
        }
        // A down-leg message not backed by an inbox line (in-process steer) still counts.
        if (typeof ev.requestId !== 'string') facts.steersQueued += 1
        if (ev.delivered === true) facts.steersDelivered += 1
      } else if (kind === 'started') {
        facts.started = ms(ev.at)
      } else if (kind === 'finished') {
        facts.finished = true
        facts.finishedAt = ms(ev.at)
        facts.passed = typeof ev.passed === 'boolean' ? ev.passed : null
        facts.finishedPatchBytes = typeof ev.patchBytes === 'number' ? ev.patchBytes : null
        facts.evidenceBytes = typeof ev.evidence === 'string' ? ev.evidence.length : 0
      }
    }
    workerLogs.set(w.label, facts)
  }

  const startedAt = ms(state?.startedAt) ?? spawns[0]?.at ?? null
  const completedAt =
    ms(state?.completedAt) ??
    [...spawns.map((s) => s.at), ...closes.map((c) => c.at)].reduce<number | null>(
      (acc, t) => (t === null ? acc : acc === null ? t : Math.max(acc, t)),
      null,
    )

  return {
    rootId,
    spawns,
    closes,
    workerSpawns,
    workerCloses,
    brain: { tokensIn: brainIn, tokensOut: brainOut, usd: brainUsd, meteredCount },
    workerLogs,
    startedAt,
    completedAt,
  }
}

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
  const state = parseJson(src.state)
  const result = parseJson(src.result)
  const judge = parseJson(src.judge)
  const tree = parseSupervisorTree(src)
  const { rootId, workerSpawns, workerCloses, startedAt, completedAt } = tree

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
      const facts = tree.workerLogs.get(w.label)
      const queued = facts?.steersQueued ?? 0
      const delivered = facts?.steersDelivered ?? 0
      upLegMessages += facts?.questions ?? 0
      steerRows.push({ worker: w.label, queued, delivered })
      steerQueuedTotal += queued
      steerDeliveredTotal += delivered
    }
  }
  const workersGapReason = src.workersMissingReason ?? 'workers/ directory absent'
  const steers: Measured<number> =
    src.workers === null ? gap('steers', workersGapReason) : steerQueuedTotal
  const steersDelivered: Measured<number> =
    src.workers === null ? unavailable(workersGapReason) : steerDeliveredTotal
  const steersByWorker: Measured<readonly SteerBreakdown[]> =
    src.workers === null ? unavailable(workersGapReason) : steerRows

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
  const firstSettleAt = workerCloses.reduce<number | null>(
    (acc, c) => (c.at === null ? acc : acc === null ? c.at : Math.min(acc, c.at)),
    null,
  )
  const respawns =
    firstSettleAt === null
      ? 0
      : workerSpawns.filter((s) => s.at !== null && s.at > firstSettleAt).length

  const labelCounts = new Map<string, number>()
  for (const s of workerSpawns) labelCounts.set(s.label, (labelCounts.get(s.label) ?? 0) + 1)
  const repeatedLabels = [...labelCounts.entries()].filter(([, n]) => n > 1).map(([l]) => l)

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

  let accepted = 0
  let rejected = 0
  let emptyPass = 0
  let evidenceBytes = 0
  for (const w of src.workers ?? []) {
    const f = tree.workerLogs.get(w.label)
    if (f === undefined || !f.finished) continue
    evidenceBytes += f.evidenceBytes
    if (f.passed === true) {
      if ((f.finishedPatchBytes ?? 0) > 0) accepted += 1
      else emptyPass += 1
    } else if (f.passed === false) rejected += 1
  }

  // Evidence→respawn: for each worker spawn issued after some settlement, did a
  // settlement land strictly between the previous spawn and this one?
  let observeThenRespawn = 0
  let respawnWithoutEvidence = 0
  const spawnTimes = workerSpawns
    .map((s) => s.at)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
  const closeTimes = workerCloses
    .map((c) => c.at)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
  for (let i = 1; i < spawnTimes.length; i += 1) {
    const prevSpawn = spawnTimes[i - 1] as number
    const thisSpawn = spawnTimes[i] as number
    const sawEvidence = closeTimes.some((t) => t >= prevSpawn && t <= thisSpawn)
    if (firstSettleAt !== null && thisSpawn > firstSettleAt) {
      if (sawEvidence) observeThenRespawn += 1
      else respawnWithoutEvidence += 1
    }
  }

  const decision: DecisionMetrics = {
    settledByStatus: haveJournal ? settledByStatus : gap('settledByStatus', journalMissing),
    settledVerdicts: haveJournal ? settledVerdicts : unavailable(journalMissing),
    accepted: src.workers === null ? unavailable(workersGapReason) : accepted,
    rejected: src.workers === null ? unavailable(workersGapReason) : rejected,
    emptyPass: src.workers === null ? unavailable(workersGapReason) : emptyPass,
    observeThenRespawn: haveJournal ? observeThenRespawn : unavailable(journalMissing),
    respawnWithoutEvidence: haveJournal ? respawnWithoutEvidence : unavailable(journalMissing),
    reviewActions:
      src.workers === null ? unavailable(workersGapReason) : steerQueuedTotal + upLegMessages,
    workerEvidenceBytes: src.workers === null ? unavailable(workersGapReason) : evidenceBytes,
  }

  // ── economics ──────────────────────────────────────────────────────────
  const journalWorkerIn = workerCloses.reduce((a, c) => a + c.spend.tokens.input, 0)
  const journalWorkerOut = workerCloses.reduce((a, c) => a + c.spend.tokens.output, 0)
  const journalWorkerUsd = workerCloses.reduce((a, c) => a + c.spend.usd, 0)
  const sq = src.harnessWorkerTokens
  const harnessGapReason =
    src.harnessMissingReason ?? 'harness session store unavailable and journal settled spend is 0'
  const workerIn: Measured<number> =
    sq !== null
      ? journalWorkerIn + sq.input
      : journalWorkerIn > 0
        ? journalWorkerIn
        : gap('workers.tokensIn', harnessGapReason)
  const workerOut: Measured<number> =
    sq !== null
      ? journalWorkerOut + sq.output
      : journalWorkerOut > 0
        ? journalWorkerOut
        : unavailable(harnessGapReason)

  const stateResult = asRecord(state?.result)
  const stateUsd = typeof stateResult.spentUsd === 'number' ? stateResult.spentUsd : null
  const totalUsd: Measured<number> =
    stateUsd !== null
      ? round(stateUsd, 6)
      : haveJournal
        ? round(tree.brain.usd + journalWorkerUsd, 6)
        : gap('totalUsd', journalMissing)

  const perWorker: PerWorkerRow[] = (src.workers ?? []).map((w) => {
    const f = tree.workerLogs.get(w.label)
    return {
      worker: w.label,
      wallMs: f?.started != null && f.finishedAt != null ? f.finishedAt - f.started : null,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      patchBytes: w.patchBytes ?? f?.finishedPatchBytes ?? null,
      passed: f?.passed ?? null,
    }
  })
  const walls = perWorker
    .map((w) => w.wallMs)
    .filter((w): w is number => w !== null)
    .sort((a, b) => a - b)

  const brainCalls = parseJsonl(src.brainLog)
  const economics: EconomicsMetrics = {
    brain: {
      tokensIn: haveJournal ? tree.brain.tokensIn : gap('brain.tokensIn', journalMissing),
      tokensOut: haveJournal ? tree.brain.tokensOut : unavailable(journalMissing),
      usd: haveJournal ? round(tree.brain.usd, 6) : unavailable(journalMissing),
      source: haveJournal
        ? `journal metered events (n=${tree.brain.meteredCount})`
        : journalMissing,
    },
    brainTruncations:
      src.brainLog === null
        ? gap(
            'brain.brainTruncations',
            src.supRunDir === null
              ? 'no supervisor run dir under <ws>/.loops/supervisor'
              : 'brain.jsonl absent — loops predates the brain-call tap, so truncation cannot be ruled out',
          )
        : brainCalls.filter((c) => c.finish_reason === 'length').length,
    workers: {
      tokensIn: workerIn,
      tokensOut: workerOut,
      usd: haveJournal ? round(journalWorkerUsd, 6) : unavailable(journalMissing),
      source:
        sq !== null
          ? `journal settled spend + ${sq.store} sessions (n=${sq.sessions})`
          : `journal settled spend only — ${src.harnessMissingReason ?? 'harness session store unavailable'}`,
    },
    totalUsd,
    totalUsdSource:
      stateUsd !== null
        ? `state.json result.spentUsd${journalWorkerUsd === 0 ? ' — brain-priced only; worker CLI inference is unpriced (see worker token counts)' : ''}`
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
    src.patch === null ? gap('patch', 'delivered patch file absent') : parsePatch(src.patch)

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
    generatedAt: new Date(now()).toISOString(),
    orchestration,
    decision,
    economics,
    outcome,
    gaps,
    traceCommand:
      'npx --yes @tangle-network/traces@latest analyze --harness opencode --cwd <worker-clone-cwd>',
  }
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
