/** Measure spend and token completeness, capture gaps, and per-worker economics. */
import { roundDecimal as round } from '../math/round-decimal'
import { summarizeNumberSeries } from '../statistics'
import type { CloseRow, SpawnRow, SupervisorTreeFacts } from './source-facts'
import { asRecord, parseJsonl, workerSourceKey } from './source-facts'
import type {
  DecisionMetrics,
  EconomicsMetrics,
  Measured,
  PerWorkerRow,
  SpendMeasurements,
  SupervisorRunSources,
  Unavailable,
} from './types'
import { isUnavailable, unavailable } from './types'

const NO_CACHE_COUNTERS = 'the journal carries no cache-token counters for this role'
const NO_CACHE_BREAKDOWN =
  'Runtime recorded cacheBreakdownKnown:false — the provider reported a total without splitting cache reads from writes'

interface SupervisorEconomicsInput {
  src: SupervisorRunSources
  tree: SupervisorTreeFacts
  result: Record<string, unknown> | null
  decision: DecisionMetrics
  haveJournal: boolean
  journalMissing: string
  workersGapReason: string
  gaps: string[]
  gap(what: string, reason: string): Unavailable
  spawnsForSource(worker: NonNullable<SupervisorRunSources['workers']>[number]): readonly SpawnRow[]
  spawnForSource(worker: NonNullable<SupervisorRunSources['workers']>[number]): SpawnRow | null
  closeById: ReadonlyMap<string, CloseRow>
}

export function analyzeSupervisorEconomics(input: SupervisorEconomicsInput) {
  const {
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
  } = input
  const { rootId, workerSpawns, workerCloses, state } = tree
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

  const noteCaptureGaps = (
    owner: string,
    captures: SupervisorRunSources['rootWorkspaceCaptures'],
  ): void => {
    if (captures === null || captures?.length === 0) {
      gaps.push(`${owner} workspaceCapture: no retained output capture evidence`)
    } else if (captures !== undefined) {
      for (const [index, capture] of captures.entries()) {
        const source = `${owner} workspaceCapture[${index + 1}]`
        if (capture.projectionGap !== null) gaps.push(`${source}: ${capture.projectionGap}`)
        if (capture.coverageComplete === false) {
          gaps.push(
            `${source}: ${capture.incompleteReason ?? 'provider reported incomplete coverage'}`,
          )
        }
        if (capture.coverageComplete === null && capture.projectionGap === null) {
          gaps.push(`${source}: capture coverage was not recorded`)
        }
      }
    }
  }
  noteCaptureGaps(`root ${rootId ?? src.runRef}`, src.rootWorkspaceCaptures)
  const perWorker: PerWorkerRow[] = (src.workers ?? []).map((w) => {
    noteCaptureGaps(`worker ${w.workerId ?? w.label}`, w.workspaceCaptures)
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
      workspaceCaptures: w.workspaceCaptures ?? null,
    }
  })
  const wallDistribution = summarizeNumberSeries(
    perWorker.map((w) => w.wallMs).filter((w): w is number => w !== null),
  )

  const brainCalls = parseJsonl(src.brainLog)
  const managerTokenLimit = src.limits.managerTokens
  const economics: EconomicsMetrics = {
    resourceRecords:
      src.journal === null && !tree.resourceRecords?.length
        ? unavailable(journalMissing)
        : (tree.resourceRecords ?? []),
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
                ? 'no Runtime supervisor run directory'
                : 'brain.jsonl absent — this source has no brain-call tap, so truncation cannot be ruled out'),
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

  return { economics, stateResult }
}
